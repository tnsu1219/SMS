create table public.team_invites (
  email text primary key check (email = lower(trim(email))),
  invitation_token text not null unique,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid,
  full_name text not null check (length(trim(full_name)) between 1 and 120),
  role text not null check (role in ('admin', 'manager', 'cashier', 'inventory_officer')),
  created_at timestamptz not null default now(),
  foreign key (organization_id, branch_id)
    references public.branches(organization_id, id) on delete cascade
);

alter table public.team_invites enable row level security;
revoke all on public.team_invites from public, anon, authenticated;
grant all on public.team_invites to service_role;

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
begin
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
