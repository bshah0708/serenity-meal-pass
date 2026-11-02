-- Audit trail for every reversal done by the committee.
-- Reversals now REQUIRE a reason and are logged with who did it, when, and what was undone:
--   undo_paid · set_given(..., false) "mark not given" · restore_booking · committee cancel_booking
--   record_refund(no refund) · revoke_committee
-- The old entry points without a reason are no longer callable by the app (execute revoked).

create table if not exists public.audit_log (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default now(),
  actor       uuid references public.profiles(id),
  actor_name  text,
  action      text not null,
  booking_id  uuid references public.bookings(id) on delete set null,
  event_id    uuid references public.events(id) on delete set null,
  pass_no     text,
  reason      text not null check (length(trim(reason)) >= 3),
  details     jsonb not null default '{}'::jsonb
);
create index if not exists audit_log_at_idx on public.audit_log (at desc);
create index if not exists audit_log_booking_idx on public.audit_log (booking_id);
alter table public.audit_log enable row level security;
create policy audit_read_staff on public.audit_log for select to authenticated using (public.is_staff());
-- only a SELECT policy exists, so with RLS on nobody can insert, edit or remove rows through the API;
-- rows are written only by public.audit(), called from the functions below
grant select on public.audit_log to authenticated;

alter table public.bookings add column if not exists cancel_note text;

create or replace function public.audit(p_action text, p_booking uuid, p_reason text, p_details jsonb default '{}'::jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare b public.bookings;
begin
  if coalesce(length(trim(p_reason)), 0) < 3 then
    raise exception 'Please write the reason (at least a few words)' using errcode = '22023';
  end if;
  if p_booking is not null then select * into b from public.bookings where id = p_booking; end if;
  insert into public.audit_log(actor, actor_name, action, booking_id, event_id, pass_no, reason, details)
  values (auth.uid(), public.staff_name(auth.uid()), p_action, b.id, b.event_id, b.pass_no, left(trim(p_reason), 500), coalesce(p_details, '{}'::jsonb));
end $$;
revoke execute on function public.audit(text, uuid, text, jsonb) from public, anon, authenticated;

-- ── undo payment ──
create or replace function public.undo_paid(p_booking uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare b public.bookings;
begin
  if not public.is_staff() then raise exception 'Committee only' using errcode = '42501'; end if;
  select * into b from public.bookings where id = p_booking and status = 'paid' and amount > 0 for update;
  if b.id is null then raise exception 'This booking has no payment to undo' using errcode = '22023'; end if;
  perform public.audit('undo_paid', b.id, p_reason, jsonb_build_object('mode', b.pay_mode, 'amount', b.paid_amount, 'ref', b.pay_ref,
    'note', b.pay_note, 'paid_at', b.paid_at, 'marked_by', b.paid_by_name, 'cash_received_by', b.collected_by_name));
  update public.bookings set status = 'pending', pay_mode = null, paid_amount = null, pay_ref = null, pay_note = null,
         paid_at = null, paid_by = null, paid_by_name = null, collected_by = null, collected_by_name = null
   where id = b.id;
end $$;
revoke execute on function public.undo_paid(uuid) from public, anon, authenticated;
revoke execute on function public.undo_paid(uuid, text) from public, anon;
grant execute on function public.undo_paid(uuid, text) to authenticated;

-- ── mark given / not given ──
create or replace function public.set_given(p_booking uuid, p_session uuid, p_persons int[], p_given boolean, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare removed jsonb;
begin
  if not public.is_staff() then raise exception 'Committee only' using errcode = '42501'; end if;
  if not p_given then
    select jsonb_agg(jsonb_build_object('person', c.person_no, 'given_at', c.given_at, 'given_by', public.staff_name(c.given_by)) order by c.person_no)
      into removed from public.checkins c where c.booking_id = p_booking and c.session_id = p_session and c.person_no = any(p_persons);
    if removed is null then raise exception 'Nothing to undo: not marked as given' using errcode = '22023'; end if;
    perform public.audit('not_given', p_booking, p_reason, jsonb_build_object('session',
      (select coalesce(s.label, s.meal) || ' · ' || to_char(s.date, 'DD-Mon-YYYY') from public.event_sessions s where s.id = p_session), 'removed', removed));
  end if;
  perform public.set_given(p_booking, p_session, p_persons, p_given);   -- the original hand-over function does the change
end $$;
revoke execute on function public.set_given(uuid, uuid, int[], boolean) from public, anon, authenticated;
revoke execute on function public.set_given(uuid, uuid, int[], boolean, text) from public, anon;
grant execute on function public.set_given(uuid, uuid, int[], boolean, text) to authenticated;

-- ── restore a cancelled booking ──
create or replace function public.restore_booking(p_booking uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare b public.bookings;
begin
  if not public.is_staff() then raise exception 'Committee only' using errcode = '42501'; end if;
  select * into b from public.bookings where id = p_booking and status = 'cancelled' for update;
  if b.id is null then raise exception 'This booking is not cancelled' using errcode = '22023'; end if;
  if b.refund_status = 'refunded' then raise exception 'The money was already refunded. Make a new booking instead.' using errcode = '22023'; end if;
  perform public.audit('restore', b.id, p_reason, jsonb_build_object('cancelled_at', b.cancelled_at, 'cancelled_by', b.cancelled_by_name,
    'cancel_reason', b.cancel_reason, 'cancel_note', b.cancel_note, 'refund_status', b.refund_status));
  update public.bookings set status = case when paid_at is not null then 'paid' else 'pending' end, cancelled_at = null,
         cancelled_by = null, cancelled_by_name = null, cancel_reason = null, cancel_note = null,
         refund_status = null, refund_amount = null, refund_ref = null, refunded_at = null, refunded_by_name = null
   where id = b.id;
end $$;
revoke execute on function public.restore_booking(uuid) from public, anon, authenticated;
revoke execute on function public.restore_booking(uuid, text) from public, anon;
grant execute on function public.restore_booking(uuid, text) to authenticated;

-- ── cancel: residents use cancel_booking(id); the committee cancelling someone else's booking must give a reason ──
create or replace function public.cancel_booking(p_booking uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare b public.bookings; e public.events; staff_user boolean := public.is_staff(); amt numeric := 0; v_committee boolean;
begin
  select * into b from public.bookings where id = p_booking for update;
  if b.id is null or b.status = 'cancelled' or not (staff_user or b.user_id = auth.uid()) then
    raise exception 'This booking cannot be cancelled' using errcode = '42501';
  end if;
  v_committee := staff_user and b.user_id is distinct from auth.uid();
  select * into e from public.events where id = b.event_id;
  if not staff_user and b.status = 'paid' and coalesce(b.amount, 0) > 0 then
    if e.cancel_paid <> 'until' or e.cancel_until is null then
      raise exception 'Paid passes for this event cannot be cancelled' using errcode = '42501';
    elsif public.ist_today() > e.cancel_until then
      raise exception 'Cancellation closed on %', to_char(e.cancel_until, 'DD-Mon-YYYY') using errcode = '42501';
    end if;
  end if;
  if not staff_user and exists (select 1 from public.checkins c where c.booking_id = b.id) then
    raise exception 'A meal on this pass has already been collected, so it cannot be cancelled' using errcode = '42501';
  end if;
  if v_committee then
    perform public.audit('cancel', b.id, p_reason, jsonb_build_object('status_before', b.status, 'amount', b.amount, 'paid_amount', b.paid_amount));
  end if;
  if b.status = 'paid' then amt := coalesce(b.paid_amount, b.amount, 0); end if;
  update public.bookings set status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid(),
         cancelled_by_name = public.staff_name(auth.uid()),
         cancel_reason = case when v_committee then 'committee' else 'resident' end,
         cancel_note = case when v_committee then left(trim(p_reason), 500) end,
         refund_status = case when amt > 0 then 'due' end, refund_amount = case when amt > 0 then amt end,
         refund_ref = null, refunded_at = null, refunded_by_name = null
   where id = b.id;
end $$;
revoke execute on function public.cancel_booking(uuid, text) from public, anon;
grant execute on function public.cancel_booking(uuid, text) to authenticated;

create or replace function public.cancel_booking(p_booking uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if public.is_staff() and exists (select 1 from public.bookings where id = p_booking and user_id is distinct from auth.uid()) then
    raise exception 'Please write the reason for cancelling' using errcode = '22023';
  end if;
  perform public.cancel_booking(p_booking, null);
end $$;

-- ── refund: "no refund" needs a reason and is logged ──
create or replace function public.record_refund(p_booking uuid, p_refunded boolean, p_ref text default null) returns void
language plpgsql security definer set search_path = public as $$
declare b public.bookings;
begin
  if not public.is_staff() then raise exception 'Committee only' using errcode = '42501'; end if;
  select * into b from public.bookings where id = p_booking and status = 'cancelled' and refund_status is not null for update;
  if b.id is null then raise exception 'No refund pending on this booking' using errcode = '22023'; end if;
  if not p_refunded then perform public.audit('no_refund', b.id, p_ref, jsonb_build_object('amount', b.refund_amount)); end if;
  update public.bookings set refund_status = case when p_refunded then 'refunded' else 'not_refunded' end,
         refund_ref = nullif(trim(coalesce(p_ref, '')), ''), refunded_at = now(), refunded_by_name = public.staff_name(auth.uid())
   where id = b.id;
end $$;

-- ── remove a committee member ──
create or replace function public.revoke_committee(p_user uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_super_admin() then raise exception 'Only the super admin can revoke access' using errcode = '42501'; end if;
  if not exists (select 1 from public.staff where user_id = p_user and role = 'committee' and active) then
    raise exception 'Not an active committee member' using errcode = '22023';
  end if;
  perform public.audit('revoke_committee', null, p_reason, jsonb_build_object('user', p_user, 'name', public.staff_name(p_user)));
  update public.staff set active = false where user_id = p_user and role = 'committee';
end $$;
revoke execute on function public.revoke_committee(uuid) from public, anon, authenticated;
revoke execute on function public.revoke_committee(uuid, text) from public, anon;
grant execute on function public.revoke_committee(uuid, text) to authenticated;
