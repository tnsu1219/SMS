create extension if not exists pgcrypto with schema extensions;

create table if not exists public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) between 1 and 120),
  tax_rate numeric(5, 4) not null default 0.0800 check (tax_rate between 0 and 1),
  currency text not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  created_at timestamptz not null default now()
);

create table if not exists public.branches (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 120),
  address text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (organization_id, id)
);

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid,
  full_name text not null default '',
  email text not null,
  role text not null default 'admin' check (role in ('admin', 'manager', 'cashier')),
  created_at timestamptz not null default now(),
  foreign key (organization_id, branch_id) references public.branches(organization_id, id)
);

alter table public.profiles
  add column if not exists organization_id uuid,
  add column if not exists branch_id uuid,
  add column if not exists full_name text not null default '',
  add column if not exists email text not null default '',
  add column if not exists role text not null default 'cashier';

update public.profiles p
set email = coalesce(nullif(p.email, ''), u.email, ''),
    full_name = coalesce(
      nullif(p.full_name, ''),
      nullif(u.raw_user_meta_data ->> 'full_name', ''),
      split_part(coalesce(u.email, p.email, ''), '@', 1),
      ''
    ),
    role = coalesce(nullif(p.role, ''), 'cashier')
from auth.users u
where u.id = p.id
  and (
    coalesce(p.email, '') = ''
    or coalesce(p.full_name, '') = ''
    or coalesce(p.role, '') = ''
  );

update public.profiles
set email = coalesce(email, ''),
    full_name = coalesce(full_name, ''),
    role = coalesce(nullif(role, ''), 'cashier');

alter table public.profiles
  alter column full_name set default '',
  alter column full_name set not null,
  alter column email set default '',
  alter column email set not null,
  alter column role set default 'admin',
  alter column role set not null;

do $$
declare
  existing_profile record;
  new_organization_id uuid;
  new_branch_id uuid;
begin
  for existing_profile in
    select id, organization_id, branch_id, full_name, email
    from public.profiles
  loop
    if existing_profile.organization_id is null
      or not exists (
        select 1
        from public.organizations o
        where o.id = existing_profile.organization_id
      )
    then
      insert into public.organizations (name)
      values (
        coalesce(
          nullif(trim(existing_profile.full_name), ''),
          nullif(split_part(existing_profile.email, '@', 1), ''),
          'My organization'
        )
      )
      returning id into new_organization_id;

      update public.profiles
      set organization_id = new_organization_id
      where id = existing_profile.id;

      existing_profile.organization_id := new_organization_id;
    end if;

    if existing_profile.branch_id is null
      or not exists (
        select 1
        from public.branches b
        where b.id = existing_profile.branch_id
          and b.organization_id = existing_profile.organization_id
      )
    then
      insert into public.branches (organization_id, name)
      values (existing_profile.organization_id, 'Main branch')
      returning id into new_branch_id;

      update public.profiles
      set branch_id = new_branch_id
      where id = existing_profile.id;
    end if;
  end loop;
end;
$$;

alter table public.profiles
  alter column organization_id set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.profiles'::regclass
      and conname = 'profiles_organization_id_fkey'
  ) then
    alter table public.profiles
      add constraint profiles_organization_id_fkey
      foreign key (organization_id) references public.organizations(id) on delete cascade;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.profiles'::regclass
      and conname = 'profiles_organization_id_branch_id_fkey'
  ) then
    alter table public.profiles
      add constraint profiles_organization_id_branch_id_fkey
      foreign key (organization_id, branch_id)
      references public.branches(organization_id, id);
  end if;
end;
$$;

create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  sku text not null check (length(trim(sku)) between 1 and 80),
  name text not null check (length(trim(name)) between 1 and 160),
  category text not null default 'General',
  price numeric(12, 2) not null check (price >= 0),
  cost numeric(12, 2) not null default 0 check (cost >= 0),
  active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (organization_id, sku),
  unique (organization_id, id)
);

create table if not exists public.inventory (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null,
  product_id uuid not null,
  quantity integer not null default 0 check (quantity >= 0),
  reorder_level integer not null default 15 check (reorder_level >= 0),
  updated_at timestamptz not null default now(),
  unique (branch_id, product_id),
  foreign key (organization_id, branch_id) references public.branches(organization_id, id) on delete cascade,
  foreign key (organization_id, product_id) references public.products(organization_id, id) on delete cascade
);

create table if not exists public.sales (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null,
  cashier_id uuid references public.profiles(id) on delete set null,
  receipt_number text not null,
  customer_name text not null default 'Walk-in customer',
  payment_method text not null check (payment_method in ('cash', 'card', 'mobile')),
  subtotal numeric(12, 2) not null check (subtotal >= 0),
  tax numeric(12, 2) not null check (tax >= 0),
  total numeric(12, 2) not null check (total >= 0),
  cost_total numeric(12, 2) not null check (cost_total >= 0),
  status text not null default 'completed' check (status in ('completed', 'voided', 'refunded')),
  created_at timestamptz not null default now(),
  unique (organization_id, receipt_number),
  foreign key (organization_id, branch_id) references public.branches(organization_id, id)
);

create table if not exists public.sale_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  sale_id uuid not null references public.sales(id) on delete cascade,
  product_id uuid not null references public.products(id),
  quantity integer not null check (quantity > 0),
  unit_price numeric(12, 2) not null check (unit_price >= 0),
  unit_cost numeric(12, 2) not null check (unit_cost >= 0),
  line_total numeric(12, 2) not null check (line_total >= 0)
);

create table if not exists public.expenses (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null,
  created_by uuid not null references public.profiles(id),
  title text not null check (length(trim(title)) between 1 and 160),
  category text not null default 'General',
  amount numeric(12, 2) not null check (amount > 0),
  incurred_on date not null default current_date,
  created_at timestamptz not null default now(),
  foreign key (organization_id, branch_id) references public.branches(organization_id, id)
);

create table if not exists public.stock_movements (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null,
  product_id uuid not null,
  actor_id uuid references public.profiles(id) on delete set null,
  movement_type text not null check (movement_type in ('sale', 'restock', 'adjustment', 'transfer_in', 'transfer_out')),
  quantity_delta integer not null check (quantity_delta <> 0),
  reference_id uuid,
  created_at timestamptz not null default now(),
  foreign key (organization_id, branch_id) references public.branches(organization_id, id),
  foreign key (organization_id, product_id) references public.products(organization_id, id)
);

create index if not exists inventory_branch_idx on public.inventory (branch_id, product_id);
create index if not exists sales_branch_created_idx on public.sales (branch_id, created_at desc);
create index if not exists expenses_branch_date_idx on public.expenses (branch_id, incurred_on desc);
create index if not exists stock_movements_branch_created_idx on public.stock_movements (branch_id, created_at desc);

create or replace function public.current_organization_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select p.organization_id
  from public.profiles p
  where p.id = (select auth.uid())
$$;

create or replace function public.current_user_role()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select p.role
  from public.profiles p
  where p.id = (select auth.uid())
$$;

create or replace function public.can_access_branch(target_branch_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles p
    join public.branches b on b.id = target_branch_id
      and b.organization_id = p.organization_id
      and b.active
    where p.id = (select auth.uid())
      and (p.role = 'admin' or p.branch_id = target_branch_id)
  )
$$;

revoke all on function public.current_organization_id() from public;
revoke all on function public.current_user_role() from public;
revoke all on function public.can_access_branch(uuid) from public;
grant execute on function public.current_organization_id() to authenticated;
grant execute on function public.current_user_role() to authenticated;
grant execute on function public.can_access_branch(uuid) to authenticated;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_organization_id uuid;
  new_branch_id uuid;
  new_organization_name text;
  new_branch_name text;
  new_full_name text;
begin
  new_organization_name := coalesce(nullif(trim(new.raw_user_meta_data ->> 'organization_name'), ''), 'My organization');
  new_branch_name := coalesce(nullif(trim(new.raw_user_meta_data ->> 'branch_name'), ''), 'Main branch');
  new_full_name := coalesce(nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''), split_part(new.email, '@', 1));

  insert into public.organizations (name)
  values (new_organization_name)
  returning id into new_organization_id;

  insert into public.branches (organization_id, name)
  values (new_organization_id, new_branch_name)
  returning id into new_branch_id;

  insert into public.profiles (id, organization_id, branch_id, full_name, email, role)
  values (new.id, new_organization_id, new_branch_id, new_full_name, new.email, 'admin');

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

create or replace function public.initialize_branch_inventory()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.inventory (organization_id, branch_id, product_id)
  select new.organization_id, new.id, p.id
  from public.products p
  where p.organization_id = new.organization_id and p.active
  on conflict (branch_id, product_id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_branch_created on public.branches;
create trigger on_branch_created
  after insert on public.branches
  for each row execute procedure public.initialize_branch_inventory();

create or replace function public.create_product(
  p_branch_id uuid,
  p_sku text,
  p_name text,
  p_category text,
  p_price numeric,
  p_cost numeric,
  p_initial_quantity integer,
  p_reorder_level integer default 15
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor public.profiles%rowtype;
  new_product_id uuid;
begin
  select * into actor from public.profiles where id = (select auth.uid());
  if actor.id is null or actor.role not in ('admin', 'manager') then
    raise exception 'You do not have permission to add products' using errcode = '42501';
  end if;
  if not public.can_access_branch(p_branch_id) then
    raise exception 'You do not have permission to manage this branch' using errcode = '42501';
  end if;
  if p_initial_quantity < 0 or p_reorder_level < 0 then
    raise exception 'Stock values cannot be negative' using errcode = '22023';
  end if;

  insert into public.products (
    organization_id, sku, name, category, price, cost, created_by
  ) values (
    actor.organization_id, trim(p_sku), trim(p_name), coalesce(nullif(trim(p_category), ''), 'General'),
    p_price, p_cost, actor.id
  ) returning id into new_product_id;

  insert into public.inventory (organization_id, branch_id, product_id, quantity, reorder_level)
  select b.organization_id, b.id, new_product_id,
    case when b.id = p_branch_id then p_initial_quantity else 0 end,
    p_reorder_level
  from public.branches b
  where b.organization_id = actor.organization_id and b.active;

  if p_initial_quantity > 0 then
    insert into public.stock_movements (
      organization_id, branch_id, product_id, actor_id, movement_type, quantity_delta
    ) values (
      actor.organization_id, p_branch_id, new_product_id, actor.id, 'restock', p_initial_quantity
    );
  end if;

  return new_product_id;
end;
$$;

revoke all on function public.create_product(uuid, text, text, text, numeric, numeric, integer, integer) from public;
grant execute on function public.create_product(uuid, text, text, text, numeric, numeric, integer, integer) to authenticated;

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
  if actor.id is null or actor.role not in ('admin', 'manager') then
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

revoke all on function public.adjust_stock(uuid, uuid, integer, integer) from public;
grant execute on function public.adjust_stock(uuid, uuid, integer, integer) to authenticated;

create or replace function public.create_sale(
  p_branch_id uuid,
  p_items jsonb,
  p_payment_method text,
  p_customer_name text default 'Walk-in customer'
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

  if actor.id is null or (actor.role <> 'admin' and actor.branch_id <> p_branch_id) then
    raise exception 'You do not have permission to sell at this branch' using errcode = '42501';
  end if;
  if p_payment_method not in ('cash', 'card', 'mobile') then
    raise exception 'Unsupported payment method' using errcode = '22023';
  end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'A sale must contain at least one product' using errcode = '22023';
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
    id, organization_id, branch_id, cashier_id, receipt_number, customer_name,
    payment_method, subtotal, tax, total, cost_total
  ) values (
    sale_id, actor.organization_id, p_branch_id, actor.id, receipt,
    coalesce(nullif(trim(p_customer_name), ''), 'Walk-in customer'),
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

revoke all on function public.create_sale(uuid, jsonb, text, text) from public;
grant execute on function public.create_sale(uuid, jsonb, text, text) to authenticated;

create or replace function public.get_dashboard_summary(
  p_branch_id uuid,
  p_start timestamptz,
  p_end timestamptz
)
returns table (sales_count bigint, revenue numeric, gross_profit numeric, expenses numeric)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.can_access_branch(p_branch_id) then
    raise exception 'You do not have access to this branch' using errcode = '42501';
  end if;

  return query
    select
      (select count(*) from public.sales s
        where s.branch_id = p_branch_id and s.status = 'completed'
          and s.created_at >= p_start and s.created_at < p_end),
      coalesce((select sum(s.total) from public.sales s
        where s.branch_id = p_branch_id and s.status = 'completed'
          and s.created_at >= p_start and s.created_at < p_end), 0),
      coalesce((select sum(s.subtotal - s.cost_total) from public.sales s
        where s.branch_id = p_branch_id and s.status = 'completed'
          and s.created_at >= p_start and s.created_at < p_end), 0),
      coalesce((select sum(e.amount) from public.expenses e
        where e.branch_id = p_branch_id and e.incurred_on >= p_start::date
          and e.incurred_on < p_end::date), 0);
end;
$$;

revoke all on function public.get_dashboard_summary(uuid, timestamptz, timestamptz) from public;
grant execute on function public.get_dashboard_summary(uuid, timestamptz, timestamptz) to authenticated;

alter table public.organizations enable row level security;
alter table public.branches enable row level security;
alter table public.profiles enable row level security;
alter table public.products enable row level security;
alter table public.inventory enable row level security;
alter table public.sales enable row level security;
alter table public.sale_items enable row level security;
alter table public.expenses enable row level security;
alter table public.stock_movements enable row level security;

drop policy if exists "organization members can read their organization" on public.organizations;
create policy "organization members can read their organization"
  on public.organizations for select to authenticated
  using (id = (select public.current_organization_id()));
drop policy if exists "organization admins can update their organization" on public.organizations;
create policy "organization admins can update their organization"
  on public.organizations for update to authenticated
  using (id = (select public.current_organization_id()) and (select public.current_user_role()) = 'admin')
  with check (id = (select public.current_organization_id()));

drop policy if exists "members can read accessible branches" on public.branches;
create policy "members can read accessible branches"
  on public.branches for select to authenticated
  using (organization_id = (select public.current_organization_id())
    and ((select public.current_user_role()) = 'admin' or id = (select branch_id from public.profiles where id = (select auth.uid()))));
drop policy if exists "admins can add branches" on public.branches;
create policy "admins can add branches"
  on public.branches for insert to authenticated
  with check (organization_id = (select public.current_organization_id()) and (select public.current_user_role()) = 'admin');
drop policy if exists "admins can update branches" on public.branches;
create policy "admins can update branches"
  on public.branches for update to authenticated
  using (organization_id = (select public.current_organization_id()) and (select public.current_user_role()) = 'admin')
  with check (organization_id = (select public.current_organization_id()));

drop policy if exists "users can read their own profile and admins can read the team" on public.profiles;
create policy "users can read their own profile and admins can read the team"
  on public.profiles for select to authenticated
  using (id = (select auth.uid())
    or (organization_id = (select public.current_organization_id()) and (select public.current_user_role()) = 'admin'));
drop policy if exists "users can update their own display name" on public.profiles;
create policy "users can update their own display name"
  on public.profiles for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

drop policy if exists "members can read organization products" on public.products;
create policy "members can read organization products"
  on public.products for select to authenticated
  using (organization_id = (select public.current_organization_id()));
drop policy if exists "admins and managers can add products" on public.products;
create policy "admins and managers can add products"
  on public.products for insert to authenticated
  with check (organization_id = (select public.current_organization_id())
    and (select public.current_user_role()) in ('admin', 'manager'));
drop policy if exists "admins and managers can update products" on public.products;
create policy "admins and managers can update products"
  on public.products for update to authenticated
  using (organization_id = (select public.current_organization_id())
    and (select public.current_user_role()) in ('admin', 'manager'))
  with check (organization_id = (select public.current_organization_id()));

drop policy if exists "members can read accessible inventory" on public.inventory;
create policy "members can read accessible inventory"
  on public.inventory for select to authenticated
  using (organization_id = (select public.current_organization_id()) and (select public.can_access_branch(branch_id)));
drop policy if exists "admins and managers can add inventory" on public.inventory;
create policy "admins and managers can add inventory"
  on public.inventory for insert to authenticated
  with check (organization_id = (select public.current_organization_id())
    and (select public.current_user_role()) in ('admin', 'manager')
    and (select public.can_access_branch(branch_id)));
drop policy if exists "admins and managers can update inventory" on public.inventory;
create policy "admins and managers can update inventory"
  on public.inventory for update to authenticated
  using (organization_id = (select public.current_organization_id())
    and (select public.current_user_role()) in ('admin', 'manager')
    and (select public.can_access_branch(branch_id)))
  with check (organization_id = (select public.current_organization_id())
    and (select public.can_access_branch(branch_id)));

drop policy if exists "members can read accessible sales" on public.sales;
create policy "members can read accessible sales"
  on public.sales for select to authenticated
  using (organization_id = (select public.current_organization_id()) and (select public.can_access_branch(branch_id)));
drop policy if exists "members can read accessible sale items" on public.sale_items;
create policy "members can read accessible sale items"
  on public.sale_items for select to authenticated
  using (organization_id = (select public.current_organization_id())
    and exists (select 1 from public.sales s where s.id = sale_id and (select public.can_access_branch(s.branch_id))));

drop policy if exists "members can read accessible expenses" on public.expenses;
create policy "members can read accessible expenses"
  on public.expenses for select to authenticated
  using (organization_id = (select public.current_organization_id()) and (select public.can_access_branch(branch_id)));
drop policy if exists "admins and managers can add expenses" on public.expenses;
create policy "admins and managers can add expenses"
  on public.expenses for insert to authenticated
  with check (organization_id = (select public.current_organization_id())
    and created_by = (select auth.uid())
    and (select public.current_user_role()) in ('admin', 'manager')
    and (select public.can_access_branch(branch_id)));
drop policy if exists "admins and managers can update expenses" on public.expenses;
create policy "admins and managers can update expenses"
  on public.expenses for update to authenticated
  using (organization_id = (select public.current_organization_id())
    and (select public.current_user_role()) in ('admin', 'manager')
    and (select public.can_access_branch(branch_id)))
  with check (organization_id = (select public.current_organization_id())
    and (select public.can_access_branch(branch_id)));

drop policy if exists "members can read accessible stock movements" on public.stock_movements;
create policy "members can read accessible stock movements"
  on public.stock_movements for select to authenticated
  using (organization_id = (select public.current_organization_id()) and (select public.can_access_branch(branch_id)));

grant select on public.organizations, public.branches, public.profiles, public.products,
  public.inventory, public.sales, public.sale_items, public.expenses, public.stock_movements
  to authenticated;
grant update on public.organizations, public.branches, public.products, public.expenses to authenticated;
grant update (full_name) on public.profiles to authenticated;
grant insert on public.branches, public.expenses to authenticated;
