-- User ban state and search activity history.

alter table public.profiles
  add column if not exists is_blocked boolean not null default false;

create or replace function public.protect_privileged_profile_fields()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
begin
  if tg_op = 'UPDATE'
     and (
       old.role is distinct from new.role
       or old.credits is distinct from new.credits
       or old.is_blocked is distinct from new.is_blocked
     )
     and coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Changing role, credits, or block status is not allowed';
  end if;
  return new;
end;
$$;

create table if not exists public.search_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  city text not null check (char_length(trim(city)) between 1 and 100),
  searched_at timestamptz not null default now()
);

create index if not exists search_logs_searched_at_idx
  on public.search_logs (searched_at desc);

create index if not exists search_logs_user_id_idx
  on public.search_logs (user_id);

alter table public.search_logs enable row level security;

-- Authenticated users may only read their own history.
drop policy if exists "Users can read their own search logs" on public.search_logs;
create policy "Users can read their own search logs"
  on public.search_logs
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

-- Inserts/updates/deletes go through the service role from the app server.
-- No insert/update/delete policies for authenticated clients.

create or replace function public.set_user_blocked(p_user_id uuid, p_blocked boolean)
returns public.profiles
language plpgsql
security definer set search_path = ''
as $$
declare
  updated public.profiles;
begin
  update public.profiles
  set is_blocked = coalesce(p_blocked, false)
  where id = p_user_id
  returning * into updated;

  if updated.id is null then
    raise exception 'User not found';
  end if;

  return updated;
end;
$$;

revoke all on function public.set_user_blocked(uuid, boolean) from public;
grant execute on function public.set_user_blocked(uuid, boolean) to service_role;
