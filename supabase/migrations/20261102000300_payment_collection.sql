-- Who handled the money.
--   pay_mode            cash | upi | other | waived   ('other' = cheque, bank transfer, …; needs a note)
--   paid_by / _name     committee member who MARKED the booking as paid (always the logged-in user)
--   collected_by / _name  who physically RECEIVED the cash (cash only). A committee member, or a typed
--                       name for a volunteer without a login. Names are stored as a snapshot so receipts
--                       and reports stay correct even if a profile is renamed later.
--   pay_note            free text: cheque no., bank, reason for waiver …

alter table public.bookings drop constraint if exists bookings_pay_mode_check;
alter table public.bookings add constraint bookings_pay_mode_check check (pay_mode in ('cash','upi','other','waived'));
alter table public.bookings add column if not exists paid_by_name text;
alter table public.bookings add column if not exists collected_by uuid references public.profiles(id);
alter table public.bookings add column if not exists collected_by_name text;
alter table public.bookings add column if not exists pay_note text;

create or replace function public.staff_name(p_user uuid) returns text
language sql stable security definer set search_path = public as $$
  select coalesce(nullif(trim(p.name), ''), right(p.phone, 10), 'Committee')
    from public.profiles p where p.id = p_user
$$;
revoke execute on function public.staff_name(uuid) from public, anon, authenticated;

create or replace function public.record_payment(
  p_booking uuid, p_mode text, p_amount numeric,
  p_ref text default null, p_collected_by uuid default null, p_collected_name text default null, p_note text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare b public.bookings; c_by uuid; c_name text;
begin
  if not public.is_staff() then raise exception 'Committee only' using errcode = '42501'; end if;
  if p_mode not in ('cash','upi','other','waived') then raise exception 'Invalid payment mode' using errcode = '22023'; end if;
  if p_mode <> 'waived' and coalesce(p_amount, 0) <= 0 then raise exception 'Enter the amount received' using errcode = '22023'; end if;
  if p_mode = 'other' and coalesce(trim(p_note), '') = '' then raise exception 'For "Other", write how it was paid (e.g. cheque no.)' using errcode = '22023'; end if;

  if p_mode = 'cash' then
    if coalesce(trim(p_collected_name), '') <> '' and p_collected_by is null then
      c_name := left(trim(p_collected_name), 60);                       -- volunteer without login
    else
      c_by := coalesce(p_collected_by, auth.uid());
      if not exists (select 1 from public.staff s where s.user_id = c_by and s.active) then
        raise exception 'Cash collector must be a committee member (or type a name)' using errcode = '22023';
      end if;
      c_name := public.staff_name(c_by);
    end if;
  end if;

  update public.bookings set status = 'paid', pay_mode = p_mode,
         paid_amount = case when p_mode = 'waived' then 0 else p_amount end,
         pay_ref = nullif(trim(coalesce(p_ref, '')), ''), pay_note = nullif(trim(coalesce(p_note, '')), ''),
         paid_at = now(), paid_by = auth.uid(), paid_by_name = public.staff_name(auth.uid()),
         collected_by = c_by, collected_by_name = c_name
   where id = p_booking and status = 'pending'
   returning * into b;
  if b.id is null then raise exception 'Booking is not awaiting payment' using errcode = '22023'; end if;
  return jsonb_build_object('pass_no', b.pass_no, 'mode', b.pay_mode, 'amount', b.paid_amount,
    'marked_by', b.paid_by_name, 'collected_by', b.collected_by_name);
end $$;
revoke execute on function public.record_payment(uuid, text, numeric, text, uuid, text, text) from public, anon;
grant execute on function public.record_payment(uuid, text, numeric, text, uuid, text, text) to authenticated;

-- old entry point keeps working: cash is recorded as collected by the person marking it
create or replace function public.mark_paid(p_booking uuid, p_mode text, p_amount numeric, p_ref text default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public.record_payment(p_booking, p_mode, p_amount, p_ref, null, null, case when p_mode = 'other' then coalesce(p_ref, 'Other') end);
end $$;

create or replace function public.undo_paid(p_booking uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_staff() then raise exception 'Committee only' using errcode = '42501'; end if;
  update public.bookings set status = 'pending', pay_mode = null, paid_amount = null, pay_ref = null, pay_note = null,
         paid_at = null, paid_by = null, paid_by_name = null, collected_by = null, collected_by_name = null
   where id = p_booking and status = 'paid' and amount > 0;
end $$;

-- payments recorded before this change: the person who marked it paid is taken as the one who received the cash
update public.bookings set paid_by_name = public.staff_name(paid_by),
  collected_by = case when pay_mode = 'cash' then coalesce(collected_by, paid_by) end,
  collected_by_name = case when pay_mode = 'cash' then coalesce(collected_by_name, public.staff_name(paid_by)) end
 where status = 'paid' and paid_by is not null and paid_by_name is null;
