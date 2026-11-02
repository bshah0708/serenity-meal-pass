// Emails a booking's passes (one QR image per person) through Resend.
// Called from the committee screen: POST { booking_id } with the user's login token.
//
// Secrets:
//   RESEND_API_KEY     – resend.com → API keys
//   PASS_FROM_EMAIL    – e.g. "Serenity Space <passes@serenityspace.in>" (domain verified in Resend)
//   SITE_URL           – where the web app is hosted, e.g. https://<user>.github.io/serenity-meal-pass
// SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase automatically.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import QRCode from "npm:qrcode@1.5.4";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const fd = (d: string) => { const [y, m, dd] = d.split("-"); return `${dd}-${MON[+m - 1]}-${y}`; };
const inr = (n: number) => "₹" + Number(n || 0).toLocaleString("en-IN");

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return reply(405, { error: "Method not allowed" });

  const auth = req.headers.get("Authorization") ?? "";
  const asUser = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: auth } } });
  const { data: staff } = await asUser.rpc("is_staff");
  if (staff !== true) return reply(403, { error: "Committee only" });

  const { booking_id } = await req.json().catch(() => ({}));
  if (!booking_id) return reply(400, { error: "booking_id is required" });

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: b, error } = await admin.from("bookings")
    .select("*, events(name_gu,name_en,venue), booking_sessions(event_sessions(label,date,meal,sort))")
    .eq("id", booking_id).single();
  if (error || !b) return reply(404, { error: "Booking not found" });
  if (!b.email) return reply(400, { error: "This booking has no email address" });

  const site = (Deno.env.get("SITE_URL") ?? "").replace(/\/$/, "");
  const sessions = (b.booking_sessions ?? []).map((x: any) => x.event_sessions).sort((a: any, z: any) => a.date.localeCompare(z.date) || a.sort - z.sort);
  const dates = [...new Set(sessions.map((s: any) => fd(s.date)))].join(", ");
  const people: { n: number; type: string }[] = [];
  for (let i = 0; i < b.adults; i++) people.push({ n: people.length + 1, type: "Adult" });
  for (let i = 0; i < b.children; i++) people.push({ n: people.length + 1, type: "Child" });

  const attachments = await Promise.all(people.map(async (p) => {
    const url = `${site}/pass.html#${b.pass_no}-${p.n}`;
    const png = await QRCode.toDataURL(url, { errorCorrectionLevel: "Q", margin: 2, width: 600 });
    return { filename: `Pass_${b.pass_no}-${p.n}_${p.type}${p.n}.png`, content: png.split(",")[1] };
  }));
  const ev = b.events ?? {};
  const due = b.status === "pending";
  const links = people.map((p) => `<li>${p.type} ${p.n}: <a href="${site}/pass.html#${b.pass_no}-${p.n}">${esc(b.pass_no)}-${p.n}</a></li>`).join("");
  const html = `<div style="font-family:Arial,sans-serif;color:#17231a;max-width:560px">
    <p style="font-size:17px"><b>${esc(ev.name_gu ?? "")}</b><br>${esc(ev.name_en ?? "")}</p>
    <p>નમસ્તે ${esc(b.name)},<br>દરેક વ્યક્તિ માટે અલગ પાસ (QR) સાથે જોડેલ છે. કાઉન્ટર પર દરેક વ્યક્તિ પોતાનો QR બતાવે.</p>
    <p>Dear ${esc(b.name)},<br>A separate pass with its own QR code is attached for each person. Each person shows their own QR at the counter.</p>
    <table style="border-collapse:collapse;font-size:14px">
      <tr><td style="padding:3px 14px 3px 0;color:#5e6b60">Pass no.</td><td><b style="font-family:monospace">${esc(b.pass_no)}</b></td></tr>
      <tr><td style="padding:3px 14px 3px 0;color:#5e6b60">Flat</td><td>${esc(b.block)}-${esc(b.flat_no)}</td></tr>
      <tr><td style="padding:3px 14px 3px 0;color:#5e6b60">Date</td><td>${esc(dates)}</td></tr>
      <tr><td style="padding:3px 14px 3px 0;color:#5e6b60">Persons</td><td>${b.adults} adult(s)${b.children ? ", " + b.children + " child(ren)" : ""}</td></tr>
      <tr><td style="padding:3px 14px 3px 0;color:#5e6b60">Amount</td><td>${b.amount > 0 ? inr(b.amount) : "Free"} – ${due ? "payment pending" : "paid"}</td></tr>
    </table>
    ${due ? `<p style="color:#b23a26">Payment is pending. Please pay at the committee desk.</p>` : ""}
    ${b.pass_type === "physical" ? `<p>You chose printed passes. Please collect them from the committee desk.</p>` : ""}
    <p>Open your passes on the phone:</p><ul>${links}</ul>
    <p>🌿 Serenity Space Committee</p></div>`;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${Deno.env.get("RESEND_API_KEY")}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: Deno.env.get("PASS_FROM_EMAIL"), to: [b.email], subject: `Your meal passes – ${ev.name_en ?? ev.name_gu ?? ""} – ${b.block}-${b.flat_no}`, html, attachments }),
  });
  if (!res.ok) { console.error("Resend error", res.status, await res.text()); return reply(502, { error: "The email service refused the message" }); }

  await admin.from("bookings").update({ email_sent_at: new Date().toISOString() }).eq("id", booking_id);
  return reply(200, { sent: true, to: b.email, passes: people.length });
});
