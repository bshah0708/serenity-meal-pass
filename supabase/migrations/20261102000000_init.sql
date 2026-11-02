-- Serenity Space Meal Pass — database schema
-- Residents log in with mobile number + OTP (Supabase Auth, phone provider).
-- Every table has Row Level Security: a resident sees only their own profile and bookings;
-- committee members (approved by the super admin) see and manage everything.

-- ───────────────────────────── settings ─────────────────────────────
create table if not exists public.app_settings (
  key   text primary key,
  value jsonb not null default 'null'::jsonb,
  updated_at timestamptz not null default now()
);
-- The first person to log in with this mobile number becomes super admin (E.164 without "+").
insert into public.app_settings(key, value) values
  ('super_admin_phone', '"919724212198"'),
  ('desk', '{"place":"Society office","contact":""}'),
  ('upi', '{"enabled":false,"id":"","name":"Serenity Space CHS Ltd"}')
on conflict (key) do nothing;

-- ───────────────────────────── people ─────────────────────────────
create table if not exists public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  phone      text unique,                      -- verified login number, set from auth.users
  name       text check (char_length(name) <= 80),
  block      text check (block in ('A','B','C','D','E','F','G','H','I')),
  flat_no    text check (flat_no ~ '^[0-9]{3,4}$'),
  email      text check (email is null or email ~* '^[^@\s]+@[^@\s]+\.[a-z]{2,}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.staff (
  user_id     uuid primary key references public.profiles(id) on delete cascade,
  role        text not null check (role in ('super_admin','committee')),
  active      boolean not null default true,
  approved_by uuid references public.profiles(id),
  approved_at timestamptz not null default now()
);

create table if not exists public.staff_requests (
  user_id      uuid primary key references public.profiles(id) on delete cascade,
  note         text check (char_length(note) <= 200),
  status       text not null default 'pending' check (status in ('pending','approved','rejected')),
  requested_at timestamptz not null default now(),
  decided_at   timestamptz,
  decided_by   uuid references public.profiles(id)
);

-- ───────────────────────────── events ─────────────────────────────
create table if not exists public.events (
  id          uuid primary key default gen_random_uuid(),
  code        text not null check (code ~ '^[A-Z0-9]{2,8}$'),
  name_gu     text,
  name_en     text,
  venue       text,
  notes       text,
  kind        text not null default 'single' check (kind in ('single','multi')),
  capacity    int  not null default 0 check (capacity >= 0),          -- 0 = unlimited (persons)
  open_date   date not null,
  close_date  date not null,
  published   boolean not null default false,
  price_mode  text not null default 'paid' check (price_mode in ('paid','discount','free')),
  cost        numeric(10,2) not null default 0,    -- actual cost per head per session (for subsidy reports)
  adult_rate  numeric(10,2) not null default 0,
  child_rate  numeric(10,2) not null default 0,
  child_note  text default 'below 10 yrs',
  pkg_adult   numeric(10,2) not null default 0,    -- all-sessions package (multi only), 0 = none
  pkg_child   numeric(10,2) not null default 0,
  late_from   date,                                -- optional: rate increases from this date
  late_extra  numeric(10,2) not null default 0,    -- per person per session
  created_by  uuid references public.profiles(id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  check (close_date >= open_date),
  check (name_gu is not null or name_en is not null)
);

create table if not exists public.event_sessions (
  id       uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  label    text,
  date     date not null,
  meal     text not null default 'Snacks' check (meal in ('Snacks','Breakfast','Lunch','Dinner','Hi-Tea')),
  sort     int  not null default 0
);
create index if not exists event_sessions_event_idx on public.event_sessions(event_id);

-- ───────────────────────────── bookings ─────────────────────────────
create table if not exists public.bookings (
  id           uuid primary key default gen_random_uuid(),
  event_id     uuid not null references public.events(id) on delete restrict,
  user_id      uuid references public.profiles(id) on delete set null,   -- owner (null = desk booking for someone without an account)
  pass_no      text not null unique,
  block        text not null,
  flat_no      text not null,
  name         text not null,
  mobile       text not null check (mobile ~ '^[6-9][0-9]{9}$'),
  email        text,
  pass_type    text not null default 'mobile' check (pass_type in ('mobile','physical')),
  adults       int  not null check (adults between 0 and 20),
  children     int  not null check (children between 0 and 20),
  amount       numeric(10,2) not null,
  late_fee     numeric(10,2) not null default 0,
  cost         numeric(10,2) not null default 0,
  is_package   boolean not null default false,
  status       text not null default 'pending' check (status in ('pending','paid','cancelled')),
  pay_mode     text check (pay_mode in ('cash','upi','waived')),
  pay_ref      text,
  paid_amount  numeric(10,2),
  paid_at      timestamptz,
  paid_by      uuid references public.profiles(id),
  upi_ref      text,
  upi_at       timestamptz,
  printed_at   timestamptz,
  wa_sent_at   timestamptz,
  email_sent_at timestamptz,
  by_committee boolean not null default false,
  created_by   uuid references public.profiles(id),
  created_at   timestamptz not null default now(),
  cancelled_at timestamptz,
  check (adults + children >= 1)
);
create index if not exists bookings_event_idx on public.bookings(event_id);
create index if not exists bookings_user_idx  on public.bookings(user_id);

create table if not exists public.booking_sessions (
  booking_id uuid not null references public.bookings(id) on delete cascade,
  session_id uuid not null references public.event_sessions(id) on delete restrict,
  primary key (booking_id, session_id)
);

-- One row per person per session when the item is handed over at the counter.
create table if not exists public.checkins (
  booking_id uuid not null references public.bookings(id) on delete cascade,
  session_id uuid not null references public.event_sessions(id) on delete cascade,
  person_no  int  not null check (person_no between 1 and 40),
  given_at   timestamptz not null default now(),
  given_by   uuid references public.profiles(id),
  primary key (booking_id, session_id, person_no)
);

-- ───────────────────────────── helpers ─────────────────────────────
create or replace function public.is_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select exists(select 1 from public.staff s where s.user_id = auth.uid() and s.active);
$$;

create or replace function public.is_super_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists(select 1 from public.staff s where s.user_id = auth.uid() and s.active and s.role = 'super_admin');
$$;

create or replace function public.valid_flat(p_block text, p_flat text) returns boolean
language plpgsql immutable as $$
declare f int; u int;
begin
  if p_block is null or p_flat is null or p_block !~ '^[A-I]$' or p_flat !~ '^[0-9]{3,4}$' then return false; end if;
  f := (left(p_flat, length(p_flat) - 2))::int;
  u := (right(p_flat, 2))::int;
  if f < 1 or f > 12 or u < 1 or u > 4 then return false; end if;
  if f = 12 and p_block <> 'F' and u > 2 then return false; end if;   -- floor 12 has only units 01-02 except block F
  return true;
end $$;

-- New auth user (after first OTP login) → profile row; the configured number becomes super admin.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare sa text;
begin
  insert into public.profiles(id, phone) values (new.id, new.phone) on conflict (id) do nothing;
  select value #>> '{}' into sa from public.app_settings where key = 'super_admin_phone';
  if sa is not null and new.phone = sa and not exists (select 1 from public.staff where role = 'super_admin') then
    insert into public.staff(user_id, role) values (new.id, 'super_admin');
  end if;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Residents may edit their details but never their verified phone.
create or replace function public.profiles_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.phone is distinct from old.phone and coalesce(current_setting('role', true), '') <> 'service_role' then
    new.phone := old.phone;
  end if;
  if new.block is not null and new.flat_no is not null and not public.valid_flat(new.block, new.flat_no) then
    raise exception 'Flat %-% does not exist', new.block, new.flat_no using errcode = '22023';
  end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists profiles_guard on public.profiles;
create trigger profiles_guard before update on public.profiles for each row execute function public.profiles_guard();

-- Price calculation shared by the booking function and the app preview.
create or replace function public.price_for(p_event uuid, p_sessions int, p_adults int, p_children int, p_on date default current_date)
returns table(amount numeric, late_fee numeric, is_package boolean, cost numeric)
language plpgsql stable security definer set search_path = public as $$
declare e public.events; total_sessions int; base numeric; late numeric := 0; pkg boolean := false;
begin
  select * into e from public.events where id = p_event;
  if not found then raise exception 'Event not found' using errcode = 'P0002'; end if;
  select count(*) into total_sessions from public.event_sessions where event_id = p_event;
  if e.price_mode = 'free' then
    return query select 0::numeric, 0::numeric, false, e.cost * (p_adults + p_children) * p_sessions; return;
  end if;
  if e.kind = 'multi' and p_sessions = total_sessions and e.pkg_adult > 0 then
    pkg := true;
    base := p_adults * e.pkg_adult + p_children * (case when e.pkg_child > 0 then e.pkg_child else e.child_rate * p_sessions end);
  else
    base := p_sessions * (p_adults * e.adult_rate + p_children * e.child_rate);
  end if;
  if e.late_from is not null and e.late_extra > 0 and p_on >= e.late_from then
    late := e.late_extra * (p_adults + p_children) * p_sessions;
  end if;
  return query select base + late, late, pkg, e.cost * (p_adults + p_children) * p_sessions;
end $$;

create or replace function public.gen_pass_no(p_code text, p_block text, p_flat text) returns text
language plpgsql volatile as $$
declare chars text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; r text := ''; i int;
begin
  for i in 1..5 loop r := r || substr(chars, 1 + floor(random() * length(chars))::int, 1); end loop;
  return p_code || '-' || p_block || p_flat || '-' || r;
end $$;

-- ───────────────────────────── booking API ─────────────────────────────
-- Residents: book for the flat on their profile, only while the window is open, within capacity.
-- Committee: may book for any flat (desk booking); linked to the resident's account when flat + mobile match a profile.
create or replace function public.create_booking(
  p_event uuid, p_sessions uuid[], p_adults int, p_children int, p_pass_type text,
  p_name text, p_mobile text, p_email text, p_block text default null, p_flat text default null)
returns public.bookings
language plpgsql security definer set search_path = public as $$
declare me public.profiles; e public.events; staff_user boolean := public.is_staff(); b public.bookings;
  blk text; fno text; owner uuid; n_sess int; used int; pr record; tries int := 0;
begin
  if auth.uid() is null then raise exception 'Please log in' using errcode = '42501'; end if;
  select * into me from public.profiles where id = auth.uid();
  select * into e from public.events where id = p_event for update;
  if not found then raise exception 'Event not found' using errcode = 'P0002'; end if;
  if not staff_user then
    if not e.published or current_date < e.open_date or current_date > e.close_date then
      raise exception 'Booking for this event is not open now' using errcode = '22023';
    end if;
    if me.block is null or me.flat_no is null then
      raise exception 'Please complete your profile (block and flat) first' using errcode = '22023';
    end if;
    blk := me.block; fno := me.flat_no; owner := me.id;
  else
    blk := coalesce(p_block, me.block); fno := coalesce(p_flat, me.flat_no);
    select id into owner from public.profiles where block = blk and flat_no = fno and right(phone, 10) = p_mobile limit 1;
  end if;
  if not public.valid_flat(blk, fno) then raise exception 'Flat %-% does not exist', blk, fno using errcode = '22023'; end if;
  if p_mobile !~ '^[6-9][0-9]{9}$' then raise exception 'Enter a valid 10-digit mobile number' using errcode = '22023'; end if;
  if p_email is not null and p_email <> '' and p_email !~* '^[^@\s]+@[^@\s]+\.[a-z]{2,}$' then raise exception 'Enter a valid email' using errcode = '22023'; end if;
  if coalesce(trim(p_name), '') = '' then raise exception 'Enter the name for the pass' using errcode = '22023'; end if;
  if coalesce(p_adults,0) + coalesce(p_children,0) < 1 then raise exception 'Add at least one person' using errcode = '22023'; end if;
  if p_pass_type not in ('mobile','physical') then raise exception 'Choose mobile or printed pass' using errcode = '22023'; end if;

  select count(*) into n_sess from public.event_sessions where event_id = p_event and id = any(p_sessions);
  if n_sess = 0 or n_sess <> coalesce(array_length(p_sessions, 1), 0) then
    raise exception 'Choose at least one valid session' using errcode = '22023';
  end if;
  if e.kind = 'single' and n_sess <> (select count(*) from public.event_sessions where event_id = p_event) then
    raise exception 'This event has a single sitting' using errcode = '22023';
  end if;

  if e.capacity > 0 and not staff_user then
    select coalesce(sum(adults + children), 0) into used from public.bookings where event_id = p_event and status <> 'cancelled';
    if used + p_adults + p_children > e.capacity then
      raise exception 'Sorry, only % places are left', greatest(e.capacity - used, 0) using errcode = '22023';
    end if;
  end if;

  select * into pr from public.price_for(p_event, n_sess, p_adults, p_children);
  loop
    begin
      insert into public.bookings(event_id, user_id, pass_no, block, flat_no, name, mobile, email, pass_type, adults, children,
        amount, late_fee, cost, is_package, status, by_committee, created_by)
      values (p_event, owner, public.gen_pass_no(e.code, blk, fno), blk, fno, trim(p_name), p_mobile, nullif(lower(trim(p_email)), ''),
        p_pass_type, p_adults, p_children, pr.amount, pr.late_fee, pr.cost, pr.is_package,
        case when pr.amount = 0 then 'paid' else 'pending' end, staff_user, auth.uid())
      returning * into b;
      exit;
    exception when unique_violation then
      tries := tries + 1; if tries > 5 then raise; end if;
    end;
  end loop;
  if pr.amount = 0 then update public.bookings set pay_mode = 'waived', paid_amount = 0, paid_at = now() where id = b.id returning * into b; end if;
  insert into public.booking_sessions(booking_id, session_id) select b.id, unnest(p_sessions);
  return b;
end $$;

create or replace function public.submit_upi_ref(p_booking uuid, p_ref text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_ref !~ '^[A-Za-z0-9]{6,22}$' then raise exception 'Enter the UPI reference exactly as shown in your app' using errcode = '22023'; end if;
  update public.bookings set upi_ref = p_ref, upi_at = now()
   where id = p_booking and status = 'pending' and (user_id = auth.uid() or public.is_staff());
  if not found then raise exception 'Booking not found' using errcode = 'P0002'; end if;
end $$;

-- Residents can cancel their own unpaid booking; committee can cancel any.
create or replace function public.cancel_booking(p_booking uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.bookings set status = 'cancelled', cancelled_at = now()
   where id = p_booking and status <> 'cancelled'
     and (public.is_staff() or (user_id = auth.uid() and status = 'pending'));
  if not found then raise exception 'This booking cannot be cancelled' using errcode = '42501'; end if;
end $$;

create or replace function public.mark_paid(p_booking uuid, p_mode text, p_amount numeric, p_ref text default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_staff() then raise exception 'Committee only' using errcode = '42501'; end if;
  if p_mode not in ('cash','upi','waived') then raise exception 'Invalid payment mode' using errcode = '22023'; end if;
  update public.bookings set status = 'paid', pay_mode = p_mode, paid_amount = case when p_mode = 'waived' then 0 else p_amount end,
         pay_ref = nullif(p_ref, ''), paid_at = now(), paid_by = auth.uid()
   where id = p_booking and status = 'pending';
  if not found then raise exception 'Booking is not awaiting payment' using errcode = '22023'; end if;
end $$;

create or replace function public.undo_paid(p_booking uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_staff() then raise exception 'Committee only' using errcode = '42501'; end if;
  update public.bookings set status = 'pending', pay_mode = null, paid_amount = null, pay_ref = null, paid_at = null, paid_by = null
   where id = p_booking and status = 'paid' and amount > 0;
end $$;

create or replace function public.restore_booking(p_booking uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_staff() then raise exception 'Committee only' using errcode = '42501'; end if;
  update public.bookings set status = case when paid_at is not null then 'paid' else 'pending' end, cancelled_at = null
   where id = p_booking and status = 'cancelled';
end $$;

create or replace function public.mark_sent(p_booking uuid, p_channel text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_staff() then raise exception 'Committee only' using errcode = '42501'; end if;
  update public.bookings set
    wa_sent_at    = case when p_channel = 'whatsapp' then now() else wa_sent_at end,
    email_sent_at = case when p_channel = 'email'    then now() else email_sent_at end,
    printed_at    = case when p_channel = 'print'    then coalesce(printed_at, now()) else printed_at end
   where id = p_booking;
end $$;

-- ───────────────────────────── counter scan ─────────────────────────────
-- token = PASSNO or PASSNO-<person>. Atomically checks and (optionally) marks today's session as given.
create or replace function public.scan_pass(p_token text, p_auto boolean default true) returns jsonb
language plpgsql security definer set search_path = public as $$
declare t text := upper(regexp_replace(coalesce(p_token,''), '^.*#', '')); b public.bookings; e public.events;
  person int := 0; m text[]; sess record; open_today uuid[]; given jsonb; result text; marked uuid := null;
begin
  if not public.is_staff() then raise exception 'Committee only' using errcode = '42501'; end if;
  select * into b from public.bookings where pass_no = t;
  if not found then
    m := regexp_match(t, '^(.*)-([0-9]{1,2})$');
    if m is not null then select * into b from public.bookings where pass_no = m[1]; person := m[2]::int; end if;
  end if;
  if b.id is null then return jsonb_build_object('result','not_found','token',t); end if;
  if person > b.adults + b.children then return jsonb_build_object('result','not_found','token',t); end if;
  select * into e from public.events where id = b.event_id;

  if b.status = 'cancelled' then result := 'cancelled';
  elsif b.status = 'pending' then result := 'unpaid';
  else
    select array_agg(s.id order by s.sort, s.date) into open_today
      from public.event_sessions s join public.booking_sessions bs on bs.session_id = s.id and bs.booking_id = b.id
     where s.date = current_date
       and (person = 0 or not exists (select 1 from public.checkins c where c.booking_id = b.id and c.session_id = s.id and c.person_no = person));
    if not exists (select 1 from public.event_sessions s join public.booking_sessions bs on bs.session_id = s.id and bs.booking_id = b.id where s.date = current_date) then
      result := 'no_session_today';
    elsif person = 0 then result := 'booking';
    elsif open_today is null then result := 'already_given';
    elsif array_length(open_today,1) = 1 and p_auto then
      insert into public.checkins(booking_id, session_id, person_no, given_by) values (b.id, open_today[1], person, auth.uid())
        on conflict do nothing;
      if found then result := 'given'; marked := open_today[1]; else result := 'already_given'; end if;
    else result := 'valid';
    end if;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('session_id',c.session_id,'person_no',c.person_no,'given_at',c.given_at)), '[]'::jsonb)
    into given from public.checkins c where c.booking_id = b.id;
  return jsonb_build_object('result', result, 'person', person, 'marked_session', marked,
    'booking', to_jsonb(b), 'event', jsonb_build_object('id',e.id,'name_gu',e.name_gu,'name_en',e.name_en),
    'sessions', (select coalesce(jsonb_agg(jsonb_build_object('id',s.id,'label',s.label,'date',s.date,'meal',s.meal) order by s.sort, s.date),'[]'::jsonb)
                   from public.event_sessions s join public.booking_sessions bs on bs.session_id = s.id and bs.booking_id = b.id),
    'given', given);
end $$;

create or replace function public.set_given(p_booking uuid, p_session uuid, p_persons int[], p_given boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_staff() then raise exception 'Committee only' using errcode = '42501'; end if;
  if p_given then
    if not exists (select 1 from public.bookings where id = p_booking and status = 'paid') then
      raise exception 'Payment not confirmed' using errcode = '22023';
    end if;
    insert into public.checkins(booking_id, session_id, person_no, given_by)
      select p_booking, p_session, unnest(p_persons), auth.uid() on conflict do nothing;
  else
    delete from public.checkins where booking_id = p_booking and session_id = p_session and person_no = any(p_persons);
  end if;
end $$;

-- Public pass view for the WhatsApp link (no login): shows only what is printed on the pass.
create or replace function public.public_pass(p_token text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare t text := upper(coalesce(p_token,'')); b public.bookings; e public.events; person int := 0; m text[];
begin
  select * into b from public.bookings where pass_no = t;
  if not found then
    m := regexp_match(t, '^(.*)-([0-9]{1,2})$');
    if m is not null then select * into b from public.bookings where pass_no = m[1]; person := m[2]::int; end if;
  end if;
  if b.id is null or length(t) < 10 then return null; end if;
  select * into e from public.events where id = b.event_id;
  return jsonb_build_object('pass_no', b.pass_no, 'person', person, 'adults', b.adults, 'children', b.children,
    'flat', b.block || '-' || b.flat_no, 'name', b.name, 'status', b.status, 'amount', b.amount, 'pass_type', b.pass_type,
    'event', jsonb_build_object('name_gu', e.name_gu, 'name_en', e.name_en, 'venue', e.venue),
    'sessions', (select coalesce(jsonb_agg(jsonb_build_object('label',s.label,'date',s.date,'meal',s.meal) order by s.sort, s.date),'[]'::jsonb)
                   from public.event_sessions s join public.booking_sessions bs on bs.session_id = s.id and bs.booking_id = b.id));
end $$;

-- Places left (counts only — residents never see other people's bookings).
create or replace function public.event_availability(p_event uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('capacity', e.capacity,
    'booked', coalesce((select sum(adults + children) from public.bookings b where b.event_id = e.id and b.status <> 'cancelled'), 0))
  from public.events e where e.id = p_event and (e.published or public.is_staff());
$$;

-- ───────────────────────────── committee approvals ─────────────────────────────
create or replace function public.request_committee_access(p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Please log in' using errcode = '42501'; end if;
  insert into public.staff_requests(user_id, note) values (auth.uid(), p_note)
  on conflict (user_id) do update set note = excluded.note, status = 'pending', requested_at = now(), decided_at = null, decided_by = null
    where public.staff_requests.status <> 'approved';
end $$;

create or replace function public.decide_committee(p_user uuid, p_approve boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_super_admin() then raise exception 'Only the super admin can approve committee members' using errcode = '42501'; end if;
  update public.staff_requests set status = case when p_approve then 'approved' else 'rejected' end, decided_at = now(), decided_by = auth.uid()
   where user_id = p_user;
  if p_approve then
    insert into public.staff(user_id, role, approved_by) values (p_user, 'committee', auth.uid())
    on conflict (user_id) do update set active = true, approved_by = auth.uid(), approved_at = now() where public.staff.role <> 'super_admin';
  end if;
end $$;

create or replace function public.revoke_committee(p_user uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_super_admin() then raise exception 'Only the super admin can revoke access' using errcode = '42501'; end if;
  update public.staff set active = false where user_id = p_user and role = 'committee';
end $$;

-- ───────────────────────────── row level security ─────────────────────────────
alter table public.app_settings     enable row level security;
alter table public.profiles         enable row level security;
alter table public.staff            enable row level security;
alter table public.staff_requests   enable row level security;
alter table public.events           enable row level security;
alter table public.event_sessions   enable row level security;
alter table public.bookings         enable row level security;
alter table public.booking_sessions enable row level security;
alter table public.checkins         enable row level security;

-- settings: everyone logged in reads desk/upi; only committee writes; the super admin number is not exposed.
drop policy if exists settings_read on public.app_settings;
create policy settings_read on public.app_settings for select to authenticated using (key <> 'super_admin_phone' or public.is_super_admin());
drop policy if exists settings_write on public.app_settings;
create policy settings_write on public.app_settings for all to authenticated using (public.is_staff() and key <> 'super_admin_phone') with check (public.is_staff() and key <> 'super_admin_phone');

drop policy if exists profiles_own on public.profiles;
create policy profiles_own on public.profiles for select to authenticated using (id = auth.uid() or public.is_staff());
drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists staff_read on public.staff;
create policy staff_read on public.staff for select to authenticated using (user_id = auth.uid() or public.is_staff());

drop policy if exists staff_requests_read on public.staff_requests;
create policy staff_requests_read on public.staff_requests for select to authenticated using (user_id = auth.uid() or public.is_super_admin());

drop policy if exists events_read on public.events;
create policy events_read on public.events for select to authenticated using (published or public.is_staff());
drop policy if exists events_write on public.events;
create policy events_write on public.events for all to authenticated using (public.is_staff()) with check (public.is_staff());

drop policy if exists sessions_read on public.event_sessions;
create policy sessions_read on public.event_sessions for select to authenticated
  using (public.is_staff() or exists (select 1 from public.events e where e.id = event_id and e.published));
drop policy if exists sessions_write on public.event_sessions;
create policy sessions_write on public.event_sessions for all to authenticated using (public.is_staff()) with check (public.is_staff());

drop policy if exists bookings_read on public.bookings;
create policy bookings_read on public.bookings for select to authenticated using (user_id = auth.uid() or public.is_staff());
drop policy if exists bookings_staff_update on public.bookings;
create policy bookings_staff_update on public.bookings for update to authenticated using (public.is_staff()) with check (public.is_staff());
-- (no insert policy: bookings are created only through create_booking(), which prices them server-side)

drop policy if exists bsess_read on public.booking_sessions;
create policy bsess_read on public.booking_sessions for select to authenticated
  using (exists (select 1 from public.bookings b where b.id = booking_id and (b.user_id = auth.uid() or public.is_staff())));

drop policy if exists checkins_read on public.checkins;
create policy checkins_read on public.checkins for select to authenticated using (public.is_staff());

-- ───────────────────────────── grants ─────────────────────────────
revoke all on all tables in schema public from anon;
grant select, insert, update, delete on all tables in schema public to authenticated;
revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated;
grant execute on function public.public_pass(text) to anon;

-- Live updates for the committee screens.
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin alter publication supabase_realtime add table public.bookings, public.checkins, public.events; exception when duplicate_object then null; end;
  end if;
end $$;
