alter table public.profiles
  add column if not exists chat_credits integer not null default 3
    check (chat_credits >= 0);

update public.profiles
set chat_credits = coalesce(chat_credits, 3)
where chat_credits is null;

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
    credits,
    chat_credits
  )
  values (
    new.id,
    trim(new.raw_user_meta_data ->> 'first_name'),
    trim(new.raw_user_meta_data ->> 'last_name'),
    lower(new.email),
    trim(new.raw_user_meta_data ->> 'phone'),
    upper(new.raw_user_meta_data ->> 'country_code'),
    'user',
    5,
    3
  );

  return new;
end;
$$;

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
       or old.chat_credits is distinct from new.chat_credits
     )
     and coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Changing role or credits is not allowed';
  end if;
  return new;
end;
$$;

create or replace function public.consume_chat_credit(p_user_id uuid)
returns integer
language plpgsql
security definer set search_path = ''
as $$
declare
  remaining integer;
begin
  update public.profiles
  set chat_credits = chat_credits - 1
  where id = p_user_id
    and chat_credits > 0
  returning chat_credits into remaining;

  if remaining is null then
    return -1;
  end if;

  return remaining;
end;
$$;

revoke all on function public.consume_chat_credit(uuid) from public;
grant execute on function public.consume_chat_credit(uuid) to service_role;

create or replace function public.add_chat_credits(p_user_id uuid, p_amount integer)
returns integer
language plpgsql
security definer set search_path = ''
as $$
declare
  remaining integer;
begin
  if p_amount is null or p_amount < 1 or p_amount > 100000 then
    raise exception 'Invalid chat credit amount';
  end if;

  update public.profiles
  set chat_credits = chat_credits + p_amount
  where id = p_user_id
  returning chat_credits into remaining;

  if remaining is null then
    raise exception 'User not found';
  end if;

  return remaining;
end;
$$;

revoke all on function public.add_chat_credits(uuid, integer) from public;
grant execute on function public.add_chat_credits(uuid, integer) to service_role;
