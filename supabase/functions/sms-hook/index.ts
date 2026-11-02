// Supabase Auth "Send SMS" hook → MSG91.
// Supabase generates the 6-digit OTP and calls this function; we deliver it through MSG91
// using a DLT-approved template that contains the variable ##otp##.
//
// Secrets (set with `supabase secrets set` or in the dashboard):
//   SEND_SMS_HOOK_SECRETS   – shown by Supabase when you enable the hook (starts with "v1,whsec_")
//   MSG91_AUTH_KEY          – MSG91 → API → Auth key
//   MSG91_TEMPLATE_ID       – MSG91 Flow / template id of the approved OTP template
// Optional:
//   MSG91_OTP_VAR           – template variable name (default "otp")
import { Webhook } from "https://esm.sh/standardwebhooks@1.0.0";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(405, { error: { http_code: 405, message: "Method not allowed" } });

  const raw = await req.text();
  const secret = (Deno.env.get("SEND_SMS_HOOK_SECRETS") ?? "").replace("v1,whsec_", "");
  let payload: { user: { phone: string }; sms: { otp: string } };
  try {
    payload = new Webhook(secret).verify(raw, Object.fromEntries(req.headers)) as typeof payload;
  } catch (_e) {
    return json(401, { error: { http_code: 401, message: "Invalid signature" } });
  }

  const phone = (payload.user?.phone ?? "").replace(/\D/g, "");   // e.g. 919724212198
  const otp = payload.sms?.otp ?? "";
  if (!/^91[6-9]\d{9}$/.test(phone) || !/^\d{4,8}$/.test(otp)) {
    return json(400, { error: { http_code: 400, message: "Only Indian mobile numbers are supported" } });
  }

  const res = await fetch("https://control.msg91.com/api/v5/flow", {
    method: "POST",
    headers: { "Content-Type": "application/json", accept: "application/json", authkey: Deno.env.get("MSG91_AUTH_KEY") ?? "" },
    body: JSON.stringify({
      template_id: Deno.env.get("MSG91_TEMPLATE_ID"),
      short_url: "0",
      recipients: [{ mobiles: phone, [Deno.env.get("MSG91_OTP_VAR") ?? "otp"]: otp }],
    }),
  });
  const text = await res.text();
  let ok = res.ok;
  try { ok = ok && JSON.parse(text).type !== "error"; } catch { /* non-JSON reply */ }
  if (!ok) {
    console.error("MSG91 error", res.status, text);
    return json(502, { error: { http_code: 502, message: "Could not send the SMS. Please try again in a minute." } });
  }
  return json(200, {});
});
