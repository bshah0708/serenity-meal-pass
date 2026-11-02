-- A meal is given against THAT person's own QR.
--   * Scanning a person's QR marks only that person (scan_pass / scan_group, unchanged).
--   * give_by_qr(token, session): used by the counter when the scanned person has more than one
--     session today (e.g. lunch + dinner) or auto-mark is off — still only the scanned person.
--   * Marking given WITHOUT scanning (set_given … true) is an exception: a reason is required and
--     it is written to the audit trail as "Given without QR".

create or replace function public.give_by_qr(p_token text, p_session uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare t text := upper(regexp_replace(coalesce(p_token, ''), '^.*#', '')); m text[]; b public.bookings; person int; ins int;
begin
  if not public.is_staff() then raise exception 'Committee only' using errcode = '42501'; end if;
  m := regexp_match(t, '^(.*)-([0-9]{1,2})$');
  if m is null then raise exception 'This is not a person''s pass QR' using errcode = '22023'; end if;
  select * into b from public.bookings where pass_no = m[1]; person := m[2]::int;
  if b.id is null or person < 1 or person > b.adults + b.children then raise exception 'Pass not found' using errcode = '22023'; end if;
  if b.status <> 'paid' then raise exception 'Payment not confirmed' using errcode = '22023'; end if;
  if not exists (select 1 from public.booking_sessions bs join public.event_sessions s on s.id = bs.session_id
                  where bs.booking_id = b.id and s.id = p_session and s.date = current_date) then
    raise exception 'This pass is not valid for that session today' using errcode = '22023';
  end if;
  insert into public.checkins(booking_id, session_id, person_no, given_by) values (b.id, p_session, person, auth.uid()) on conflict do nothing;
  get diagnostics ins = row_count;
  return jsonb_build_object('result', case when ins > 0 then 'given' else 'already_given' end, 'person', person);
end $$;
revoke execute on function public.give_by_qr(text, uuid) from public, anon;
grant execute on function public.give_by_qr(text, uuid) to authenticated;

create or replace function public.set_given(p_booking uuid, p_session uuid, p_persons int[], p_given boolean, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare removed jsonb;
begin
  if not public.is_staff() then raise exception 'Committee only' using errcode = '42501'; end if;
  if p_given then
    -- without a QR scan: exception, reason required and logged
    perform public.audit('manual_given', p_booking, p_reason, jsonb_build_object('session',
      (select coalesce(s.label, s.meal) || ' · ' || to_char(s.date, 'DD-Mon-YYYY') from public.event_sessions s where s.id = p_session),
      'persons', to_jsonb(p_persons)));
  else
    select jsonb_agg(jsonb_build_object('person', c.person_no, 'given_at', c.given_at, 'given_by', public.staff_name(c.given_by)) order by c.person_no)
      into removed from public.checkins c where c.booking_id = p_booking and c.session_id = p_session and c.person_no = any(p_persons);
    if removed is null then raise exception 'Nothing to undo: not marked as given' using errcode = '22023'; end if;
    perform public.audit('not_given', p_booking, p_reason, jsonb_build_object('session',
      (select coalesce(s.label, s.meal) || ' · ' || to_char(s.date, 'DD-Mon-YYYY') from public.event_sessions s where s.id = p_session), 'removed', removed));
  end if;
  perform public.set_given(p_booking, p_session, p_persons, p_given);   -- the original hand-over function does the change
end $$;
