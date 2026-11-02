-- Email login (alternative to mobile OTP while SMS is not active).
-- The email-otp Edge Function creates the account and mails a 6-digit code through the society Gmail;
-- the app verifies it with Supabase Auth. Email-login residents type their mobile number (not verified),
-- kept in profiles.mobile.

alter table public.profiles add column if not exists mobile text;
alter table public.profiles add constraint profiles_mobile_check check (mobile is null or mobile ~ '^[6-9][0-9]{9}$');

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare sa text;
begin
  insert into public.profiles(id, phone, email) values (new.id, new.phone, lower(nullif(new.email, ''))) on conflict (id) do nothing;
  select value #>> '{}' into sa from public.app_settings where key = 'super_admin_phone';
  if sa is not null and new.phone = sa and not exists (select 1 from public.staff where role = 'super_admin') then
    insert into public.staff(user_id, role) values (new.id, 'super_admin');
  end if;
  return new;
end $$;

-- rate limiting for login emails (written only by the Edge Function with the service key)
create table if not exists public.login_email_log (
  id    bigint generated always as identity primary key,
  email text not null,
  ip    text,
  at    timestamptz not null default now()
);
create index if not exists login_email_log_idx on public.login_email_log (email, at desc);
alter table public.login_email_log enable row level security;   -- no policies: not readable through the API

-- a committee desk booking is linked to the resident's account when flat + mobile match
-- (the booking function already matches the verified phone; this also matches the typed mobile of email-login residents)
create or replace function public.link_desk_booking() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.user_id is null then
    select p.id into new.user_id from public.profiles p
     where p.block = new.block and p.flat_no = new.flat_no
       and (right(p.phone, 10) = right(new.mobile, 10) or p.mobile = right(new.mobile, 10))
     order by p.created_at limit 1;
  end if;
  return new;
end $$;
revoke execute on function public.link_desk_booking() from public, anon, authenticated;
create trigger bookings_link_desk before insert on public.bookings for each row execute function public.link_desk_booking();
