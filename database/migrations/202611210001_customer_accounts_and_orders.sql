alter table public.customers
  add column auth_user_id uuid references auth.users(id) on delete cascade;

create unique index customers_auth_user_id_uidx
  on public.customers (auth_user_id)
  where auth_user_id is not null;

alter table public.sales
  add column customer_id uuid references public.customers(id) on delete set null;

create index sales_customer_created_idx
  on public.sales (customer_id, created_at desc)
  where customer_id is not null;

create table public.customer_orders (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  customer_id uuid not null,
  branch_id uuid not null,
  status text not null default 'pending'
    check (status in ('pending', 'confirmed', 'ready', 'completed', 'cancelled')),
  note text,
  subtotal numeric(12, 2) not null check (subtotal >= 0),
  tax numeric(12, 2) not null check (tax >= 0),
  total numeric(12, 2) not null check (total >= 0),
  sales_id uuid references public.sales(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (organization_id, customer_id)
    references public.customers(organization_id, id) on delete cascade,
  foreign key (organization_id, branch_id)
    references public.branches(organization_id, id)
);

create table public.customer_order_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  order_id uuid not null references public.customer_orders(id) on delete cascade,
  product_id uuid not null references public.products(id),
  product_name text not null,
  quantity integer not null check (quantity > 0),
  unit_price numeric(12, 2) not null check (unit_price >= 0),
  line_total numeric(12, 2) not null check (line_total >= 0)
);

create index customer_orders_branch_status_idx
  on public.customer_orders (branch_id, status, created_at desc);
create index customer_order_items_order_idx
  on public.customer_order_items (order_id);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_organization_id uuid;
  new_branch_id uuid;
  new_full_name text;
  pending_invite public.team_invites%rowtype;
  existing_customer_id uuid;
begin
  if new.raw_user_meta_data ->> 'account_type' = 'customer' then
    begin
      new_organization_id := (new.raw_user_meta_data ->> 'organization_id')::uuid;
    exception when invalid_text_representation then
      raise exception 'Choose a valid business to create a customer account.'
        using errcode = '22023';
    end;

    if not exists (
      select 1 from public.organizations where id = new_organization_id
    ) then
      raise exception 'The selected business is unavailable.'
        using errcode = '22023';
    end if;

    new_full_name := coalesce(
      nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''),
      split_part(new.email, '@', 1)
    );

    select id into existing_customer_id
    from public.customers
    where organization_id = new_organization_id
      and lower(email) = lower(new.email)
      and auth_user_id is null
    order by created_at
    limit 1
    for update;

    if existing_customer_id is null then
      insert into public.customers (
        organization_id, auth_user_id, name, email, phone
      ) values (
        new_organization_id, new.id, new_full_name, lower(new.email),
        nullif(trim(new.raw_user_meta_data ->> 'phone'), '')
      );
    else
      update public.customers
      set auth_user_id = new.id,
          name = new_full_name,
          phone = coalesce(
            nullif(trim(new.raw_user_meta_data ->> 'phone'), ''),
            phone
          )
      where id = existing_customer_id;
    end if;

    return new;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(487392105);

  if exists (select 1 from public.profiles limit 1) then
    select *
    into pending_invite
    from public.team_invites
    where email = lower(trim(new.email))
      and invitation_token = new.raw_user_meta_data ->> 'team_invite_token'
    for update;

    if not found then
      raise exception 'User accounts must be created through the authenticated team invitation flow.'
        using errcode = '42501';
    end if;

    insert into public.profiles (
      id, organization_id, branch_id, full_name, email, role
    )
    values (
      new.id,
      pending_invite.organization_id,
      pending_invite.branch_id,
      pending_invite.full_name,
      lower(trim(new.email)),
      pending_invite.role
    );

    delete from public.team_invites where email = pending_invite.email;
    return new;
  end if;

  new_full_name := coalesce(
    nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''),
    split_part(new.email, '@', 1)
  );

  insert into public.organizations (name)
  values (
    coalesce(
      nullif(trim(new.raw_user_meta_data ->> 'organization_name'), ''),
      'My organization'
    )
  )
  returning id into new_organization_id;

  insert into public.branches (organization_id, name)
  values (
    new_organization_id,
    coalesce(
      nullif(trim(new.raw_user_meta_data ->> 'branch_name'), ''),
      'Main branch'
    )
  )
  returning id into new_branch_id;

  insert into public.profiles (
    id, organization_id, branch_id, full_name, email, role
  )
  values (
    new.id, new_organization_id, new_branch_id, new_full_name, new.email, 'admin'
  );

  return new;
end;
$$;

create or replace function public.list_customer_signup_organizations()
returns table (id uuid, name text, currency text)
language sql
stable
security definer
set search_path = ''
as $$
  select o.id, o.name, o.currency
  from public.organizations o
  order by o.name
$$;

revoke all on function public.list_customer_signup_organizations() from public;
grant execute on function public.list_customer_signup_organizations() to anon, authenticated;

create or replace function public.current_customer_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select c.id
  from public.customers c
  where c.auth_user_id = (select auth.uid())
$$;

create or replace function public.current_customer_organization_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select c.organization_id
  from public.customers c
  where c.auth_user_id = (select auth.uid())
$$;

revoke all on function public.current_customer_id() from public;
revoke all on function public.current_customer_organization_id() from public;
grant execute on function public.current_customer_id() to authenticated;
grant execute on function public.current_customer_organization_id() to authenticated;

drop policy if exists "members can read accessible branches" on public.branches;
create policy "members and store customers can read their branches"
  on public.branches for select to authenticated
  using (
    (
      organization_id = (select public.current_organization_id())
      and (
        (select public.current_user_role()) = 'admin'
        or id = (select branch_id from public.profiles where id = (select auth.uid()))
      )
    )
    or organization_id = (select public.current_customer_organization_id())
  );

drop policy if exists "members can read their organization" on public.organizations;
create policy "members and store customers can read their organization"
  on public.organizations for select to authenticated
  using (
    id = (select public.current_organization_id())
    or id = (select public.current_customer_organization_id())
  );

drop policy if exists "members can read organization products" on public.products;
create policy "members and store customers can read organization products"
  on public.products for select to authenticated
  using (
    organization_id = (select public.current_organization_id())
    or organization_id = (select public.current_customer_organization_id())
  );

drop policy if exists "members can read accessible inventory" on public.inventory;
create policy "members and store customers can read accessible inventory"
  on public.inventory for select to authenticated
  using (
    (
      organization_id = (select public.current_organization_id())
      and (select public.can_access_branch(branch_id))
    )
    or organization_id = (select public.current_customer_organization_id())
  );

drop policy if exists "members can read accessible customers" on public.customers;
create policy "members can read accessible customers"
  on public.customers for select to authenticated
  using (
    auth_user_id = (select auth.uid())
    or (
      organization_id = (select public.current_organization_id())
      and (branch_id is null or (select public.can_access_branch(branch_id)))
    )
  );

create policy "customers can update their own contact details"
  on public.customers for update to authenticated
  using (
    auth_user_id = (select auth.uid())
    and id = (select public.current_customer_id())
    and organization_id = (select public.current_customer_organization_id())
  )
  with check (
    auth_user_id = (select auth.uid())
    and id = (select public.current_customer_id())
    and organization_id = (select public.current_customer_organization_id())
  );

revoke update on public.customers from authenticated;
grant update (name, email, phone, address, notes, branch_id)
  on public.customers to authenticated;

drop policy if exists "members can read accessible sales" on public.sales;
create policy "members and customers can read accessible sales"
  on public.sales for select to authenticated
  using (
    (
      organization_id = (select public.current_organization_id())
      and (select public.can_access_branch(branch_id))
    )
    or customer_id = (select public.current_customer_id())
  );

drop policy if exists "members can read accessible sale items" on public.sale_items;
create policy "members and customers can read accessible sale items"
  on public.sale_items for select to authenticated
  using (
    (
      organization_id = (select public.current_organization_id())
      and exists (
        select 1 from public.sales s
        where s.id = sale_id
          and (select public.can_access_branch(s.branch_id))
      )
    )
    or exists (
      select 1 from public.sales s
      where s.id = sale_id
        and s.customer_id = (select public.current_customer_id())
    )
  );

alter table public.customer_orders enable row level security;
alter table public.customer_order_items enable row level security;

create policy "customers and branch staff can read customer orders"
  on public.customer_orders for select to authenticated
  using (
    customer_id = (select public.current_customer_id())
    or (
      organization_id = (select public.current_organization_id())
      and (select public.can_access_branch(branch_id))
    )
  );

create policy "customers and branch staff can read customer order items"
  on public.customer_order_items for select to authenticated
  using (
    exists (
      select 1 from public.customer_orders o
      where o.id = order_id
        and (
          o.customer_id = (select public.current_customer_id())
          or (
            o.organization_id = (select public.current_organization_id())
            and (select public.can_access_branch(o.branch_id))
          )
        )
    )
  );

grant select on public.customer_orders, public.customer_order_items to authenticated;
revoke all on public.customer_orders, public.customer_order_items from anon;

drop function if exists public.create_sale(uuid, jsonb, text, text);

create function public.create_sale(
  p_branch_id uuid,
  p_items jsonb,
  p_payment_method text,
  p_customer_name text default 'Walk-in customer',
  p_customer_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor public.profiles%rowtype;
  product_row public.products%rowtype;
  inventory_row public.inventory%rowtype;
  customer_row public.customers%rowtype;
  sale_id uuid;
  receipt text;
  item jsonb;
  item_product_id uuid;
  item_quantity integer;
  item_subtotal numeric(12, 2);
  item_cost numeric(12, 2);
  sale_subtotal numeric(12, 2) := 0;
  sale_cost numeric(12, 2) := 0;
  tax_rate numeric(5, 4);
  sale_tax numeric(12, 2);
begin
  select * into actor
  from public.profiles
  where id = (select auth.uid());

  if actor.id is null or actor.role not in ('admin', 'manager', 'cashier')
    or (actor.role <> 'admin' and actor.branch_id <> p_branch_id) then
    raise exception 'You do not have permission to sell at this branch' using errcode = '42501';
  end if;
  if p_payment_method not in ('cash', 'card', 'mobile') then
    raise exception 'Unsupported payment method' using errcode = '22023';
  end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'A sale must contain at least one product' using errcode = '22023';
  end if;

  if p_customer_id is not null then
    select * into customer_row
    from public.customers
    where id = p_customer_id
      and organization_id = actor.organization_id
      and (branch_id is null or branch_id = p_branch_id);
    if customer_row.id is null then
      raise exception 'Customer not found for this branch' using errcode = 'P0002';
    end if;
  end if;

  select o.tax_rate into tax_rate
  from public.organizations o
  where o.id = actor.organization_id;

  for item in select value from jsonb_array_elements(p_items)
  loop
    item_product_id := (item ->> 'product_id')::uuid;
    item_quantity := (item ->> 'quantity')::integer;
    if item_quantity is null or item_quantity < 1 then
      raise exception 'Product quantity must be positive' using errcode = '22023';
    end if;

    select * into product_row
    from public.products
    where id = item_product_id
      and organization_id = actor.organization_id
      and active;
    if product_row.id is null then
      raise exception 'Product not found or inactive' using errcode = 'P0002';
    end if;

    select * into inventory_row
    from public.inventory
    where branch_id = p_branch_id and product_id = item_product_id
    for update;
    if inventory_row.id is null or inventory_row.quantity < item_quantity then
      raise exception 'Insufficient stock for %', product_row.name using errcode = 'P0001';
    end if;

    item_subtotal := product_row.price * item_quantity;
    item_cost := product_row.cost * item_quantity;
    sale_subtotal := sale_subtotal + item_subtotal;
    sale_cost := sale_cost + item_cost;
  end loop;

  sale_tax := round(sale_subtotal * tax_rate, 2);
  sale_id := gen_random_uuid();
  receipt := 'R-' || to_char(now() at time zone 'UTC', 'YYYYMMDD') || '-' || upper(substr(replace(sale_id::text, '-', ''), 1, 8));

  insert into public.sales (
    id, organization_id, branch_id, cashier_id, customer_id, receipt_number, customer_name,
    payment_method, subtotal, tax, total, cost_total
  ) values (
    sale_id, actor.organization_id, p_branch_id, actor.id, p_customer_id, receipt,
    coalesce(nullif(trim(p_customer_name), ''), customer_row.name, 'Walk-in customer'),
    p_payment_method, sale_subtotal, sale_tax, sale_subtotal + sale_tax, sale_cost
  );

  for item in select value from jsonb_array_elements(p_items)
  loop
    item_product_id := (item ->> 'product_id')::uuid;
    item_quantity := (item ->> 'quantity')::integer;
    select * into product_row from public.products where id = item_product_id;

    update public.inventory
      set quantity = quantity - item_quantity, updated_at = now()
      where branch_id = p_branch_id and product_id = item_product_id;

    insert into public.sale_items (
      organization_id, sale_id, product_id, quantity, unit_price, unit_cost, line_total
    ) values (
      actor.organization_id, sale_id, product_row.id, item_quantity,
      product_row.price, product_row.cost, product_row.price * item_quantity
    );

    insert into public.stock_movements (
      organization_id, branch_id, product_id, actor_id, movement_type, quantity_delta, reference_id
    ) values (
      actor.organization_id, p_branch_id, product_row.id, actor.id, 'sale', -item_quantity, sale_id
    );
  end loop;

  return sale_id;
end;
$$;

revoke all on function public.create_sale(uuid, jsonb, text, text, uuid) from public;
grant execute on function public.create_sale(uuid, jsonb, text, text, uuid) to authenticated;

create or replace function public.create_customer_order(
  p_branch_id uuid,
  p_items jsonb,
  p_note text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  customer_row public.customers%rowtype;
  branch_row public.branches%rowtype;
  product_row public.products%rowtype;
  inventory_quantity integer;
  new_order_id uuid;
  item jsonb;
  order_product_id uuid;
  item_quantity integer;
  normalized_items jsonb;
  subtotal numeric(12, 2) := 0;
  tax_rate numeric(5, 4);
  tax_amount numeric(12, 2);
begin
  select * into customer_row
  from public.customers
  where auth_user_id = (select auth.uid());
  if customer_row.id is null then
    raise exception 'Customer account not found' using errcode = '42501';
  end if;

  select * into branch_row
  from public.branches
  where id = p_branch_id
    and organization_id = customer_row.organization_id
    and active;
  if branch_row.id is null then
    raise exception 'Choose an active branch for your order' using errcode = '22023';
  end if;
  if jsonb_typeof(p_items) <> 'array'
    or jsonb_array_length(p_items) < 1
    or jsonb_array_length(p_items) > 50 then
    raise exception 'Choose between 1 and 50 order items' using errcode = '22023';
  end if;
  if p_note is not null and length(trim(p_note)) > 500 then
    raise exception 'Order note cannot exceed 500 characters' using errcode = '22023';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_items) as requested(product_id uuid, quantity integer)
    where product_id is null or quantity is null or quantity < 1 or quantity > 99
  ) then
    raise exception 'Order quantities must be between 1 and 99' using errcode = '22023';
  end if;

  select jsonb_agg(jsonb_build_object('product_id', requested.product_id, 'quantity', requested.quantity))
    into normalized_items
  from (
    select product_id, sum(quantity)::integer as quantity
    from jsonb_to_recordset(p_items) as requested(product_id uuid, quantity integer)
    group by product_id
  ) requested;
  if exists (
    select 1
    from jsonb_to_recordset(normalized_items) as requested(product_id uuid, quantity integer)
    where quantity > 99
  ) then
    raise exception 'Order quantities must be between 1 and 99' using errcode = '22023';
  end if;

  for item in select value from jsonb_array_elements(normalized_items)
  loop
    order_product_id := (item ->> 'product_id')::uuid;
    item_quantity := (item ->> 'quantity')::integer;

    select * into product_row
    from public.products
    where id = order_product_id
      and organization_id = customer_row.organization_id
      and active;
    if product_row.id is null then
      raise exception 'A selected product is no longer available' using errcode = 'P0002';
    end if;
    select quantity into inventory_quantity
    from public.inventory
    where branch_id = p_branch_id and inventory.product_id = order_product_id;
    if coalesce(inventory_quantity, 0) < item_quantity then
      raise exception 'A selected item has insufficient available stock' using errcode = 'P0001';
    end if;
    subtotal := subtotal + product_row.price * item_quantity;
  end loop;

  select o.tax_rate into tax_rate
  from public.organizations o
  where o.id = customer_row.organization_id;
  tax_amount := round(subtotal * tax_rate, 2);

  insert into public.customer_orders (
    organization_id, customer_id, branch_id, note, subtotal, tax, total
  ) values (
    customer_row.organization_id, customer_row.id, p_branch_id,
    nullif(trim(p_note), ''), subtotal, tax_amount, subtotal + tax_amount
  ) returning id into new_order_id;

  for item in select value from jsonb_array_elements(normalized_items)
  loop
    order_product_id := (item ->> 'product_id')::uuid;
    item_quantity := (item ->> 'quantity')::integer;
    select * into product_row from public.products where id = order_product_id;
    insert into public.customer_order_items (
      organization_id, order_id, product_id, product_name, quantity, unit_price, line_total
    ) values (
      customer_row.organization_id, new_order_id, product_row.id, product_row.name,
      item_quantity, product_row.price, product_row.price * item_quantity
    );
  end loop;

  return new_order_id;
end;
$$;

create or replace function public.update_customer_order_status(
  p_order_id uuid,
  p_status text,
  p_payment_method text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor public.profiles%rowtype;
  order_row public.customer_orders%rowtype;
  order_items jsonb;
  customer_name text;
  new_sale_id uuid;
begin
  select * into actor
  from public.profiles
  where id = (select auth.uid());
  if actor.id is null
    or actor.role not in ('admin', 'manager', 'cashier')
    or not public.can_access_branch((
      select o.branch_id from public.customer_orders o where o.id = p_order_id
    )) then
    raise exception 'You do not have permission to manage this branch order'
      using errcode = '42501';
  end if;

  select * into order_row
  from public.customer_orders
  where id = p_order_id
    and organization_id = actor.organization_id
  for update;
  if order_row.id is null then
    raise exception 'Order not found' using errcode = 'P0002';
  end if;

  if p_status not in ('confirmed', 'ready', 'completed', 'cancelled') then
    raise exception 'Choose a valid order status' using errcode = '22023';
  end if;
  if not (
    (order_row.status = 'pending' and p_status in ('confirmed', 'cancelled'))
    or (order_row.status = 'confirmed' and p_status in ('ready', 'cancelled'))
    or (order_row.status = 'ready' and p_status in ('completed', 'cancelled'))
  ) then
    raise exception 'This order cannot move from % to %', order_row.status, p_status
      using errcode = '22023';
  end if;

  if p_status = 'completed' then
    if p_payment_method not in ('cash', 'card', 'mobile') then
      raise exception 'Choose a payment method before completing the order'
        using errcode = '22023';
    end if;
    select c.name into customer_name
    from public.customers c
    where c.id = order_row.customer_id;
    select coalesce(
      jsonb_agg(jsonb_build_object('product_id', i.product_id, 'quantity', i.quantity)),
      '[]'::jsonb
    ) into order_items
    from public.customer_order_items i
    where i.order_id = order_row.id;
    new_sale_id := public.create_sale(
      order_row.branch_id, order_items, p_payment_method, customer_name, order_row.customer_id
    );
    update public.customer_orders
    set status = p_status, sales_id = new_sale_id, updated_at = now()
    where id = order_row.id;
  else
    update public.customer_orders
    set status = p_status, updated_at = now()
    where id = order_row.id;
  end if;

  return order_row.id;
end;
$$;

revoke all on function public.create_customer_order(uuid, jsonb, text) from public;
revoke all on function public.update_customer_order_status(uuid, text, text) from public;
grant execute on function public.create_customer_order(uuid, jsonb, text) to authenticated;
grant execute on function public.update_customer_order_status(uuid, text, text) to authenticated;
