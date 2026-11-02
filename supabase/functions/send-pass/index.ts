// Emails a booking's passes (one QR image per person).
// Called from the committee screen: POST { booking_id } with the user's login token.
//
// Two ways to send — set ONE of them as Edge Function secrets:
//   A) Gmail (no domain needed, ~500 mails/day):
//        SMTP_USER  – the society Gmail address, e.g. serenityspace.passes@gmail.com
//        SMTP_PASS  – a Gmail *App password* (Google account → Security → 2-Step Verification → App passwords)
//        (optional) SMTP_HOST / SMTP_PORT – default smtp.gmail.com / 465
//   B) Resend (needs your own domain verified in Resend to mail residents):
//        RESEND_API_KEY, PASS_FROM_EMAIL e.g. "Serenity Space <passes@your-domain.in>"
//   SITE_URL – where the web app is hosted (default: the GitHub Pages address below)
// SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase automatically.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import QRCode from "npm:qrcode@1.5.4";
import nodemailer from "npm:nodemailer@6.9.16";
const DEFAULT_SITE = "https://bshah0708.github.io/serenity-meal-pass";

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
  const smtpUser = Deno.env.get("SMTP_USER"), smtpPass = Deno.env.get("SMTP_PASS"), resendKey = Deno.env.get("RESEND_API_KEY");
  if (!(smtpUser && smtpPass) && !resendKey) return reply(503, { error: "Email is not set up yet. The super admin needs to add the Gmail (SMTP_USER / SMTP_PASS) or Resend secrets in Supabase." });

  const site = (Deno.env.get("SITE_URL") || DEFAULT_SITE).replace(/\/$/, "");
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

  const subject = `Your meal passes – ${ev.name_en ?? ev.name_gu ?? ""} – ${b.block}-${b.flat_no}`;
  if (smtpUser && smtpPass) {
    try {
      const tx = nodemailer.createTransport({ host: Deno.env.get("SMTP_HOST") || "smtp.gmail.com", port: +(Deno.env.get("SMTP_PORT") || 465), secure: true, auth: { user: smtpUser, pass: smtpPass } });
      await tx.sendMail({ from: Deno.env.get("PASS_FROM_EMAIL") || `Serenity Space Meal Pass <${smtpUser}>`, to: b.email, subject, html,
        attachments: attachments.map((a) => ({ filename: a.filename, content: a.content, encoding: "base64" })) });
    } catch (e) {
      const m = String((e as Error)?.message ?? e);
      console.error("SMTP error", m);
      return reply(502, { error: /535|auth|credentials|Username and Password/i.test(m) ? "Gmail refused the login. Check SMTP_USER and use a Gmail App password (not the normal password) for SMTP_PASS." : "Gmail could not send the email: " + m.slice(0, 160) });
    }
  } else {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: Deno.env.get("PASS_FROM_EMAIL"), to: [b.email], subject, html, attachments }),
    });
    if (!res.ok) {
      const t = await res.text(); console.error("Resend error", res.status, t);
      const why = res.status === 401 ? "The Resend API key is invalid. Create a new key at resend.com and update RESEND_API_KEY in Supabase."
        : res.status === 403 || /domain|verify/i.test(t) ? "Resend can only email residents after your sending domain is verified (PASS_FROM_EMAIL). Use the Gmail option instead if you have no domain."
        : res.status === 422 ? "Resend rejected the sender address (PASS_FROM_EMAIL): " + t.slice(0, 140)
        : "The email service refused the message (" + res.status + ").";
      return reply(502, { error: why });
    }
  }

  await admin.from("bookings").update({ email_sent_at: new Date().toISOString() }).eq("id", booking_id);
  return reply(200, { sent: true, to: b.email, passes: people.length });
});
