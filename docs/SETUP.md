# Setup guide — Serenity Space Meal Pass

About **1–2 hours of clicking**, spread over a few days because the SMS sender (DLT) approval takes time.
You can use the app with **free test logins** (step 5) while DLT approval is pending.

| What | Where | Cost |
|---|---|---|
| Code and website hosting | GitHub + GitHub Pages | Free |
| Database, login, server functions | Supabase (Free plan) | Free |
| OTP SMS | MSG91 | ≈ ₹0.20–0.25 per SMS |
| SMS sender registration (India, one-time) | DLT portal (Jio / Vodafone Idea / Airtel) | ≈ ₹5,900 one-time |
| Pass emails (optional) | Resend | Free up to 3,000 emails / month |

> **If Claude has the GitHub and Supabase connectors**, it can do steps 1–4 and 6 for you. You still create the accounts, do the DLT/MSG91 registration, and paste in the keys.

---

## 1. GitHub repository

1. Sign in at github.com and create a repository named **`serenity-meal-pass`** (Public is simplest — GitHub Pages is free for public repos; nothing secret is stored in the code).
2. Upload this project (or let Claude push it).

## 2. Supabase project

1. Sign up at **supabase.com** → **New project**.
   - Name: `serenity-meal-pass`
   - Region: **South Asia (Mumbai)**
   - Database password: generate one and **save it** (needed below).
2. When the project is ready, note from **Project Settings**:
   - **Project ref** – the code in the URL, e.g. `abcdwxyz` in `https://abcdwxyz.supabase.co`
   - **API → Project URL** and **anon public key**
3. Create a personal access token: **Account (top-right) → Access Tokens → Generate new token**. Save it.

## 3. Connect GitHub to Supabase (secrets and variables)

In GitHub: **repo → Settings → Secrets and variables → Actions**.

**Secrets** (hidden):

| Name | Value |
|---|---|
| `SUPABASE_ACCESS_TOKEN` | token from step 2.3 |
| `SUPABASE_DB_PASSWORD` | database password from step 2.1 |
| `SUPABASE_PROJECT_REF` | project ref |

**Variables** (visible):

| Name | Value |
|---|---|
| `SUPABASE_URL` | `https://<project-ref>.supabase.co` |
| `SUPABASE_ANON_KEY` | anon public key |
| `SITE_URL` | `https://<your-github-username>.github.io/serenity-meal-pass` |

Then **Settings → Pages → Build and deployment → Source: GitHub Actions**.

## 4. Deploy

**Actions** tab → run **Deploy Supabase**, then **Deploy website** (button “Run workflow”).
Both also run automatically whenever the code changes.

- *Deploy Supabase* creates all tables, privacy rules and functions, and deploys the two server functions.
- *Deploy website* publishes the app at your `SITE_URL`.

## 5. Turn on mobile login (Supabase dashboard)

1. **Authentication → Sign In / Providers → Phone** → enable. If the screen insists on an SMS provider, choose Twilio and enter placeholder values — once the hook below is on, Supabase sends every SMS through it instead.
2. **Authentication → URL Configuration → Site URL** = your `SITE_URL`.
3. **Free test logins (use while MSG91 is not ready):** under the Phone provider, add *Test phone numbers and OTPs*, e.g. `919724212198=123456`. These numbers log in with that code and no SMS is sent. Remove them before going live.
4. **Authentication → Hooks → Send SMS hook → Enable** → type **HTTPS** →
   URL `https://<project-ref>.supabase.co/functions/v1/sms-hook` → **Generate secret**.
   Copy the secret (starts with `v1,whsec_`) into GitHub secret **`SEND_SMS_HOOK_SECRETS`**, then re-run **Deploy Supabase**.

## 6. MSG91 + DLT (real SMS)

1. **DLT registration** (one-time, as the society): register on a DLT portal (e.g. Jio TrueConnect / Vilpower) as *Principal Entity* with the society registration certificate and PAN.
   - Header (sender ID), 6 letters, e.g. **`SRNTYS`**.
   - Content template (category *Service Implicit*):
     `Your Serenity Space login code is {#var#}. Do not share it with anyone. - Serenity Space`
2. **MSG91**: sign up at msg91.com → add the DLT Entity ID, Header and the approved template.
   In MSG91 create the template with the variable **`##otp##`** in place of `{#var#}`, and note its **Template ID**.
3. **MSG91 → API → Auth key**: copy it.
4. Add GitHub secrets **`MSG91_AUTH_KEY`** and **`MSG91_TEMPLATE_ID`** (and `MSG91_OTP_VAR` only if your template variable isn't `otp`). Re-run **Deploy Supabase**.
5. Log in on the site with a real number to test.

## 7. Pass emails (optional)

**Option A – Gmail (easiest, no domain needed, about 500 emails a day)**
1. Use a society Gmail account (e.g. `serenityspace.passes@gmail.com`). Turn on **2-Step Verification**.
2. Google Account → Security → **App passwords** → create one named "Meal Pass". Copy the 16-letter password.
3. Supabase dashboard → **Edge Functions → Secrets** → add `SMTP_USER` = the Gmail address and `SMTP_PASS` = the app password.
   Delete `RESEND_API_KEY` there if it holds an old or invalid key (Gmail is used whenever `SMTP_USER` and `SMTP_PASS` are set).

**Option B – Resend** (only if the society owns a domain)
1. resend.com → verify your domain → create an API key.
2. Secrets `RESEND_API_KEY` and `PASS_FROM_EMAIL` (e.g. `Serenity Space <passes@yourdomain.in>`).
   Without a verified domain Resend can only email the account owner.

If something is wrong, the committee screen now shows the exact reason (wrong key, Gmail login refused, domain not verified).
Without email, everything else works; committee members send passes on WhatsApp.

### Email login (works once the Gmail secrets above are set)
Residents can tap **✉️ Email** on the login screen and get a 6-digit code by email instead of SMS.
The `email-otp` function creates the account and sends the code through the same Gmail.
In Supabase → **Authentication → Sign In / Providers → Email** must be **enabled** (it is by default).
Limits: 3 codes per email per 15 minutes, 15 per device per hour.

## 8. First login and committee

1. Open the site and log in with **9724212198** — this number becomes **Super admin** automatically (set in `supabase/migrations/…_init.sql`, setting `super_admin_phone`).
2. Fill in your details. Settings → set the payment desk and UPI.
3. Committee members log in, fill in their details and tap **Request committee access**. Approve them in **Settings → Committee access**.
4. Share the site link with residents (WhatsApp broadcast / MyGate notice / Adnmo screens).

---

## Changing things later

- **Ask Claude** (with the GitHub connector): it edits the code and pushes; the Actions deploy automatically. Database changes go in a **new** file under `supabase/migrations/` — never edit an applied migration.
- **Change super admin number before first login**: edit `super_admin_phone` in the migration. After launch: Supabase **Table editor → app_settings**.
- **Backups**: Supabase → Database → Backups (daily on paid plans). On the Free plan, export bookings to Excel from Reports after each event.
- **Free plan pause**: Supabase pauses a free project after 7 days without any use; it resumes when opened from the dashboard. Regular use during booking windows keeps it awake.
