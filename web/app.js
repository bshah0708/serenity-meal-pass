/* Serenity Space Meal Pass — web app (residents + committee).
   Talks to Supabase: Auth (mobile OTP), Postgres with Row Level Security, RPC functions, Edge Functions.
   No build step: plain script, vendored libraries in /vendor. */
(function () {
"use strict";

/* ───────────── config & client ───────────── */
const CFG = window.SS_CONFIG || {};
const sb = (window.supabase && CFG.supabaseUrl) ? window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey, { auth: { persistSession: true, autoRefreshToken: true } }) : null;
const SITE = (CFG.siteUrl || location.href.replace(/[#?].*$/, "").replace(/\/[^/]*$/, "")).replace(/\/$/, "");

const BLOCKS = ["A","B","C","D","E","F","G","H","I"];
const MEALS = ["Snacks","Breakfast","Lunch","Dinner","Hi-Tea"];
const MEAL_GU = { Snacks:"નાસ્તો", Breakfast:"સવારનો નાસ્તો", Lunch:"બપોરનું ભોજન", Dinner:"રાત્રિ ભોજન", "Hi-Tea":"હાઈ-ટી" };
const MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

const S = { user:null, profile:null, staff:null, events:[], bookings:[], checkins:{}, settings:{}, avail:{},
            profiles:{}, staffList:[], requests:[], myRequest:null, editProfile:false, ready:false };
let mode = "resident", tab = "overview", userPicked = false;
const sel = {};

/* ───────────── helpers ───────────── */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const esc = v => String(v == null ? "" : v).replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
const pad = n => String(n).padStart(2, "0");
const today = () => { const d = new Date(); return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); };
const fd = s => { if (!s) return "—"; const [y, m, d] = String(s).slice(0, 10).split("-"); return d + "-" + MON[+m - 1] + "-" + y; };
const fdt = iso => { if (!iso) return "—"; const d = new Date(iso); return pad(d.getDate()) + "-" + MON[d.getMonth()] + "-" + d.getFullYear() + " " + pad(d.getHours()) + ":" + pad(d.getMinutes()); };
const hm = iso => { const d = new Date(iso); return pad(d.getHours()) + ":" + pad(d.getMinutes()); };
const inr = n => "₹" + Number(n || 0).toLocaleString("en-IN");
const validEmail = e => /^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/.test(e);
const isStaff = () => !!(S.staff && S.staff.active);
const isSuper = () => isStaff() && S.staff.role === "super_admin";
function toast(msg) { $$(".toast").forEach(x => x.remove()); const t = document.createElement("div"); t.className = "toast"; t.textContent = msg; document.body.appendChild(t); setTimeout(() => t.remove(), 2800); }
function errMsg(e) { const m = (e && (e.message || e.error_description || e.error)) || "Something went wrong"; return String(m).replace(/^.*?:\s(?=[A-Z])/, ""); }
function validFlat(block, no) {
  if (!BLOCKS.includes(block)) return "Choose a block.";
  const n = String(no || "").trim(); if (!/^\d{3,4}$/.test(n)) return "Choose your flat number.";
  const f = +n.slice(0, -2), u = +n.slice(-2);
  if (f < 1 || f > 12 || u < 1 || u > 4) return "Flat " + block + "-" + n + " does not exist.";
  if (f === 12 && block !== "F" && u > 2) return "Floor 12 has only units 01 and 02 in block " + block + ".";
  return "";
}
function flatsOf(b) { const o = []; for (let f = 1; f <= 12; f++) for (let u = 1; u <= 4; u++) { if (f === 12 && b !== "F" && u > 2) continue; o.push(String(f) + pad(u)); } return o; }
const blockOpts = all => (all ? '<option value="">All</option>' : "") + BLOCKS.map(b => `<option>${b}</option>`).join("");
const flatOpts = (b, cur) => b ? '<option value="">Select flat</option>' + flatsOf(b).map(x => `<option${x === cur ? " selected" : ""}>${x}</option>`).join("") : '<option value="">Choose block first</option>';
function rid(n) { const a = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; let s = ""; crypto.getRandomValues(new Uint8Array(n)).forEach(x => s += a[x % a.length]); return s; }
function qrSvg(text) { try { const q = qrcode(0, "Q"); q.addData(text); q.make(); return q.createSvgTag({ cellSize: 4, margin: 0, scalable: true }); } catch (e) { return ""; } }
const evById = id => S.events.find(e => e.id === id);
const tok = (b, n) => b.pass_no + (n ? "-" + n : "");
const passUrl = (b, n) => SITE + "/pass.html#" + tok(b, n);
function persons(b) { const r = []; for (let i = 0; i < b.adults; i++) r.push({ n: r.length + 1, type: "Adult", gu: "મોટા" }); for (let i = 0; i < b.children; i++) r.push({ n: r.length + 1, type: "Child", gu: "બાળક" }); return r; }
function evDates(ev, b) { const ss = (ev.sessions || []).filter(s => b.sessions.includes(s.id)); const d = [...new Set(ss.map(s => fd(s.date)))]; return d.length > 3 ? d[0] + " to " + d[d.length - 1] : d.join(", "); }
const given = (b, sid, n) => ((S.checkins[b.id] || {})[sid] || {})[n] || null;
function sessLabel(ev, ids) {
  const ss = (ev && ev.sessions) || []; if (!ids || !ids.length) return "—";
  if (ev.kind === "multi" && ids.length === ss.length && ss.length > 1) return "All " + ss.length + " sessions";
  return ids.map(id => { const s = ss.find(x => x.id === id); return s ? (s.label || fd(s.date)) : "?"; }).join(", ");
}
function arm(btn, fn, label) { btn.addEventListener("click", () => { if (btn.classList.contains("armed")) { fn(); return; } const t = btn.innerHTML; btn.classList.add("armed"); btn.textContent = label || "Tap again to confirm"; setTimeout(() => { btn.classList.remove("armed"); btn.innerHTML = t; }, 3500); }); }
function loadScript(src) { return new Promise((res, rej) => { if ($(`script[src="${src}"]`)) return res(); const s = document.createElement("script"); s.src = src; s.onload = res; s.onerror = () => rej(new Error("Could not load " + src)); document.head.appendChild(s); }); }

/* ───────────── pricing & status (mirror of SQL price_for, for preview only) ───────────── */
function windowState(ev) {
  const t = today();
  if (!ev.published) return { k: "draft", label: "Draft", cls: "" };
  if (t < ev.open_date) return { k: "soon", label: "Opens " + fd(ev.open_date), cls: "info" };
  if (t > ev.close_date) return { k: "closed", label: "Closed", cls: "bad" };
  return { k: "open", label: "Open till " + fd(ev.close_date), cls: "ok" };
}
const isLate = ev => !!(ev.late_from && +ev.late_extra > 0 && today() >= ev.late_from);
function priceFor(ev, nSess, a, c) {
  if (ev.price_mode === "free") return { amount: 0, pkg: false, late: false, lateAmt: 0 };
  const all = ev.kind === "multi" && nSess === (ev.sessions || []).length && +ev.pkg_adult > 0;
  const base = all ? a * +ev.pkg_adult + c * (+ev.pkg_child > 0 ? +ev.pkg_child : +ev.child_rate * nSess) : nSess * (a * +ev.adult_rate + c * +ev.child_rate);
  const late = isLate(ev), lateAmt = late ? +ev.late_extra * (a + c) * nSess : 0;
  return { amount: base + lateAmt, pkg: all, late, lateAmt };
}
function bStatus(b) {
  if (b.status === "cancelled") return { k: "cancelled", label: "Cancelled", cls: "bad" };
  if (b.status === "paid") return +b.amount > 0 ? { k: "paid", label: "Paid" + (b.pay_mode ? " · " + (MODE[b.pay_mode] || b.pay_mode) : ""), cls: "ok" } : { k: "free", label: "Free", cls: "ok" };
  if (b.upi_ref) return { k: "upi", label: "UPI ref – verify", cls: "info" };
  return { k: "pending", label: "Payment pending", cls: "warn" };
}
const active = b => b.status !== "cancelled";
/* ── cancellation rules (mirror of SQL cancel_booking / auto_cancel_unpaid) ── */
const addDays = (iso, n) => { const x = new Date(iso + "T00:00:00"); x.setDate(x.getDate() + n); return x.getFullYear() + "-" + pad(x.getMonth() + 1) + "-" + pad(x.getDate()); };
const unpaidCutoff = ev => ev && ev.unpaid_cancel_days != null && (ev.sessions || []).length ? addDays(ev.sessions[0].date, -ev.unpaid_cancel_days) : null;
const istDate = ts => { try { return new Date(ts).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }); } catch (e) { return String(ts).slice(0, 10); } };
function cancelLines(ev, b) {
  if (!ev) return [];
  const L = [], free = ev.price_mode === "free" || (b && !(+b.amount > 0)), cut = unpaidCutoff(ev);
  if (free) { L.push({ k: "ok", gu: "ભોજન લેતા પહેલાં ગમે ત્યારે રદ કરી શકાય.", en: "Free passes can be cancelled any time before the meal is collected." }); return L; }
  L.push({ k: "ok", gu: "ચુકવણી બાકી હોય ત્યાં સુધી ગમે ત્યારે રદ કરી શકાય.", en: "Unpaid bookings can be cancelled any time." });
  if (cut && !(b && istDate(b.created_at) >= cut))
    L.push({ k: "warn", gu: `${fd(addDays(cut, -1))} સુધીમાં ચુકવણી કરો, નહીંતર ${fd(cut)}ના રોજ બુકિંગ આપોઆપ રદ થશે.`, en: `Pay by ${fd(addDays(cut, -1))}. Unpaid bookings are cancelled automatically on ${fd(cut)}${ev.unpaid_cancel_days ? ` (${ev.unpaid_cancel_days} day${ev.unpaid_cancel_days === 1 ? "" : "s"} before the event)` : ""}.` });
  if (ev.cancel_paid === "until" && ev.cancel_until)
    L.push({ k: "info", gu: `ચુકવેલ પાસ ${fd(ev.cancel_until)} સુધી રદ કરી શકાય; રકમ કમિટી પરત કરશે.`, en: `Paid passes can be cancelled until ${fd(ev.cancel_until)}; the committee refunds the amount.` });
  else L.push({ k: "bad", gu: "ચુકવણી થયા પછી પાસ રદ નહીં થાય.", en: "Paid passes cannot be cancelled." });
  return L;
}
function policyBox(ev, b, title) {
  const L = cancelLines(ev, b); if (!L.length) return "";
  return `<div class="policy"><b><span class="gu">રદ કરવાના નિયમો</span> · ${title || "Cancellation"}</b><ul>${L.map(l => `<li class="${l.k}"><span class="gu">${esc(l.gu)}</span> ${esc(l.en)}</li>`).join("")}</ul></div>`;
}
/* can the logged-in resident cancel this booking now? → {ok, why} */
function canSelfCancel(b) {
  const ev = evById(b.event_id) || {};
  if (b.status === "cancelled") return { ok: false };
  if (Object.keys(S.checkins[b.id] || {}).length) return { ok: false, why: "Meal already collected" };
  if (b.status === "pending" || !(+b.amount > 0)) return { ok: true };
  if (ev.cancel_paid !== "until" || !ev.cancel_until) return { ok: false, why: "Paid passes cannot be cancelled" };
  if (istDate(Date.now()) > ev.cancel_until) return { ok: false, why: "Cancellation closed on " + fd(ev.cancel_until) };
  return { ok: true, refund: +(b.paid_amount != null ? b.paid_amount : b.amount) };
}
const CANCEL_WHY = { resident: "by the resident", committee: "by the committee", auto_unpaid: "automatically — not paid in time" };
function cancelInfo(b, forResident) {
  if (b.status !== "cancelled") return "";
  const who = b.cancel_reason === "auto_unpaid" ? CANCEL_WHY.auto_unpaid : b.cancel_reason === "resident" ? (forResident ? "by you" : "by the resident") : b.cancel_reason === "committee" ? "by the committee" + (b.cancelled_by_name ? " (" + b.cancelled_by_name + ")" : "") : "";
  return `Cancelled ${who}${b.cancelled_at ? " on " + fdt(b.cancelled_at) : ""}`;
}
function refundInfo(b) {
  if (!b.refund_status) return null;
  const a = inr(b.refund_amount || 0);
  if (b.refund_status === "due") return { cls: "warn", label: "Refund due " + a, line: `Refund of ${a} due from the committee` };
  if (b.refund_status === "refunded") return { cls: "ok", label: "Refunded " + a, line: `${a} refunded${b.refunded_by_name ? " by " + b.refunded_by_name : ""}${b.refunded_at ? " on " + fdt(b.refunded_at) : ""}${b.refund_ref ? " · " + b.refund_ref : ""}` };
  return { cls: "", label: "No refund", line: `No refund given${b.refunded_by_name ? " (recorded by " + b.refunded_by_name + ")" : ""}${b.refund_ref ? " · " + b.refund_ref : ""}` };
}
const MODE = { cash: "Cash", upi: "UPI", other: "Other", waived: "Waived" };
/* one line: who handled the money — "Cash · received by Biren · marked by Akash" */
function payWho(b, short) {
  if (b.status !== "paid" || !b.pay_mode) return "";
  const m = MODE[b.pay_mode] || b.pay_mode, marked = b.paid_by_name || "";
  if (b.pay_mode === "cash") return `${m} · received by ${b.collected_by_name || marked || "—"}${!short && marked && marked !== b.collected_by_name ? " · marked by " + marked : ""}`;
  if (b.pay_mode === "waived") return +b.amount > 0 ? `Waived${marked ? " by " + marked : ""}` : "";
  return `${m}${b.pay_mode === "other" && b.pay_note ? " (" + b.pay_note + ")" : ""}${marked ? " · marked by " + marked : ""}`;
}
const meName = () => { const p = S.profile || {}; return (p.name || "").trim() || String(p.phone || "").slice(-10) || "you"; };
function collectorOpts(cur) {
  const list = (S.staffList || []).filter(x => x.active).map(x => ({ id: x.user_id, name: ((S.profiles[x.user_id] || {}).name || "").trim() || String((S.profiles[x.user_id] || {}).phone || "").slice(-10) || "Committee member" }))
    .sort((a, z) => (z.id === S.user.id) - (a.id === S.user.id) || a.name.localeCompare(z.name));
  return list.map(x => `<option value="${x.id}"${x.id === cur ? " selected" : ""}>${esc(x.name)}${x.id === S.user.id ? " (me)" : ""}</option>`).join("") + `<option value="__other">Someone else (type name)…</option>`;
}

/* ───────────── sheets ───────────── */
function openSheet(html, wide) {
  closeSheet();
  const o = document.createElement("div"); o.className = "ovl"; o.id = "ovl";
  o.innerHTML = `<div class="sheet${wide ? " wide" : ""}" role="dialog" aria-modal="true">${html}</div>`;
  o.addEventListener("click", e => { if (e.target === o) closeSheet(); });
  document.body.appendChild(o); document.body.style.overflow = "hidden";
  $$(".x", o).forEach(b => b.onclick = closeSheet);
  return o;
}
function closeSheet() { const o = $("#ovl"); if (o) o.remove(); document.body.style.overflow = ""; }
document.addEventListener("keydown", e => { if (e.key === "Escape") closeSheet(); });

/* ───────────── data loading ───────────── */
async function fetchAll(q) {   // pages through PostgREST results (1000 per page)
  const out = []; for (let from = 0; ; from += 1000) { const { data, error } = await q().range(from, from + 999); if (error) throw error; out.push(...data); if (data.length < 1000) return out; }
}
const normBooking = b => Object.assign(b, { flat: b.block + "-" + b.flat_no, sessions: (b.booking_sessions || []).map(x => x.session_id) });
const normEvent = e => Object.assign(e, { sessions: (e.event_sessions || []).slice().sort((a, z) => (a.date || "").localeCompare(z.date || "") || a.sort - z.sort) });

async function loadProfile() {
  const uid = S.user.id;
  const [p, st, rq] = await Promise.all([
    sb.from("profiles").select("*").eq("id", uid).maybeSingle(),
    sb.from("staff").select("*").eq("user_id", uid).maybeSingle(),
    sb.from("staff_requests").select("*").eq("user_id", uid).maybeSingle(),
  ]);
  S.profile = p.data || { id: uid, phone: S.user.phone };
  S.staff = st.data && st.data.active ? st.data : null;
  S.myRequest = rq.data || null;
}
async function loadData() {
  const evs = await fetchAll(() => sb.from("events").select("*, event_sessions(*)").order("open_date", { ascending: false }));
  S.events = evs.map(normEvent);
  const set = await sb.from("app_settings").select("key,value");
  S.settings = Object.fromEntries((set.data || []).map(r => [r.key, r.value]));
  try { await sb.rpc("auto_cancel_unpaid"); } catch (e) {}
  S.bookings = (await fetchAll(() => sb.from("bookings").select("*, booking_sessions(session_id)").order("created_at", { ascending: false }))).map(normBooking);
  const ck = await fetchAll(() => sb.from("checkins").select("*"));
  const m = {}; ck.forEach(c => { ((m[c.booking_id] = m[c.booking_id] || {})[c.session_id] = m[c.booking_id][c.session_id] || {})[c.person_no] = { at: c.given_at }; });
  S.checkins = m;
  if (isStaff()) {
    const [pr, st] = await Promise.all([fetchAll(() => sb.from("profiles").select("*")), sb.from("staff").select("*")]);
    S.profiles = Object.fromEntries(pr.map(p => [p.id, p])); S.staffList = st.data || [];
    if (isSuper()) S.requests = (await sb.from("staff_requests").select("*").order("requested_at")).data || [];
  } else {
    await Promise.all(S.events.filter(e => e.capacity > 0 && windowState(e).k === "open").map(async e => {
      const { data } = await sb.rpc("event_availability", { p_event: e.id }); if (data) S.avail[e.id] = data; }));
  }
  S.ready = true;
}
let reloadT = 0;
function reloadSoon() { clearTimeout(reloadT); reloadT = setTimeout(async () => { try { await loadData(); render(); } catch (e) { console.error(e); } }, 600); }
let channel = null;
function subscribeLive() {
  if (channel) sb.removeChannel(channel);
  channel = sb.channel("ss-live")
    .on("postgres_changes", { event: "*", schema: "public", table: "bookings" }, reloadSoon)
    .on("postgres_changes", { event: "*", schema: "public", table: "events" }, reloadSoon)
    .on("postgres_changes", { event: "*", schema: "public", table: "checkins" }, reloadSoon)
    .subscribe();
}

/* ───────────── login (mobile + OTP) ───────────── */
let otpPhone = "", resendT = 0;
function showLogin() {
  $("#login").hidden = false; $("#resident").hidden = true; $("#admin").hidden = true;
  $("#logout").hidden = true; $("#meBtn").hidden = true; $("#modeSwitch").hidden = true; $("#roleBadge").hidden = true;
}
$("#phoneForm").addEventListener("submit", async e => {
  e.preventDefault();
  const n = $("#lgPhone").value.replace(/\D/g, "").slice(-10), err = $("#lgErr1"); err.textContent = "";
  if (!/^[6-9]\d{9}$/.test(n)) { err.textContent = "Enter your 10-digit mobile number."; return; }
  const btn = $("#lgSend"); btn.disabled = true; btn.textContent = "Sending…";
  const { error } = await sb.auth.signInWithOtp({ phone: "+91" + n });
  btn.disabled = false; btn.textContent = "Send code";
  if (error) { err.textContent = /rate|security purposes/i.test(error.message) ? "Please wait a minute before asking for another code." : errMsg(error); return; }
  otpPhone = n; $("#lgTo").textContent = "+91 " + n.slice(0, 5) + " " + n.slice(5);
  $("#phoneForm").hidden = true; $("#otpForm").hidden = false; $("#lgOtp").value = ""; $("#lgOtp").focus();
  startResendTimer();
});
function startResendTimer() {
  let s = 60; const b = $("#lgResend"); b.disabled = true; clearInterval(resendT);
  resendT = setInterval(() => { s--; b.textContent = s > 0 ? `Resend code in ${s}s` : "Resend code"; if (s <= 0) { b.disabled = false; clearInterval(resendT); } }, 1000);
}
$("#lgResend").onclick = async () => { const { error } = await sb.auth.signInWithOtp({ phone: "+91" + otpPhone }); if (error) $("#lgErr2").textContent = errMsg(error); else { toast("New code sent"); startResendTimer(); } };
$("#lgChange").onclick = () => { $("#otpForm").hidden = true; $("#phoneForm").hidden = false; $("#lgPhone").focus(); };
$("#lgOtp").addEventListener("input", e => { e.target.value = e.target.value.replace(/\D/g, "").slice(0, 6); if (e.target.value.length === 6) $("#otpForm").requestSubmit(); });
$("#otpForm").addEventListener("submit", async e => {
  e.preventDefault();
  const code = $("#lgOtp").value, err = $("#lgErr2"); err.textContent = "";
  if (!/^\d{6}$/.test(code)) { err.textContent = "Enter the 6-digit code from the SMS."; return; }
  const btn = $("#lgVerify"); btn.disabled = true; btn.textContent = "Checking…";
  const { error } = await sb.auth.verifyOtp({ phone: "+91" + otpPhone, token: code, type: "sms" });
  btn.disabled = false; btn.textContent = "Verify & log in";
  if (error) err.textContent = /expired|invalid/i.test(error.message) ? "That code is wrong or has expired. Check the SMS or resend." : errMsg(error);
});
$("#logout").onclick = async () => { await sb.auth.signOut(); location.hash = ""; location.reload(); };

/* ───────────── resident: account / profile ───────────── */
function profileComplete() { const p = S.profile || {}; return !!(p.name && p.block && p.flat_no && p.email); }
function renderAccount() {
  const box = $("#acctBox"), pf = S.profile || {};
  const phone10 = String(pf.phone || S.user.phone || "").slice(-10);
  const me = $("#meBtn");
  if (profileComplete() && !S.editProfile) {
    me.textContent = pf.name.trim().charAt(0).toUpperCase(); me.hidden = false;
    box.innerHTML = ""; $("#acct").hidden = true;
    return;
  }
  me.hidden = true; $("#acct").hidden = false;
  box.innerHTML = `<div class="card"><h3 class="gu">તમારી વિગતો · Your details</h3>
    <p class="small muted" style="margin:4px 0 12px">One-time setup. Passes are booked for this flat. Only you and the committee can see your bookings.</p>
    <div class="grid2">
      <div class="field"><label for="pfName">Full name <span class="gu">નામ</span></label><input id="pfName" type="text" maxlength="60" value="${esc(pf.name || "")}" autocomplete="name"></div>
      <div class="field"><span class="lab">Flat <span class="gu">ફ્લેટ</span></span><div class="row" style="flex-wrap:nowrap"><select id="pfBlock" aria-label="Block" style="width:84px"><option value="">–</option>${blockOpts()}</select><select id="pfFlat" aria-label="Flat number">${flatOpts(pf.block || "", pf.flat_no)}</select></div></div>
      <div class="field"><label>Mobile (verified)</label><input type="text" value="${esc(phone10)}" disabled></div>
      <div class="field"><label for="pfMail">Email <span class="gu">ઈમેલ</span></label><input id="pfMail" type="email" maxlength="80" value="${esc(pf.email || "")}" autocomplete="email"></div>
    </div><div class="err" id="pfErr"></div>
    <div class="row">${profileComplete() ? `<button class="btn" type="button" id="pfCancel">Cancel</button>` : ""}<button class="btn primary" type="button" id="pfSave">Save my details</button></div></div>`;
  if (pf.block) $("#pfBlock").value = pf.block;
  $("#pfBlock").onchange = () => { $("#pfFlat").innerHTML = flatOpts($("#pfBlock").value); };
  if ($("#pfCancel")) $("#pfCancel").onclick = () => { S.editProfile = false; renderAccount(); };
  $("#pfSave").onclick = async () => {
    const name = $("#pfName").value.trim(), blk = $("#pfBlock").value, no = $("#pfFlat").value, mail = $("#pfMail").value.trim().toLowerCase(), err = $("#pfErr");
    if (!name) return err.textContent = "Enter your name.";
    const fe = validFlat(blk, no); if (fe) return err.textContent = fe;
    if (!validEmail(mail)) return err.textContent = "Enter a valid email. Passes are sent to it.";
    const { data, error } = await sb.from("profiles").update({ name, block: blk, flat_no: no, email: mail }).eq("id", S.user.id).select().single();
    if (error) return err.textContent = errMsg(error);
    S.profile = data; S.editProfile = false; toast("Details saved"); render();
  };
}

function profileSheet() {
  const pf = S.profile || {}, phone10 = String(pf.phone || S.user.phone || "").slice(-10);
  openSheet(`<header><div><div class="muted small gu">મારી વિગતો</div><h2>My profile</h2></div><button class="x" type="button" aria-label="Close">×</button></header>
    <div class="acct"><div class="av">${esc((pf.name || "?").trim().charAt(0).toUpperCase())}</div>
      <div style="min-width:0"><b style="font-size:1.05rem">${esc(pf.name || "")}</b>
      <div class="small"><b>${esc(pf.block)}-${esc(pf.flat_no)}</b> · <span class="mono">${esc(phone10)}</span></div>
      <div class="small muted" style="overflow-wrap:anywhere">${esc(pf.email || "")}</div></div></div>
    <p class="small muted" style="margin:12px 0">Your bookings are private: only you and the committee can see them.</p>
    <div class="row"><button class="btn primary" type="button" id="pfEdit">Edit details</button><button class="btn" type="button" id="pfOut">Log out</button></div>`);
  $("#pfEdit").onclick = () => { closeSheet(); S.editProfile = true; renderAccount(); $("#acct").scrollIntoView({ behavior: "smooth", block: "start" }); };
  $("#pfOut").onclick = () => $("#logout").click();
}
$("#meBtn").onclick = profileSheet;

/* ───────────── resident: events & booking ───────────── */
function eventCard(ev) {
  const w = windowState(ev), ss = ev.sessions || [];
  const dates = ss.length ? (ss.length === 1 ? fd(ss[0].date) : fd(ss[0].date) + " → " + fd(ss[ss.length - 1].date)) : "";
  let price = "";
  if (ev.price_mode === "free") price = `<div><span class="lbl gu">નિઃશુલ્ક</span><b>Free</b></div>`;
  else {
    const per = ev.kind === "multi" ? " / session" : "";
    price = `<div><span class="lbl">Adult${per}</span><b>${inr(ev.adult_rate)}</b> ${ev.price_mode === "discount" && +ev.cost > +ev.adult_rate ? `<s>${inr(ev.cost)}</s>` : ""}</div>` +
      `<div><span class="lbl">Child${ev.child_note ? " (" + esc(ev.child_note) + ")" : ""}</span><b>${inr(ev.child_rate)}</b></div>` +
      (ev.kind === "multi" && +ev.pkg_adult > 0 ? `<div><span class="lbl">All ${ss.length} sessions</span><b>${inr(ev.pkg_adult)}</b></div>` : "");
  }
  const late = ev.price_mode !== "free" && ev.late_from && +ev.late_extra > 0 ? `<div class="late"><svg class="ic sm"><use href="#i-clock"/></svg>${isLate(ev) ? `Late booking rate applies: +${inr(ev.late_extra)} per person per session.` : `Book before ${fd(ev.late_from)}. From then, +${inr(ev.late_extra)} per person per session.`}</div>` : "";
  const av = S.avail[ev.id], left = av ? Math.max(0, av.capacity - av.booked) : null;
  const d0 = ss[0] && ss[0].date ? ss[0].date.split("-") : null;
  return `<article class="ev">
    <div class="evtop">
      <div class="dtile">${d0 ? `<div class="m">${MON[+d0[1] - 1]}</div><div class="d">${+d0[2]}</div><div class="n">${ss.length > 1 ? ss.length + " days" : d0[0]}</div>` : `<div class="m">TBA</div><div class="d">–</div><div class="n">&nbsp;</div>`}</div>
      <div style="min-width:0"><div class="spread" style="gap:6px"><span class="when">${esc(dates)}</span><span class="chip ${w.cls}">${esc(w.label)}</span></div>
      <h3><span class="gu">${esc(ev.name_gu || ev.name_en)}</span>${ev.name_gu && ev.name_en ? `<span class="en">${esc(ev.name_en)}</span>` : ""}</h3></div>
    </div>
    <div class="meta">${[...new Set(ss.map(s => s.meal))].map(m => `<span class="tag">${esc(MEAL_GU[m] || m)} · ${esc(m)}</span>`).join("")}${ev.venue ? `<span class="tag"><svg class="ic sm"><use href="#i-pin"/></svg>${esc(ev.venue)}</span>` : ""}${left != null ? `<span class="tag">${left} places left</span>` : ""}</div>
    ${ev.notes ? `<div class="small muted">${esc(ev.notes)}</div>` : ""}
    <div class="price">${price}</div>${late}
    ${ev.price_mode === "free" ? "" : `<div class="policy mini">${cancelLines(ev).map(l => `<span class="${l.k}">${esc(l.en)}</span>`).join("")}</div>`}
    ${tilePasses(ev)}
    ${w.k === "open" && left !== 0 ? `<button class="btn primary" data-book="${ev.id}" type="button"><svg class="ic sm"><use href="#i-ticket"/></svg>${mineFor(ev).length ? "વધુ પાસ બુક કરો · Book more passes" : "પાસ બુક કરો · Book pass"}</button>` : (left === 0 ? `<div class="chip bad">Fully booked</div>` : "")}
  </article>`;
}
/* resident's own active bookings for one event (RLS already limits S.bookings, filter again to be safe) */
const mineFor = ev => S.bookings.filter(b => b.user_id === S.user.id && b.event_id === ev.id && active(b)).sort((x, y) => x.created_at.localeCompare(y.created_at));
function tilePasses(ev) {
  const list = mineFor(ev); if (!list.length) return "";
  const T = sumUp(list), past = (((ev.sessions || []).slice(-1)[0] || {}).date || "") < today();
  const rows = []; list.forEach(b => persons(b).forEach(pp => rows.push({ b, pp, st: personState(b, pp.n) })));
  const ready = rows.filter(r => r.st.ok).length;
  const head = `<span class="tp-h"><svg class="ic sm"><use href="#i-ticket"/></svg><span><b><span class="gu">તમારા પાસ</span> · Your passes</b>
      <small>${pplTxt(T.adults, T.children)} · ${T.amount > 0 ? inr(T.amount) : "Free"}${T.due > 0 ? ` · <span class="due">due ${inr(T.due)}</span>` : T.amount > 0 ? ` · <span class="okc">paid</span>` : ""}</small></span></span>
    <span class="evtot"><b>${T.persons}</b></span>`;
  const body = `<div class="tp-list">${rows.map(r => {
      const bs = bStatus(r.b), chip = r.st.done ? `<span class="chip info">${esc(r.st.why)}</span>` : r.b.status === "paid" ? `<span class="chip ok">${r.st.ok ? "Ready" : esc(r.st.why)}</span>` : `<span class="chip ${bs.cls}">${esc(bs.label)}</span>`;
      return `<button type="button" class="tp-row" data-tq="${r.b.id}:${r.pp.n}"><span class="tp-qr">${qrSvg(passUrl(r.b, r.pp.n))}</span>
        <span class="tp-txt"><b>${r.pp.type} ${r.pp.n}</b><small class="mono">${esc(tok(r.b, r.pp.n))}</small></span>${chip}</button>`;
    }).join("")}</div>
    <div class="tp-act">${ready > 1 && !past ? `<button class="btn sm primary" type="button" data-together="${ev.id}"><svg class="ic sm"><use href="#i-scan"/></svg>Collect ${ready} together</button>` : ""}
      <a class="btn sm" href="#mypasses" data-gotomine="${ev.id}">Payment & details</a></div>`;
  return collapsible("tp:" + ev.id, isOpen("tp:" + ev.id, false), head, body, "tpass");
}
function personQrSheet(b, n) {
  openSheet(`<header><div><div class="muted small">Show this QR at the counter</div><h2>${persons(b)[n - 1].type} ${n} <span class="muted small">of ${b.adults + b.children}</span></h2></div><button class="x" type="button" aria-label="Close">×</button></header>
    <div class="tickets one">${ticket(b, n)}</div>`);
}
function renderResident() {
  renderAccount();
  const box = $("#resEvents");
  const list = S.events.filter(e => e.published && !(windowState(e).k === "closed" && ((e.sessions.slice(-1)[0] || {}).date || "") < today()))
    .sort((a, b) => String((a.sessions[0] || {}).date).localeCompare(String((b.sessions[0] || {}).date)));
  box.innerHTML = list.length ? list.map(eventCard).join("") : `<div class="empty" style="grid-column:1/-1"><b>હાલ કોઈ બુકિંગ ચાલુ નથી</b>No booking is open right now. Events such as 26 January, 15 August, Holi and Navratri will appear here when the committee opens booking.</div>`;
  box.onclick = e => {
    const t = e.target.closest("[data-tg]"); if (t) { toggleBox(t); return; }
    const q = e.target.closest("[data-tq]"); if (q) { const [id, n] = q.dataset.tq.split(":"); const b = S.bookings.find(x => x.id === id); if (b) personQrSheet(b, +n); return; }
    const g = e.target.closest("[data-together]"); if (g) { groupSheet(evById(g.dataset.together)); return; }
    const m = e.target.closest("[data-gotomine]"); if (m) { e.preventDefault(); $("#myEv").value = m.dataset.gotomine; openState["ev:" + m.dataset.gotomine] = true; renderMine(); $("#mypasses").scrollIntoView({ behavior: "smooth", block: "start" }); }
  };
  $$("[data-book]", box).forEach(b => b.onclick = () => {
    if (!profileComplete()) { S.editProfile = true; renderAccount(); $("#acct").scrollIntoView({ behavior: "smooth" }); toast("Add your details first, then book."); return; }
    bookingForm(evById(b.dataset.book), false);
  });
  renderMine(); renderReqBox();
}
/* totals of a set of bookings (active only) — used for "already booked / adding now / new total" */
function sumUp(list) {
  const act = list.filter(active), r = { count: act.length, adults: 0, children: 0, amount: 0, paid: 0, due: 0 };
  act.forEach(b => { r.adults += b.adults; r.children += b.children; r.amount += +b.amount; if (b.status === "paid") r.paid += +b.amount; else r.due += +b.amount; });
  r.persons = r.adults + r.children; return r;
}
const pplTxt = (a, c) => `${a + c} pass${a + c === 1 ? "" : "es"} (${a} adult${a === 1 ? "" : "s"}${c ? ", " + c + " child" + (c > 1 ? "ren" : "") : ""})`;
function bookingForm(ev, asAdmin, preset) {
  if (!ev) return;
  const ss = ev.sessions || [], multi = ev.kind === "multi" && ss.length > 1, pf = S.profile || {};
  const evOpts = asAdmin ? S.events.map(e => `<option value="${e.id}"${e.id === ev.id ? " selected" : ""}>${esc(e.name_en || e.name_gu)}</option>`).join("") : "";
  const o = openSheet(`
    <header><div><div class="muted small">${asAdmin ? "Booking on behalf of a resident" : "પાસ બુકિંગ · Pass booking"}</div><h2 class="gu">${esc(ev.name_gu || ev.name_en)}</h2>${ev.name_gu && ev.name_en ? `<div class="muted">${esc(ev.name_en)}</div>` : ""}</div><button class="x" type="button" aria-label="Close">×</button></header>
    ${asAdmin ? `<div class="field"><label for="fEv">Event</label><select id="fEv">${evOpts}</select></div>` : ""}
    <div id="dupNote"></div>
    <div class="grid3">
      <div class="field"><label for="fBlock">Block <span class="gu">બ્લોક</span></label><select id="fBlock"><option value="">–</option>${blockOpts()}</select></div>
      <div class="field"><label for="fFlat">Flat no. <span class="gu">ફ્લેટ</span></label><select id="fFlat"><option value="">Choose block first</option></select></div>
      <div class="field"><label for="fMob">Mobile <span class="gu">મોબાઇલ</span></label><input id="fMob" type="tel" inputmode="numeric" maxlength="10" placeholder="10 digits"></div>
    </div>
    <div class="grid2">
      <div class="field"><label for="fName">Name on pass <span class="gu">નામ</span></label><input id="fName" type="text" maxlength="60"></div>
      <div class="field"><label for="fMail">Email <span class="gu">ઈમેલ</span></label><input id="fMail" type="email" maxlength="80" placeholder="name@gmail.com"></div>
    </div>
    ${multi ? `<div class="field"><div class="spread"><span class="lab">Sessions <span class="gu">દિવસ/સમય</span></span><span class="row"><button class="btn sm" type="button" id="sAll">Select all</button><button class="btn sm" type="button" id="sNone">Clear</button></span></div>
      <div class="sesslist">${ss.map(s => `<label class="sess"><input type="checkbox" value="${s.id}" checked><span>${esc(s.label || s.meal)}<small>${fd(s.date)} · ${esc(s.meal)}</small></span></label>`).join("")}</div></div>` : ""}
    <div class="row" style="gap:20px">
      <div class="field"><span class="lab">Adults <span class="gu">મોટા</span></span><div class="step"><button type="button" data-d="a" data-v="-1" aria-label="Fewer adults">−</button><output id="oA">1</output><button type="button" data-d="a" data-v="1" aria-label="More adults">+</button></div></div>
      <div class="field"><span class="lab">Children <span class="gu">બાળકો</span>${ev.child_note ? " (" + esc(ev.child_note) + ")" : ""}</span><div class="step"><button type="button" data-d="c" data-v="-1" aria-label="Fewer children">−</button><output id="oC">0</output><button type="button" data-d="c" data-v="1" aria-label="More children">+</button></div></div>
    </div>
    <div class="field"><span class="lab">How will you show the pass? <span class="gu">પાસ કેવી રીતે જોઈએ?</span></span>
      <div class="seg"><label><input type="radio" name="fType" value="mobile" checked> <span><span class="gu">મોબાઇલ પાસ</span> · Mobile pass <small class="muted" style="display:block">QR on WhatsApp &amp; email, show on phone</small></span></label>
      <label><input type="radio" name="fType" value="physical"> <span><span class="gu">પ્રિન્ટેડ પાસ</span> · Printed pass <small class="muted" style="display:block">Collect from the committee desk</small></span></label></div></div>
    <div class="sumbox" id="sumBox"></div>
    ${policyBox(ev, null)}
    <div class="err" id="fErr"></div>
    <div class="row" style="justify-content:flex-end"><button class="btn" type="button" id="fCancel">Cancel</button><button class="btn primary" type="button" id="fGo">${asAdmin ? "Create booking" : "બુક કરો · Confirm booking"}</button></div>`);
  let a = 1, c = 0;
  $("#fBlock", o).addEventListener("change", () => { $("#fFlat", o).innerHTML = flatOpts($("#fBlock", o).value); upd(); });
  if (asAdmin) {
    if (preset) { $("#fBlock", o).value = preset.block || ""; $("#fFlat", o).innerHTML = flatOpts(preset.block, preset.no); }
    $("#fEv", o).onchange = e => bookingForm(evById(e.target.value), true, { block: $("#fBlock", o).value, no: $("#fFlat", o).value });
  } else {
    $("#fBlock", o).value = pf.block; $("#fFlat", o).innerHTML = flatOpts(pf.block, pf.flat_no);
    $("#fBlock", o).disabled = true; $("#fFlat", o).disabled = true;
    $("#fMob", o).value = String(pf.phone || "").slice(-10); $("#fName", o).value = pf.name || ""; $("#fMail", o).value = pf.email || "";
  }
  $("#fCancel", o).onclick = closeSheet;
  const chosen = () => multi ? $$(".sesslist input:checked", o).map(i => i.value) : ss.map(s => s.id);
  function upd() {
    $("#oA", o).textContent = a; $("#oC", o).textContent = c;
    const n = chosen().length, pr = priceFor(ev, n, a, c);
    const how = ev.price_mode === "free" ? "Free pass" : (pr.pkg ? "Full package rate" : (n + " session" + (n === 1 ? "" : "s") + " × " + (a + c) + " person" + (a + c === 1 ? "" : "s"))) + (pr.late ? " · incl. late fee " + inr(pr.lateAmt) : "");
    const flat = $("#fBlock", o).value && $("#fFlat", o).value ? $("#fBlock", o).value + "-" + $("#fFlat", o).value : "";
    const prev = S.bookings.filter(b => b.event_id === ev.id && active(b) && (asAdmin ? (flat && b.flat === flat) : b.user_id === S.user.id));
    const P = sumUp(prev);
    $("#dupNote", o).innerHTML = P.count ? `<div class="prevbox">
        <div class="spread"><b>${asAdmin ? "Flat " + esc(flat) + " has already booked" : "<span class='gu'>તમે પહેલેથી બુક કર્યું છે</span> · You have already booked"}</b><span class="chip info">${P.count} booking${P.count > 1 ? "s" : ""}</span></div>
        <div class="prevlist">${prev.map((b, i) => { const st = bStatus(b); return `<div class="prevrow"><span class="num">${i + 1}.</span><span>${pplTxt(b.adults, b.children)}<small class="mono">${esc(b.pass_no)}</small></span><span class="num">${+b.amount > 0 ? inr(b.amount) : "Free"}</span><span class="chip ${st.cls}">${esc(st.label)}</span></div>`; }).join("")}</div>
        <div class="small muted">This form adds a <b>new, separate booking</b> with its own passes. Your earlier passes stay as they are.</div></div>` : "";
    const T = { a: P.adults + a, c: P.children + c, amt: P.amount + pr.amount };
    $("#sumBox", o).innerHTML = (P.count ? `
      <div class="sumrow"><span>Already booked</span><span>${pplTxt(P.adults, P.children)}</span><b class="num">${inr(P.amount)}</b></div>
      <div class="sumrow now"><span>Adding now <small>${esc(how)}</small></span><span>${pplTxt(a, c)}</span><b class="num">${inr(pr.amount)}</b></div>
      <div class="sumrow total-line"><span>Total for this event</span><span>${pplTxt(T.a, T.c)}</span><b class="num">${inr(T.amt)}</b></div>` : "") +
      `<div class="total"><div><div class="lab">${P.count ? "Pay for this new booking" : "Amount payable"} <span class="gu">${P.count ? "આ બુકિંગની રકમ" : "કુલ રકમ"}</span></div><div class="small muted">${P.count ? pplTxt(a, c) + " · " : ""}${esc(how)}</div></div><b class="num" id="tAmt">${inr(pr.amount)}</b></div>`;
    $("#fGo", o).textContent = asAdmin ? (P.count ? "Add booking" : "Create booking") : (P.count ? `Add ${a + c} more pass${a + c === 1 ? "" : "es"}` : "બુક કરો · Confirm booking");
  }
  $$(".step button", o).forEach(b => b.onclick = () => { const v = +b.dataset.v; if (b.dataset.d === "a") a = Math.max(0, Math.min(20, a + v)); else c = Math.max(0, Math.min(20, c + v)); upd(); });
  if (multi) { $$(".sesslist input", o).forEach(i => i.onchange = upd); $("#sAll", o).onclick = () => { $$(".sesslist input", o).forEach(i => i.checked = true); upd(); }; $("#sNone", o).onclick = () => { $$(".sesslist input", o).forEach(i => i.checked = false); upd(); }; }
  $("#fFlat", o).addEventListener("change", upd);
  upd();
  $("#fGo", o).onclick = async () => {
    const err = $("#fErr", o); err.textContent = "";
    const blk = $("#fBlock", o).value, no = $("#fFlat", o).value, name = $("#fName", o).value.trim(), mob = $("#fMob", o).value.replace(/\D/g, ""), mail = $("#fMail", o).value.trim().toLowerCase();
    const fe = validFlat(blk, no); if (fe) return err.textContent = fe;
    if (!name) return err.textContent = "Please enter the name for the pass.";
    if (!/^[6-9]\d{9}$/.test(mob)) return err.textContent = "Enter a valid 10-digit mobile number.";
    if (mail && !validEmail(mail)) return err.textContent = "Enter a valid email address.";
    if (!asAdmin && !mail) return err.textContent = "Enter your email. Passes are sent to it.";
    const ids = chosen(); if (!ids.length) return err.textContent = "Select at least one session.";
    if (a + c < 1) return err.textContent = "Add at least one person.";
    const btn = $("#fGo", o); btn.disabled = true; btn.textContent = "Saving…";
    const { data, error } = await sb.rpc("create_booking", { p_event: ev.id, p_sessions: ids, p_adults: a, p_children: c, p_pass_type: $("input[name=fType]:checked", o).value,
      p_name: name, p_mobile: mob, p_email: mail || null, p_block: asAdmin ? blk : null, p_flat: asAdmin ? no : null });
    if (error) { btn.disabled = false; btn.textContent = "Try again"; err.textContent = errMsg(error); return; }
    const b = normBooking(Object.assign({}, data, { booking_sessions: ids.map(id => ({ session_id: id })) }));
    S.bookings.unshift(b); confirmSheet(b, asAdmin); reloadSoon();
  };
}

/* ───────────── passes ───────────── */
function ticket(b, n) {
  const ev = evById(b.event_id) || {}, st = bStatus(b), p = persons(b)[n - 1] || { type: "Person", gu: "" }, tot = b.adults + b.children;
  return `<div class="tk">
    <div class="tk-h"><div class="gu">${esc(ev.name_gu || ev.name_en || "")}</div>${ev.name_gu && ev.name_en ? `<small>${esc(ev.name_en)}</small>` : ""}</div>
    <div class="tk-b"><div class="qr">${qrSvg(passUrl(b, n))}</div>
      <dl class="kv"><dt>Person</dt><dd><b>${p.type} ${n}</b> <span class="muted">of ${tot}</span> <span class="gu muted">${p.gu}</span></dd>
      <dt>Flat</dt><dd><b>${esc(b.flat)}</b></dd><dt>Name</dt><dd>${esc(b.name)}</dd>
      <dt>Date</dt><dd>${esc(evDates(ev, b))}</dd><dt>Session</dt><dd>${esc(sessLabel(ev, b.sessions))}</dd></dl></div>
    <div class="tk-f"><span class="mono">${esc(tok(b, n))}</span><span class="chip ${st.cls}">${esc(st.label)}</span></div>
  </div>`;
}
function passCard(b, actions) {
  const ev = evById(b.event_id) || {}, st = bStatus(b), tot = b.adults + b.children;
  return `<div class="passwrap">
    <div class="spread"><div><b class="gu">${esc(ev.name_gu || ev.name_en || "")}</b> · ${esc(b.flat)} · ${esc(b.name)}<div class="small muted">${tot} person${tot === 1 ? "" : "s"} · ${esc(evDates(ev, b))} · ${+b.amount > 0 ? inr(b.amount) : "Free"} · ${b.pass_type === "physical" ? "Printed pass" : "Mobile pass"} · <span class="mono">${esc(b.pass_no)}</span></div></div><span class="chip ${st.cls}">${esc(st.label)}</span></div>
    ${b.status === "cancelled" ? "" : `<div class="tickets">${persons(b).map(p => ticket(b, p.n)).join("")}</div>`}
    ${actions || ""}
  </div>`;
}
function upiBlock(b) {
  const u = S.settings.upi || {}; if (!u.enabled || !u.id || !(+b.amount > 0) || b.status !== "pending") return "";
  const uri = "upi://pay?pa=" + encodeURIComponent(u.id) + "&pn=" + encodeURIComponent(u.name || "Serenity Space") + "&am=" + (+b.amount).toFixed(2) + "&cu=INR&tn=" + encodeURIComponent(b.pass_no);
  return `<div class="upi"><div class="qr">${qrSvg(uri)}</div><div style="min-width:0;display:flex;flex-direction:column;gap:6px">
    <div><b>Pay ${inr(b.amount)} by UPI</b><div class="small muted">Scan with any UPI app, or <a href="${esc(uri)}">open your UPI app</a>. Pass no. ${esc(b.pass_no)} is filled in as the note.</div></div>
    <div class="small">UPI ID: <span class="mono" style="user-select:all">${esc(u.id)}</span></div>
    <div class="row"><input type="text" id="utr_${b.id}" placeholder="12-digit UTR / reference" value="${esc(b.upi_ref || "")}" style="flex:1 1 160px"><button class="btn sm primary" data-utr="${b.id}" type="button">${b.upi_ref ? "Update" : "Submit"}</button></div>
    ${b.upi_ref ? `<div class="small" style="color:var(--info)">Reference received. The committee will verify and confirm.</div>` : ""}
  </div></div>`;
}
function wireUtr(root) {
  $$("[data-utr]", root).forEach(btn => btn.onclick = async () => {
    const id = btn.dataset.utr, v = $("#utr_" + id, root).value.trim();
    const { error } = await sb.rpc("submit_upi_ref", { p_booking: id, p_ref: v });
    if (error) toast(errMsg(error)); else { toast("Reference saved. Thank you."); reloadSoon(); }
  });
}
const ST_GU = { paid: "ચૂકવેલ ✅", free: "નિઃશુલ્ક ✅", pending: "બાકી – કમિટી ડેસ્ક પર ચૂકવો", upi: "UPI ચકાસણી બાકી", cancelled: "રદ" };
function waText(b) {
  const ev = evById(b.event_id) || {}, st = bStatus(b), desk = (S.settings.desk || {}).place;
  const amt = +b.amount > 0 ? inr(b.amount) : "—", mobile = b.pass_type !== "physical", dates = evDates(ev, b);
  const links = persons(b).map(p => `${p.type} ${p.n}: ${passUrl(b, p.n)}`).join("\n");
  return [`🎟️ *Serenity Space – ભોજન પાસ*`, ``, `*${ev.name_gu || ev.name_en}*`, `ફ્લેટ: *${b.flat}*  |  ${b.name}`,
    `વ્યક્તિ: ${b.adults} મોટા${b.children ? ", " + b.children + " બાળક" : ""}`, `તારીખ: ${dates}`, `રકમ: ${amt} – ${ST_GU[st.k] || st.label}`, ``,
    `પાસ નંબર: *${b.pass_no}*`, mobile ? `દરેક વ્યક્તિનો QR અલગ છે. કાઉન્ટર પર લિંક ખોલી QR બતાવો 👇` : `પ્રિન્ટેડ પાસ કમિટી ડેસ્ક પરથી મેળવો. નીચેની લિંક પણ ચાલશે 👇`, ``,
    `🎟️ *Serenity Space – Meal Pass*`, ``, `*${ev.name_en || ev.name_gu}*`, `Flat: *${b.flat}*  |  ${b.name}`,
    `Persons: ${b.adults} adult${b.adults === 1 ? "" : "s"}${b.children ? ", " + b.children + " child" + (b.children > 1 ? "ren" : "") : ""}`, `Date: ${dates}`,
    `Amount: ${amt} – ${st.k === "pending" ? "Payment pending, please pay at the committee desk" : st.label}`, ``, `Pass no.: *${b.pass_no}*`,
    mobile ? `Each person has a separate QR. Open the link and show it at the counter:` : `Collect your printed passes from the committee desk. These links also work:`, ``,
    links, (st.k === "pending" && desk ? `\n📍 ${desk}` : ""), ``, `🌿 Serenity Space Committee`].join("\n");
}
const waLink = (b, toSelf) => "https://wa.me/" + (toSelf ? "" : "91" + b.mobile) + "?text=" + encodeURIComponent(waText(b));

function confirmSheet(b, asAdmin) {
  const desk = S.settings.desk || {}, mobile = b.pass_type !== "physical";
  const o = openSheet(`
    <header><div><div class="chip ok">Booked</div><h2 style="margin-top:6px" class="gu">બુકિંગ થઈ ગયું · Booking confirmed</h2></div><button class="x" type="button" aria-label="Close">×</button></header>
    ${(() => { const all = S.bookings.filter(x => x.event_id === b.event_id && active(x) && (asAdmin ? x.flat === b.flat : x.user_id === S.user.id) && x.id !== b.id); if (!all.length) return "";
      const T = sumUp(all.concat([b])); return `<div class="prevbox"><b>This is booking ${all.length + 1} for this event.</b>
        <div class="sumrow"><span>Earlier</span><span>${pplTxt(T.adults - b.adults, T.children - b.children)}</span><b class="num">${inr(T.amount - b.amount)}</b></div>
        <div class="sumrow now"><span>Just added</span><span>${pplTxt(b.adults, b.children)}</span><b class="num">${inr(b.amount)}</b></div>
        <div class="sumrow total-line"><span>Total now</span><span>${pplTxt(T.adults, T.children)}</span><b class="num">${inr(T.amount)}</b></div></div>`; })()}
    ${passCard(b)}
    ${+b.amount > 0 ? `<div class="notice small"><span class="gu">${inr(b.amount)} કમિટી ડેસ્ક પર ચૂકવો. ${mobile ? "પેમેન્ટ પછી પાસ માન્ય થશે." : "પેમેન્ટ પછી પ્રિન્ટેડ પાસ મળશે."}</span><br>Pay ${inr(b.amount)} at the committee desk${(S.settings.upi || {}).enabled ? " or by UPI below" : ""}. ${mobile ? "Your mobile pass becomes valid once payment is confirmed." : "Your printed pass is handed over after payment."}${desk.place ? "<br><b>Desk:</b> " + esc(desk.place) : ""}${desk.contact ? "<br><b>Contact:</b> " + esc(desk.contact) : ""}</div>` : `<div class="notice small">This is a free pass.</div>`}
    ${upiBlock(b)}
    ${policyBox(evById(b.event_id), b)}
    <div class="row"><a class="btn primary" href="${esc(asAdmin ? waLink(b) : waLink(b, true))}" target="_blank" rel="noopener">${asAdmin ? "Send on WhatsApp to " + esc(b.mobile) : "Save passes to my WhatsApp"}</a>${asAdmin && b.email ? `<button class="btn" type="button" id="cMail">Email passes</button>` : ""}</div>
    <div class="err" id="cErr"></div>
    <div class="row" style="justify-content:flex-end">${asAdmin ? `<button class="btn" type="button" id="cAnother">Book another</button>` : ""}<button class="btn x2" type="button">Done</button></div>`);
  $(".x2", o).onclick = closeSheet; wireUtr(o);
  if (asAdmin) {
    $("#cAnother", o).onclick = () => bookingForm(evById(b.event_id), true);
    if ($("#cMail", o)) $("#cMail", o).onclick = () => emailPass(b, $("#cMail", o), $("#cErr", o));
  }
}
function paySection(b) {
  const st = bStatus(b), desk = S.settings.desk || {};
  if (b.status === "cancelled") { const rf = refundInfo(b);
    return `<div class="paysec"><div class="payrow"><span>Status</span><span class="chip bad">Cancelled</span></div>
      <div class="small muted">${esc(cancelInfo(b, true))}.</div>${rf ? `<div class="payrow"><span>Refund</span><span class="chip ${rf.cls}">${esc(rf.label)}</span></div><div class="small muted">${esc(rf.line)}.</div>` : ""}</div>`; }
  return `<div class="paysec">
    <div class="payrow"><span>Amount</span><b class="num">${+b.amount > 0 ? inr(b.amount) : "Free"}</b></div>
    <div class="payrow"><span>Status</span><span class="chip ${st.cls}">${esc(st.label)}</span></div>
    ${b.paid_at && b.status === "paid" && +b.amount > 0 ? `<div class="payrow"><span>Paid on</span><span>${fdt(b.paid_at)}</span></div>
      ${b.pay_mode === "cash" && b.collected_by_name ? `<div class="payrow"><span>Cash received by</span><span>${esc(b.collected_by_name)}</span></div>` : ""}
      ${b.pay_mode !== "cash" && b.paid_by_name ? `<div class="payrow"><span>${b.pay_mode === "upi" ? "UPI verified by" : "Recorded by"}</span><span>${esc(b.paid_by_name)}</span></div>` : ""}
      ${b.pay_ref ? `<div class="payrow"><span>${b.pay_mode === "upi" ? "UTR" : "Receipt no."}</span><span class="mono">${esc(b.pay_ref)}</span></div>` : ""}` : ""}
    ${b.status === "pending" ? `<div class="small muted"><span class="gu">કમિટી ડેસ્ક પર ચૂકવો</span> · Pay at the committee desk${(S.settings.upi || {}).enabled ? " or by UPI" : ""}.${desk.place ? " " + esc(desk.place) + "." : ""}${desk.contact ? " Contact " + esc(desk.contact) + "." : ""}</div>` : ""}
    ${upiBlock(b)}
  </div>`;
}
/* ── collapsible sections: state survives re-renders (live updates) ── */
const openState = {};
const isOpen = (key, dflt) => (key in openState ? openState[key] : dflt);
const chev = `<svg class="ic sm chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>`;
function collapsible(key, open, headHtml, bodyHtml, cls) {
  return `<div class="cbox ${cls || ""}${open ? " open" : ""}" data-key="${key}">
    <button class="chead" type="button" aria-expanded="${open}" data-tg="${key}">${headHtml}${chev}</button>
    <div class="coll"><div class="coll-in"${open ? "" : " inert"}>${bodyHtml}</div></div></div>`;
}
function toggleBox(btn) {
  const box = btn.closest(".cbox"), key = box.dataset.key, open = !box.classList.contains("open");
  openState[key] = open; box.classList.toggle("open", open); btn.setAttribute("aria-expanded", String(open));
  const inner = box.querySelector(":scope > .coll > .coll-in"); if (open) inner.removeAttribute("inert"); else inner.setAttribute("inert", "");
}
function myBookingCard(b, i, n, dfltOpen) {
  const ev = evById(b.event_id) || {}, st = bStatus(b), cancelled = b.status === "cancelled", due = st.k === "pending" || st.k === "upi";
  const head = `<span class="bkno${cancelled ? " x" : ""}">${i}</span>
    <span class="bkmain"><b>${b.adults + b.children} pass${b.adults + b.children === 1 ? "" : "es"}</b><small>${b.adults} adult${b.adults === 1 ? "" : "s"}${b.children ? ", " + b.children + " child" + (b.children > 1 ? "ren" : "") : ""} · ${esc(sessLabel(ev, b.sessions))}</small><small class="mono">${esc(b.pass_no)} · ${b.pass_type === "physical" ? "Printed" : "Mobile"}</small></span>
    <span class="bkside"><b class="num">${+b.amount > 0 ? inr(b.amount) : "Free"}</b><span class="chip ${st.cls}">${esc(st.label)}</span></span>`;
  const passes = cancelled ? `<p class="small muted" style="margin:0">This booking was cancelled.</p>` : collapsible("pp:" + b.id, isOpen("pp:" + b.id, !due || n === 1),
    `<span class="subh"><svg class="ic sm"><use href="#i-ticket"/></svg><span><span class="gu">પાસ</span> · Passes <small>${b.adults + b.children} QR code${b.adults + b.children === 1 ? "" : "s"}, one per person</small></span></span>`,
    `<div class="tickets">${persons(b).map(p => ticket(b, p.n)).join("")}</div>`, "sub");
  const pay = collapsible("py:" + b.id, isOpen("py:" + b.id, due),
    `<span class="subh"><span class="rs">₹</span><span><span class="gu">ચુકવણી</span> · Payment <small>${cancelled ? "Cancelled" : due ? "Due " + inr(b.amount) : +b.amount > 0 ? "Paid " + inr(b.amount) + (b.pay_mode ? " · " + b.pay_mode.toUpperCase() : "") : "Free"}</small></span></span>`,
    paySection(b), "sub pay");
  const cc = canSelfCancel(b);
  const body = `<div class="bkbody">${passes}${pay}
    ${!cancelled ? policyBox(ev, b, "for this booking") : ""}
    ${!cancelled ? `<div class="row mybk-act"><a class="btn sm" href="${esc(waLink(b, true))}" target="_blank" rel="noopener">Save to WhatsApp</a>${cc.ok ? `<button class="btn sm danger" type="button" data-mycancel="${b.id}" data-refund="${cc.refund || 0}">${cc.refund ? "Cancel · refund " + inr(cc.refund) : "Cancel booking"}</button>` : cc.why ? `<span class="small muted">${esc(cc.why)}</span>` : ""}<span class="small muted" style="margin-left:auto">Booked ${fd(b.created_at)}</span></div>` : ""}</div>`;
  return collapsible("bk:" + b.id, isOpen("bk:" + b.id, dfltOpen), head, body, "mybk" + (cancelled ? " is-cancelled" : "") + (due ? " is-due" : ""));
}
/* resident: pick passes → one QR for the counter */
function personState(b, n) {
  if (b.status === "cancelled") return { ok: false, why: "Cancelled" };
  if (b.status !== "paid") return { ok: false, why: "Payment due" };
  const ev = evById(b.event_id) || {}, t = today();
  const todays = (ev.sessions || []).filter(s => b.sessions.includes(s.id) && s.date === t);
  if (todays.length && todays.every(s => given(b, s.id, n))) { const g = todays.map(s => given(b, s.id, n)).pop(); return { ok: false, why: "Collected " + hm(g.at), done: true }; }
  const future = (ev.sessions || []).filter(s => b.sessions.includes(s.id) && s.date >= t);
  if (!future.length) return { ok: false, why: "Event over" };
  return { ok: true };
}
const groupToken = picks => { const by = {}; picks.forEach(([pno, n]) => (by[pno] = by[pno] || []).push(n)); return "G:" + Object.entries(by).map(([p, ns]) => p + ":" + ns.sort((a, z) => a - z).join(".")).join(","); };
function groupSheet(e) {
  const list = S.bookings.filter(b => b.user_id === S.user.id && b.event_id === e.id && active(b)).sort((x, y) => x.created_at.localeCompare(y.created_at));
  const rows = []; list.forEach((b, i) => persons(b).forEach(p => rows.push({ b, p, i: i + 1, st: personState(b, p.n) })));
  const okRows = rows.filter(r => r.st.ok);
  const todaySess = (e.sessions || []).filter(s => s.date === today());
  const o = openSheet(`<header><div><div class="muted small">${esc(e.name_en || "")}</div><h2 class="gu">એકસાથે લો · Collect together</h2></div><button class="x" type="button" aria-label="Close">×</button></header>
    <p class="small muted" style="margin:0">Tick the passes you want to collect now. You get <b>one QR</b> for all of them — the committee scans it once and hands over all the dishes.</p>
    ${todaySess.length ? "" : `<div class="notice small">This event's next session is not today. The QR works on the event day.</div>`}
    <div class="row" style="justify-content:space-between"><b class="small">${okRows.length} of ${rows.length} pass${rows.length === 1 ? "" : "es"} can be collected</b>
      <span class="row"><button class="btn sm" type="button" id="gAll">Select all</button><button class="btn sm" type="button" id="gNone">Clear</button></span></div>
    <div class="gpick">${rows.map((r, k) => `<label class="gp${r.st.ok ? "" : " off"}"><input type="checkbox" data-k="${k}"${r.st.ok ? " checked" : " disabled"}>
      <span><b>${r.p.type} ${r.p.n}</b> <span class="muted small">· booking ${r.i}</span><small class="mono">${esc(tok(r.b, r.p.n))}</small></span>
      ${r.st.ok ? `<span class="chip ok">Ready</span>` : `<span class="chip ${r.st.done ? "info" : "warn"}">${esc(r.st.why)}</span>`}</label>`).join("")}</div>
    <div class="gqr" id="gQr"></div>
    <div class="row" style="justify-content:flex-end"><button class="btn x2" type="button">Done</button></div>`, true);
  $(".x2", o).onclick = closeSheet;
  const draw = () => {
    const picks = $$(".gpick input:checked", o).map(i => rows[+i.dataset.k]);
    const box = $("#gQr", o);
    if (!picks.length) { box.innerHTML = `<div class="empty"><b>No passes selected</b>Tick at least one pass to get the QR.</div>`; return; }
    const A = picks.filter(r => r.p.type === "Adult").length, C = picks.length - A;
    const url = SITE + "/#" + groupToken(picks.map(r => [r.b.pass_no, r.p.n]));
    box.innerHTML = `<div class="gqr-card"><div class="gqr-h"><b>${picks.length} dish${picks.length === 1 ? "" : "es"}</b><span>${A} adult${A === 1 ? "" : "s"}${C ? " · " + C + " child" + (C > 1 ? "ren" : "") : ""} · ${esc(list[0].flat)}</span></div>
      <div class="qr big">${qrSvg(url)}</div>
      <div class="small muted" style="text-align:center"><span class="gu">કાઉન્ટર પર આ એક QR બતાવો</span> · Show this one QR at the counter</div>
      <div class="gqr-list">${picks.map(r => `<span>${r.p.type} ${r.p.n} · ${esc(r.b.pass_no.slice(-5))}</span>`).join("")}</div></div>`;
  };
  $$(".gpick input", o).forEach(i => i.onchange = draw);
  $("#gAll", o).onclick = () => { $$(".gpick input:not(:disabled)", o).forEach(i => i.checked = true); draw(); };
  $("#gNone", o).onclick = () => { $$(".gpick input", o).forEach(i => i.checked = false); draw(); };
  draw();
}
function renderMine() {
  const box = $("#myList"), bar = $("#myTools");
  const mine = S.bookings.filter(b => b.user_id === S.user.id);
  bar.hidden = !mine.length;
  if (!mine.length) { box.innerHTML = `<div class="empty"><b>No passes yet</b>Book from an open event above. Your passes will appear here.</div>`; return; }
  const firstDate = e => ((e.sessions || [])[0] || {}).date || e.open_date || "";
  const lastDate = e => ((e.sessions || []).slice(-1)[0] || {}).date || e.close_date || "";
  const evIds = [...new Set(mine.map(b => b.event_id))].map(evById).filter(Boolean).sort((x, y) => firstDate(y).localeCompare(firstDate(x)));
  const sel = $("#myEv"), cur = sel.value;
  sel.innerHTML = `<option value="">All events (${evIds.length})</option>` + evIds.map(e => `<option value="${e.id}">${esc(e.name_gu || e.name_en)}${e.name_gu && e.name_en ? " · " + esc(e.name_en) : ""}</option>`).join("");
  if (evIds.some(e => e.id === cur)) sel.value = cur;
  const q = $("#myQ").value.trim().toLowerCase(), filtering = !!(q || sel.value);
  const groups = evIds.filter(e => !sel.value || e.id === sel.value).map(e => {
    const all = mine.filter(b => b.event_id === e.id).sort((x, y) => x.created_at.localeCompare(y.created_at));
    const shown = all.filter(b => !q || [b.pass_no, b.name, b.flat, e.name_gu, e.name_en, evDates(e, b), ...persons(b).map(p => tok(b, p.n))].join(" ").toLowerCase().includes(q));
    return { e, all, shown };
  }).filter(g => g.shown.length);
  if (!groups.length) { box.innerHTML = `<div class="empty"><b>No passes match</b>Try another event or clear the search.</div>`; return; }
  box.innerHTML = groups.map(({ e, all, shown }, gi) => {
    const T = sumUp(all), activeList = all.filter(active), past = lastDate(e) < today();
    const latest = activeList[activeList.length - 1];
    const head = `<span class="evh-main"><b class="gu">${esc(e.name_gu || e.name_en)}</b>${e.name_gu && e.name_en ? `<small>${esc(e.name_en)}</small>` : ""}
        <small>${esc((e.sessions || []).length ? fd(e.sessions[0].date) + (e.sessions.length > 1 ? " → " + fd(e.sessions[e.sessions.length - 1].date) : "") : "")}${past ? " · completed" : ""}</small></span>
      <span class="evtot"><b>${T.persons}</b><span>pass${T.persons === 1 ? "" : "es"}</span></span>`;
    const body = `<div class="evsum"><span>${T.count} booking${T.count === 1 ? "" : "s"} · ${pplTxt(T.adults, T.children)}</span><span>Total <b class="num">${inr(T.amount)}</b>${T.due > 0 ? ` · <span class="due">due ${inr(T.due)}</span>` : T.amount > 0 ? ` · <span class="okc">all paid</span>` : ""}</span></div>
      <div class="bklist">${shown.map(b => myBookingCard(b, (activeList.indexOf(b) + 1) || "×", activeList.length, filtering || b === latest)).join("")}</div>
      ${activeList.length && !past ? `<button class="btn primary together" type="button" data-together="${e.id}"><svg class="ic sm"><use href="#i-scan"/></svg><span><span class="gu">એકસાથે લો</span> · Collect together with one QR</span></button>` : ""}
      ${windowState(e).k === "open" ? `<button class="btn more" type="button" data-bookmore="${e.id}"><svg class="ic sm"><use href="#i-plus"/></svg>Book more passes for this event</button>` : ""}`;
    return collapsible("ev:" + e.id, isOpen("ev:" + e.id, filtering || !past || gi === 0), head, body, "evgroup");
  }).join("");
  wireUtr(box);
  $$("[data-bookmore]", box).forEach(btn => btn.onclick = () => bookingForm(evById(btn.dataset.bookmore), false));
  $$("[data-together]", box).forEach(btn => btn.onclick = () => groupSheet(evById(btn.dataset.together)));
  $$("[data-mycancel]", box).forEach(btn => arm(btn, async () => { const { error } = await sb.rpc("cancel_booking", { p_booking: btn.dataset.mycancel }); if (error) toast(errMsg(error)); else { toast(+btn.dataset.refund ? "Booking cancelled · the committee will refund " + inr(+btn.dataset.refund) : "Booking cancelled"); reloadSoon(); } }, +btn.dataset.refund ? "Tap again: cancel & get refund" : "Tap again to cancel"));
}
$("#myList").addEventListener("click", e => { const t = e.target.closest("[data-tg]"); if (t) toggleBox(t); });
function setAllMine(open) {
  $$("#myList .cbox").forEach(b => { if (b.classList.contains("open") !== open) toggleBox(b.querySelector(":scope > .chead")); });
}
function renderReqBox() {
  const box = $("#reqBox");
  if (isStaff()) { box.innerHTML = ""; return; }
  const r = S.myRequest;
  if (r && r.status === "pending") { box.innerHTML = `<div class="panel"><h3>Committee access</h3><p class="small" style="margin:6px 0 0">Your request was sent on ${fdt(r.requested_at)} and is waiting for approval by the super admin.</p></div>`; return; }
  box.innerHTML = `<details class="panel"><summary style="cursor:pointer;font-weight:700"><svg class="ic sm"><use href="#i-shield"/></svg>Committee member? Request committee access</summary>
    ${r && r.status === "rejected" ? `<p class="small" style="color:var(--bad)">Your earlier request was not approved.</p>` : ""}
    <p class="small muted">Your name and flat from your profile are sent with the request.</p>
    <div class="field"><label for="rqNote">Note (optional)</label><input id="rqNote" type="text" maxlength="200" placeholder="e.g. E block representative"></div>
    <div class="err" id="rqErr"></div><button class="btn primary" type="button" id="rqGo">Send request</button></details>`;
  $("#rqGo").onclick = async () => {
    if (!profileComplete()) { $("#rqErr").textContent = "Fill in your details above first."; return; }
    const { error } = await sb.rpc("request_committee_access", { p_note: $("#rqNote").value.trim() || null });
    if (error) $("#rqErr").textContent = errMsg(error); else { toast("Request sent"); await loadProfile(); render(); }
  };
}

/* ───────────── pass delivery (committee) ───────────── */
async function emailPass(b, btn, errEl) {
  const t = btn ? btn.textContent : ""; if (btn) { btn.disabled = true; btn.textContent = "Sending…"; }
  const { data, error } = await sb.functions.invoke("send-pass", { body: { booking_id: b.id } });
  if (error || !data || !data.sent) {
    let m = "Could not send the email."; try { const j = await error.context.json(); m = j.error || m; } catch (e) {}
    if (btn) { btn.disabled = false; btn.textContent = t; } if (errEl) errEl.textContent = m; else toast(m); return false;
  }
  if (btn) btn.textContent = "Email sent"; toast("Passes emailed to " + data.to); reloadSoon(); return true;
}
let logoImg = null;
const loadLogo = () => logoImg || (logoImg = new Promise(r => { const i = new Image(); i.onload = () => r(i); i.onerror = () => r(null); i.src = "assets/logo.png"; }));
function fit(g, t, max) { t = String(t || ""); if (g.measureText(t).width <= max) return t; while (t.length > 1 && g.measureText(t + "…").width > max) t = t.slice(0, -1); return t + "…"; }
async function passPng(b, n) {
  const ev = evById(b.event_id) || {}, st = bStatus(b), p = persons(b)[n - 1], tot = b.adults + b.children;
  try { await document.fonts.load('700 52px "Baloo Bhai 2"', "પાસ"); } catch (e) {}
  const W = 900, H = 1400, cv = document.createElement("canvas"); cv.width = W; cv.height = H; const g = cv.getContext("2d");
  const GREEN = "#1F5A33", INK = "#17231A", MUT = "#5E6B60";
  g.fillStyle = "#fff"; g.fillRect(0, 0, W, H); g.fillStyle = "#E3EFE2"; g.fillRect(0, 0, W, 250);
  const logo = await loadLogo(); if (logo) { const h = 200; g.drawImage(logo, 40, 25, h * logo.width / logo.height, h); }
  const tx = 230; g.fillStyle = GREEN; g.font = '700 22px "Hind Vadodara",sans-serif'; g.fillText("MEAL PASS · ભોજન પાસ", tx, 80);
  g.font = '700 46px "Baloo Bhai 2","Hind Vadodara",sans-serif'; g.fillText(fit(g, ev.name_gu || ev.name_en || "", W - tx - 40), tx, 150);
  g.fillStyle = MUT; g.font = '500 26px "Hind Vadodara",sans-serif'; g.fillText(fit(g, ev.name_en || "", W - tx - 40), tx, 200);
  g.fillStyle = GREEN; g.fillRect(0, 250, W, 84); g.fillStyle = "#fff"; g.font = '700 44px "Baloo Bhai 2","Hind Vadodara",sans-serif';
  g.fillText(`${p.type.toUpperCase()} ${n}  ·  ${p.gu}`, 50, 307); g.textAlign = "right"; g.font = '600 30px "Hind Vadodara",sans-serif'; g.fillText(`Person ${n} of ${tot}`, W - 50, 305); g.textAlign = "left";
  g.fillStyle = INK; g.font = '700 88px "Baloo Bhai 2",sans-serif'; g.fillText(b.flat, 50, 440);
  g.font = '600 36px "Hind Vadodara",sans-serif'; g.fillText(fit(g, b.name, W - 100), 50, 492);
  let y = 548; [["Date", evDates(ev, b)], ["Session", sessLabel(ev, b.sessions)], ["Amount", +b.amount > 0 ? inr(b.amount) : "Free"]].forEach(([k, v]) => { g.fillStyle = MUT; g.font = '500 26px "Hind Vadodara",sans-serif'; g.fillText(k, 50, y); g.fillStyle = INK; g.font = '600 28px "Hind Vadodara",sans-serif'; g.fillText(fit(g, v, W - 260), 220, y); y += 42; });
  const stamp = st.k === "paid" ? "PAID" : st.k === "free" ? "FREE" : st.k === "cancelled" ? "CANCELLED" : "PAYMENT DUE";
  g.font = '700 30px "Hind Vadodara",sans-serif'; const sw = g.measureText(stamp).width + 40;
  g.fillStyle = (stamp === "PAID" || stamp === "FREE") ? GREEN : "#B23A26"; g.beginPath(); g.roundRect(W - 50 - sw, 388, sw, 56, 10); g.fill(); g.fillStyle = "#fff"; g.fillText(stamp, W - 50 - sw + 20, 427);
  const q = qrcode(0, "Q"); q.addData(passUrl(b, n)); q.make(); const m = q.getModuleCount(), cell = Math.floor(480 / m), qs = cell * m, qx = (W - qs) / 2, qy = 710;
  g.fillStyle = "#000"; for (let r = 0; r < m; r++) for (let c = 0; c < m; c++) if (q.isDark(r, c)) g.fillRect(qx + c * cell, qy + r * cell, cell, cell);
  g.textAlign = "center"; g.fillStyle = INK; g.font = '600 34px "IBM Plex Mono",monospace'; g.fillText(tok(b, n), W / 2, qy + qs + 60);
  g.fillStyle = MUT; g.font = '500 24px "Hind Vadodara",sans-serif'; g.fillText("કાઉન્ટર પર આ QR બતાવો · Show this QR at the counter", W / 2, H - 58);
  g.font = '500 20px "Hind Vadodara",sans-serif'; g.fillText("Serenity Space Co-operative Housing Society Ltd., Jagatpur, Gota, Ahmedabad", W / 2, H - 24);
  g.strokeStyle = GREEN; g.lineWidth = 6; g.strokeRect(3, 3, W - 6, H - 6);
  return new Promise(r => cv.toBlob(r, "image/png"));
}
function downloadBlob(blob, name) { const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000); }
function passSheet(b) {
  if (!b) return;
  const st = bStatus(b);
  const o = openSheet(`<header><div><div class="muted small">${b.pass_type === "physical" ? "Printed pass" : "Mobile pass"} · booked ${fdt(b.created_at)}${b.by_committee ? " at desk" : ""}</div><h2>${esc(b.flat)} · ${esc(b.name)}</h2></div><button class="x" type="button" aria-label="Close">×</button></header>
    ${passCard(b)}
    <div class="row small">${persons(b).map(x => `<button class="btn sm" type="button" data-img="${x.n}">Image · ${x.type} ${x.n}</button>`).join("")}</div>
    <div class="small muted">Mobile <span class="mono">${esc(b.mobile)}</span> · Email ${esc(b.email || "—")}${b.upi_ref ? ` · UTR <span class="mono">${esc(b.upi_ref)}</span>` : ""}</div>
    ${b.status === "cancelled" ? `<div class="notice small"><b>${esc(cancelInfo(b))}.</b>${refundInfo(b) ? "<br>" + esc(refundInfo(b).line) + "." : ""}</div>` : ""}
    ${b.status === "paid" && +b.amount > 0 ? `<div class="panel"><h3 style="margin-bottom:8px">Payment</h3><dl class="kv">
      <dt>Amount</dt><dd class="num">${inr(b.paid_amount != null ? b.paid_amount : b.amount)} · ${esc(MODE[b.pay_mode] || b.pay_mode || "")}</dd>
      ${b.pay_mode === "cash" ? `<dt>Cash received by</dt><dd><b>${esc(b.collected_by_name || "—")}</b></dd>` : ""}
      <dt>Marked paid by</dt><dd>${esc(b.paid_by_name || "—")} · ${fdt(b.paid_at)}</dd>
      ${b.pay_ref ? `<dt>${b.pay_mode === "upi" ? "UTR" : "Receipt no."}</dt><dd class="mono">${esc(b.pay_ref)}</dd>` : ""}
      ${b.pay_note ? `<dt>${b.pay_mode === "waived" ? "Reason" : "Details"}</dt><dd>${esc(b.pay_note)}</dd>` : ""}</dl></div>` : ""}
    <div class="panel"><h3 style="margin-bottom:8px">Send passes</h3>
      <div class="row"><a class="btn primary" id="psWa" href="${esc(waLink(b))}" target="_blank" rel="noopener">WhatsApp to ${esc(b.mobile)}</a>
        <button class="btn" type="button" id="psMail"${b.email ? "" : " disabled"}>Email ${b.adults + b.children} pass${b.adults + b.children > 1 ? "es" : ""}</button></div>
      <div class="small muted" style="margin-top:8px">WhatsApp: ${b.wa_sent_at ? "opened " + fdt(b.wa_sent_at) : "not sent yet"} · Email: ${b.email_sent_at ? "sent " + fdt(b.email_sent_at) : "not sent yet"}</div>
      <div class="err" id="psErr"></div></div>
    <div class="row" style="justify-content:flex-end">${st.k === "pending" || st.k === "upi" ? `<button class="btn primary" type="button" id="psPay">Mark paid</button>` : ""}<button class="btn x2" type="button">Close</button></div>`, true);
  $(".x2", o).onclick = closeSheet;
  $("#psWa", o).addEventListener("click", () => sb.rpc("mark_sent", { p_booking: b.id, p_channel: "whatsapp" }).then(reloadSoon));
  $$("[data-img]", o).forEach(x => x.onclick = async () => downloadBlob(await passPng(b, +x.dataset.img), `Serenity_Space_Pass_${tok(b, +x.dataset.img)}.png`));
  if ($("#psPay", o)) $("#psPay", o).onclick = () => payForm(b);
  $("#psMail", o).onclick = () => emailPass(b, $("#psMail", o), $("#psErr", o));
}

/* ───────────── committee: shared ───────────── */
function eventSelect(selEl) {
  const cur = selEl.value;
  const evs = S.events.slice().sort((a, b) => String((b.sessions[0] || {}).date || b.created_at).localeCompare(String((a.sessions[0] || {}).date || a.created_at)));
  selEl.innerHTML = evs.length ? evs.map(e => `<option value="${e.id}">${esc(e.name_en || e.name_gu)}${e.published ? "" : " (draft)"}</option>`).join("") : `<option value="">No events yet</option>`;
  if (cur && evs.some(e => e.id === cur)) selEl.value = cur;
  else { const t = today(); const cur2 = evs.find(e => (e.sessions || []).some(s => s.date === t)) || evs.find(e => windowState(e).k === "open"); if (cur2) selEl.value = cur2.id; }
}
function evStats(ev) {
  const bs = S.bookings.filter(b => b.event_id === ev.id), act = bs.filter(active);
  const r = { passes: act.length, adults: 0, children: 0, billed: 0, collected: 0, pending: 0, upiVerify: 0, cost: 0, cancelled: bs.length - act.length, cash: 0, upi: 0, other: 0, printed: 0, byCollector: {}, refundDue: 0, refundDueN: 0, refunded: 0, autoCancelled: 0, bySess: {}, byBlock: {} };
  (ev.sessions || []).forEach(s => r.bySess[s.id] = { a: 0, c: 0, served: 0 });
  BLOCKS.forEach(b => r.byBlock[b] = { passes: 0, persons: 0, amount: 0, pending: 0 });
  bs.filter(b => b.status === "cancelled").forEach(b => { if (b.refund_status === "due") { r.refundDue += +b.refund_amount || 0; r.refundDueN++; } if (b.refund_status === "refunded") r.refunded += +b.refund_amount || 0; if (b.cancel_reason === "auto_unpaid") r.autoCancelled++; });
  act.forEach(b => {
    const st = bStatus(b);
    r.adults += b.adults; r.children += b.children; r.billed += +b.amount; r.cost += +b.cost || 0;
    if (st.k === "paid") { const amt = +(b.paid_amount != null ? b.paid_amount : b.amount); r.collected += amt;
      if (b.pay_mode === "upi") r.upi += amt; else if (b.pay_mode === "other") r.other += amt; else if (b.pay_mode === "cash") r.cash += amt;
      if (amt > 0) { const key = b.pay_mode === "cash" ? (b.collected_by_name || b.paid_by_name || "Not recorded") : (b.paid_by_name || "Not recorded");
        const c = r.byCollector[key] = r.byCollector[key] || { name: key, cash: 0, cashN: 0, upi: 0, upiN: 0, other: 0, otherN: 0 };
        if (b.pay_mode === "cash") { c.cash += amt; c.cashN++; } else if (b.pay_mode === "upi") { c.upi += amt; c.upiN++; } else { c.other += amt; c.otherN++; } } }
    if (st.k === "pending" || st.k === "upi") { r.pending += +b.amount; r.byBlock[b.block].pending += +b.amount; }
    if (st.k === "upi") r.upiVerify++;
    if (b.printed_at) r.printed++;
    b.sessions.forEach(id => { const x = r.bySess[id]; if (x) { x.a += b.adults; x.c += b.children; x.served += Object.keys((S.checkins[b.id] || {})[id] || {}).length; } });
    const bb = r.byBlock[b.block]; if (bb) { bb.passes++; bb.persons += b.adults + b.children; bb.amount += +b.amount; }
  });
  r.persons = r.adults + r.children; r.subsidy = Math.max(0, r.cost - r.billed);
  return r;
}

/* ── meals given (live): per session — booked, paid (to serve), given, left ── */
function mealStats(ev) {
  const out = (ev.sessions || []).map(s => ({ s, booked: 0, paid: 0, given: 0, unpaid: 0 }));
  const at = Object.fromEntries(out.map((x, i) => [x.s.id, x]));
  S.bookings.filter(b => b.event_id === ev.id && active(b)).forEach(b => b.sessions.forEach(sid => {
    const x = at[sid]; if (!x) return; const n = b.adults + b.children;
    x.booked += n; if (b.status === "paid") x.paid += n; else x.unpaid += n;
    x.given += Object.keys((S.checkins[b.id] || {})[sid] || {}).length;
  }));
  out.forEach(x => { x.left = Math.max(0, x.paid - x.given); x.today = x.s.date === today(); });
  return out;
}
function recentGiven(ev, limit) {
  const out = [];
  S.bookings.filter(b => b.event_id === ev.id).forEach(b => Object.entries(S.checkins[b.id] || {}).forEach(([sid, m]) => Object.entries(m).forEach(([n, v]) => {
    const s = (ev.sessions || []).find(x => x.id === sid); out.push({ at: v.at, b, n: +n, s }); })));
  return out.sort((x, y) => String(y.at).localeCompare(String(x.at))).slice(0, limit);
}
function mealRow(x, big) {
  const pct = v => x.booked ? Math.min(100, v / x.booked * 100) : 0;
  return `<div class="mrow${x.today ? " today" : ""}${big ? " big" : ""}">
    <div class="spread small"><span><b>${esc(x.s.label || x.s.meal)}</b> · ${fd(x.s.date)}${x.today ? ' <span class="chip gold">Today</span>' : ""}</span>
      <span class="num"><b class="g">${x.given}</b> given · <b>${x.left}</b> left${x.unpaid ? ` · <span class="u">${x.unpaid} unpaid</span>` : ""}</span></div>
    <div class="mbar" title="${x.given} given of ${x.paid} paid (${x.booked} booked)"><i class="p" style="width:${pct(x.paid)}%"></i><i class="g" style="width:${pct(x.given)}%"></i></div>
    <div class="small muted">${x.booked} booked · ${x.paid} paid</div></div>`;
}
function liveMealsPanel(ev, recentN) {
  const ms = mealStats(ev), td = ms.filter(x => x.today), focus = td.length ? td : ms;
  const sum = k => focus.reduce((a, x) => a + x[k], 0);
  const rec = recentN ? recentGiven(ev, recentN) : [];
  return `<div class="panel live">
    <div class="spread"><h3><span class="dot" aria-hidden="true"></span>Meals given <span class="muted small" style="font-family:var(--body)">${td.length ? "today · live" : "all sessions · live"}</span></h3></div>
    <div class="mbig"><div><b class="g">${sum("given")}</b><span>given</span></div><div><b>${sum("left")}</b><span>left to give</span></div><div><b>${sum("paid")}</b><span>paid passes</span></div>${sum("unpaid") ? `<div><b class="u">${sum("unpaid")}</b><span>unpaid</span></div>` : ""}</div>
    <div class="mrows">${ms.map(x => mealRow(x, x.today)).join("") || `<p class="muted small">No sessions.</p>`}</div>
    ${recentN ? `<div class="lab" style="margin-top:4px">Recent hand-overs</div><div class="recent">${rec.length ? rec.map(r => `<div class="rrow"><span class="mono">${hm(r.at)}</span><span><b>${esc(r.b.flat)}</b> · ${r.n <= r.b.adults ? "Adult" : "Child"} ${r.n}<small>${esc(r.b.name)} · ${esc(r.s ? (r.s.label || r.s.meal) : "")}</small></span><span class="mono small muted">${esc(r.b.pass_no.slice(-5))}</span></div>`).join("") : `<p class="muted small" style="margin:0">Nothing handed over yet.</p>`}</div>` : ""}
  </div>`;
}
function bookingGiven(b) {
  const ev = evById(b.event_id) || {}, n = b.adults + b.children, td = (ev.sessions || []).filter(s => s.date === today() && b.sessions.includes(s.id));
  const cnt = ids => ids.reduce((a, sid) => a + Object.keys((S.checkins[b.id] || {})[sid] || {}).length, 0);
  if (td.length) { const g = cnt(td.map(s => s.id)), t = n * td.length; return { g, t, label: `${g}/${t} today`, cls: g >= t ? "ok" : g ? "warn" : "" }; }
  const g = cnt(b.sessions), t = n * b.sessions.length; return { g, t, label: `${g}/${t}`, cls: g >= t && t ? "ok" : g ? "warn" : "" };
}
function renderOverview() {
  eventSelect($("#ovEvent"));
  const ev = evById($("#ovEvent").value), box = $("#ovBody");
  if (!ev) { box.innerHTML = `<div class="empty"><b>Create your first event</b>Set up 26 January snacks, Holi, Navratri or a lunch with its booking window and rates.<div style="margin-top:12px"><button class="btn primary" type="button" id="ovNew">+ New event</button></div></div>`; $("#ovNew").onclick = () => eventForm(); return; }
  const r = evStats(ev), w = windowState(ev);
  const maxS = Math.max(1, ...Object.values(r.bySess).map(x => x.a + x.c));
  box.innerHTML = `
    <div class="spread" style="margin-bottom:12px"><div><h2 class="gu">${esc(ev.name_gu || ev.name_en)}</h2><div class="muted small">${esc(ev.name_en || "")} · Booking ${fd(ev.open_date)} → ${fd(ev.close_date)}${ev.late_from && +ev.late_extra > 0 ? " · late fee from " + fd(ev.late_from) : ""}</div></div><span class="chip ${w.cls}">${esc(w.label)}</span></div>
    <div class="stats">
      <div class="stat"><div class="k">Passes</div><div class="v">${r.passes}${r.cancelled ? ` <small>+${r.cancelled} cancelled</small>` : ""}</div></div>
      <div class="stat"><div class="k">Persons</div><div class="v">${r.persons} <small>${r.adults} A · ${r.children} C</small></div>${ev.capacity > 0 ? `<div class="bar" style="margin-top:6px"><i style="width:${Math.min(100, r.persons / ev.capacity * 100)}%"></i></div><div class="small muted">of ${ev.capacity} places</div>` : ""}</div>
      <div class="stat" style="border-top:3px solid var(--ok)"><div class="k">Collected</div><div class="v" style="color:var(--ok)">${inr(r.collected)}</div><div class="small muted">Cash ${inr(r.cash)} · UPI ${inr(r.upi)}</div></div>
      <div class="stat" style="border-top:3px solid var(--marigold)"><div class="k">Pending</div><div class="v" style="color:var(--warn)">${inr(r.pending)}</div>${r.upiVerify ? `<div class="small" style="color:var(--info)">${r.upiVerify} UPI ref${r.upiVerify > 1 ? "s" : ""} to verify</div>` : ""}</div>
      ${r.cost > 0 ? `<div class="stat"><div class="k">Society subsidy</div><div class="v">${inr(r.subsidy)}</div><div class="small muted">Cost ${inr(r.cost)}</div></div>` : ""}
      <div class="stat"><div class="k">Passes printed</div><div class="v">${r.printed}<small> / ${r.passes}</small></div></div>
      ${(() => { const ms = mealStats(ev), td = ms.filter(x => x.today), f = td.length ? td : ms, g = f.reduce((a, x) => a + x.given, 0), pd = f.reduce((a, x) => a + x.paid, 0);
        return `<div class="stat" style="border-top:3px solid var(--leaf)"><div class="k">Meals given${td.length ? " today" : ""}</div><div class="v" style="color:var(--leaf)">${g}<small> / ${pd}</small></div><div class="bar" style="margin-top:6px"><i style="width:${pd ? Math.min(100, g / pd * 100) : 0}%"></i></div></div>`; })()}
    </div>
    <div class="grid2">
      ${liveMealsPanel(ev, 6)}
      <div class="panel"><h3 style="margin-bottom:10px">Block-wise</h3>
        <div class="tablewrap" style="border:0;box-shadow:none"><table><thead><tr><th>Block</th><th class="r">Passes</th><th class="r">Persons</th><th class="r">Amount</th><th class="r">Pending</th></tr></thead><tbody>
        ${BLOCKS.map(b => { const x = r.byBlock[b]; return `<tr><td>${b}</td><td class="r num">${x.passes}</td><td class="r num">${x.persons}</td><td class="r num">${inr(x.amount)}</td><td class="r num"${x.pending ? ' style="color:var(--warn)"' : ""}>${inr(x.pending)}</td></tr>`; }).join("")}
        </tbody></table></div></div>
    </div>`;
}

/* ───────────── committee: events ───────────── */
const TEMPLATES = [
  { name_en: "Republic Day Snacks", name_gu: "પ્રજાસત્તાક દિવસ નાસ્તો", code: "RD", kind: "single", sessions: [{ label: "Republic Day", date: "", meal: "Snacks" }], price_mode: "discount" },
  { name_en: "Holi Snacks", name_gu: "હોળી નાસ્તો", code: "HOL", kind: "single", sessions: [{ label: "Dhuleti", date: "", meal: "Snacks" }], price_mode: "paid" },
  { name_en: "Independence Day Snacks", name_gu: "સ્વાતંત્ર્ય દિવસ નાસ્તો", code: "ID", kind: "single", sessions: [{ label: "Independence Day", date: "", meal: "Snacks" }], price_mode: "free" },
  { name_en: "Navratri Snacks", name_gu: "નવરાત્રી નાસ્તો", code: "NAV", kind: "multi", sessions: [], price_mode: "paid" },
  { name_en: "Society Dinner", name_gu: "સોસાયટી રાત્રિ ભોજન", code: "DIN", kind: "single", sessions: [{ label: "Dinner", date: "", meal: "Dinner" }], price_mode: "paid" },
];
function renderEvents() {
  const box = $("#evList");
  const evs = S.events.slice().sort((a, b) => String((b.sessions[0] || {}).date || "").localeCompare(String((a.sessions[0] || {}).date || "")));
  const tpl = `<p class="muted small" style="margin-top:14px">Start from a template: ${TEMPLATES.map((t, i) => `<button class="btn sm" type="button" data-tpl="${i}">${esc(t.name_en)}</button>`).join(" ")}</p>`;
  box.innerHTML = (evs.length ? evs.map(e => {
    const w = windowState(e), r = evStats(e), nb = S.bookings.filter(b => b.event_id === e.id).length;
    return `<div class="evrow"><div style="min-width:0"><div class="row"><h3 class="gu">${esc(e.name_gu || e.name_en)}</h3><span class="chip ${w.cls}">${esc(w.label)}</span><span class="chip">${e.price_mode === "free" ? "Free" : e.price_mode === "discount" ? "Discounted" : "At cost"}</span></div>
      <div class="meta" style="margin-top:4px"><span>${esc(e.name_en || "")}</span><span>${e.sessions.length} session${e.sessions.length === 1 ? "" : "s"}</span><span>Window ${fd(e.open_date)} → ${fd(e.close_date)}</span><span>${r.passes} passes · ${r.persons} persons</span><span class="mono">${esc(e.code)}</span></div></div>
      <div class="row"><button class="btn sm" data-edit="${e.id}" type="button">Edit</button><button class="btn sm" data-pub="${e.id}" type="button">${e.published ? "Unpublish" : "Publish"}</button><button class="btn sm" data-dup="${e.id}" type="button">Duplicate</button>${nb ? "" : `<button class="btn sm danger" data-del="${e.id}" type="button">Delete</button>`}</div></div>`;
  }).join("") : `<div class="empty"><b>No events yet</b>Create one or start from a template below.</div>`) + tpl;
  $$("[data-tpl]", box).forEach(b => b.onclick = () => eventForm(null, TEMPLATES[+b.dataset.tpl]));
  $$("[data-edit]", box).forEach(b => b.onclick = () => eventForm(evById(b.dataset.edit)));
  $$("[data-dup]", box).forEach(b => b.onclick = () => { const e = JSON.parse(JSON.stringify(evById(b.dataset.dup))); delete e.id; e.published = false; e.name_en = (e.name_en || "") + " (copy)"; e.sessions.forEach(s => { delete s.id; }); eventForm(null, e); });
  $$("[data-pub]", box).forEach(b => b.onclick = async () => { const e = evById(b.dataset.pub); const { error } = await sb.from("events").update({ published: !e.published, updated_at: new Date().toISOString() }).eq("id", e.id); if (error) toast(errMsg(error)); else { toast(e.published ? "Moved back to draft" : "Published to residents"); reloadSoon(); } });
  $$("[data-del]", box).forEach(b => arm(b, async () => { const { error } = await sb.from("events").delete().eq("id", b.dataset.del); if (error) toast(errMsg(error)); else { toast("Event deleted"); reloadSoon(); } }, "Confirm delete"));
}
function eventForm(ev, tpl) {
  const e = ev ? JSON.parse(JSON.stringify(ev)) : Object.assign({ name_en: "", name_gu: "", code: "", kind: "single", sessions: [{ label: "", date: "", meal: "Snacks" }], price_mode: "paid", open_date: today(), close_date: "", published: false, child_note: "below 10 yrs" }, tpl ? JSON.parse(JSON.stringify(tpl)) : {});
  if (!e.sessions.length && e.kind === "single") e.sessions = [{ label: "", date: "", meal: "Snacks" }];
  e.sessions.forEach(s => { s._k = s._k || rid(6); });
  const v = k => e[k] == null || (+e[k] === 0 && k !== "capacity" && /rate|cost|pkg|extra/.test(k)) ? "" : e[k];
  const o = openSheet(`
    <header><div><div class="muted small">${ev ? "Edit event" : "New event"}</div><h2>${esc(e.name_en || "Meal pass event")}</h2></div><button class="x" type="button" aria-label="Close">×</button></header>
    <div class="grid2"><div class="field"><label for="eGu">Name in Gujarati</label><input id="eGu" type="text" value="${esc(e.name_gu || "")}"></div><div class="field"><label for="eEn">Name in English</label><input id="eEn" type="text" value="${esc(e.name_en || "")}"></div></div>
    <div class="grid3">
      <div class="field"><label for="eCode">Pass code prefix</label><input id="eCode" type="text" maxlength="8" value="${esc(e.code || "")}" placeholder="HOL27" style="text-transform:uppercase"></div>
      <div class="field"><label for="eVenue">Venue</label><input id="eVenue" type="text" value="${esc(e.venue || "")}" placeholder="Clubhouse lawn"></div>
      <div class="field"><label for="eCap">Max persons (0 = no limit)</label><input id="eCap" type="number" min="0" value="${esc(e.capacity || 0)}"></div>
    </div>
    <div class="field"><span class="lab">Type</span><div class="seg"><label><input type="radio" name="eKind" value="single"${e.kind !== "multi" ? " checked" : ""}> One time</label><label><input type="radio" name="eKind" value="multi"${e.kind === "multi" ? " checked" : ""}> Multiple sessions (Navratri, lunch + dinner)</label></div></div>
    <div class="panel" style="padding:12px"><div class="spread" style="margin-bottom:8px"><span class="lab">Sessions</span><span class="row" id="genRow"><input id="gStart" type="date" style="width:auto" aria-label="First day"><input id="gN" type="number" min="1" max="31" value="9" style="width:70px" aria-label="Number of days"><select id="gMeal" style="width:auto">${MEALS.map(m => `<option>${m}</option>`).join("")}</select><button class="btn sm" type="button" id="gGo">Add daily sessions</button></span></div>
      <div id="sessBox" style="display:grid;gap:6px"></div><button class="btn sm" type="button" id="sAdd" style="margin-top:8px">+ Add session</button></div>
    <div class="field"><span class="lab">Pricing</span><div class="seg"><label><input type="radio" name="pMode" value="paid"${e.price_mode === "paid" ? " checked" : ""}> At cost</label><label><input type="radio" name="pMode" value="discount"${e.price_mode === "discount" ? " checked" : ""}> Discounted</label><label><input type="radio" name="pMode" value="free"${e.price_mode === "free" ? " checked" : ""}> Free</label></div></div>
    <div class="grid3">
      <div class="field" data-show="discount free"><label for="pCost">Actual cost per head / session</label><input id="pCost" type="number" min="0" value="${esc(v("cost"))}"></div>
      <div class="field" data-show="paid discount"><label for="pAdult">Adult rate / session</label><input id="pAdult" type="number" min="0" value="${esc(v("adult_rate"))}"></div>
      <div class="field" data-show="paid discount"><label for="pChild">Child rate / session</label><input id="pChild" type="number" min="0" value="${esc(v("child_rate"))}"></div>
      <div class="field" data-show="paid discount free"><label for="pChildNote">Child means</label><input id="pChildNote" type="text" value="${esc(e.child_note || "")}"></div>
      <div class="field" data-show="paid discount" data-multi><label for="pPkA">All-sessions adult (optional)</label><input id="pPkA" type="number" min="0" value="${esc(v("pkg_adult"))}"></div>
      <div class="field" data-show="paid discount" data-multi><label for="pPkC">All-sessions child (optional)</label><input id="pPkC" type="number" min="0" value="${esc(v("pkg_child"))}"></div>
    </div>
    <div class="grid3">
      <div class="field"><label for="eOpen">Booking opens</label><input id="eOpen" type="date" value="${esc(e.open_date || "")}"></div>
      <div class="field"><label for="eClose">Booking closes</label><input id="eClose" type="date" value="${esc(e.close_date || "")}"></div>
      <div class="field" data-show="paid discount"><label for="pLate">Rate increases from (optional)</label><input id="pLate" type="date" value="${esc(e.late_from || "")}"></div>
      <div class="field" data-show="paid discount"><label for="pLateX">Increase ₹ per person / session</label><input id="pLateX" type="number" min="0" value="${esc(v("late_extra"))}"></div>
    </div>
    <div class="panel" style="padding:12px" data-show="paid discount"><span class="lab">Cancellation <span class="gu">રદ કરવાના નિયમો</span></span>
      <p class="small muted" style="margin:2px 0 8px">Residents can always cancel an <b>unpaid</b> booking. Choose what happens after payment.</p>
      <div class="seg"><label><input type="radio" name="cxP" value="no"${e.cancel_paid !== "until" ? " checked" : ""}> Paid passes cannot be cancelled</label><label><input type="radio" name="cxP" value="until"${e.cancel_paid === "until" ? " checked" : ""}> Allowed until a date (refund)</label></div>
      <div class="grid2" style="margin-top:8px">
        <div class="field" id="cxUntilF"><label for="cxUntil">Last date to cancel a paid pass</label><input id="cxUntil" type="date" value="${esc(e.cancel_until || "")}"></div>
        <div class="field"><label for="cxDays">Auto-cancel unpaid bookings … days before the event (blank = never)</label><input id="cxDays" type="number" min="0" max="60" inputmode="numeric" value="${e.unpaid_cancel_days == null ? "" : esc(e.unpaid_cancel_days)}" placeholder="e.g. 2"></div>
      </div>
      <div class="small" id="cxPrev"></div></div>
    <div class="field"><label for="eNotes">Note for residents (menu, timing)</label><textarea id="eNotes">${esc(e.notes || "")}</textarea></div>
    <label class="row"><input type="checkbox" id="ePub"${e.published ? " checked" : ""}> Publish to residents</label>
    <div class="err" id="eErr"></div>
    <div class="row" style="justify-content:flex-end"><button class="btn" type="button" id="eCancel">Cancel</button><button class="btn primary" type="button" id="eSave">Save event</button></div>`, true);
  $("#eCancel", o).onclick = closeSheet;
  const kind = () => $("input[name=eKind]:checked", o).value, pm = () => $("input[name=pMode]:checked", o).value;
  const readSess = () => { e.sessions = $$(".sessed", o).map(r => { const old = e.sessions.find(s => s._k === r.dataset.k) || {}; return Object.assign({}, old, { label: $(".sl", r).value.trim(), date: $(".sd", r).value, meal: $(".sm", r).value }); }); };
  function drawSess() {
    const k = kind(); $("#genRow", o).hidden = k !== "multi"; $("#sAdd", o).hidden = k !== "multi" && e.sessions.length >= 1;
    if (k === "single" && e.sessions.length > 1) e.sessions = e.sessions.slice(0, 1);
    if (!e.sessions.length) e.sessions = [{ _k: rid(6), label: "", date: "", meal: "Snacks" }];
    $("#sessBox", o).innerHTML = e.sessions.map(s => `<div class="sessed" data-k="${s._k}"><input class="sl" type="text" placeholder="Label e.g. Day 1" value="${esc(s.label || "")}" aria-label="Session label"><input class="sd" type="date" value="${esc(s.date || "")}" aria-label="Date"><select class="sm" aria-label="Meal">${MEALS.map(m => `<option${m === s.meal ? " selected" : ""}>${m}</option>`).join("")}</select>${k === "multi" ? `<button class="btn sm" type="button" data-rm="${s._k}" aria-label="Remove session">✕</button>` : "<span></span>"}</div>`).join("");
    $$("[data-rm]", o).forEach(b => b.onclick = () => { readSess(); e.sessions = e.sessions.filter(s => s._k !== b.dataset.rm); drawSess(); });
    drawPrice();
  }
  function drawPrice() { const m = pm(); $$("[data-show]", o).forEach(x => x.hidden = !x.dataset.show.split(" ").includes(m)); $$("[data-multi]", o).forEach(x => x.hidden = kind() !== "multi" || m === "free"); }
  $$("input[name=eKind]", o).forEach(r => r.onchange = () => { readSess(); drawSess(); });
  $$("input[name=pMode]", o).forEach(r => r.onchange = drawPrice);
  $("#sAdd", o).onclick = () => { readSess(); e.sessions.push({ _k: rid(6), label: "", date: "", meal: (e.sessions.slice(-1)[0] || {}).meal || "Snacks" }); drawSess(); };
  $("#gGo", o).onclick = () => { const st = $("#gStart", o).value, n = +$("#gN", o).value, m = $("#gMeal", o).value; if (!st || !(n > 0)) { toast("Pick the first day and number of days."); return; }
    readSess(); e.sessions = e.sessions.filter(s => s.date || s.label); const d = new Date(st + "T00:00:00");
    for (let i = 0; i < n; i++) { const x = new Date(d); x.setDate(d.getDate() + i); e.sessions.push({ _k: rid(6), label: "Day " + (i + 1), date: x.getFullYear() + "-" + pad(x.getMonth() + 1) + "-" + pad(x.getDate()), meal: m }); } drawSess(); };
  const cxRead = () => ({ cancel_paid: $("input[name=cxP]:checked", o).value, cancel_until: $("input[name=cxP]:checked", o).value === "until" ? ($("#cxUntil", o).value || null) : null,
    unpaid_cancel_days: $("#cxDays", o).value === "" ? null : Math.max(0, Math.min(60, Math.floor(+$("#cxDays", o).value || 0))) });
  const cxDraw = () => { readSess(); const c = cxRead(); $("#cxUntilF", o).hidden = c.cancel_paid !== "until";
    const fake = Object.assign({}, c, { price_mode: pm(), sessions: e.sessions.filter(s => s.date).sort((a, z) => a.date.localeCompare(z.date)) });
    $("#cxPrev", o).innerHTML = `<div class="muted" style="margin-bottom:4px">Residents will see:</div>` + cancelLines(fake).map(l => `<div class="policy-l ${l.k}">${esc(l.en)}</div>`).join(""); };
  $$("input[name=cxP]", o).forEach(r => r.onchange = cxDraw); ["#cxUntil", "#cxDays"].forEach(id => $(id, o).oninput = cxDraw); o.addEventListener("change", e2 => { if (e2.target.closest(".sessed")) cxDraw(); });
  drawSess(); cxDraw();
  $("#eSave", o).onclick = async () => {
    readSess(); const err = $("#eErr", o); err.textContent = "";
    const m = pm(), k = kind(), num = id => +$(id, o).value || 0;
    const row = { name_gu: $("#eGu", o).value.trim() || null, name_en: $("#eEn", o).value.trim() || null, code: $("#eCode", o).value.trim().toUpperCase().replace(/[^A-Z0-9]/g, ""),
      venue: $("#eVenue", o).value.trim() || null, capacity: Math.max(0, Math.floor(num("#eCap"))), kind: k, open_date: $("#eOpen", o).value, close_date: $("#eClose", o).value,
      notes: $("#eNotes", o).value.trim() || null, published: $("#ePub", o).checked, price_mode: m, cost: num("#pCost"),
      adult_rate: m === "free" ? 0 : num("#pAdult"), child_rate: m === "free" ? 0 : num("#pChild"), child_note: $("#pChildNote", o).value.trim() || null,
      pkg_adult: k === "multi" && m !== "free" ? num("#pPkA") : 0, pkg_child: k === "multi" && m !== "free" ? num("#pPkC") : 0,
      late_from: m === "free" ? null : ($("#pLate", o).value || null), late_extra: m === "free" ? 0 : num("#pLateX"), updated_at: new Date().toISOString() };
    Object.assign(row, m === "free" ? { cancel_paid: "no", cancel_until: null, unpaid_cancel_days: null } : cxRead());
    if (!row.name_gu && !row.name_en) return err.textContent = "Give the event a name.";
    if (!row.code) row.code = ((row.name_en || "SS").replace(/[^A-Za-z]/g, "").slice(0, 3).toUpperCase() || "SS") + String(new Date().getFullYear()).slice(2);
    if (!/^[A-Z0-9]{2,8}$/.test(row.code)) return err.textContent = "Pass code prefix: 2–8 letters or digits.";
    if (!e.sessions.length || e.sessions.some(s => !s.date)) return err.textContent = "Every session needs a date.";
    if (!row.open_date || !row.close_date) return err.textContent = "Set both the booking open and close dates.";
    if (row.close_date < row.open_date) return err.textContent = "Close date must be after the open date.";
    if (m !== "free" && !(row.adult_rate > 0)) return err.textContent = "Enter the adult rate.";
    if (m === "discount" && !(row.cost > row.adult_rate)) return err.textContent = "For a discounted event, actual cost should be more than the adult rate.";
    if (row.cancel_paid === "until" && !row.cancel_until) return err.textContent = "Set the last date to cancel a paid pass.";
    if (row.cancel_until && e.sessions.length && row.cancel_until > e.sessions.map(s => s.date).sort()[0]) return err.textContent = "The last cancellation date should be on or before the first session.";
    if (row.late_from && (row.late_from < row.open_date || row.late_from > row.close_date)) return err.textContent = "The rate-increase date should fall inside the booking window.";
    const btn = $("#eSave", o); btn.disabled = true; btn.textContent = "Saving…";
    let id = ev && ev.id;
    const res = id ? await sb.from("events").update(row).eq("id", id) : await sb.from("events").insert(Object.assign(row, { created_by: S.user.id })).select("id").single();
    if (res.error) { btn.disabled = false; btn.textContent = "Save event"; return err.textContent = errMsg(res.error); }
    if (!id) id = res.data.id;
    const sorted = e.sessions.slice().sort((a, z) => a.date.localeCompare(z.date));
    const keep = sorted.filter(s => s.id).map(s => s.id);
    if (ev) { const gone = (ev.sessions || []).filter(s => !keep.includes(s.id)).map(s => s.id);
      if (gone.length) { const d = await sb.from("event_sessions").delete().in("id", gone); if (d.error) { btn.disabled = false; btn.textContent = "Save event"; return err.textContent = "A removed session already has bookings, so it can't be deleted."; } } }
    for (const [i, s] of sorted.entries()) {
      const r = { event_id: id, label: s.label || null, date: s.date, meal: s.meal, sort: i };
      const q = s.id ? await sb.from("event_sessions").update(r).eq("id", s.id) : await sb.from("event_sessions").insert(r);
      if (q.error) { btn.disabled = false; btn.textContent = "Save event"; return err.textContent = errMsg(q.error); }
    }
    closeSheet(); toast("Event saved"); reloadSoon();
  };
}

/* ───────────── committee: bookings ───────────── */
function filteredBookings() {
  const evId = $("#bkEvent").value, st = $("#bkStatus").value, blk = $("#bkBlock").value, pt = $("#bkType").value, q = $("#bkSearch").value.trim().toLowerCase();
  return S.bookings.filter(b => {
    if (evId && b.event_id !== evId) return false;
    const s = bStatus(b).k;
    if (pt && b.pass_type !== pt) return false;
    if (st === "unprinted") { if (s === "cancelled" || b.pass_type === "mobile" || b.printed_at) return false; }
    else if (st === "ungiven") { if (s !== "paid" && s !== "free") return false; const g = bookingGiven(b); if (g.g >= g.t) return false; }
    else if (st === "refund") { if (b.refund_status !== "due") return false; }
    else if (st === "auto") { if (b.cancel_reason !== "auto_unpaid") return false; }
    else if (st === "unsent") { if (s === "cancelled" || b.pass_type !== "mobile" || b.email_sent_at || b.wa_sent_at) return false; }
    else if (st) { if (s !== st) return false; } else if (s === "cancelled") return false;
    if (blk && b.block !== blk) return false;
    if (q && !(b.flat.toLowerCase().includes(q) || b.flat.replace("-", "").toLowerCase().includes(q) || b.name.toLowerCase().includes(q) || b.mobile.includes(q) || b.pass_no.toLowerCase().includes(q) || (b.upi_ref || "").toLowerCase().includes(q))) return false;
    return true;
  }).sort((a, b) => a.flat.localeCompare(b.flat, undefined, { numeric: true }) || a.created_at.localeCompare(b.created_at));
}
function renderBookings() {
  eventSelect($("#bkEvent"));
  const list = filteredBookings(), ev = evById($("#bkEvent").value), box = $("#bkTable");
  Object.keys(sel).forEach(k => { if (!list.some(b => b.id === k)) delete sel[k]; });
  $("#bkSummary").textContent = list.length ? `${list.length} booking${list.length === 1 ? "" : "s"} · ${list.reduce((s, b) => s + b.adults + b.children, 0)} persons · ${inr(list.reduce((s, b) => s + +b.amount, 0))}` : "";
  if (!ev) { box.innerHTML = `<div class="empty"><b>No events yet</b>Create an event first, then bookings will appear here.</div>`; $("#bkBulk").innerHTML = ""; return; }
  if (!list.length) { box.innerHTML = `<div class="empty"><b>No bookings match</b>${S.bookings.some(b => b.event_id === ev.id) ? "Try clearing the filters." : "Residents' bookings will appear here as soon as they book."}</div>`; $("#bkBulk").innerHTML = ""; return; }
  const allSel = list.every(b => sel[b.id]);
  box.innerHTML = `<div class="tablewrap bk"><table><thead><tr><th><input type="checkbox" id="selAll"${allSel ? " checked" : ""} aria-label="Select all"></th><th>Pass no.</th><th>Flat</th><th>Name</th><th>Mobile</th><th>Sessions</th><th class="r">A</th><th class="r">C</th><th class="r">Amount</th><th>Status</th><th>Given</th><th>Pass</th><th></th></tr></thead><tbody>
  ${list.map(b => { const st = bStatus(b); return `<tr>
    <td data-l="sel"><input type="checkbox" data-sel="${b.id}"${sel[b.id] ? " checked" : ""} aria-label="Select ${esc(b.pass_no)}"></td>
    <td data-l="pno" class="mono">${esc(b.pass_no)}</td><td data-l="flat"><b>${esc(b.flat)}</b></td><td data-l="name" class="tw">${esc(b.name)}${b.by_committee ? ' <span class="muted small">(desk)</span>' : ""}</td><td data-l="mob" class="mono">${esc(b.mobile)}</td>
    <td data-l="sess" class="tw small">${esc(sessLabel(ev, b.sessions))} · ${b.adults}A ${b.children}C</td><td data-l="a" class="r num">${b.adults}</td><td data-l="c" class="r num">${b.children}</td>
    <td data-l="amt" class="r num">${+b.amount > 0 ? inr(b.amount) : "Free"}${+b.late_fee ? `<div class="small muted">incl. late ${inr(b.late_fee)}</div>` : ""}</td>
    <td data-l="status"><span class="chip ${st.cls}">${esc(st.label)}</span>${b.upi_ref ? `<div class="small mono muted">UTR ${esc(b.upi_ref)}</div>` : ""}${b.paid_at && st.k === "paid" ? `<div class="small muted">${fdt(b.paid_at)}</div>${payWho(b) ? `<div class="small who-l">${esc(payWho(b))}</div>` : ""}` : ""}${st.k === "cancelled" ? `<div class="small who-l">${esc(cancelInfo(b))}</div>${refundInfo(b) ? `<span class="chip ${refundInfo(b).cls}">${esc(refundInfo(b).label)}</span>${b.refund_status !== "due" ? `<div class="small who-l">${esc(refundInfo(b).line)}</div>` : ""}` : ""}` : ""}</td>
    <td data-l="given">${(() => { const g = bookingGiven(b); return b.status === "cancelled" ? "—" : `<span class="chip ${g.cls}">🍽 ${g.label}</span>`; })()}</td>
    <td data-l="pass">${b.pass_type === "mobile" ? `<span class="small">📱 Mobile</span> <span class="small muted">${b.wa_sent_at ? "WA ✓ " : ""}${b.email_sent_at ? "Email ✓" : ""}${!b.wa_sent_at && !b.email_sent_at ? "Not sent" : ""}</span>` : `<span class="small">🖨️ Printed</span> <span class="small muted">${b.printed_at ? "Printed ✓" : "Not printed"}</span>`}</td>
    <td data-l="act"><div class="row" style="flex-wrap:nowrap"><button class="btn sm" data-pass="${b.id}" type="button">Send / view</button>${st.k === "pending" || st.k === "upi" ? `<button class="btn sm primary" data-pay="${b.id}" type="button">Mark paid</button>` : ""}${st.k === "paid" ? `<button class="btn sm" data-unpay="${b.id}" type="button">Undo paid</button>` : ""}${b.refund_status === "due" ? `<button class="btn sm primary" data-refund="${b.id}" type="button">Refund</button>` : ""}${st.k === "cancelled" ? (b.refund_status === "refunded" ? "" : `<button class="btn sm" data-restore="${b.id}" type="button">Restore</button>`) : `<button class="btn sm danger" data-cancel="${b.id}" type="button">Cancel</button>`}</div></td>
  </tr>`; }).join("")}</tbody></table></div>`;
  const find = id => S.bookings.find(x => x.id === id);
  $("#selAll").onchange = e => { list.forEach(b => { if (e.target.checked) sel[b.id] = 1; else delete sel[b.id]; }); renderBookings(); };
  $$("[data-sel]", box).forEach(c => c.onchange = () => { if (c.checked) sel[c.dataset.sel] = 1; else delete sel[c.dataset.sel]; drawBulk(); });
  $$("[data-pass]", box).forEach(b => b.onclick = () => passSheet(find(b.dataset.pass)));
  $$("[data-pay]", box).forEach(b => b.onclick = () => payForm(find(b.dataset.pay)));
  const rpc = async (fn, id, msg) => { const { error } = await sb.rpc(fn, { p_booking: id }); if (error) toast(errMsg(error)); else { toast(msg); reloadSoon(); } };
  $$("[data-unpay]", box).forEach(b => arm(b, () => rpc("undo_paid", b.dataset.unpay, "Payment entry removed"), "Confirm undo"));
  $$("[data-cancel]", box).forEach(b => arm(b, () => rpc("cancel_booking", b.dataset.cancel, "Booking cancelled"), "Confirm cancel"));
  $$("[data-restore]", box).forEach(b => b.onclick = () => rpc("restore_booking", b.dataset.restore, "Booking restored"));
  $$("[data-refund]", box).forEach(b => b.onclick = () => refundForm(find(b.dataset.refund)));
  drawBulk();
}
function drawBulk() {
  const ids = Object.keys(sel), box = $("#bkBulk");
  if (!ids.length) { box.innerHTML = ""; return; }
  const bs = ids.map(id => S.bookings.find(b => b.id === id)).filter(Boolean);
  const unpaid = bs.filter(b => ["pending", "upi"].includes(bStatus(b).k)), mail = bs.filter(b => active(b) && b.email);
  box.innerHTML = `<div class="bulk"><b>${ids.length} selected</b><span class="small" style="opacity:.8">${inr(unpaid.reduce((s, b) => s + +b.amount, 0))} unpaid</span><span style="flex:1"></span>
    ${unpaid.length ? `<button class="btn sm" id="bPay" type="button">Mark ${unpaid.length} paid…</button>` : ""}${mail.length ? `<button class="btn sm" id="bMail" type="button">Email ${mail.length}</button>` : ""}<button class="btn sm" id="bPrint" type="button">Print passes</button><button class="btn sm" id="bClr" type="button">Clear</button></div>`;
  $("#bClr").onclick = () => { Object.keys(sel).forEach(k => delete sel[k]); renderBookings(); };
  $("#bPrint").onclick = () => printPasses(bs.filter(active));
  if (unpaid.length) $("#bPay").onclick = () => payForm(null, unpaid);
  if (mail.length) arm($("#bMail"), () => bulkEmail(mail, $("#bMail")), "Confirm: email " + mail.length);
}
async function bulkEmail(list, btn) {
  btn.disabled = true; let ok = 0;
  for (const b of list) { btn.textContent = `Sending ${ok + 1}/${list.length}…`; if (await emailPass(b)) ok++; else break; }
  toast(`${ok} of ${list.length} emailed`); btn.disabled = false; reloadSoon();
}
function refundForm(b) {
  if (!b) return;
  const o = openSheet(`<header><div><div class="muted small">Refund · ${esc(cancelInfo(b))}</div><h2>${esc(b.flat)} · ${esc(b.name)}</h2><div class="mono small muted">${esc(b.pass_no)}</div></div><button class="x" type="button" aria-label="Close">×</button></header>
    <div class="prevbox"><div class="sumrow"><span>Paid</span><span>${esc(MODE[b.pay_mode] || "")}${b.collected_by_name ? " · received by " + esc(b.collected_by_name) : ""}</span><b class="num">${inr(b.refund_amount || 0)}</b></div></div>
    <div class="field"><span class="lab">Refund</span><div class="seg"><label><input type="radio" name="rfY" value="1" checked> Money returned</label><label><input type="radio" name="rfY" value="0"> No refund</label></div></div>
    <div class="field"><label for="rfRef">How / note</label><input id="rfRef" type="text" maxlength="120" placeholder="e.g. Cash returned by Sachin / UPI UTR 4123…"></div>
    <div class="who small"><svg class="ic sm"><use href="#i-user"/></svg><span>Recorded by <b>${esc(meName())}</b> · ${fdt(new Date().toISOString())}</span></div>
    <div class="err" id="rfErr"></div>
    <div class="row" style="justify-content:flex-end"><button class="btn x2" type="button">Cancel</button><button class="btn primary" type="button" id="rfGo">Save</button></div>`);
  $(".x2", o).onclick = closeSheet;
  $("#rfGo", o).onclick = async () => {
    const y = $("input[name=rfY]:checked", o).value === "1", note = $("#rfRef", o).value.trim();
    if (!y && !note) return $("#rfErr", o).textContent = "Write why no refund is given.";
    const { error } = await sb.rpc("record_refund", { p_booking: b.id, p_refunded: y, p_ref: note || null });
    if (error) $("#rfErr", o).textContent = errMsg(error); else { closeSheet(); toast(y ? "Refund recorded" : "Saved: no refund"); reloadSoon(); }
  };
}
/* record a payment for one or many bookings: mode, amount, who received the cash / who marked it */
function payForm(b, many) {
  const list = many || [b]; if (!list[0]) return;
  const one = list.length === 1, total = list.reduce((t, x) => t + +x.amount, 0), upiRef = one && list[0].upi_ref;
  const o = openSheet(`<header><div><div class="muted small">Record payment</div><h2>${one ? esc(list[0].flat) + " · " + esc(list[0].name) : list.length + " bookings · " + inr(total)}</h2>${one ? `<div class="mono small muted">${esc(list[0].pass_no)}</div>` : ""}</div><button class="x" type="button" aria-label="Close">×</button></header>
    <div class="field"><span class="lab">How was it paid? <span class="gu">ચુકવણી કેવી રીતે?</span></span>
      <div class="seg paymode">${["cash", "upi", "other", "waived"].map(m => `<label><input type="radio" name="pyM" value="${m}"${(upiRef ? m === "upi" : m === "cash") ? " checked" : ""}> ${MODE[m]}</label>`).join("")}</div></div>
    ${one ? `<div class="field"><label for="pyAmt">Amount received (₹)</label><input id="pyAmt" type="number" min="0" inputmode="numeric" value="${+list[0].amount}"></div>` : `<div class="notice small">Each booking is marked paid for its own amount (total ${inr(total)}).</div>`}
    <div class="pm pm-cash"><div class="field"><label for="pyBy">Cash received by <span class="gu">રોકડ કોણે લીધી?</span></label><select id="pyBy">${collectorOpts(S.user.id)}</select></div>
      <div class="field" id="pyNameF" hidden><label for="pyName">Name of the person who received the cash</label><input id="pyName" type="text" maxlength="60" placeholder="e.g. Ramesh Patel (volunteer, B-204)"></div></div>
    <div class="pm pm-upi"><div class="field"><label for="pyUtr">UPI reference / UTR</label><input id="pyUtr" type="text" inputmode="numeric" maxlength="40" value="${esc(upiRef || "")}" placeholder="12-digit UTR from the bank app"></div>
      ${upiRef ? `<div class="notice small" style="background:var(--info-soft);border:0">Resident submitted UTR <span class="mono">${esc(upiRef)}</span> on ${fdt(list[0].upi_at)}. Check it in the bank statement before confirming.</div>` : ""}</div>
    <div class="pm pm-other"><div class="field"><label for="pyNote">How was it paid? (required)</label><input id="pyNote" type="text" maxlength="120" placeholder="e.g. Cheque 004512 HDFC / NEFT / adjusted in maintenance"></div></div>
    <div class="pm pm-waived"><div class="field"><label for="pyWhy">Reason (optional)</label><input id="pyWhy" type="text" maxlength="120" placeholder="e.g. Volunteer / guest of society"></div></div>
    <div class="pm pm-cash pm-other"><div class="field"><label for="pyRef">Receipt no. (optional)</label><input id="pyRef" type="text" maxlength="40"></div></div>
    <div class="who small" id="pyWho"></div>
    <div class="err" id="pyErr"></div>
    <div class="row" style="justify-content:flex-end"><button class="btn" type="button" id="pyC">Cancel</button><button class="btn primary" type="button" id="pyGo">${one ? "Mark paid" : "Mark " + list.length + " paid"}</button></div>`);
  const mode = () => $("input[name=pyM]:checked", o).value;
  const sync = () => {
    const m = mode(), other = $("#pyBy", o).value === "__other"; $("#pyErr", o).textContent = "";
    $$(".pm", o).forEach(x => x.hidden = !x.classList.contains("pm-" + m));
    $("#pyNameF", o).hidden = !(m === "cash" && other);
    const who = m === "cash" ? `<b>${esc(other ? ($("#pyName", o).value.trim() || "…") : $("#pyBy option:checked", o).textContent.replace(" (me)", ""))}</b> received the cash` : m === "upi" ? "UPI checked in the bank statement" : m === "other" ? "Paid by another method" : "No money collected";
    $("#pyWho", o).innerHTML = `<svg class="ic sm"><use href="#i-user"/></svg><span>${who} · marked paid by <b>${esc(meName())}</b> · ${fdt(new Date().toISOString())}</span>`;
  };
  $$("input[name=pyM]", o).forEach(r => r.onchange = sync); $("#pyBy", o).onchange = sync; $("#pyName", o).oninput = sync; sync();
  $("#pyC", o).onclick = closeSheet;
  $("#pyGo", o).onclick = async () => {
    const m = mode(), err = $("#pyErr", o), by = $("#pyBy", o).value, typed = $("#pyName", o).value.trim();
    if (m === "cash" && by === "__other" && !typed) return err.textContent = "Type the name of the person who received the cash.";
    if (m === "other" && !$("#pyNote", o).value.trim()) return err.textContent = "Write how it was paid (e.g. cheque number).";
    const btn = $("#pyGo", o); btn.disabled = true; let n = 0, last = null;
    for (const x of list) {
      const amt = one ? (+$("#pyAmt", o).value || 0) : +x.amount;
      const { error } = await sb.rpc("record_payment", { p_booking: x.id, p_mode: m, p_amount: amt,
        p_ref: (m === "upi" ? $("#pyUtr", o).value : m === "waived" ? "" : $("#pyRef", o).value).trim() || null,
        p_collected_by: m === "cash" && by !== "__other" ? by : null, p_collected_name: m === "cash" && by === "__other" ? typed : null,
        p_note: (m === "other" ? $("#pyNote", o).value : m === "waived" ? $("#pyWhy", o).value : "").trim() || null });
      if (error) { last = error; break; } n++;
    }
    btn.disabled = false;
    if (last) { err.textContent = (n ? n + " marked paid, then: " : "") + errMsg(last); if (n) reloadSoon(); return; }
    closeSheet(); toast(n === 1 ? "Marked paid" : n + " marked paid"); reloadSoon();
  };
}

/* ───────────── committee: counter (live camera + photo + search) ───────────── */
function sessRows(b, sessions, givenMap, okToServe, focusN) {
  return sessions.map(s => {
    const ps = persons(b), left = ps.filter(p => !(givenMap[s.id] || {})[p.n]);
    const chips = ps.map(p => { const d = (givenMap[s.id] || {})[p.n], f = focusN === p.n ? " focus" : "";
      return d ? `<button class="pchip done${f}" type="button" data-unserve="${b.id}|${s.id}|${p.n}" title="Tap to undo">${p.type} ${p.n} ✓ ${hm(d.at)}</button>`
               : `<button class="pchip${f}" type="button" data-serve="${b.id}|${s.id}|${p.n}"${okToServe ? "" : " disabled"}>${p.type} ${p.n}</button>`; }).join("");
    return `<div class="srow"><div class="spread"><span>${esc(s.label || s.meal)} · ${fd(s.date)}${s.date === today() ? ' <span class="chip gold">Today</span>' : ""}</span>
      <span class="small muted">${ps.length - left.length}/${ps.length} given${left.length > 1 && okToServe ? ` · <button class="linkbtn" type="button" data-serveall="${b.id}|${s.id}|${left.map(p => p.n).join(",")}">give all ${left.length}</button>` : ""}</span></div>
      <div class="pchips">${chips}</div></div>`;
  }).join("");
}
function wireServe(box, after) {
  const call = async (bid, sid, ns, on) => { const { error } = await sb.rpc("set_given", { p_booking: bid, p_session: sid, p_persons: ns, p_given: on }); if (error) toast(errMsg(error)); after && after(); };
  $$("[data-serve]", box).forEach(btn => btn.onclick = () => { const [b, s, n] = btn.dataset.serve.split("|"); call(b, s, [+n], true); });
  $$("[data-serveall]", box).forEach(btn => arm(btn, () => { const [b, s, ns] = btn.dataset.serveall.split("|"); call(b, s, ns.split(",").map(Number), true); }, "confirm"));
  $$("[data-unserve]", box).forEach(btn => arm(btn, () => { const [b, s, n] = btn.dataset.unserve.split("|"); call(b, s, [+n], false); }, "Undo?"));
}
function renderCounter() {
  eventSelect($("#ctEvent"));
  const lev = evById($("#ctEvent").value); $("#ctLive").innerHTML = lev ? liveMealsPanel(lev, 5) : "";
  const q = $("#ctQ").value.trim().toUpperCase().replace(/\s/g, ""), box = $("#ctBody"), evId = $("#ctEvent").value;
  if (!q) { box.innerHTML = ""; return; }
  const hits = S.bookings.filter(b => (!evId || b.event_id === evId) && (b.pass_no === q || q.startsWith(b.pass_no + "-") || b.flat === q || b.flat.replace("-", "") === q.replace("-", "") || (q.length >= 4 && b.pass_no.includes(q))));
  if (!hits.length) { box.innerHTML = `<div class="empty"><b>No pass found</b>Check the number, or the event selected above.</div>`; return; }
  box.innerHTML = hits.map(b => { const ev = evById(b.event_id) || {}, st = bStatus(b), ok = st.k === "paid" || st.k === "free";
    return `<div class="panel"><div class="spread"><div><span class="mono" style="font-weight:700">${esc(b.pass_no)}</span> · <b>${esc(b.flat)}</b> · ${esc(b.name)}</div><span class="chip ${st.cls}">${esc(st.label)}</span></div>
      <div class="small muted" style="margin:4px 0 6px">${esc(ev.name_en || ev.name_gu || "")} · ${esc(evDates(ev, b))} · ${b.adults} adult${b.adults === 1 ? "" : "s"}, ${b.children} child${b.children === 1 ? "" : "ren"} · ${inr(b.amount)}</div>
      ${ok ? "" : `<div class="notice warn small">Payment not confirmed. Collect ${inr(b.amount)} before giving items.</div>`}
      ${sessRows(b, (ev.sessions || []).filter(s => b.sessions.includes(s.id)), S.checkins[b.id] || {}, ok)}</div>`; }).join("");
  wireServe(box, () => reloadSoon());
}
let scanBusy = false, lastTok = "", lastAt = 0;
async function handleScan(raw, auto) {
  const t = String(raw || "").trim().replace(/^.*#/, "").toUpperCase();
  if (t.startsWith("G:")) return handleGroupScan(t, auto);
  const now = Date.now(); if (scanBusy || (t === lastTok && now - lastAt < 4000)) return; scanBusy = true; lastTok = t; lastAt = now;
  const box = $("#ctScan"); box.innerHTML = `<div class="result ask"><div class="status-line"><span class="spinner"></span><b>Checking ${esc(t.slice(0, 30))}…</b></div></div>`;
  const { data: j, error } = await sb.rpc("scan_pass", { p_token: t, p_auto: !!auto });
  scanBusy = false;
  if (error) { box.innerHTML = `<div class="result stop"><div class="big">Could not check</div><div class="small">${esc(errMsg(error))}</div></div>`; return; }
  if (j.result === "given") reloadSoon();
  if (navigator.vibrate) navigator.vibrate(j.result === "given" || j.result === "valid" || j.result === "booking" ? 60 : [80, 60, 80]);
  if (j.result === "not_found") { box.innerHTML = `<div class="result stop"><div class="big">✕ Pass not found</div><div class="small">Read: <span class="mono">${esc(j.token)}</span>. Ask for the pass number and search below.</div></div>`; return; }
  const b = normBooking(Object.assign({}, j.booking, { booking_sessions: (j.sessions || []).map(s => ({ session_id: s.id })) }));
  const n = j.person || 0, p = n ? persons(b)[n - 1] : null, gm = {};
  (j.given || []).forEach(g => { (gm[g.session_id] = gm[g.session_id] || {})[g.person_no] = { at: g.given_at }; });
  const detail = `<dl class="kv vfy">${p ? `<dt>Person</dt><dd><b>${p.type} ${n}</b> of ${b.adults + b.children} <span class="gu">${p.gu}</span></dd>` : `<dt>Persons</dt><dd><b>${b.adults + b.children}</b> (${b.adults} adult${b.adults === 1 ? "" : "s"}${b.children ? ", " + b.children + " child" + (b.children > 1 ? "ren" : "") : ""})</dd>`}
    <dt>Flat</dt><dd><b>${esc(b.flat)}</b></dd><dt>Name</dt><dd>${esc(b.name)}</dd>
    <dt>Event</dt><dd><span class="gu">${esc(j.event.name_gu || "")}</span>${j.event.name_gu && j.event.name_en ? " · " : ""}${esc(j.event.name_en || "")}</dd>
    <dt>Date</dt><dd>${esc([...new Set((j.sessions || []).map(s => fd(s.date)))].join(", "))}</dd><dt>Pass</dt><dd class="mono">${esc(tok(b, n))}</dd></dl>`;
  const rows = `<div style="margin-top:8px">${sessRows(b, j.sessions || [], gm, b.status === "paid", n || null)}</div>`;
  const last = (j.sessions || []).filter(s => s.date === today()).map(s => (gm[s.id] || {})[n]).filter(Boolean).pop();
  const cards = {
    given: ["go", `✓ Give item · ${p && p.type} ${n}`, `<div class="small">Marked as given just now.</div>${rows}`],
    valid: ["go", `✓ Valid · ${p && p.type} ${n}`, `<div class="small">Tap ${p && p.type} ${n} under today's session to mark it given.</div>${rows}`],
    booking: ["go", "✓ Valid booking", `<div class="small">This is the booking number. Tap each person as items are given.</div>${rows}`],
    already_given: ["stop", `✕ Already given${last ? " at " + hm(last.at) : ""}`, `<div class="small">Do not give again.</div>${rows}`],
    no_session_today: ["ask", "No session today for this pass", rows],
    unpaid: ["ask", "Payment pending · " + inr(b.amount), `${b.upi_ref ? `<div class="small">UTR submitted: <span class="mono">${esc(b.upi_ref)}</span></div>` : ""}<div class="row" style="margin-top:6px"><button class="btn primary" type="button" data-scanpay>Collect &amp; mark paid</button></div>`],
    cancelled: ["stop", "✕ Cancelled pass", "<div>Do not give items.</div>"],
  }[j.result] || ["ask", j.result, ""];
  box.innerHTML = `<div class="result ${cards[0]}" role="status"><div class="big">${cards[1]}</div>${detail}${cards[2]}</div>`;
  wireServe(box, () => { lastTok = ""; handleScan(tok(b, n), false); reloadSoon(); });
  const pb = $("[data-scanpay]", box); if (pb) pb.onclick = () => payForm(Object.assign(S.bookings.find(x => x.id === b.id) || b));
}
/* one QR for several passes */
const RES_UI = {
  given: ["ok", "✓ Given now"], ready: ["info", "Ready to give"], already_given: ["bad", "Already given"],
  unpaid: ["warn", "Payment due"], cancelled: ["bad", "Cancelled"], no_session_today: ["warn", "No session today"],
  other_event: ["bad", "Different event"], not_found: ["bad", "Not found"] };
async function handleGroupScan(t, auto, force) {
  const now = Date.now(); if (!force && (scanBusy || (t === lastTok && now - lastAt < 4000))) return; scanBusy = true; lastTok = t; lastAt = now;
  const box = $("#ctScan"); box.innerHTML = `<div class="result ask"><div class="status-line"><span class="spinner"></span><b>Checking group pass…</b></div></div>`;
  const { data: j, error } = await sb.rpc("scan_group", { p_token: t, p_auto: !!auto });
  scanBusy = false;
  if (error) { box.innerHTML = `<div class="result stop"><div class="big">Could not check</div><div class="small">${esc(errMsg(error))}</div></div>`; return; }
  const items = j.items || [], bad = items.filter(x => !["given", "ready"].includes(x.result));
  if (navigator.vibrate) navigator.vibrate(j.give > 0 ? 60 : [80, 60, 80]);
  const cls = j.give === 0 ? "stop" : bad.length ? "ask" : "go";
  const big = j.give === 0 ? "✕ Nothing to give" : j.given_now ? `✓ Give ${j.given_now} dish${j.given_now === 1 ? "" : "es"}` : `${j.ready} dish${j.ready === 1 ? "" : "es"} ready to give`;
  const ev = j.event || {}, A = items.filter(x => ["given", "ready"].includes(x.result) && x.type === "Adult").length, C = items.filter(x => ["given", "ready"].includes(x.result) && x.type === "Child").length;
  const rows = items.map(x => { const u = RES_UI[x.result] || ["", x.result];
    return `<div class="grow"><span><b>${esc(x.type || "?")} ${x.person}</b> <span class="mono small">${esc(x.pass_no)}</span>${x.flat ? `<small>${esc(x.flat)} · ${esc(x.name || "")}${x.session ? " · " + esc(x.session) : ""}</small>` : ""}</span>
      <span class="chip ${u[0]}">${u[1]}${x.given_at && x.result === "already_given" ? " " + hm(x.given_at) : ""}</span></div>`; }).join("");
  box.innerHTML = `<div class="result ${cls}" role="status"><div class="big">${big}</div>
    <div class="gcount"><span><b>${j.give}</b> to give</span>${A ? `<span>${A} adult${A === 1 ? "" : "s"}</span>` : ""}${C ? `<span>${C} child${C === 1 ? "" : "ren"}</span>` : ""}${bad.length ? `<span class="warnc">${bad.length} not valid</span>` : ""}</div>
    <dl class="kv vfy"><dt>Group pass</dt><dd>${j.total} pass${j.total === 1 ? "" : "es"} in one QR</dd>
      <dt>Flat</dt><dd><b>${esc((j.flats || []).join(", ") || "—")}</b></dd><dt>Name</dt><dd>${esc((j.names || []).join(", ") || "—")}</dd>
      <dt>Event</dt><dd><span class="gu">${esc(ev.name_gu || "")}</span>${ev.name_gu && ev.name_en ? " · " : ""}${esc(ev.name_en || "")}</dd></dl>
    <div class="glist">${rows}</div>
    ${!auto && j.ready ? `<button class="btn primary big" type="button" id="gGive">Give all ${j.ready} and mark as given</button>` : ""}
    ${(j.flats || []).length > 1 ? `<div class="small" style="color:var(--warn)">This QR has passes from more than one flat. Check with the resident.</div>` : ""}</div>`;
  if ($("#gGive")) $("#gGive").onclick = () => handleGroupScan(t, true, true);
  reloadSoon();
}

/* live camera */
let camStream = null, camTimer = 0, detector = null;
try { detector = ("BarcodeDetector" in window) ? new BarcodeDetector({ formats: ["qr_code"] }) : null; } catch (e) { detector = null; }
async function startCam() {
  try { camStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 } }, audio: false }); }
  catch (e) { $("#camHint").textContent = "Camera not available. Allow camera access in the browser, or use “From photo / screenshot”."; return; }
  const v = $("#camVideo"); v.srcObject = camStream; await v.play();
  $("#camBox").hidden = false; $("#camStart").hidden = true; $("#camHint").textContent = "Hold the QR inside the frame.";
  const cv = document.createElement("canvas"), g = cv.getContext("2d", { willReadFrequently: true });
  const tick = async () => {
    if (!camStream) return;
    if (v.readyState >= 2 && !scanBusy) {
      let txt = null;
      if (detector) { try { const r = await detector.detect(v); if (r[0]) txt = r[0].rawValue; } catch (e) {} }
      if (!txt) { const w = 640, h = Math.round(640 * v.videoHeight / v.videoWidth) || 480; cv.width = w; cv.height = h; g.drawImage(v, 0, 0, w, h); const r = jsQR(g.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: "dontInvert" }); if (r) txt = r.data; }
      if (txt) { $("#camBox").classList.add("hit"); setTimeout(() => $("#camBox").classList.remove("hit"), 400); handleScan(txt, $("#ctAuto").checked); }
    }
    camTimer = setTimeout(tick, 220);
  };
  tick();
}
function stopCam() { clearTimeout(camTimer); if (camStream) camStream.getTracks().forEach(t => t.stop()); camStream = null; $("#camBox").hidden = true; $("#camStart").hidden = false; $("#camHint").textContent = ""; }
$("#camStart").onclick = startCam; $("#camStop").onclick = stopCam;
async function decodeFile(file) {
  const img = await createImageBitmap(file).catch(() => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = URL.createObjectURL(file); }));
  if (detector) { try { const r = await detector.detect(img); if (r[0]) return r[0].rawValue; } catch (e) {} }
  for (const t of [{ c: 1, m: 1000 }, { c: 1, m: 1400 }, { c: 1, m: 700 }, { c: .7, m: 900 }, { c: .5, m: 900 }, { c: 1, m: 2000 }]) {
    const cw = img.width * t.c, ch = img.height * t.c, sc = Math.min(1, t.m / Math.max(cw, ch)), w = Math.round(cw * sc), h = Math.round(ch * sc);
    const cv = document.createElement("canvas"); cv.width = w; cv.height = h; const g = cv.getContext("2d", { willReadFrequently: true });
    g.drawImage(img, (img.width - cw) / 2, (img.height - ch) / 2, cw, ch, 0, 0, w, h);
    const r = jsQR(g.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: "attemptBoth" }); if (r) return r.data;
  }
  return null;
}
$("#ctPick").addEventListener("change", async e => {
  const f = e.target.files && e.target.files[0]; if (!f) return; e.target.value = "";
  $("#ctScan").innerHTML = `<div class="result ask"><div class="status-line"><span class="spinner"></span><b>Reading QR…</b></div></div>`;
  const txt = await decodeFile(f).catch(() => null);
  if (!txt) { $("#ctScan").innerHTML = `<div class="result stop"><div class="big">QR not readable</div><div class="small">Keep the whole QR in the photo and avoid glare, or type the pass number below.</div></div>`; return; }
  lastTok = ""; handleScan(txt, $("#ctAuto").checked);
});

/* ───────────── committee: reports & print ───────────── */
function renderReports() {
  eventSelect($("#rpEvent"));
  const ev = evById($("#rpEvent").value), box = $("#rpBody");
  if (!ev) { box.innerHTML = `<div class="empty"><b>No events yet</b>Reports and passes appear once an event has bookings.</div>`; return; }
  const r = evStats(ev), bs = S.bookings.filter(b => b.event_id === ev.id && active(b));
  const phys = bs.filter(b => b.pass_type !== "mobile"), ready = phys.filter(b => b.status === "paid"), unprinted = ready.filter(b => !b.printed_at);
  const mobReady = bs.filter(b => b.pass_type === "mobile" && b.email && !b.email_sent_at);
  box.innerHTML = `
    <div class="grid2">
      <div class="panel"><h3>Print passes</h3><p class="small muted" style="margin:6px 0 12px">A4 sheets with 8 cut-out passes per page, one per person, each with its own QR.</p>
        <div style="display:grid;gap:8px">
          <button class="btn primary" type="button" id="prNew"${unprinted.length ? "" : " disabled"}>Printed passes, paid, not yet printed (${unprinted.length})</button>
          <button class="btn" type="button" id="prReady"${ready.length ? "" : " disabled"}>All printed passes, paid (${ready.length})</button>
          <button class="btn" type="button" id="prAll"${bs.length ? "" : " disabled"}>Every active booking incl. mobile &amp; unpaid (${bs.length})</button>
        </div>
        <div class="hr" style="margin-block:12px"></div>
        <button class="btn" type="button" id="mlAll"${mobReady.length ? "" : " disabled"}>Email all mobile passes not yet sent (${mobReady.length})</button><div class="err" id="mlErr"></div></div>
      <div class="panel"><h3>Excel report</h3><p class="small muted" style="margin:6px 0 12px">Summary, all bookings, person passes, session headcount, block-wise and pending payments.</p>
        <button class="btn primary" type="button" id="xlOne">Download report for this event</button>
        <div class="hr" style="margin-block:12px"></div>
        <button class="btn" type="button" id="xlAll"${S.events.length > 1 ? "" : " disabled"}>Download all events</button></div>
    </div>
    <div class="panel" style="margin-top:12px"><h3 style="margin-bottom:8px">Summary</h3>
      <dl class="kv" style="max-width:460px">
        <dt>Passes / persons</dt><dd class="num">${r.passes} / ${r.persons} (${r.adults} A, ${r.children} C)</dd>
        <dt>Billed</dt><dd class="num">${inr(r.billed)}</dd><dt>Collected</dt><dd class="num">${inr(r.collected)} (Cash ${inr(r.cash)}, UPI ${inr(r.upi)}${r.other ? ", Other " + inr(r.other) : ""})</dd>
        <dt>Pending</dt><dd class="num">${inr(r.pending)}</dd>${r.cost ? `<dt>Actual cost</dt><dd class="num">${inr(r.cost)}</dd><dt>Society subsidy</dt><dd class="num">${inr(r.subsidy)}</dd>` : ""}
        <dt>Cancelled</dt><dd class="num">${r.cancelled}${r.autoCancelled ? ` (${r.autoCancelled} auto, unpaid)` : ""}</dd>
        ${r.refundDueN ? `<dt>Refunds due</dt><dd class="num" style="color:var(--warn)"><b>${inr(r.refundDue)}</b> (${r.refundDueN})</dd>` : ""}${r.refunded ? `<dt>Refunded</dt><dd class="num">${inr(r.refunded)}</dd>` : ""}</dl>
        ${policyBox(ev, null, "rules for this event")}</div>
    ${collectorTable(r)}`;
  $("#prNew").onclick = () => printPasses(unprinted); $("#prReady").onclick = () => printPasses(ready); $("#prAll").onclick = () => printPasses(bs);
  if (mobReady.length) arm($("#mlAll"), () => bulkEmail(mobReady, $("#mlAll")), "Confirm: email " + mobReady.length);
  $("#xlOne").onclick = () => excel([ev]); $("#xlAll").onclick = () => excel(S.events.slice());
}
/* who holds the money: cash by the person who RECEIVED it; UPI / other by the person who MARKED it paid */
function collectorTable(r) {
  const rows = Object.values(r.byCollector).sort((a, z) => (z.cash + z.upi + z.other) - (a.cash + a.upi + a.other));
  if (!rows.length) return "";
  const t = rows.reduce((s, c) => ({ cash: s.cash + c.cash, upi: s.upi + c.upi, other: s.other + c.other }), { cash: 0, upi: 0, other: 0 });
  return `<div class="panel" style="margin-top:12px" id="rpWho"><h3>Money collected by person</h3>
    <p class="small muted" style="margin:4px 0 10px">Cash is counted against the person who <b>received</b> it, so each member can hand it over to the treasurer. UPI and other payments are listed against the person who <b>verified and marked</b> them paid.</p>
    <div class="whol">${rows.map(c => `<div class="whor"><b class="nm">${esc(c.name)}</b><span class="tt num">${inr(c.cash + c.upi + c.other)}</span>
      <span class="parts">${c.cashN ? `<span><i class="cash"></i>Cash in hand <b>${inr(c.cash)}</b> (${c.cashN})</span>` : ""}${c.upiN ? `<span><i class="upi"></i>UPI verified <b>${inr(c.upi)}</b> (${c.upiN})</span>` : ""}${c.otherN ? `<span><i class="oth"></i>Other <b>${inr(c.other)}</b> (${c.otherN})</span>` : ""}</span></div>`).join("")}
    <div class="whor tot"><b class="nm">Total</b><span class="tt num">${inr(t.cash + t.upi + t.other)}</span><span class="parts"><span>Cash <b>${inr(t.cash)}</b></span><span>UPI <b>${inr(t.upi)}</b></span>${t.other ? `<span>Other <b>${inr(t.other)}</b></span>` : ""}</span></div></div></div>`;
}
function printPasses(list) {
  if (!list.length) { toast("No passes to print."); return; }
  list = list.slice().sort((a, b) => a.flat.localeCompare(b.flat, undefined, { numeric: true }));
  const issued = fd(today()), tickets = []; list.forEach(b => persons(b).forEach(p => tickets.push([b, p.n])));
  const card = ([b, n]) => { const ev = evById(b.event_id) || {}, st = bStatus(b), pp = persons(b)[n - 1];
    const stamp = st.k === "paid" ? "PAID" : st.k === "free" ? "FREE" : "PAYMENT DUE";
    return `<div class="p"><div class="hd"><img src="${SITE}/assets/logo.png" alt=""><div><div class="ev">${esc(ev.name_gu || ev.name_en)}</div><div class="en">${esc(ev.name_en || "")}</div></div></div>
      <div class="bd"><div class="info"><div class="flat">${esc(b.flat)}</div><div class="nm">${esc(b.name)}</div><div class="person">${pp.type.toUpperCase()} ${n} <span>of ${b.adults + b.children} · ${pp.gu}</span></div>
      <table><tr><td>Session</td><td>${esc(sessLabel(ev, b.sessions))}</td></tr><tr><td>Date</td><td>${esc(evDates(ev, b))}</td></tr>${ev.venue ? `<tr><td>Venue</td><td>${esc(ev.venue)}</td></tr>` : ""}</table></div>
      <div class="qr">${qrSvg(passUrl(b, n))}<div class="no">${esc(tok(b, n))}</div></div></div>
      <div class="ft"><span class="st ${stamp === "PAYMENT DUE" ? "due" : ""}">${stamp}</span><span>Issued ${issued}</span><span class="sg">Committee sign</span></div></div>`; };
  const chunks = []; for (let i = 0; i < tickets.length; i += 8) chunks.push(tickets.slice(i, i + 8));
  const html = `<!doctype html><html lang="gu"><head><meta charset="utf-8"><title>Serenity Space Passes</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Baloo+Bhai+2:wght@600;700&family=Hind+Vadodara:wght@400;600&family=IBM+Plex+Mono:wght@600&display=swap">
<style>@page{size:A4;margin:8mm}*{box-sizing:border-box}body{margin:0;font-family:"Hind Vadodara",Arial,sans-serif;color:#17231a;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.sheet{display:grid;grid-template-columns:repeat(2,95mm);grid-auto-rows:68mm;gap:3mm 4mm;justify-content:center;padding-top:2mm}
.p{border:1.4px dashed #1f5a33;border-radius:3mm;padding:3mm 3.5mm;display:flex;flex-direction:column;break-inside:avoid;overflow:hidden}
.hd{display:flex;gap:3mm;align-items:center;border-bottom:1px solid #cfdcc9;padding-bottom:1.6mm}.hd img{height:12mm}
.ev{font-family:"Baloo Bhai 2",sans-serif;font-weight:700;font-size:13pt;line-height:1.05;color:#1f5a33}.en{font-size:8pt;color:#5e6b60}
.bd{display:flex;gap:3mm;flex:1;padding-top:1.6mm;min-height:0}.info{flex:1;min-width:0}
.flat{font-family:"Baloo Bhai 2",sans-serif;font-weight:700;font-size:17pt;line-height:1}.nm{font-size:10pt;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.person{display:inline-block;background:#1f5a33;color:#fff;font-weight:700;font-size:9pt;padding:.3mm 2mm;border-radius:1mm;margin:.6mm 0 .8mm}.person span{font-weight:400}
table{border-collapse:collapse;font-size:8pt;width:100%}td{padding:.3mm 0;vertical-align:top}td:first-child{color:#5e6b60;width:14mm}
.qr{width:25mm;display:flex;flex-direction:column;align-items:center;gap:1mm}.qr svg{width:25mm;height:25mm}.no{font-family:"IBM Plex Mono",monospace;font-size:6.4pt;font-weight:600;text-align:center;word-break:break-all}
.ft{display:flex;justify-content:space-between;align-items:center;font-size:7pt;color:#5e6b60;border-top:1px solid #cfdcc9;padding-top:1.2mm;gap:2mm}
.st{font-weight:700;color:#fff;background:#1f5a33;padding:.4mm 2.4mm;border-radius:1mm;font-size:8pt}.st.due{background:#b23a26}.sg{border-top:1px solid #8a968c;min-width:22mm;text-align:center}
.pg{break-after:page}.pg:last-child{break-after:auto}</style></head><body>
${chunks.map(pg => `<div class="pg"><div class="sheet">${pg.map(card).join("")}</div></div>`).join("")}
<script>window.onload=()=>setTimeout(()=>window.print(),400)<\/script></body></html>`;
  const w = window.open("", "_blank"); if (!w) { toast("Allow pop-ups for this site to print."); return; }
  w.document.open(); w.document.write(html); w.document.close();
  Promise.all(list.filter(b => !b.printed_at).map(b => sb.rpc("mark_sent", { p_booking: b.id, p_channel: "print" }))).then(reloadSoon);
}
async function excel(evs) {
  try { await loadScript("vendor/xlsx.full.min.js"); } catch (e) { toast("Could not load the Excel library."); return; }
  const ids = new Set(evs.map(e => e.id)), wb = XLSX.utils.book_new();
  const sheet = rows => { const ws = XLSX.utils.json_to_sheet(rows.length ? rows : [{ Note: "No data" }]); const keys = Object.keys(rows[0] || { Note: 1 }); ws["!cols"] = keys.map(k => ({ wch: Math.min(40, Math.max(k.length + 2, ...rows.map(r => String(r[k] == null ? "" : r[k]).length + 1))) })); return ws; };
  XLSX.utils.book_append_sheet(wb, sheet(evs.map(ev => { const r = evStats(ev); return { "Event": ev.name_en || ev.name_gu, "Gujarati name": ev.name_gu || "", "Type": ev.kind === "multi" ? "Multiple sessions" : "One time", "Pricing": ev.price_mode === "free" ? "Free" : ev.price_mode === "discount" ? "Discounted" : "At cost",
    "Booking opens": fd(ev.open_date), "Booking closes": fd(ev.close_date), "Passes": r.passes, "Adults": r.adults, "Children": r.children, "Persons": r.persons, "Billed (₹)": r.billed, "Collected (₹)": r.collected, "Cash (₹)": r.cash, "UPI (₹)": r.upi, "Other (₹)": r.other, "Pending (₹)": r.pending, "Refunds due (₹)": r.refundDue, "Refunded (₹)": r.refunded, "Actual cost (₹)": r.cost, "Society subsidy (₹)": r.subsidy, "Cancelled": r.cancelled }; })), "Summary");
  const bks = S.bookings.filter(b => ids.has(b.event_id)).sort((a, b) => a.flat.localeCompare(b.flat, undefined, { numeric: true }));
  const rows = bks.map(b => { const ev = evById(b.event_id) || {}, st = bStatus(b); return { "Event": ev.name_en || ev.name_gu, "Pass no.": b.pass_no, "Block": b.block, "Flat": b.flat, "Name": b.name, "Mobile": b.mobile, "Email": b.email || "", "Pass type": b.pass_type === "mobile" ? "Mobile" : "Printed",
    "Sessions": sessLabel(ev, b.sessions), "Adults": b.adults, "Children": b.children, "Amount (₹)": +b.amount, "Late fee (₹)": +b.late_fee, "Status": st.label, "Paid amount (₹)": st.k === "paid" ? +b.paid_amount : 0, "Mode": MODE[b.pay_mode] || "", "Cash received by": b.pay_mode === "cash" ? b.collected_by_name || "" : "", "Marked paid by": b.paid_by_name || "", "Receipt / UTR": b.pay_ref || b.upi_ref || "", "Payment note": b.pay_note || "", "Cancelled": b.status === "cancelled" ? cancelInfo(b) : "", "Refund": refundInfo(b) ? refundInfo(b).line : "",
    "Paid on": b.paid_at ? fdt(b.paid_at) : "", "Printed": b.printed_at ? fdt(b.printed_at) : "", "WhatsApp sent": b.wa_sent_at ? fdt(b.wa_sent_at) : "", "Email sent": b.email_sent_at ? fdt(b.email_sent_at) : "", "Booked on": fdt(b.created_at), "Booked at desk": b.by_committee ? "Yes" : "No" }; });
  XLSX.utils.book_append_sheet(wb, sheet(rows), "All bookings");
  const coll = []; evs.forEach(ev => Object.values(evStats(ev).byCollector).forEach(c => coll.push({ "Event": ev.name_en || ev.name_gu, "Committee member": c.name, "Cash received (₹)": c.cash, "Cash bookings": c.cashN, "UPI verified (₹)": c.upi, "UPI bookings": c.upiN, "Other (₹)": c.other, "Other bookings": c.otherN, "Total (₹)": c.cash + c.upi + c.other })));
  XLSX.utils.book_append_sheet(wb, sheet(coll), "Collected by");
  const per = []; bks.filter(active).forEach(b => { const ev = evById(b.event_id) || {}; persons(b).forEach(p => { const row = { "Event": ev.name_en || ev.name_gu, "Person pass no.": tok(b, p.n), "Flat": b.flat, "Booked by": b.name, "Person": p.type + " " + p.n, "Status": bStatus(b).label };
    (ev.sessions || []).filter(s => b.sessions.includes(s.id)).forEach(s => { const g = given(b, s.id, p.n); row[(s.label || s.meal) + " (" + fd(s.date) + ")"] = g ? "Given " + hm(g.at) : ""; }); per.push(row); }); });
  XLSX.utils.book_append_sheet(wb, sheet(per), "Person passes");
  const sess = []; evs.forEach(ev => { const r = evStats(ev); ev.sessions.forEach(s => { const x = r.bySess[s.id]; sess.push({ "Event": ev.name_en || ev.name_gu, "Session": s.label || s.meal, "Date": fd(s.date), "Meal": s.meal, "Adults": x.a, "Children": x.c, "Total persons": x.a + x.c, "Given so far": x.served }); }); });
  XLSX.utils.book_append_sheet(wb, sheet(sess), "Session headcount");
  const blk = []; evs.forEach(ev => { const r = evStats(ev); BLOCKS.forEach(b => { const x = r.byBlock[b]; blk.push({ "Event": ev.name_en || ev.name_gu, "Block": b, "Passes": x.passes, "Persons": x.persons, "Amount (₹)": x.amount, "Pending (₹)": x.pending }); }); });
  XLSX.utils.book_append_sheet(wb, sheet(blk), "Block-wise");
  XLSX.utils.book_append_sheet(wb, sheet(rows.filter(r => /pending|verify/i.test(r.Status)).map(r => ({ "Event": r.Event, "Flat": r.Flat, "Name": r.Name, "Mobile": r.Mobile, "Pass no.": r["Pass no."], "Amount (₹)": r["Amount (₹)"], "Status": r.Status, "UTR": r["Receipt / UTR"] }))), "Pending payments");
  XLSX.writeFile(wb, `Serenity_Space_Meal_Pass_Report_${evs.length === 1 ? (evs[0].name_en || evs[0].code).replace(/[^A-Za-z0-9]+/g, "_") : "All_Events"}_${today()}.xlsx`);
}

/* ───────────── committee: settings & approvals ───────────── */
function fillSettings() {
  const d = S.settings.desk || {}, u = S.settings.upi || {};
  if (document.activeElement && $("[data-pane=settings]").contains(document.activeElement)) return;
  $("#stDesk").value = d.place || ""; $("#stContact").value = d.contact || ""; $("#stUpiOn").checked = !!u.enabled; $("#stUpiId").value = u.id || ""; $("#stUpiName").value = u.name || "";
}
$("#stSave").onclick = async () => {
  const upi = { enabled: $("#stUpiOn").checked, id: $("#stUpiId").value.trim(), name: $("#stUpiName").value.trim() };
  if (upi.enabled && !/^[\w.\-]{2,}@[A-Za-z]{2,}$/.test(upi.id)) { $("#stMsg").textContent = "Enter a valid UPI ID (name@bank) before switching UPI on."; return; }
  const { error } = await sb.from("app_settings").upsert([{ key: "desk", value: { place: $("#stDesk").value.trim(), contact: $("#stContact").value.trim() } }, { key: "upi", value: upi }]);
  $("#stMsg").textContent = error ? errMsg(error) : "Saved."; if (!error) reloadSoon();
};
function renderAccess() {
  const box = $("#accessPanel"); box.hidden = !isSuper(); if (!isSuper()) return;
  const P = id => S.profiles[id] || {}, who = p => `${esc(p.name || "—")} · ${esc(p.block || "")}-${esc(p.flat_no || "")}`;
  const reqs = S.requests.filter(r => r.status === "pending"), members = S.staffList.filter(s => s.role === "committee" && s.active);
  box.innerHTML = `<div class="spread"><h3>Committee access</h3><span class="chip gold">Super admin · you</span></div>
    <p class="small muted" style="margin:6px 0 12px">Members log in with their mobile number, fill in their details and tap “Request committee access”. Approve them here.</p>
    <div class="lab" style="margin-bottom:4px">Waiting for approval (${reqs.length})</div>
    ${reqs.length ? reqs.map(r => { const p = P(r.user_id); return `<div class="who"><div style="min-width:0"><b>${who(p)}</b><div class="small muted"><span class="mono">${esc(String(p.phone || "").slice(-10))}</span> · ${esc(p.email || "")} · ${fdt(r.requested_at)}${r.note ? " · " + esc(r.note) : ""}</div></div>
      <div class="row"><button class="btn sm primary" type="button" data-ok="${r.user_id}">Approve</button><button class="btn sm danger" type="button" data-no="${r.user_id}">Reject</button></div></div>`; }).join("") : `<p class="small muted" style="margin:0 0 8px">No pending requests.</p>`}
    <div class="lab" style="margin:14px 0 4px">Approved committee (${members.length})</div>
    ${members.length ? members.map(s => { const p = P(s.user_id); return `<div class="who"><div style="min-width:0"><b>${who(p)}</b><div class="small muted"><span class="mono">${esc(String(p.phone || "").slice(-10))}</span> · approved ${fd(s.approved_at)}</div></div><button class="btn sm danger" type="button" data-rv="${s.user_id}">Revoke</button></div>`; }).join("") : `<p class="small muted" style="margin:0">No committee members approved yet.</p>`}`;
  const go = async (fn, args, msg) => { const { error } = await sb.rpc(fn, args); if (error) toast(errMsg(error)); else { toast(msg); reloadSoon(); } };
  $$("[data-ok]", box).forEach(b => b.onclick = () => go("decide_committee", { p_user: b.dataset.ok, p_approve: true }, "Approved"));
  $$("[data-no]", box).forEach(b => arm(b, () => go("decide_committee", { p_user: b.dataset.no, p_approve: false }, "Request rejected"), "Confirm reject"));
  $$("[data-rv]", box).forEach(b => arm(b, () => go("revoke_committee", { p_user: b.dataset.rv }, "Access revoked"), "Confirm revoke"));
}

/* ───────────── routing ───────────── */
function render() {
  if (!S.user) { showLogin(); return; }
  $("#login").hidden = true; $("#logout").hidden = false;
  const staff = isStaff();
  $("#modeSwitch").hidden = !staff; $("#roleBadge").hidden = !staff; $("#roleBadge").textContent = isSuper() ? "Super admin" : "Committee";
  if (!staff) mode = "resident"; else if (!userPicked) mode = "admin";
  $("#mAdmin").setAttribute("aria-pressed", String(mode === "admin")); $("#mRes").setAttribute("aria-pressed", String(mode === "resident"));
  $("#resident").hidden = mode !== "resident"; $("#admin").hidden = mode !== "admin";
  if (mode !== "resident") $("#meBtn").hidden = true;
  if (!S.ready) return;
  if (mode === "resident") { renderResident(); return; }
  $$("#tabs button").forEach(b => b.setAttribute("aria-selected", String(b.dataset.tab === tab)));
  $$("[data-pane]").forEach(p => p.hidden = p.dataset.pane !== tab);
  if (tab !== "counter" && camStream) stopCam();
  ({ overview: renderOverview, events: renderEvents, bookings: renderBookings, counter: renderCounter, reports: renderReports, settings: () => { fillSettings(); renderAccess(); } })[tab]();
}
$$("#tabs button").forEach(b => b.onclick = () => { tab = b.dataset.tab; try { localStorage.setItem("ss_tab", tab); } catch (e) {} render(); window.scrollTo(0, 0); });
$("#mAdmin").onclick = () => { userPicked = true; mode = "admin"; render(); };
$("#mRes").onclick = () => { userPicked = true; mode = "resident"; if (camStream) stopCam(); render(); };
["#ovEvent", "#rpEvent"].forEach(s => $(s).onchange = render);
["#bkEvent", "#bkStatus", "#bkBlock", "#bkType"].forEach(s => $(s).onchange = () => { Object.keys(sel).forEach(k => delete sel[k]); renderBookings(); });
$("#bkSearch").oninput = renderBookings; $("#ctQ").oninput = renderCounter; $("#ctEvent").onchange = renderCounter;
$("#bkNew").onclick = () => { const ev = evById($("#bkEvent").value) || S.events[0]; if (!ev) { toast("Create an event first."); return; } bookingForm(ev, true); };
$("#newEvent").onclick = () => eventForm();
$("#bkBlock").innerHTML = blockOpts(true);
$("#myEv").onchange = renderMine; $("#myQ").addEventListener("input", renderMine);
$("#myOpenAll").onclick = () => setAllMine(true); $("#myCloseAll").onclick = () => setAllMine(false);
try { const t = localStorage.getItem("ss_tab"); if (t) tab = t; } catch (e) {}

/* ───────────── install as an app (Android + iPhone) ───────────── */
const UA = navigator.userAgent || "";
const isIOS = /iPhone|iPad|iPod/.test(UA) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const isAndroid = /Android/.test(UA);
const inAppBrowser = /FBAN|FBAV|Instagram|WhatsApp|Line\/|; wv\)|GSA\//.test(UA);
const isStandalone = () => window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
let deferredPrompt = null;
function installSnoozed() { try { return Date.now() < +(localStorage.getItem("ss_install_snooze") || 0); } catch (e) { return false; } }
function snoozeInstall(days) { try { localStorage.setItem("ss_install_snooze", String(Date.now() + days * 864e5)); } catch (e) {} }
function showInstallBar() {
  const bar = $("#installBar");
  if (isStandalone() || installSnoozed() || !(isIOS || isAndroid || deferredPrompt)) { bar.hidden = true; return; }
  $("#ibInstall").textContent = deferredPrompt ? "Install" : "How to install";
  bar.hidden = false;
}
function installHelp() {
  const share = `<span class="glyph" aria-hidden="true"><svg class="ic sm" viewBox="0 0 24 24"><path d="M12 15V3M8 7l4-4 4 4"/><path d="M6 11H5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-1"/></svg></span>`;
  const plus = `<span class="glyph" aria-hidden="true"><svg class="ic sm" viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="3"/><path d="M12 8v8M8 12h8"/></svg></span>`;
  const dots = `<span class="glyph" aria-hidden="true"><b>⋮</b></span>`;
  let steps;
  if (isIOS && inAppBrowser) steps = [`Tap the <b>⋯</b> or <b>Share</b> button and choose <b>Open in Safari</b>.`, `In Safari, tap ${share} <b>Share</b>.`, `Choose ${plus} <b>Add to Home Screen</b>, then <b>Add</b>.`];
  else if (isIOS) steps = [`Tap ${share} <b>Share</b> at the bottom of Safari (top on iPad).`, `Scroll down and choose ${plus} <b>Add to Home Screen</b>.`, `Tap <b>Add</b>. The Meal Pass icon appears on your home screen.`];
  else if (inAppBrowser) steps = [`Tap ${dots} and choose <b>Open in Chrome</b>.`, `In Chrome, tap ${dots} → <b>Install app</b> (or <b>Add to Home screen</b>).`, `Tap <b>Install</b>.`];
  else steps = [`Tap ${dots} in the top-right corner of Chrome.`, `Choose <b>Install app</b> (or <b>Add to Home screen</b>).`, `Tap <b>Install</b>. The Meal Pass icon appears with your apps.`];
  const o = openSheet(`<header><div><div class="muted small">${isIOS ? "iPhone / iPad" : "Android"}</div><h2 class="gu">એપ ઇન્સ્ટોલ કરો · Install the app</h2></div><button class="x" type="button" aria-label="Close">×</button></header>
    <p class="small muted" style="margin:0">Free, no app store needed. It opens full-screen, keeps you logged in, and your passes are one tap away.</p>
    <ol class="ios-steps">${steps.map(s => `<li><span>${s}</span></li>`).join("")}</ol>
    <div class="row" style="justify-content:flex-end"><button class="btn primary x2" type="button">Got it</button></div>`);
  $(".x2", o).onclick = closeSheet;
}
window.addEventListener("beforeinstallprompt", e => { e.preventDefault(); deferredPrompt = e; showInstallBar(); });
window.addEventListener("appinstalled", () => { deferredPrompt = null; $("#installBar").hidden = true; toast("Meal Pass installed"); });
$("#ibInstall").onclick = async () => {
  if (deferredPrompt) {
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice.catch(() => ({ outcome: "dismissed" }));
    deferredPrompt = null; if (outcome !== "accepted") snoozeInstall(3);
    showInstallBar(); return;
  }
  installHelp();
};
$("#ibClose").onclick = () => { snoozeInstall(7); $("#installBar").hidden = true; };
if ("serviceWorker" in navigator) window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
showInstallBar();

/* ───────────── boot ───────────── */
/* a pass QR (single or group) opened via its link → committee lands on the counter with the result */
function routeHash() {
  const h = decodeURIComponent((location.hash || "").slice(1)).toUpperCase();
  if (!h || !S.ready || !isStaff()) return false;
  if (!(/^[A-Z0-9]{2,8}-[A-I]\d{3,4}-[A-Z0-9]{5}(-\d{1,2})?$/.test(h) || /^G:[A-Z0-9:.,\-]+$/.test(h))) return false;
  userPicked = true; mode = "admin"; tab = "counter"; closeSheet(); render(); handleScan(h, $("#ctAuto").checked);
  return true;
}
window.addEventListener("hashchange", routeHash);
async function onSession(session) {
  S.user = session ? session.user : null; S.ready = false;
  if (!S.user) { render(); return; }
  render();
  $("#sysNote").innerHTML = `<div class="center"><span class="spinner"></span></div>`;
  try { await loadProfile(); await loadData(); $("#sysNote").innerHTML = ""; subscribeLive(); }
  catch (e) { console.error(e); $("#sysNote").innerHTML = `<div class="notice warn">Could not load data: ${esc(errMsg(e))}. Check your connection and reload.</div>`; }
  render();
  if (routeHash()) {}
  else if (!profileComplete() && mode === "resident") { S.editProfile = true; renderAccount(); }
}
if (!sb) {
  $("#sysNote").innerHTML = `<div class="notice warn">This site is not configured yet. Copy <span class="mono">config.example.js</span> to <span class="mono">config.js</span> and fill in your Supabase project URL and anon key.</div>`;
} else {
  let first = true;
  sb.auth.onAuthStateChange((event, session) => {
    if (event === "INITIAL_SESSION" || event === "SIGNED_IN" || event === "SIGNED_OUT") {
      if (event === "SIGNED_IN" && !first && S.user && session && session.user.id === S.user.id) return;
      first = false; onSession(session);
    }
  });
}
})();
