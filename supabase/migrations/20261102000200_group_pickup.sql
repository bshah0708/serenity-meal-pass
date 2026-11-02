-- Collect several passes with ONE QR.
-- The resident's app builds a group token   G:<PASS_NO>:<person>.<person>,<PASS_NO>:<person>…
-- (e.g. G:DIN26-E903-K7P2M:1.2.3,DIN26-E903-AB12C:1.2). The committee scans it once:
-- every valid pass is marked as given for today's session, and the reply lists each person
-- with what happened, so the counter knows exactly how many dishes to hand over.

-- Residents may see the hand-over records of their OWN bookings (to know what is already collected).
drop policy if exists checkins_read_own on public.checkins;
create policy checkins_read_own on public.checkins for select to authenticated
  using (exists (select 1 from public.bookings b where b.id = booking_id and b.user_id = auth.uid()));

create or replace function public.scan_group(p_token text, p_auto boolean default true) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  t text := upper(regexp_replace(coalesce(p_token, ''), '^.*#', ''));
  part text; pno text; nums text; n int; b public.bookings; ev_id uuid; e public.events;
  s_id uuid; s_label text; res text; g_at timestamptz; seen text[] := '{}'; key text;
  items jsonb := '[]'::jsonb; flats text[] := '{}'; names text[] := '{}'; ready int := 0; given_now int := 0; ins int;
begin
  if not public.is_staff() then raise exception 'Committee only' using errcode = '42501'; end if;
  if left(t, 2) <> 'G:' then return jsonb_build_object('result', 'not_group'); end if;
  t := substr(t, 3);
  if length(t) > 3000 then raise exception 'QR is too long' using errcode = '22023'; end if;

  foreach part in array string_to_array(t, ',') loop
    pno := split_part(part, ':', 1); nums := split_part(part, ':', 2);
    b := null;
    select * into b from public.bookings where pass_no = pno;
    foreach n in array (select coalesce(array_agg(x::int), '{}') from unnest(string_to_array(nums, '.')) x where x ~ '^[0-9]{1,2}$') loop
      key := pno || '-' || n;
      continue when key = any(seen);
      seen := seen || key;
      res := null; s_id := null; s_label := null; g_at := null;
      if b.id is null or n < 1 or n > b.adults + b.children then res := 'not_found';
      else
        ev_id := coalesce(ev_id, b.event_id);
        if b.event_id <> ev_id then res := 'other_event';
        elsif b.status = 'cancelled' then res := 'cancelled';
        elsif b.status = 'pending' then res := 'unpaid';
        elsif not exists (select 1 from public.event_sessions s join public.booking_sessions bs on bs.session_id = s.id and bs.booking_id = b.id where s.date = current_date) then
          res := 'no_session_today';
        else
          -- earliest of today's sessions this person has not collected yet (lunch, then dinner…)
          select s.id, coalesce(s.label, s.meal) into s_id, s_label
            from public.event_sessions s join public.booking_sessions bs on bs.session_id = s.id and bs.booking_id = b.id
           where s.date = current_date
             and not exists (select 1 from public.checkins c where c.booking_id = b.id and c.session_id = s.id and c.person_no = n)
           order by s.sort, s.date limit 1;
          if s_id is null then
            res := 'already_given';
            select max(c.given_at) into g_at from public.checkins c join public.event_sessions s on s.id = c.session_id
             where c.booking_id = b.id and c.person_no = n and s.date = current_date;
          elsif p_auto then
            insert into public.checkins(booking_id, session_id, person_no, given_by) values (b.id, s_id, n, auth.uid()) on conflict do nothing;
            get diagnostics ins = row_count;
            if ins > 0 then res := 'given'; given_now := given_now + 1; g_at := now(); else res := 'already_given'; end if;
          else
            res := 'ready'; ready := ready + 1;
          end if;
        end if;
        if not (b.block || '-' || b.flat_no) = any(flats) then flats := flats || (b.block || '-' || b.flat_no); end if;
        if not b.name = any(names) then names := names || b.name; end if;
      end if;
      items := items || jsonb_build_object('pass_no', pno, 'person', n,
        'type', case when b.id is null then null when n <= b.adults then 'Adult' else 'Child' end,
        'flat', case when b.id is null then null else b.block || '-' || b.flat_no end, 'name', b.name,
        'result', res, 'session', s_label, 'given_at', g_at, 'booking_id', b.id);
    end loop;
  end loop;

  if ev_id is not null then select * into e from public.events where id = ev_id; end if;
  return jsonb_build_object('result', 'group', 'give', given_now + ready, 'given_now', given_now, 'ready', ready,
    'total', jsonb_array_length(items), 'flats', to_jsonb(flats), 'names', to_jsonb(names), 'items', items,
    'event', case when e.id is null then null else jsonb_build_object('id', e.id, 'name_gu', e.name_gu, 'name_en', e.name_en) end);
end $$;

revoke execute on function public.scan_group(text, boolean) from public, anon;
grant execute on function public.scan_group(text, boolean) to authenticated;
