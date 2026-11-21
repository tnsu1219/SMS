alter table public.profiles
  drop constraint if exists profiles_role_check;

alter table public.profiles
  add constraint profiles_role_check
  check (role in ('admin', 'manager', 'cashier', 'inventory_officer'));

alter table public.products
  add column brand text,
  add column model text,
  add column color text,
  add column storage_gb integer check (storage_gb is null or storage_gb > 0),
  add column is_serialized boolean not null default false;

create table public.suppliers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 160),
  contact_name text,
  email text,
  phone text,
  address text,
  tax_identifier text,
  notes text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (organization_id, id)
);

create table public.customers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid,
  name text not null check (length(trim(name)) between 1 and 160),
  email text,
  phone text,
  address text,
  notes text,
  created_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, branch_id)
    references public.branches(organization_id, id) on delete set null (branch_id)
);

create table public.product_serials (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  product_id uuid not null,
  branch_id uuid not null,
  serial_number text,
  imei text,
  status text not null default 'in_stock'
    check (status in ('in_stock', 'reserved', 'in_transit', 'sold', 'retired')),
  created_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, product_id)
    references public.products(organization_id, id) on delete cascade,
  foreign key (organization_id, branch_id)
    references public.branches(organization_id, id) on delete cascade,
  check ((imei is null or imei ~ '^[0-9]{14,16}$')
    and (nullif(trim(serial_number), '') is not null
      or coalesce(imei ~ '^[0-9]{14,16}$', false)))
);

create unique index product_serials_org_serial_uidx
  on public.product_serials (organization_id, lower(trim(serial_number)))
  where serial_number is not null and length(trim(serial_number)) > 0;
create unique index product_serials_org_imei_uidx
  on public.product_serials (organization_id, imei)
  where imei is not null;
create index product_serials_branch_product_idx
  on public.product_serials (branch_id, product_id, status);

create table public.inventory_transfers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  source_branch_id uuid not null,
  destination_branch_id uuid not null,
  status text not null default 'requested'
    check (status in ('requested', 'approved', 'rejected', 'dispatched', 'received')),
  notes text,
  requested_by uuid not null references public.profiles(id),
  approved_by uuid references public.profiles(id),
  rejected_by uuid references public.profiles(id),
  dispatched_by uuid references public.profiles(id),
  received_by uuid references public.profiles(id),
  requested_at timestamptz not null default now(),
  approved_at timestamptz,
  rejected_at timestamptz,
  dispatched_at timestamptz,
  received_at timestamptz,
  unique (organization_id, id),
  foreign key (organization_id, source_branch_id)
    references public.branches(organization_id, id),
  foreign key (organization_id, destination_branch_id)
    references public.branches(organization_id, id),
  check (source_branch_id <> destination_branch_id)
);

create table public.inventory_transfer_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  transfer_id uuid not null,
  product_id uuid not null,
  quantity integer not null check (quantity > 0),
  serial_ids uuid[] not null default '{}'::uuid[],
  unique (transfer_id, product_id),
  foreign key (organization_id, transfer_id)
    references public.inventory_transfers(organization_id, id) on delete cascade,
  foreign key (organization_id, product_id)
    references public.products(organization_id, id)
);

create index inventory_transfers_source_idx
  on public.inventory_transfers (source_branch_id, requested_at desc);
create index inventory_transfers_destination_idx
  on public.inventory_transfers (destination_branch_id, requested_at desc);
create index inventory_transfer_items_transfer_idx
  on public.inventory_transfer_items (transfer_id);

create or replace function public.adjust_stock(
  p_branch_id uuid,
  p_product_id uuid,
  p_quantity_delta integer,
  p_reorder_level integer default null
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor public.profiles%rowtype;
  stock_row public.inventory%rowtype;
  new_quantity integer;
begin
  select * into actor from public.profiles where id = (select auth.uid());
  if actor.id is null or actor.role not in ('admin', 'manager', 'inventory_officer') then
    raise exception 'You do not have permission to adjust stock' using errcode = '42501';
  end if;
  if not public.can_access_branch(p_branch_id) then
    raise exception 'You do not have permission to manage this branch' using errcode = '42501';
  end if;
  if p_quantity_delta = 0 or (p_reorder_level is not null and p_reorder_level < 0) then
    raise exception 'Stock changes and reorder levels must be valid' using errcode = '22023';
  end if;

  select * into stock_row
  from public.inventory
  where branch_id = p_branch_id and product_id = p_product_id
    and organization_id = actor.organization_id
  for update;
  if stock_row.id is null then
    raise exception 'Inventory record not found' using errcode = 'P0002';
  end if;

  new_quantity := stock_row.quantity + p_quantity_delta;
  if new_quantity < 0 then
    raise exception 'Stock cannot be reduced below zero' using errcode = '22023';
  end if;

  update public.inventory set
    quantity = new_quantity,
    reorder_level = coalesce(p_reorder_level, reorder_level),
    updated_at = now()
  where id = stock_row.id;

  insert into public.stock_movements (
    organization_id, branch_id, product_id, actor_id, movement_type, quantity_delta
  ) values (
    actor.organization_id, p_branch_id, p_product_id, actor.id,
    case when p_quantity_delta > 0 then 'restock' else 'adjustment' end,
    p_quantity_delta
  );

  return new_quantity;
end;
$$;

create or replace function public.register_serialized_stock(
  p_branch_id uuid,
  p_product_id uuid,
  p_serials jsonb,
  p_reorder_level integer default null
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor public.profiles%rowtype;
  product_row public.products%rowtype;
  stock_row public.inventory%rowtype;
  serial_item jsonb;
  new_quantity integer;
begin
  select * into actor
  from public.profiles
  where id = (select auth.uid());

  if actor.id is null or actor.role not in ('admin', 'manager', 'inventory_officer') then
    raise exception 'You do not have permission to register serialized stock' using errcode = '42501';
  end if;
  if not public.can_access_branch(p_branch_id) then
    raise exception 'You do not have permission to manage this branch' using errcode = '42501';
  end if;
  if p_serials is null or jsonb_typeof(p_serials) <> 'array' or jsonb_array_length(p_serials) = 0
      or (p_reorder_level is not null and p_reorder_level < 0) then
    raise exception 'Serials and reorder level must be valid' using errcode = '22023';
  end if;

  select * into product_row
  from public.products
  where id = p_product_id and organization_id = actor.organization_id
    and active and is_serialized
  for share;
  if product_row.id is null then
    raise exception 'Serialized product not found or inactive' using errcode = 'P0002';
  end if;

  for serial_item in select value from jsonb_array_elements(p_serials)
  loop
    if jsonb_typeof(serial_item) <> 'object'
        or (nullif(trim(serial_item ->> 'imei'), '') is not null
          and trim(serial_item ->> 'imei') !~ '^[0-9]{14,16}$')
        or (nullif(trim(serial_item ->> 'serial_number'), '') is null
          and coalesce(serial_item ->> 'imei', '') !~ '^[0-9]{14,16}$') then
      raise exception 'Each unit must have a serial number or valid IMEI' using errcode = '22023';
    end if;

    insert into public.product_serials (
      organization_id, product_id, branch_id, serial_number, imei
    ) values (
      actor.organization_id, product_row.id, p_branch_id,
      nullif(trim(serial_item ->> 'serial_number'), ''),
      nullif(trim(serial_item ->> 'imei'), '')
    );
  end loop;

  select * into stock_row
  from public.inventory
  where organization_id = actor.organization_id
    and branch_id = p_branch_id and product_id = p_product_id
  for update;
  if stock_row.id is null then
    raise exception 'Inventory record not found' using errcode = 'P0002';
  end if;

  new_quantity := stock_row.quantity + jsonb_array_length(p_serials);
  update public.inventory set
    quantity = new_quantity,
    reorder_level = coalesce(p_reorder_level, reorder_level),
    updated_at = now()
  where id = stock_row.id;

  insert into public.stock_movements (
    organization_id, branch_id, product_id, actor_id, movement_type, quantity_delta
  ) values (
    actor.organization_id, p_branch_id, p_product_id, actor.id,
    'restock', jsonb_array_length(p_serials)
  );

  return new_quantity;
end;
$$;

create or replace function public.create_inventory_transfer(
  p_source_branch_id uuid,
  p_destination_branch_id uuid,
  p_items jsonb,
  p_notes text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor public.profiles%rowtype;
  product_row public.products%rowtype;
  transfer_id uuid;
  item jsonb;
  item_product_id uuid;
  item_quantity integer;
  item_serial_ids uuid[];
  serial_id uuid;
  stock_row public.inventory%rowtype;
begin
  select * into actor from public.profiles where id = (select auth.uid());
  if actor.id is null or actor.role not in ('admin', 'manager', 'inventory_officer') then
    raise exception 'You do not have permission to request transfers' using errcode = '42501';
  end if;
  if p_source_branch_id = p_destination_branch_id
      or not exists (
        select 1 from public.branches b
        where b.id = p_source_branch_id and b.organization_id = actor.organization_id and b.active
      )
      or not exists (
        select 1 from public.branches b
        where b.id = p_destination_branch_id and b.organization_id = actor.organization_id and b.active
      )
      or (actor.role <> 'admin' and actor.branch_id is distinct from p_source_branch_id) then
    raise exception 'You do not have permission to transfer between these branches' using errcode = '42501';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'A transfer must contain at least one product' using errcode = '22023';
  end if;

  transfer_id := gen_random_uuid();
  insert into public.inventory_transfers (
    id, organization_id, source_branch_id, destination_branch_id,
    notes, requested_by
  ) values (
    transfer_id, actor.organization_id, p_source_branch_id, p_destination_branch_id,
    nullif(trim(p_notes), ''), actor.id
  );

  for item in select value from jsonb_array_elements(p_items)
  loop
    item_product_id := (item ->> 'product_id')::uuid;
    item_quantity := (item ->> 'quantity')::integer;
    if item_quantity is null or item_quantity < 1 then
      raise exception 'Transfer quantities must be positive' using errcode = '22023';
    end if;

    select * into product_row
    from public.products
    where id = item_product_id and organization_id = actor.organization_id and active
    for share;
    if product_row.id is null then
      raise exception 'Product not found or inactive' using errcode = 'P0002';
    end if;

    select coalesce(array_agg(value::uuid), '{}'::uuid[])
    into item_serial_ids
    from jsonb_array_elements_text(coalesce(item -> 'serial_ids', '[]'::jsonb));
    if jsonb_typeof(coalesce(item -> 'serial_ids', '[]'::jsonb)) <> 'array'
        or (select count(distinct u.serial_id) from unnest(item_serial_ids) as u(serial_id))
          <> cardinality(item_serial_ids) then
      raise exception 'Serial identifiers must be a unique array' using errcode = '22023';
    end if;
    if (product_row.is_serialized and cardinality(item_serial_ids) <> item_quantity)
        or (not product_row.is_serialized and cardinality(item_serial_ids) <> 0) then
      raise exception 'Serialized units must be supplied for each serialized item' using errcode = '22023';
    end if;

    select * into stock_row
    from public.inventory
    where organization_id = actor.organization_id
      and branch_id = p_source_branch_id and product_id = item_product_id
    for update;
    if stock_row.id is null or stock_row.quantity < item_quantity then
      raise exception 'Insufficient source stock' using errcode = 'P0001';
    end if;

    insert into public.inventory_transfer_items (
      organization_id, transfer_id, product_id, quantity, serial_ids
    ) values (
      actor.organization_id, transfer_id, item_product_id, item_quantity, item_serial_ids
    );

    foreach serial_id in array item_serial_ids
    loop
      update public.product_serials
      set status = 'reserved'
      where id = serial_id and organization_id = actor.organization_id
        and product_id = item_product_id and branch_id = p_source_branch_id
        and status = 'in_stock';
      if not found then
        raise exception 'A serialized unit is unavailable at the source branch' using errcode = 'P0001';
      end if;
    end loop;
  end loop;

  return transfer_id;
end;
$$;

create or replace function public.approve_inventory_transfer(p_transfer_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor public.profiles%rowtype;
  transfer_row public.inventory_transfers%rowtype;
begin
  select * into actor from public.profiles where id = (select auth.uid());
  if actor.id is null or actor.role not in ('admin', 'manager') then
    raise exception 'Only an admin or manager can approve transfers' using errcode = '42501';
  end if;
  select * into transfer_row from public.inventory_transfers
  where id = p_transfer_id for update;
  if transfer_row.id is null or transfer_row.organization_id <> actor.organization_id
      or not public.can_access_branch(transfer_row.source_branch_id) then
    raise exception 'Transfer not found or not accessible' using errcode = '42501';
  end if;
  if transfer_row.status <> 'requested' then
    raise exception 'Only requested transfers can be approved' using errcode = '22023';
  end if;

  update public.inventory_transfers
  set status = 'approved', approved_by = actor.id, approved_at = now()
  where id = transfer_row.id;
end;
$$;

create or replace function public.reject_inventory_transfer(p_transfer_id uuid, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor public.profiles%rowtype;
  transfer_row public.inventory_transfers%rowtype;
  item_row public.inventory_transfer_items%rowtype;
  serial_id uuid;
begin
  select * into actor from public.profiles where id = (select auth.uid());
  if actor.id is null or actor.role not in ('admin', 'manager') then
    raise exception 'Only an admin or manager can reject transfers' using errcode = '42501';
  end if;
  select * into transfer_row from public.inventory_transfers
  where id = p_transfer_id for update;
  if transfer_row.id is null or transfer_row.organization_id <> actor.organization_id
      or not public.can_access_branch(transfer_row.source_branch_id) then
    raise exception 'Transfer not found or not accessible' using errcode = '42501';
  end if;
  if transfer_row.status <> 'requested' then
    raise exception 'Only requested transfers can be rejected' using errcode = '22023';
  end if;

  for item_row in
    select * from public.inventory_transfer_items where transfer_id = transfer_row.id
  loop
    foreach serial_id in array item_row.serial_ids
    loop
      update public.product_serials set status = 'in_stock'
      where id = serial_id and status = 'reserved';
    end loop;
  end loop;

  update public.inventory_transfers
  set status = 'rejected',
      rejected_by = actor.id,
      rejected_at = now(),
      notes = concat_ws(E'\n', nullif(notes, ''), nullif(trim(p_reason), ''))
  where id = transfer_row.id;
end;
$$;

create or replace function public.dispatch_inventory_transfer(p_transfer_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor public.profiles%rowtype;
  transfer_row public.inventory_transfers%rowtype;
  item_row public.inventory_transfer_items%rowtype;
  stock_row public.inventory%rowtype;
  serial_id uuid;
begin
  select * into actor from public.profiles where id = (select auth.uid());
  if actor.id is null or actor.role not in ('admin', 'manager', 'inventory_officer') then
    raise exception 'You do not have permission to dispatch transfers' using errcode = '42501';
  end if;
  select * into transfer_row from public.inventory_transfers
  where id = p_transfer_id for update;
  if transfer_row.id is null or transfer_row.organization_id <> actor.organization_id
      or not public.can_access_branch(transfer_row.source_branch_id) then
    raise exception 'Transfer not found or not accessible' using errcode = '42501';
  end if;
  if transfer_row.status <> 'approved' then
    raise exception 'Only approved transfers can be dispatched' using errcode = '22023';
  end if;

  for item_row in
    select * from public.inventory_transfer_items
    where transfer_id = transfer_row.id order by product_id
  loop
    select * into stock_row
    from public.inventory
    where organization_id = actor.organization_id
      and branch_id = transfer_row.source_branch_id and product_id = item_row.product_id
    for update;
    if stock_row.id is null or stock_row.quantity < item_row.quantity then
      raise exception 'Insufficient source stock at dispatch' using errcode = 'P0001';
    end if;

    update public.inventory
    set quantity = quantity - item_row.quantity, updated_at = now()
    where id = stock_row.id;
    insert into public.stock_movements (
      organization_id, branch_id, product_id, actor_id, movement_type, quantity_delta, reference_id
    ) values (
      actor.organization_id, transfer_row.source_branch_id, item_row.product_id, actor.id,
      'transfer_out', -item_row.quantity, transfer_row.id
    );

    foreach serial_id in array item_row.serial_ids
    loop
      update public.product_serials set status = 'in_transit'
      where id = serial_id and status = 'reserved'
        and branch_id = transfer_row.source_branch_id;
      if not found then
        raise exception 'A reserved serialized unit is unavailable' using errcode = 'P0001';
      end if;
    end loop;
  end loop;

  update public.inventory_transfers
  set status = 'dispatched', dispatched_by = actor.id, dispatched_at = now()
  where id = transfer_row.id;
end;
$$;

create or replace function public.receive_inventory_transfer(p_transfer_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor public.profiles%rowtype;
  transfer_row public.inventory_transfers%rowtype;
  item_row public.inventory_transfer_items%rowtype;
  serial_id uuid;
begin
  select * into actor from public.profiles where id = (select auth.uid());
  if actor.id is null or actor.role not in ('admin', 'manager', 'inventory_officer') then
    raise exception 'You do not have permission to receive transfers' using errcode = '42501';
  end if;
  select * into transfer_row from public.inventory_transfers
  where id = p_transfer_id for update;
  if transfer_row.id is null or transfer_row.organization_id <> actor.organization_id
      or not public.can_access_branch(transfer_row.destination_branch_id) then
    raise exception 'Transfer not found or not accessible' using errcode = '42501';
  end if;
  if transfer_row.status <> 'dispatched' then
    raise exception 'Only dispatched transfers can be received' using errcode = '22023';
  end if;

  for item_row in
    select * from public.inventory_transfer_items
    where transfer_id = transfer_row.id order by product_id
  loop
    insert into public.inventory (organization_id, branch_id, product_id, quantity)
    values (actor.organization_id, transfer_row.destination_branch_id, item_row.product_id, item_row.quantity)
    on conflict (branch_id, product_id) do update
      set quantity = public.inventory.quantity + excluded.quantity, updated_at = now();

    insert into public.stock_movements (
      organization_id, branch_id, product_id, actor_id, movement_type, quantity_delta, reference_id
    ) values (
      actor.organization_id, transfer_row.destination_branch_id, item_row.product_id, actor.id,
      'transfer_in', item_row.quantity, transfer_row.id
    );

    foreach serial_id in array item_row.serial_ids
    loop
      update public.product_serials
      set status = 'in_stock', branch_id = transfer_row.destination_branch_id
      where id = serial_id and status = 'in_transit'
        and branch_id = transfer_row.source_branch_id;
      if not found then
        raise exception 'A serialized unit is not in transit' using errcode = 'P0001';
      end if;
    end loop;
  end loop;

  update public.inventory_transfers
  set status = 'received', received_by = actor.id, received_at = now()
  where id = transfer_row.id;
end;
$$;

revoke all on function public.adjust_stock(uuid, uuid, integer, integer) from public;
revoke all on function public.register_serialized_stock(uuid, uuid, jsonb, integer) from public;
revoke all on function public.create_inventory_transfer(uuid, uuid, jsonb, text) from public;
revoke all on function public.approve_inventory_transfer(uuid) from public;
revoke all on function public.reject_inventory_transfer(uuid, text) from public;
revoke all on function public.dispatch_inventory_transfer(uuid) from public;
revoke all on function public.receive_inventory_transfer(uuid) from public;

grant execute on function public.adjust_stock(uuid, uuid, integer, integer) to authenticated;
grant execute on function public.register_serialized_stock(uuid, uuid, jsonb, integer) to authenticated;
grant execute on function public.create_inventory_transfer(uuid, uuid, jsonb, text) to authenticated;
grant execute on function public.approve_inventory_transfer(uuid) to authenticated;
grant execute on function public.reject_inventory_transfer(uuid, text) to authenticated;
grant execute on function public.dispatch_inventory_transfer(uuid) to authenticated;
grant execute on function public.receive_inventory_transfer(uuid) to authenticated;

alter table public.suppliers enable row level security;
alter table public.customers enable row level security;
alter table public.product_serials enable row level security;
alter table public.inventory_transfers enable row level security;
alter table public.inventory_transfer_items enable row level security;

create policy "organization members can read suppliers"
  on public.suppliers for select to authenticated
  using (organization_id = (select public.current_organization_id()));
create policy "admins and managers can add suppliers"
  on public.suppliers for insert to authenticated
  with check (organization_id = (select public.current_organization_id())
    and (select public.current_user_role()) in ('admin', 'manager'));
create policy "admins and managers can update suppliers"
  on public.suppliers for update to authenticated
  using (organization_id = (select public.current_organization_id())
    and (select public.current_user_role()) in ('admin', 'manager'))
  with check (organization_id = (select public.current_organization_id()));

create policy "members can read accessible customers"
  on public.customers for select to authenticated
  using (organization_id = (select public.current_organization_id())
    and (branch_id is null or (select public.can_access_branch(branch_id))));
create policy "branch staff can add customers"
  on public.customers for insert to authenticated
  with check (organization_id = (select public.current_organization_id())
    and branch_id is not null
    and (select public.can_access_branch(branch_id))
    and (select public.current_user_role()) in ('admin', 'manager', 'cashier'));
create policy "branch staff can update customers"
  on public.customers for update to authenticated
  using (organization_id = (select public.current_organization_id())
    and branch_id is not null
    and (select public.can_access_branch(branch_id))
    and (select public.current_user_role()) in ('admin', 'manager', 'cashier'))
  with check (organization_id = (select public.current_organization_id())
    and branch_id is not null
    and (select public.can_access_branch(branch_id))
    and (select public.current_user_role()) in ('admin', 'manager', 'cashier'));

create policy "members can read accessible product serials"
  on public.product_serials for select to authenticated
  using (organization_id = (select public.current_organization_id())
    and (select public.can_access_branch(branch_id)));
create policy "members can read accessible transfers"
  on public.inventory_transfers for select to authenticated
  using (organization_id = (select public.current_organization_id())
    and ((select public.can_access_branch(source_branch_id))
      or (select public.can_access_branch(destination_branch_id))));
create policy "members can read items of accessible transfers"
  on public.inventory_transfer_items for select to authenticated
  using (organization_id = (select public.current_organization_id())
    and exists (
      select 1 from public.inventory_transfers t
      where t.id = transfer_id
        and ((select public.can_access_branch(t.source_branch_id))
          or (select public.can_access_branch(t.destination_branch_id)))
    ));

grant select on public.suppliers, public.customers, public.product_serials,
  public.inventory_transfers, public.inventory_transfer_items to authenticated;
grant insert, update on public.suppliers, public.customers to authenticated;
