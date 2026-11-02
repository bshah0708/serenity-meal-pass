// Runs the real migration in an embedded Postgres (PGlite) with a minimal stand-in for Supabase Auth,
// then checks the privacy rules and booking logic as different users.
// Run: cd tests && npm install && npm test
import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";
import { strict as assert } from "node:assert";

const db = new PGlite();
const ok = (m) => console.log("  ✓ " + m);

// --- Supabase-like scaffolding: roles, auth schema, auth.uid() ---
await db.exec(`
  create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  create schema auth;
  create table auth.users (id uuid primary key default gen_random_uuid(), phone text unique);
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema auth to authenticated, anon; grant usage on schema public to authenticated, anon;
  grant execute on function auth.uid() to authenticated, anon;
`);
for (const f of readdirSync(new URL("../supabase/migrations/", import.meta.url)).sort()) {
  await db.exec(readFileSync(new URL("../supabase/migrations/" + f, import.meta.url), "utf8"));
}
ok("migration applied");

const signup = async (phone) => (await db.query("insert into auth.users(phone) values ($1) returning id", [phone])).rows[0].id;
async function as(uid, sql, params = []) {
  await db.exec("reset role");
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [uid || ""]);
  await db.exec(uid ? "set role authenticated" : "set role anon");
  try { return await db.query(sql, params); } finally { await db.exec("reset role"); }
}
async function fails(uid, sql, params, re) {
  try { await as(uid, sql, params); } catch (e) { if (re) assert.match(e.message, re); return e.message; }
  assert.fail("expected failure: " + sql);
}

// --- people ---
const biren = await signup("919724212198");
const asha  = await signup("919800000001");
const ravi  = await signup("919800000002");
const akash = await signup("919800000003");
let r = await as(biren, "select role from staff where user_id = auth.uid()");
assert.equal(r.rows[0].role, "super_admin"); ok("configured mobile number becomes super admin on first login");
r = await as(asha, "select public.is_staff() s"); assert.equal(r.rows[0].s, false); ok("ordinary resident is not staff");

await as(asha, "update profiles set name='Asha Patel', block='E', flat_no='903', email='asha@example.com' where id=auth.uid()");
await as(ravi, "update profiles set name='Ravi Shah', block='C', flat_no='101' where id=auth.uid()");
await fails(ravi, "update profiles set block='B', flat_no='1204' where id=auth.uid()", [], /does not exist/); ok("non-existent flat (B-1204) rejected");
await as(asha, "update profiles set phone='910000000000' where id=auth.uid()");
r = await as(asha, "select phone from profiles where id=auth.uid()"); assert.equal(r.rows[0].phone, "919800000001"); ok("resident cannot change verified phone");
r = await as(asha, "select count(*)::int n from profiles"); assert.equal(r.rows[0].n, 1); ok("resident sees only own profile");
r = await as(biren, "select count(*)::int n from profiles"); assert.equal(r.rows[0].n, 4); ok("super admin sees all profiles");

// --- committee approval ---
await as(akash, "select request_committee_access('C-101 committee member')");
await fails(akash, "select decide_committee(auth.uid(), true)", [], /super admin/); ok("member cannot approve themselves");
await as(biren, "select decide_committee($1, true)", [akash]);
r = await as(akash, "select public.is_staff() s"); assert.equal(r.rows[0].s, true); ok("super admin approves committee member");
await fails(akash, "select decide_committee($1, true)", [asha], /super admin/); ok("committee member cannot approve others");

// --- events ---
await fails(asha, "insert into events(code,name_en,open_date,close_date) values ('X1','x',current_date,current_date)", [], /row-level security/); ok("resident cannot create events");
const today = new Date().toISOString().slice(0, 10);
r = await as(akash, `insert into events(code,name_gu,name_en,kind,capacity,open_date,close_date,published,price_mode,cost,adult_rate,child_rate)
  values ('NAV26','નવરાત્રી','Navratri Snacks','multi',6,current_date - 1,current_date + 5,true,'discount',60,40,20) returning id`);
const ev = r.rows[0].id;
const s1 = (await as(akash, "insert into event_sessions(event_id,label,date,meal,sort) values ($1,'Day 1',current_date,'Snacks',1) returning id", [ev])).rows[0].id;
const s2 = (await as(akash, "insert into event_sessions(event_id,label,date,meal,sort) values ($1,'Day 2',current_date+1,'Snacks',2) returning id", [ev])).rows[0].id;
const draft = (await as(akash, "insert into events(code,name_en,open_date,close_date) values ('DR','Draft',current_date,current_date) returning id")).rows[0].id;
r = await as(asha, "select count(*)::int n from events"); assert.equal(r.rows[0].n, 1); ok("residents see only published events");

// --- bookings ---
r = await as(asha, "select * from create_booking($1,$2,2,1,'mobile','Asha Patel','9800000001','asha@example.com','A','101')", [ev, [s1, s2]]);
const bA = r.rows[0];
assert.equal(bA.block + "-" + bA.flat_no, "E-903"); ok("resident booking uses the flat on their profile, not the one they send");
assert.equal(Number(bA.amount), 2 * (2 * 40 + 1 * 20)); ok("amount priced on the server (₹" + bA.amount + ")");
assert.equal(bA.status, "pending");
await fails(ravi, "insert into bookings(event_id,pass_no,block,flat_no,name,mobile,adults,children,amount) values ($1,'X','C','101','x','9800000002',1,0,0)", [ev], /row-level security/);
ok("direct insert blocked (no ₹0 self-made bookings)");
const bR = (await as(ravi, "select * from create_booking($1,$2,1,0,'physical','Ravi Shah','9800000002',null)", [ev, [s1]])).rows[0];
r = await as(ravi, "select count(*)::int n from bookings"); assert.equal(r.rows[0].n, 1); ok("resident sees only own bookings");
r = await as(ravi, "select count(*)::int n from bookings where id=$1", [bA.id]); assert.equal(r.rows[0].n, 0); ok("resident cannot read another resident's booking by id");
r = await as(ravi, "update bookings set status='paid' where id=$1 returning id", [bR.id]); assert.equal(r.rows.length, 0); ok("resident cannot mark own booking paid");
await fails(ravi, "select mark_paid($1,'cash',40)", [bR.id], /Committee only/); ok("resident cannot call mark_paid");
r = await as(akash, "select count(*)::int n from bookings"); assert.equal(r.rows[0].n, 2); ok("committee sees all bookings");
await fails(ravi, "select * from create_booking($1,$2,3,0,'mobile','Ravi Shah','9800000002',null)", [ev, [s1]], /only 2 places/); ok("capacity enforced for residents");
await fails(asha, "select * from create_booking($1,$2,1,0,'mobile','Asha','9800000001',null)", [draft, []], /not open/); ok("unpublished event cannot be booked");
r = await as(asha, "select event_availability($1) a", [ev]); assert.deepEqual(r.rows[0].a, { capacity: 6, booked: 4 }); ok("residents see places left (counts only)");

// desk booking by committee links to the resident's account when flat + mobile match
const bDesk = (await as(akash, "select * from create_booking($1,$2,1,0,'physical','Ravi Shah','9800000002',null,'C','101')", [ev, [s2]])).rows[0];
assert.equal(bDesk.user_id, ravi); assert.equal(bDesk.by_committee, true); ok("desk booking appears in the resident's own account");

// --- payment + UPI ---
await as(asha, "select submit_upi_ref($1,'412345678901')", [bA.id]);
await fails(ravi, "select submit_upi_ref($1,'999999999999')", [bA.id], /not found/); ok("resident cannot touch someone else's booking");
await as(akash, "select mark_paid($1,'upi',$2,'412345678901')", [bA.id, bA.amount]);
r = await as(asha, "select status, pay_mode from bookings where id=$1", [bA.id]); assert.equal(r.rows[0].status, "paid"); ok("committee marks paid; resident sees the update");
await fails(asha, "select cancel_booking($1)", [bA.id], /cannot be cancelled/); ok("resident cannot cancel after payment");
await as(ravi, "select cancel_booking($1)", [bR.id]); ok("resident can cancel own unpaid booking");

// --- counter scan ---
await fails(asha, "select scan_pass('x')", [], /Committee only/); ok("only committee can scan");
r = await as(akash, "select scan_pass($1) j", [bA.pass_no + "-2"]); assert.equal(r.rows[0].j.result, "given"); ok("scan of person 2 marks today's session given");
r = await as(akash, "select scan_pass($1) j", ["https://site/pass.html#" + bA.pass_no + "-2"]); assert.equal(r.rows[0].j.result, "already_given"); ok("second scan of the same QR is refused (from a URL QR too)");
r = await as(akash, "select scan_pass($1) j", [bA.pass_no + "-3"]); assert.equal(r.rows[0].j.result, "given"); ok("child 3 has a separate QR");
r = await as(akash, "select scan_pass($1) j", [bA.pass_no + "-4"]); assert.equal(r.rows[0].j.result, "not_found"); ok("person number beyond the booking is rejected");
r = await as(akash, "select scan_pass($1) j", [bR.pass_no + "-1"]); assert.equal(r.rows[0].j.result, "cancelled"); ok("cancelled pass flagged");
r = await as(akash, "select scan_pass($1) j", [bDesk.pass_no + "-1"]); assert.equal(r.rows[0].j.result, "unpaid"); ok("unpaid pass flagged");
r = await as(ravi, "select count(*)::int n from checkins"); assert.equal(r.rows[0].n, 0); ok("residents cannot read other people's counter records");

// --- collect together: one QR for several passes ---
const bG = (await as(asha, "select * from create_booking($1,$2,1,1,'mobile','Asha Patel','9800000001','asha@example.com')", [ev, [s1, s2]])).rows[0];
await as(akash, "select mark_paid($1,'cash',$2)", [bG.id, bG.amount]);
const gTok = `https://site/#G:${bA.pass_no}:1.2.3,${bG.pass_no}:1.2,${bDesk.pass_no}:1`;
await fails(asha, "select scan_group($1)", [gTok], /Committee only/); ok("residents cannot scan a group QR");
r = await as(akash, "select scan_group($1, false) j", [gTok]); let j = r.rows[0].j;
const res = it => j.items.find(x => x.pass_no === it[0] && x.person === it[1]).result;
assert.equal(j.ready, 3); assert.equal(res([bA.pass_no, 2]), "already_given"); assert.equal(res([bDesk.pass_no, 1]), "unpaid");
ok("preview: 3 ready, person 2 & 3 of the first booking already given, unpaid desk pass refused");
r = await as(akash, "select scan_group($1) j", [gTok]); j = r.rows[0].j;
assert.equal(j.given_now, 3); assert.equal(j.give, 3); ok("one scan marks all 3 remaining passes as given");
r = await as(akash, "select scan_group($1) j", [gTok]); j = r.rows[0].j;
assert.equal(j.give, 0); assert.ok(j.items.every(x => ["already_given", "unpaid"].includes(x.result))); ok("scanning the same group QR again gives nothing");
r = await as(akash, "select scan_group($1) j", [`G:${bA.pass_no}:1.1.1`]); assert.equal(r.rows[0].j.total, 1); ok("duplicate entries in a QR are counted once");
const ev2 = (await as(akash, "insert into events(code,name_en,open_date,close_date,published,adult_rate) values ('OTH','Other',current_date-1,current_date+1,true,10) returning id")).rows[0].id;
const s9 = (await as(akash, "insert into event_sessions(event_id,date) values ($1,current_date) returning id", [ev2])).rows[0].id;
const bO = (await as(asha, "select * from create_booking($1,$2,1,0,'mobile','Asha','9800000001',null)", [ev2, [s9]])).rows[0];
r = await as(akash, "select scan_group($1, false) j", [`G:${bG.pass_no}:1,${bO.pass_no}:1`]); j = r.rows[0].j;
assert.equal(j.items[1].result, "other_event"); ok("passes from a different event are not mixed into the group");
r = await as(asha, "select count(*)::int n from checkins"); assert.ok(r.rows[0].n >= 4); ok("resident can see hand-over records of own passes");
r = await as(ravi, "select count(*)::int n from checkins"); assert.equal(r.rows[0].n, 0); ok("…but not anyone else's");

// --- public pass link ---
r = await as(null, "select public_pass($1) p", [bA.pass_no + "-1"]); assert.equal(r.rows[0].p.flat, "E-903"); ok("WhatsApp pass link works without login");
await fails(null, "select count(*) from bookings", [], /permission denied/); ok("anonymous visitors cannot list bookings");

// --- settings ---
r = await as(asha, "select count(*)::int n from app_settings where key='super_admin_phone'"); assert.equal(r.rows[0].n, 0); ok("super admin number hidden from residents");
r = await as(asha, "update app_settings set value='{\"enabled\":true}' where key='upi' returning key"); assert.equal(r.rows.length, 0); ok("residents cannot change settings");

// --- who handled the money ---
await db.exec("reset role"); await db.query("update events set capacity = 100 where id=$1", [ev]);
const nb = async () => (await as(asha, "select * from create_booking($1,$2,1,0,'mobile','Asha Patel','9800000001','asha@example.com')", [ev, [s2]])).rows[0];
const p1 = await nb(), p2 = await nb(), p3 = await nb(), p4 = await nb();
await fails(asha, "select record_payment($1,'cash',250)", [p1.id], /Committee only/); ok("residents cannot record payments");
await db.exec("reset role"); await db.query("update profiles set name='Biren Shah' where id=$1", [biren]); await db.query("update profiles set name='Akash' where id=$1", [akash]);
r = await as(akash, "select record_payment($1,'cash',$2,'R-101',$3) j", [p1.id, p1.amount, biren]);
assert.equal(r.rows[0].j.collected_by, "Biren Shah"); assert.equal(r.rows[0].j.marked_by, "Akash"); ok("cash: collected by Biren, marked paid by Akash");
r = await as(akash, "select record_payment($1,'cash',$2,null,null,'Ramesh (volunteer)') j", [p2.id, p2.amount]);
assert.equal(r.rows[0].j.collected_by, "Ramesh (volunteer)"); ok("cash collected by a volunteer without login (typed name)");
await fails(akash, "select record_payment($1,'cash',$2,null,$3)", [p3.id, p3.amount, ravi], /committee member/); ok("cash collector must be a committee member");
r = await as(akash, "select record_payment($1,'upi',$2,'412345678999') j", [p3.id, p3.amount]);
assert.equal(r.rows[0].j.collected_by, null); assert.equal(r.rows[0].j.marked_by, "Akash"); ok("UPI: records who verified and marked it paid");
await fails(akash, "select record_payment($1,'other',$2)", [p4.id, p4.amount], /how it was paid/); ok("'Other' needs a note");
await as(akash, "select record_payment($1,'other',$2,null,null,null,'Cheque 004512 HDFC')", [p4.id, p4.amount]);
r = await as(asha, "select pay_mode, pay_note, collected_by_name, paid_by_name from bookings where id=$1", [p1.id]);
assert.equal(r.rows[0].collected_by_name, "Biren Shah"); ok("resident sees who received the cash on their own booking");
await fails(akash, "select undo_paid($1)", [p1.id], /permission denied/); ok("undo payment without a reason is not allowed");
await fails(akash, "select undo_paid($1,'')", [p1.id], /reason/); ok("blank reason refused");
await as(akash, "select undo_paid($1,'Entered against wrong flat')", [p1.id]);
r = await as(akash, "select action, actor_name, reason, details->>'cash_received_by' c from audit_log where booking_id=$1", [p1.id]);
assert.equal(r.rows[0].action, "undo_paid"); assert.equal(r.rows[0].actor_name, "Akash"); assert.equal(r.rows[0].c, "Biren Shah");
ok("undo payment logged: who, reason and the payment that was removed");
r = await as(akash, "select status, collected_by_name, paid_by_name from bookings where id=$1", [p1.id]);
assert.equal(r.rows[0].status, "pending"); assert.equal(r.rows[0].collected_by_name, null); ok("undo paid clears who collected / marked");

// --- cancellation rules ---
r = await as(akash, `insert into events(code,name_en,kind,capacity,open_date,close_date,published,price_mode,adult_rate,child_rate,cancel_paid,cancel_until,unpaid_cancel_days)
  values ('CX26','Cancel test','single',0,current_date - 3,current_date + 1,true,'paid',100,50,'until',current_date + 1,3) returning id`);
const evC = r.rows[0].id;
const sC = (await as(akash, "insert into event_sessions(event_id,label,date,meal,sort) values ($1,'Day',current_date+2,'Dinner',1) returning id", [evC])).rows[0].id;
const nc = async () => (await as(asha, "select * from create_booking($1,$2,1,0,'mobile','Asha Patel','9800000001','asha@example.com')", [evC, [sC]])).rows[0];
const q1 = await nc(), q2 = await nc(), q3 = await nc(), q4 = await nc(), q5 = await nc(), q6 = await nc();
await as(asha, "select cancel_booking($1)", [q1.id]);
r = await as(asha, "select status, cancel_reason, refund_status from bookings where id=$1", [q1.id]);
assert.deepEqual(r.rows[0], { status: "cancelled", cancel_reason: "resident", refund_status: null }); ok("unpaid booking: resident can always cancel, no refund");
await as(akash, "select record_payment($1,'cash',100)", [q2.id]);
await as(asha, "select cancel_booking($1)", [q2.id]);
r = await as(asha, "select refund_status, refund_amount::int a from bookings where id=$1", [q2.id]);
assert.equal(r.rows[0].refund_status, "due"); assert.equal(r.rows[0].a, 100); ok("paid booking cancelled before the last date → refund due ₹100");
await as(akash, "select record_payment($1,'cash',100)", [q3.id]);
await db.exec("reset role"); await db.query("update events set cancel_until = current_date - 1 where id=$1", [evC]);
await fails(asha, "select cancel_booking($1)", [q3.id], /Cancellation closed/); ok("after the last cancellation date a paid booking cannot be cancelled");
await db.query("update events set cancel_paid = 'no' where id=$1", [evC]);
await fails(asha, "select cancel_booking($1)", [q3.id], /cannot be cancelled/); ok("event set to 'no cancellation' blocks paid cancellations");
await fails(akash, "select cancel_booking($1)", [q3.id], /reason for cancelling/); ok("committee must give a reason to cancel a resident's booking");
await as(akash, "select cancel_booking($1,'Resident moved out')", [q3.id]);
r = await as(akash, "select cancel_reason, refund_status, cancelled_by_name from bookings where id=$1", [q3.id]);
assert.equal(r.rows[0].cancel_reason, "committee"); assert.equal(r.rows[0].refund_status, "due"); assert.equal(r.rows[0].cancelled_by_name, "Akash"); ok("committee can still cancel; records who did it");
await fails(asha, "select record_refund($1,true)", [q3.id], /Committee only/); ok("only committee records refunds");
await as(akash, "select record_refund($1,true,'Cash returned')", [q3.id]);
r = await as(asha, "select refund_status, refunded_by_name from bookings where id=$1", [q3.id]);
assert.equal(r.rows[0].refund_status, "refunded"); assert.equal(r.rows[0].refunded_by_name, "Akash"); ok("refund recorded with who returned the money");
await fails(akash, "select restore_booking($1,'Wrongly cancelled')", [q3.id], /already refunded/); ok("a refunded booking cannot be restored");
await as(asha, "select submit_upi_ref($1,'412300000000')", [q5.id]);
await db.exec("reset role"); await db.query("update bookings set created_at = now() - interval '5 days' where id = any($1)", [[q4.id, q5.id]]);
r = await as(asha, "select auto_cancel_unpaid() n"); assert.equal(r.rows[0].n, 1);
r = await as(akash, "select id, status, cancel_reason from bookings where id = any($1)", [[q4.id, q5.id, q6.id]]);
const st = Object.fromEntries(r.rows.map(x => [x.id, x.status + "/" + (x.cancel_reason || "")]));
assert.equal(st[q4.id], "cancelled/auto_unpaid"); assert.equal(st[q5.id], "pending/"); assert.equal(st[q6.id], "pending/");
ok("auto-cancel: unpaid booking past the deadline cancelled; UPI waiting for check and late bookings kept");
r = await as(asha, "select auto_cancel_unpaid() n"); assert.equal(r.rows[0].n, 0); ok("auto-cancel is safe to run again");

// --- audit trail: mark not given, restore ---
await fails(akash, "select set_given($1,$2,'{2}',false)", [bA.id, s1], /permission denied/); ok("'not given' without reason is not allowed");
await fails(akash, "select set_given($1,$2,'{2}',false,'no')", [bA.id, s1], /reason/); ok("too-short reason refused");
await as(akash, "select set_given($1,$2,'{2}',false,'Scanned the wrong pass by mistake')", [bA.id, s1]);
r = await as(akash, "select count(*)::int n from checkins where booking_id=$1 and person_no=2", [bA.id]); assert.equal(r.rows[0].n, 0);
r = await as(akash, "select details from audit_log where action='not_given' and booking_id=$1", [bA.id]);
assert.equal(r.rows[0].details.removed[0].person, 2); assert.ok(r.rows[0].details.removed[0].given_at); ok("mark not given: removed and logged with the original hand-over time");
await fails(akash, "select set_given($1,$2,'{2}',false,'Again by mistake')", [bA.id, s1], /Nothing to undo/); ok("cannot 'un-give' something not given");
await as(akash, "select set_given($1,$2,'{2}',true,null)", [bA.id, s1]); ok("marking given needs no reason");
const qR = await nc(); await as(akash, "select cancel_booking($1,'Duplicate booking')", [qR.id]);
await as(akash, "select restore_booking($1,'Not a duplicate after all')", [qR.id]);
r = await as(akash, "select action, reason from audit_log where booking_id=$1 order by id", [qR.id]);
assert.deepEqual(r.rows.map(x => x.action), ["cancel", "restore"]); ok("committee cancel and restore both logged with reasons");
r = await as(asha, "select count(*)::int n from audit_log"); assert.equal(r.rows[0].n, 0); ok("residents cannot read the audit trail");
await fails(akash, "insert into audit_log(action, reason) values ('x','fake entry')", [], /permission denied|row-level/); ok("audit trail cannot be written directly");
await fails(akash, "delete from audit_log", [], /permission denied|row-level/).catch(async () => { r = await db.query("select count(*)::int n from audit_log"); assert.ok(r.rows[0].n > 0); });
r = await db.query("select count(*)::int n from audit_log"); assert.ok(r.rows[0].n >= 5); ok("audit trail cannot be deleted");

// --- revoke ---
await fails(biren, "select revoke_committee($1,'')", [akash], /reason/);
await as(biren, "select revoke_committee($1,'Stepped down from committee')", [akash]);
r = await db.query("select count(*)::int n from audit_log where action='revoke_committee'"); assert.equal(r.rows[0].n, 1); ok("removing a committee member is logged with reason");
r = await as(akash, "select count(*)::int n from bookings"); assert.equal(r.rows[0].n, 0); ok("revoked member loses access to others' bookings");

console.log("\nAll database checks passed.");
