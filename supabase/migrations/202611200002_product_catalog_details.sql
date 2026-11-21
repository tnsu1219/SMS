create or replace function public.create_product_with_details(
  p_branch_id uuid,
  p_sku text,
  p_name text,
  p_category text,
  p_price numeric,
  p_cost numeric,
  p_initial_quantity integer,
  p_reorder_level integer,
  p_brand text default null,
  p_model text default null,
  p_color text default null,
  p_storage_gb integer default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor public.profiles%rowtype;
  new_product_id uuid;
  new_sku text;
begin
  select * into actor from public.profiles where id = (select auth.uid());
  if actor.id is null or actor.role not in ('admin', 'manager') then
    raise exception 'You do not have permission to add products' using errcode = '42501';
  end if;
  if not public.can_access_branch(p_branch_id) then
    raise exception 'You do not have permission to manage this branch' using errcode = '42501';
  end if;
  if p_initial_quantity is null or p_initial_quantity < 0
    or p_reorder_level is null or p_reorder_level < 0 then
    raise exception 'Stock values cannot be negative' using errcode = '22023';
  end if;
  if p_price is null or p_price <= 0 or p_cost is null or p_cost < 0 then
    raise exception 'Selling price must be greater than zero and cost cannot be negative' using errcode = '22023';
  end if;
  if p_storage_gb is not null and p_storage_gb <= 0 then
    raise exception 'Storage must be greater than zero' using errcode = '22023';
  end if;
  if nullif(trim(p_name), '') is null or length(trim(p_name)) > 160 then
    raise exception 'Product name is required and must be no more than 160 characters' using errcode = '22023';
  end if;

  new_sku := coalesce(
    nullif(trim(p_sku), ''),
    'AUTO-' || upper(replace(pg_catalog.gen_random_uuid()::text, '-', ''))
  );
  if length(new_sku) > 80 then
    raise exception 'SKU must be no more than 80 characters' using errcode = '22023';
  end if;

  insert into public.products (
    organization_id, sku, name, category, price, cost, created_by,
    brand, model, color, storage_gb
  ) values (
    actor.organization_id, new_sku, trim(p_name),
    coalesce(nullif(trim(p_category), ''), 'General'),
    p_price, p_cost, actor.id,
    nullif(trim(p_brand), ''),
    nullif(trim(p_model), ''),
    nullif(trim(p_color), ''),
    p_storage_gb
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

revoke all on function public.create_product_with_details(
  uuid, text, text, text, numeric, numeric, integer, integer, text, text, text, integer
) from public;
grant execute on function public.create_product_with_details(
  uuid, text, text, text, numeric, numeric, integer, integer, text, text, text, integer
) to authenticated;
