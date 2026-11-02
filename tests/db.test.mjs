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

// --- revoke ---
await as(biren, "select revoke_committee($1)", [akash]);
r = await as(akash, "select count(*)::int n from bookings"); assert.equal(r.rows[0].n, 0); ok("revoked member loses access to others' bookings");

console.log("\nAll database checks passed.");
