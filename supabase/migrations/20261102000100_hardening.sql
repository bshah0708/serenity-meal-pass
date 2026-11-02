-- Hardening after Supabase security advisor review.
-- 1. Pin search_path on the two helper functions that had none.
alter function public.valid_flat(text, text) set search_path = public;
alter function public.gen_pass_no(text, text, text) set search_path = public;

-- 2. Internal functions are not part of the app API: only triggers / other functions call them.
revoke execute on function public.handle_new_user() from authenticated, anon, public;
revoke execute on function public.profiles_guard() from authenticated, anon, public;
revoke execute on function public.price_for(uuid, int, int, int, date) from authenticated, anon, public;
revoke execute on function public.gen_pass_no(text, text, text) from authenticated, anon, public;

-- The remaining SECURITY DEFINER functions are the app's API and check the caller inside
-- (is_staff / is_super_admin / ownership). public_pass is intentionally callable without login
-- so the WhatsApp pass link works; it returns only what is printed on the pass.
