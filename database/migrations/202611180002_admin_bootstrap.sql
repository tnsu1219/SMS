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
begin
  perform pg_catalog.pg_advisory_xact_lock(487392105);

  if exists (select 1 from public.profiles limit 1) then
    raise exception 'Initial administrator setup is already complete'
      using errcode = '42501';
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

create or replace function public.admin_setup_available()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select not exists (select 1 from public.profiles limit 1)
$$;

revoke all on function public.admin_setup_available() from public;
grant execute on function public.admin_setup_available() to anon, authenticated;
