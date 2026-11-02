// Email login code for residents (used while SMS OTP is not available).
// POST { email }  →  creates the account if needed and emails a login code (6 or 8 digits, per project setting)
//                    through the same Gmail / SMTP account used for pass emails.
// Returns { sent, length } (the project may use 6- or 8-digit codes). The app then calls supabase.auth.verifyOtp({ email, token, type: "email" }).
//
// Secrets: SMTP_USER, SMTP_PASS (optional SMTP_HOST, SMTP_PORT, PASS_FROM_EMAIL) — same as send-pass.
// Deployed with verify_jwt = false (people are not logged in yet). Abuse limits below.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import nodemailer from "npm:nodemailer@6.9.16";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const PER_EMAIL_15MIN = 3, PER_IP_HOUR = 15, ALL_PER_HOUR = 200;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return reply(405, { error: "Method not allowed" });

  const { email: raw } = await req.json().catch(() => ({}));
  const email = String(raw ?? "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(email) || email.length > 100) return reply(400, { error: "Enter a valid email address." });

  const smtpUser = Deno.env.get("SMTP_USER"), smtpPass = Deno.env.get("SMTP_PASS");
  if (!smtpUser || !smtpPass) return reply(503, { error: "Email login is not set up yet. Please contact the committee." });

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || null;

  // ── abuse limits ──
  const since = (min: number) => new Date(Date.now() - min * 60000).toISOString();
  const [e1, e2, e3] = await Promise.all([
    admin.from("login_email_log").select("id", { count: "exact", head: true }).eq("email", email).gte("at", since(15)),
    ip ? admin.from("login_email_log").select("id", { count: "exact", head: true }).eq("ip", ip).gte("at", since(60)) : Promise.resolve({ count: 0 }),
    admin.from("login_email_log").select("id", { count: "exact", head: true }).gte("at", since(60)),
  ]);
  if ((e1.count ?? 0) >= PER_EMAIL_15MIN) return reply(429, { error: "Too many codes for this email. Please wait 15 minutes, or use the last code you received." });
  if ((e2.count ?? 0) >= PER_IP_HOUR || (e3.count ?? 0) >= ALL_PER_HOUR) return reply(429, { error: "Too many login requests. Please try again in a while." });
  await admin.from("login_email_log").insert({ email, ip });

  // ── account (created on first login) + code ──
  const created = await admin.auth.admin.createUser({ email, email_confirm: true });
  if (created.error && !/already|registered|exists/i.test(created.error.message)) {
    console.error("createUser", created.error.message);
    return reply(500, { error: "Could not prepare your login. Please try again." });
  }
  const link = await admin.auth.admin.generateLink({ type: "magiclink", email });
  const code = link.data?.properties?.email_otp;
  if (link.error || !code) { console.error("generateLink", link.error?.message); return reply(500, { error: "Could not create a login code. Please try again." }); }

  const html = `<div style="font-family:Arial,sans-serif;color:#17231a;max-width:480px">
    <p style="font-size:16px"><b>Serenity Space · Meal Pass</b></p>
    <p>તમારો લૉગિન કોડ · Your login code:</p>
    <p style="font-size:30px;letter-spacing:6px;font-weight:bold;font-family:monospace;margin:6px 0 14px">${code}</p>
    <p>આ કોડ 1 કલાક માટે માન્ય છે. કોઈને શેર કરશો નહીં.<br>Valid for 1 hour. Do not share it with anyone.</p>
    <p style="color:#5e6b60;font-size:12px">If you did not try to log in, you can ignore this email.</p></div>`;
  try {
    const tx = nodemailer.createTransport({ host: Deno.env.get("SMTP_HOST") || "smtp.gmail.com", port: +(Deno.env.get("SMTP_PORT") || 465), secure: true, auth: { user: smtpUser, pass: smtpPass } });
    await tx.sendMail({ from: Deno.env.get("PASS_FROM_EMAIL") || `Serenity Space Meal Pass <${smtpUser}>`, to: email,
      subject: `${code} is your Serenity Space login code`, text: `Your Serenity Space Meal Pass login code is ${code}. Valid for 1 hour. Do not share it.`, html });
  } catch (e) {
    console.error("SMTP", String((e as Error)?.message ?? e));
    return reply(502, { error: "The login email could not be sent. Please try again or contact the committee." });
  }
  return reply(200, { sent: true, length: String(code).length });
});
