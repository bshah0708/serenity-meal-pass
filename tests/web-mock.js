// In-memory stand-in for supabase-js used by the browser smoke test (tests/web.test.py).
// It mimics just enough of the client API for the app's screens; database rules are tested separately in db.test.mjs.
(function () {
  const uuid = () => "xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx".replace(/x/g, () => (Math.random() * 16 | 0).toString(16));
  const today = new Date(); const d = n => { const x = new Date(today); x.setDate(x.getDate() + n); return x.toISOString().slice(0, 10); };
  const ROLE = window.__MOCK_ROLE || "resident";            // "resident" | "super"
  const me = { id: ROLE === "super" ? "u-super" : "u-res", phone: ROLE === "super" ? "919724212198" : "919800000001" };
  const ev1 = uuid(), s1 = uuid(), s2 = uuid(), ev2 = uuid(), s3 = uuid();
  const T = {
    profiles: [
      { id: "u-super", phone: "919724212198", name: "Biren Shah", block: "E", flat_no: "903", email: "b@example.com" },
      { id: "u-res", phone: "919800000001", name: ROLE === "resident" ? null : "Asha Patel", block: ROLE === "resident" ? null : "E", flat_no: ROLE === "resident" ? null : "904", email: null },
      { id: "u-akash", phone: "919800000003", name: "Akash Joshi", block: "C", flat_no: "101", email: "a@example.com" },
    ],
    staff: [{ user_id: "u-super", role: "super_admin", active: true, approved_at: new Date().toISOString() }],
    staff_requests: [{ user_id: "u-akash", note: "C block rep", status: "pending", requested_at: new Date().toISOString() }],
    app_settings: [{ key: "desk", value: { place: "Society office, 7–9 pm", contact: "97242 12198" } }, { key: "upi", value: { enabled: true, id: "serenity@icici", name: "Serenity Space CHS" } }],
    events: [
      { id: ev1, cancel_paid: "until", cancel_until: d(0), unpaid_cancel_days: 1, code: "DIN26", name_gu: "સોસાયટી રાત્રિ ભોજન", name_en: "Diwali Community Dinner", venue: "Podium", notes: "Gujarati thali", kind: "multi", capacity: 300, open_date: d(-5), close_date: d(1), published: true, price_mode: "paid", cost: 0, adult_rate: 250, child_rate: 150, child_note: "below 10 yrs", pkg_adult: 450, pkg_child: 0, late_from: null, late_extra: 0, created_at: d(-6) },
      { id: ev2, code: "RD27", name_gu: "પ્રજાસત્તાક દિવસ નાસ્તો", name_en: "Republic Day Snacks", venue: "Clubhouse lawn", notes: null, kind: "single", capacity: 0, open_date: d(-1), close_date: d(40), published: true, price_mode: "discount", cost: 80, adult_rate: 50, child_rate: 30, child_note: "below 10 yrs", pkg_adult: 0, pkg_child: 0, late_from: d(20), late_extra: 10, created_at: d(-2) },
    ],
    event_sessions: [
      { id: s1, event_id: ev1, label: "Day 1", date: d(0), meal: "Dinner", sort: 0 },
      { id: s2, event_id: ev1, label: "Day 2", date: d(1), meal: "Dinner", sort: 1 },
      { id: s3, event_id: ev2, label: "Republic Day", date: d(40), meal: "Snacks", sort: 0 },
    ],
    bookings: [], booking_sessions: [], checkins: [], audit_log: [],
  };
  const bk = (user, flat, name, mob, sess, a, c, status, extra) => {
    const id = uuid(), [blk, no] = flat.split("-");
    T.bookings.push(Object.assign({ id, event_id: ev1, user_id: user, pass_no: "DIN26-" + blk + no + "-" + Math.random().toString(36).slice(2, 7).toUpperCase(), block: blk, flat_no: no, name, mobile: mob, email: "x@example.com", pass_type: "mobile",
      adults: a, children: c, amount: sess.length * (a * 250 + c * 150), late_fee: 0, cost: 0, status, pay_mode: status === "paid" ? "cash" : null, paid_amount: status === "paid" ? sess.length * (a * 250 + c * 150) : null, paid_at: status === "paid" ? new Date().toISOString() : null,
      upi_ref: null, printed_at: null, wa_sent_at: null, email_sent_at: null, by_committee: false, created_at: new Date().toISOString() }, extra || {}));
    sess.forEach(s => T.booking_sessions.push({ booking_id: id, session_id: s }));
    return T.bookings[T.bookings.length - 1];
  };
  window.__seed = { a: bk("u-akash", "C-101", "Akash Joshi", "9800000003", [s1], 3, 0, "pending", { upi_ref: "412345678901", pass_type: "physical", pass_no: "DIN26-C101-QW3ER" }),
                    b: bk("u-super", "E-903", "Biren Shah", "9724212198", [s1, s2], 2, 1, "paid", { pass_no: "DIN26-E903-K7P2M" }) };
  window.__T = T;

  const staff = () => T.staff.some(s => s.user_id === me.id && s.active);
  const visible = (table, rows) => {
    if (staff()) return rows;
    if (table === "bookings") return rows.filter(r => r.user_id === me.id);
    if (table === "profiles") return rows.filter(r => r.id === me.id);
    if (table === "events") return rows.filter(r => r.published);
    if (table === "checkins") return rows.filter(r => (T.bookings.find(b => b.id === r.booking_id) || {}).user_id === me.id);
    if (table === "staff_requests") return rows.filter(r => r.user_id === me.id);
    if (table === "staff") return rows.filter(r => r.user_id === me.id);
    return rows;
  };
  const embed = (table, row, sel) => {
    const r = Object.assign({}, row);
    if (/event_sessions\(/.test(sel) && table === "events") r.event_sessions = T.event_sessions.filter(s => s.event_id === row.id);
    if (/booking_sessions\(/.test(sel) && table === "bookings") r.booking_sessions = T.booking_sessions.filter(s => s.booking_id === row.id).map(s => ({ session_id: s.session_id }));
    return r;
  };
  function from(table) {
    const q = { table, filters: [], sel: "*", op: "select", one: 0, payload: null, ret: false };
    const api = {
      select(s) { if (q.op === "select") q.sel = s || "*"; else q.ret = true; return api; },
      eq(k, v) { q.filters.push(r => r[k] === v); return api; }, in(k, v) { q.filters.push(r => v.includes(r[k])); return api; },
      order() { return api; }, limit() { return api; }, range(a) { q.page = a; return api; }, single() { q.one = 1; return api; }, maybeSingle() { q.one = 2; return api; },
      insert(p) { q.op = "insert"; q.payload = p; return api; }, update(p) { q.op = "update"; q.payload = p; return api; }, delete() { q.op = "delete"; return api; },
      upsert(p) { q.op = "upsert"; q.payload = p; return api; },
      then(res, rej) { return Promise.resolve(run()).then(res, rej); },
    };
    function run() {
      const rows = T[table];
      if (q.op === "insert") { const items = [].concat(q.payload).map(p => Object.assign({ id: uuid(), created_at: new Date().toISOString() }, p)); rows.push(...items); return { data: q.one ? items[0] : items, error: null }; }
      if (q.op === "upsert") { [].concat(q.payload).forEach(p => { const i = rows.findIndex(r => r.key === p.key); if (i >= 0) rows[i] = Object.assign(rows[i], p); else rows.push(p); }); return { data: null, error: null }; }
      let hit = visible(table, rows).filter(r => q.filters.every(f => f(r)));
      if (q.op === "update") { hit.forEach(r => Object.assign(r, q.payload)); return { data: q.one ? Object.assign({}, hit[0]) : hit, error: null }; }
      if (q.op === "delete") { hit.forEach(r => rows.splice(rows.indexOf(r), 1)); return { data: null, error: null }; }
      if (q.page) hit = [];
      const out = hit.map(r => embed(table, r, q.sel));
      if (q.one === 1) return out[0] ? { data: out[0], error: null } : { data: null, error: { message: "Row not found" } };
      if (q.one === 2) return { data: out[0] || null, error: null };
      return { data: out, error: null };
    }
    return api;
  }
  const B = id => T.bookings.find(b => b.id === id);
  const rpcs = {
    create_booking(a) {
      const ev = T.events.find(e => e.id === a.p_event), p = T.profiles.find(x => x.id === me.id);
      const blk = staff() && a.p_block ? a.p_block : p.block, no = staff() && a.p_flat ? a.p_flat : p.flat_no;
      const n = a.p_sessions.length, all = ev.kind === "multi" && n === T.event_sessions.filter(s => s.event_id === ev.id).length && ev.pkg_adult > 0;
      const amount = ev.price_mode === "free" ? 0 : all ? a.p_adults * ev.pkg_adult + a.p_children * ev.child_rate * n : n * (a.p_adults * ev.adult_rate + a.p_children * ev.child_rate);
      const b = { id: uuid(), event_id: ev.id, user_id: staff() && a.p_block ? null : me.id, pass_no: ev.code + "-" + blk + no + "-" + Math.random().toString(36).slice(2, 7).toUpperCase(), block: blk, flat_no: no, name: a.p_name, mobile: a.p_mobile, email: a.p_email, pass_type: a.p_pass_type,
        adults: a.p_adults, children: a.p_children, amount, late_fee: 0, cost: 0, status: amount ? "pending" : "paid", by_committee: staff(), created_at: new Date().toISOString() };
      T.bookings.push(b); a.p_sessions.forEach(s => T.booking_sessions.push({ booking_id: b.id, session_id: s })); return b;
    },
    submit_upi_ref(a) { B(a.p_booking).upi_ref = a.p_ref; },
    cancel_booking(a) {
      if (staff() && B(a.p_booking).user_id !== me.id) rpcs.__audit("cancel", a);
      const b = B(a.p_booking), e = T.events.find(x => x.id === b.event_id), nm = (T.profiles.find(x => x.id === me.id) || {}).name;
      if (!staff() && b.status === "paid" && +b.amount > 0) {
        if (e.cancel_paid !== "until") throw new Error("Paid passes for this event cannot be cancelled");
        if (new Date().toISOString().slice(0, 10) > e.cancel_until) throw new Error("Cancellation closed");
      }
      const amt = b.status === "paid" ? +(b.paid_amount != null ? b.paid_amount : b.amount) : 0;
      Object.assign(b, { status: "cancelled", cancelled_at: new Date().toISOString(), cancelled_by_name: nm, cancel_reason: staff() && b.user_id !== me.id ? "committee" : "resident",
        refund_status: amt > 0 ? "due" : null, refund_amount: amt > 0 ? amt : null });
    },
    record_refund(a) { if (!staff()) throw new Error("Committee only"); Object.assign(B(a.p_booking), { refund_status: a.p_refunded ? "refunded" : "not_refunded", refund_ref: a.p_ref, refunded_at: new Date().toISOString(), refunded_by_name: (T.profiles.find(x => x.id === me.id) || {}).name }); },
    auto_cancel_unpaid() { return 0; },
    mark_paid(a) { Object.assign(B(a.p_booking), { status: "paid", pay_mode: a.p_mode, paid_amount: a.p_amount, paid_at: new Date().toISOString() }); },
    record_payment(a) {
      const nm = id => { const p = T.profiles.find(x => x.id === id); return p ? p.name : null; };
      if (!staff()) throw new Error("Committee only");
      if (a.p_mode === "other" && !a.p_note) throw new Error('For "Other", write how it was paid (e.g. cheque no.)');
      const c = a.p_mode === "cash" ? (a.p_collected_name || nm(a.p_collected_by || me.id)) : null;
      Object.assign(B(a.p_booking), { status: "paid", pay_mode: a.p_mode, paid_amount: a.p_mode === "waived" ? 0 : a.p_amount, pay_ref: a.p_ref, pay_note: a.p_note, paid_at: new Date().toISOString(),
        paid_by: me.id, paid_by_name: nm(me.id), collected_by: a.p_mode === "cash" && !a.p_collected_name ? (a.p_collected_by || me.id) : null, collected_by_name: c });
      return { marked_by: nm(me.id), collected_by: c };
    },
    __audit(action, a, details) { if (!a.p_reason || a.p_reason.trim().length < 3) throw new Error("Please write the reason"); const b = a.p_booking && B(a.p_booking);
      T.audit_log.unshift({ id: T.audit_log.length + 1, at: new Date().toISOString(), actor: me.id, actor_name: (T.profiles.find(x => x.id === me.id) || {}).name, action, booking_id: b ? b.id : null, event_id: b ? b.event_id : null, pass_no: b ? b.pass_no : null, reason: a.p_reason, details: details || {} }); },
    undo_paid(a) { rpcs.__audit("undo_paid", a, { mode: B(a.p_booking).pay_mode, amount: B(a.p_booking).paid_amount, cash_received_by: B(a.p_booking).collected_by_name }); Object.assign(B(a.p_booking), { status: "pending", pay_mode: null, paid_at: null, paid_by_name: null, collected_by_name: null, pay_ref: null, pay_note: null }); },
    restore_booking(a) { rpcs.__audit("restore", a); B(a.p_booking).status = "pending"; },
    mark_sent(a) { const b = B(a.p_booking); if (a.p_channel === "print") b.printed_at = new Date().toISOString(); if (a.p_channel === "whatsapp") b.wa_sent_at = new Date().toISOString(); },
    event_availability(a) { const e = T.events.find(x => x.id === a.p_event); return { capacity: e.capacity, booked: T.bookings.filter(b => b.event_id === e.id).reduce((s, b) => s + b.adults + b.children, 0) }; },
    request_committee_access(a) { T.staff_requests.push({ user_id: me.id, note: a.p_note, status: "pending", requested_at: new Date().toISOString() }); },
    decide_committee(a) { const r = T.staff_requests.find(x => x.user_id === a.p_user); r.status = a.p_approve ? "approved" : "rejected"; if (a.p_approve) T.staff.push({ user_id: a.p_user, role: "committee", active: true, approved_at: new Date().toISOString() }); },
    revoke_committee(a) { rpcs.__audit("revoke_committee", a); T.staff.find(s => s.user_id === a.p_user).active = false; },
    set_given(a) { if (!a.p_given) rpcs.__audit("not_given", a, { session: "Day 1", removed: a.p_persons.map(n => ({ person: n, given_at: new Date().toISOString() })) }); a.p_persons.forEach(n => { const i = T.checkins.findIndex(c => c.booking_id === a.p_booking && c.session_id === a.p_session && c.person_no === n); if (a.p_given && i < 0) T.checkins.push({ booking_id: a.p_booking, session_id: a.p_session, person_no: n, given_at: new Date().toISOString() }); if (!a.p_given && i >= 0) T.checkins.splice(i, 1); }); },
    public_pass(a) {
      const t = a.p_token; let b = T.bookings.find(x => x.pass_no === t), n = 0;
      if (!b) { const m = t.match(/^(.*)-(\d{1,2})$/); if (m) { b = T.bookings.find(x => x.pass_no === m[1]); n = +m[2]; } }
      if (!b) return null; const ev = T.events.find(e => e.id === b.event_id);
      return { pass_no: b.pass_no, person: n, adults: b.adults, children: b.children, flat: b.block + "-" + b.flat_no, name: b.name, status: b.status, amount: b.amount, pass_type: b.pass_type,
        event: { name_gu: ev.name_gu, name_en: ev.name_en, venue: ev.venue }, sessions: T.booking_sessions.filter(x => x.booking_id === b.id).map(x => T.event_sessions.find(s => s.id === x.session_id)) };
    },
    scan_group(a) {
      const t = a.p_token.replace(/^.*#/, "").toUpperCase().slice(2), td = new Date().toISOString().slice(0, 10), items = [], seen = new Set();
      let ev = null, ready = 0, now = 0; const flats = new Set(), names = new Set();
      t.split(",").forEach(part => { const [pno, nums] = part.split(":"); const b = T.bookings.find(x => x.pass_no === pno);
        (nums || "").split(".").map(Number).forEach(n => { if (seen.has(pno + n)) return; seen.add(pno + n); let res;
          if (!b || n < 1 || n > b.adults + b.children) res = "not_found";
          else { ev = ev || b.event_id; flats.add(b.block + "-" + b.flat_no); names.add(b.name);
            const ss = T.booking_sessions.filter(x => x.booking_id === b.id).map(x => T.event_sessions.find(s => s.id === x.session_id)).filter(s => s.date === td);
            if (b.event_id !== ev) res = "other_event"; else if (b.status === "cancelled") res = "cancelled"; else if (b.status !== "paid") res = "unpaid";
            else if (!ss.length) res = "no_session_today";
            else { const open = ss.find(s => !T.checkins.some(c => c.booking_id === b.id && c.session_id === s.id && c.person_no === n));
              if (!open) res = "already_given"; else if (a.p_auto) { T.checkins.push({ booking_id: b.id, session_id: open.id, person_no: n, given_at: new Date().toISOString() }); res = "given"; now++; } else { res = "ready"; ready++; } } }
          items.push({ pass_no: pno, person: n, type: b ? (n <= b.adults ? "Adult" : "Child") : null, flat: b && b.block + "-" + b.flat_no, name: b && b.name, result: res, session: "Day 1" }); }); });
      const e = T.events.find(x => x.id === ev) || {};
      return { result: "group", give: now + ready, given_now: now, ready, total: items.length, flats: [...flats], names: [...names], items, event: { name_gu: e.name_gu, name_en: e.name_en } };
    },
    scan_pass(a) {
      const t = a.p_token; let b = T.bookings.find(x => x.pass_no === t), n = 0;
      if (!b) { const m = t.match(/^(.*)-(\d{1,2})$/); if (m) { b = T.bookings.find(x => x.pass_no === m[1]); n = +m[2]; } }
      if (!b) return { result: "not_found", token: t };
      const sess = T.booking_sessions.filter(x => x.booking_id === b.id).map(x => T.event_sessions.find(s => s.id === x.session_id));
      const ev = T.events.find(e => e.id === b.event_id), td = new Date().toISOString().slice(0, 10);
      let result;
      if (b.status === "cancelled") result = "cancelled"; else if (b.status === "pending") result = "unpaid";
      else { const tds = sess.filter(s => s.date === td); if (!tds.length) result = "no_session_today"; else if (!n) result = "booking";
        else { const open = tds.filter(s => !T.checkins.some(c => c.booking_id === b.id && c.session_id === s.id && c.person_no === n));
          if (!open.length) result = "already_given"; else if (open.length === 1 && a.p_auto) { T.checkins.push({ booking_id: b.id, session_id: open[0].id, person_no: n, given_at: new Date().toISOString() }); result = "given"; } else result = "valid"; } }
      return { result, person: n, booking: b, event: { id: ev.id, name_gu: ev.name_gu, name_en: ev.name_en }, sessions: sess, given: T.checkins.filter(c => c.booking_id === b.id).map(c => ({ session_id: c.session_id, person_no: c.person_no, given_at: c.given_at })) };
    },
  };
  let authCb = null, session = window.__MOCK_LOGGED_IN === false ? null : { user: me };
  window.supabase = { createClient: () => ({
    from,
    rpc: async (name, args) => { try { return { data: rpcs[name](args || {}), error: null }; } catch (e) { return { data: null, error: { message: String(e) } }; } },
    auth: {
      onAuthStateChange(cb) { authCb = cb; setTimeout(() => cb("INITIAL_SESSION", session), 0); return { data: { subscription: { unsubscribe() {} } } }; },
      async signInWithOtp() { return { error: null }; },
      async verifyOtp({ token, email }) { if (token !== "123456") return { error: { message: "Token has expired or is invalid" } };
        if (email) { me.id = "u-mail"; me.phone = null; me.email = email; if (!T.profiles.some(x => x.id === "u-mail")) T.profiles.push({ id: "u-mail", phone: null, email, name: null, block: null, flat_no: null }); }
        session = { user: me }; setTimeout(() => authCb("SIGNED_IN", session), 0); return { data: session, error: null }; },
      async signOut() { session = null; authCb("SIGNED_OUT", null); return { error: null }; },
    },
    functions: { invoke: async (name, o) => { window.__invoked = (window.__invoked || []).concat([[name, o && o.body]]); return name === "email-otp" ? { data: { sent: true }, error: null } : { data: { sent: true, to: "x@example.com", passes: 1 }, error: null }; } },
    channel() { const c = { on() { return c; }, subscribe() { return c; } }; return c; },
    removeChannel() {},
  }) };
})();
