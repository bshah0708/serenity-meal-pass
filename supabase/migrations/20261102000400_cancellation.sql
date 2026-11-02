-- Cancellation rules per event.
--   Unpaid bookings: the resident can always cancel.
--   Paid bookings:   cancel_paid = 'no'    → resident cannot cancel (committee still can)
--                    cancel_paid = 'until' → resident can cancel up to and including cancel_until;
--                                            the amount becomes "refund due" for the committee.
--   unpaid_cancel_days = N → unpaid bookings are cancelled automatically N days before the first
--                    session (on that date, India time). Bookings with a UPI reference waiting for
--                    verification are kept. NULL = never auto-cancel.
-- Every cancellation records who / why, and refunds record who paid the money back.

alter table public.events add column if not exists cancel_paid text not null default 'no';
alter table public.events add column if not exists cancel_until date;
alter table public.events add column if not exists unpaid_cancel_days int;
alter table public.events drop constraint if exists events_cancel_paid_check;
alter table public.events add constraint events_cancel_paid_check check (cancel_paid in ('no','until'));
alter table public.events drop constraint if exists events_unpaid_days_check;
alter table public.events add constraint events_unpaid_days_check check (unpaid_cancel_days is null or unpaid_cancel_days between 0 and 60);

alter table public.bookings add column if not exists cancelled_by uuid references public.profiles(id);
alter table public.bookings add column if not exists cancelled_by_name text;
alter table public.bookings add column if not exists cancel_reason text;
alter table public.bookings add column if not exists refund_status text;
alter table public.bookings add column if not exists refund_amount numeric;
alter table public.bookings add column if not exists refund_ref text;
alter table public.bookings add column if not exists refunded_at timestamptz;
alter table public.bookings add column if not exists refunded_by_name text;
alter table public.bookings drop constraint if exists bookings_cancel_reason_check;
alter table public.bookings add constraint bookings_cancel_reason_check check (cancel_reason in ('resident','committee','auto_unpaid'));
alter table public.bookings drop constraint if exists bookings_refund_status_check;
alter table public.bookings add constraint bookings_refund_status_check check (refund_status in ('due','refunded','not_refunded'));

create or replace function public.ist_today() returns date language sql stable as $$ select (now() at time zone 'Asia/Kolkata')::date $$;

-- date from which unpaid bookings are auto-cancelled (null = off)
create or replace function public.unpaid_cutoff(p_event uuid) returns date
language sql stable security definer set search_path = public as $$
  select (select min(s.date) from public.event_sessions s where s.event_id = e.id) - e.unpaid_cancel_days
    from public.events e where e.id = p_event and e.unpaid_cancel_days is not null
$$;

create or replace function public.cancel_booking(p_booking uuid) returns void
language plpgsql security definer set search_path = public as $$
declare b public.bookings; e public.events; staff_user boolean := public.is_staff(); amt numeric := 0;
begin
  select * into b from public.bookings where id = p_booking for update;
  if b.id is null or b.status = 'cancelled' or not (staff_user or b.user_id = auth.uid()) then
    raise exception 'This booking cannot be cancelled' using errcode = '42501';
  end if;
  select * into e from public.events where id = b.event_id;
  if not staff_user and b.status = 'paid' and coalesce(b.amount, 0) > 0 then   -- free passes: always cancellable
    if e.cancel_paid <> 'until' or e.cancel_until is null then
      raise exception 'Paid passes for this event cannot be cancelled' using errcode = '42501';
    elsif public.ist_today() > e.cancel_until then
      raise exception 'Cancellation closed on %', to_char(e.cancel_until, 'DD-Mon-YYYY') using errcode = '42501';
    end if;
  end if;
  if not staff_user and exists (select 1 from public.checkins c where c.booking_id = b.id) then
    raise exception 'A meal on this pass has already been collected, so it cannot be cancelled' using errcode = '42501';
  end if;
  if b.status = 'paid' then amt := coalesce(b.paid_amount, b.amount, 0); end if;
  update public.bookings set status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid(),
         cancelled_by_name = public.staff_name(auth.uid()),
         cancel_reason = case when staff_user and b.user_id is distinct from auth.uid() then 'committee' else 'resident' end,
         refund_status = case when amt > 0 then 'due' end, refund_amount = case when amt > 0 then amt end,
         refund_ref = null, refunded_at = null, refunded_by_name = null
   where id = b.id;
end $$;

-- committee records the refund (or that no refund is given)
create or replace function public.record_refund(p_booking uuid, p_refunded boolean, p_ref text default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_staff() then raise exception 'Committee only' using errcode = '42501'; end if;
  update public.bookings set refund_status = case when p_refunded then 'refunded' else 'not_refunded' end,
         refund_ref = nullif(trim(coalesce(p_ref, '')), ''), refunded_at = now(), refunded_by_name = public.staff_name(auth.uid())
   where id = p_booking and status = 'cancelled' and refund_status is not null;
  if not found then raise exception 'No refund pending on this booking' using errcode = '22023'; end if;
end $$;
revoke execute on function public.record_refund(uuid, boolean, text) from public, anon;
grant execute on function public.record_refund(uuid, boolean, text) to authenticated;

create or replace function public.restore_booking(p_booking uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_staff() then raise exception 'Committee only' using errcode = '42501'; end if;
  if exists (select 1 from public.bookings where id = p_booking and refund_status = 'refunded') then
    raise exception 'The money was already refunded. Make a new booking instead.' using errcode = '22023';
  end if;
  update public.bookings set status = case when paid_at is not null then 'paid' else 'pending' end, cancelled_at = null,
         cancelled_by = null, cancelled_by_name = null, cancel_reason = null,
         refund_status = null, refund_amount = null, refund_ref = null, refunded_at = null, refunded_by_name = null
   where id = p_booking and status = 'cancelled';
end $$;

-- cancel unpaid bookings whose payment deadline has passed. Safe to run any number of times.
create or replace function public.auto_cancel_unpaid() returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  update public.bookings b set status = 'cancelled', cancelled_at = now(), cancel_reason = 'auto_unpaid',
         cancelled_by = null, cancelled_by_name = 'Automatic (not paid in time)'
    from public.events e
   where e.id = b.event_id and b.status = 'pending' and b.upi_ref is null
     and public.unpaid_cutoff(e.id) is not null
     and public.ist_today() >= public.unpaid_cutoff(e.id)
     and (b.created_at at time zone 'Asia/Kolkata')::date < public.unpaid_cutoff(e.id);
  get diagnostics n = row_count;
  return n;
end $$;
revoke execute on function public.auto_cancel_unpaid() from public, anon;
grant execute on function public.auto_cancel_unpaid() to authenticated;   -- the app also nudges it on load

-- run it every hour on Supabase (pg_cron); skipped where the extension is not available (tests)
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    perform cron.schedule('meal-pass-auto-cancel-unpaid', '5 * * * *', 'select public.auto_cancel_unpaid()');
  end if;
end $$;
