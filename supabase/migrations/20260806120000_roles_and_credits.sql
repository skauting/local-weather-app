-- Roles and starting credits for registered users.

alter table public.profiles
  add column if not exists role text not null default 'user'
    check (role in ('user', 'admin')),
  add column if not exists credits integer not null default 5
    check (credits >= 0);

-- Existing rows get the defaults above; new signups also start with 5 credits.
update public.profiles
set
  role = coalesce(role, 'user'),
  credits = coalesce(credits, 5)
where role is null or credits is null;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
begin
  insert into public.profiles (
    id,
    first_name,
    last_name,
    email,
    phone,
    country_code,
    role,
    credits
  )
  values (
    new.id,
    trim(new.raw_user_meta_data ->> 'first_name'),
    trim(new.raw_user_meta_data ->> 'last_name'),
    lower(new.email),
    trim(new.raw_user_meta_data ->> 'phone'),
    upper(new.raw_user_meta_data ->> 'country_code'),
    'user',
    5
  );

  return new;
end;
$$;

-- Users must not change their own role or credits through the client.
drop policy if exists "Users can update their own profile" on public.profiles;

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
     )
     and coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Changing role or credits is not allowed';
  end if;
  return new;
end;
$$;

drop trigger if exists protect_privileged_profile_fields on public.profiles;

create trigger protect_privileged_profile_fields
  before update on public.profiles
  for each row execute procedure public.protect_privileged_profile_fields();

-- Atomically spend one credit; returns remaining credits, or -1 when none left.
create or replace function public.consume_credit(p_user_id uuid)
returns integer
language plpgsql
security definer set search_path = ''
as $$
declare
  remaining integer;
begin
  update public.profiles
  set credits = credits - 1
  where id = p_user_id
    and credits > 0
  returning credits into remaining;

  if remaining is null then
    return -1;
  end if;

  return remaining;
end;
$$;

revoke all on function public.consume_credit(uuid) from public;
grant execute on function public.consume_credit(uuid) to service_role;

-- Atomically add credits; returns the new balance.
create or replace function public.add_credits(p_user_id uuid, p_amount integer)
returns integer
language plpgsql
security definer set search_path = ''
as $$
declare
  remaining integer;
begin
  if p_amount is null or p_amount < 1 or p_amount > 100000 then
    raise exception 'Invalid credit amount';
  end if;

  update public.profiles
  set credits = credits + p_amount
  where id = p_user_id
  returning credits into remaining;

  if remaining is null then
    raise exception 'User not found';
  end if;

  return remaining;
end;
$$;

revoke all on function public.add_credits(uuid, integer) from public;
grant execute on function public.add_credits(uuid, integer) to service_role;
