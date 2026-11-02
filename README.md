# Serenity Space Meal Pass

Meal and snack pass booking for **Serenity Space Co-operative Housing Society**, Jagatpur, Ahmedabad (416 flats, blocks A–I).

Residents log in with their **mobile number + SMS OTP**, book passes for society events (26 January, 15 August, Holi, Navratri, lunches and dinners), and get **one QR pass per person** on WhatsApp, email or printed. The committee manages events, payments, printing, a QR-scanning counter and reports.

## What it does

**Residents**
- Login with mobile number + 6-digit OTP (MSG91)
- One-time profile: name, block/flat (dropdown of real flats only), email
- Book for their own flat only; sees **only their own bookings**
- Mobile pass (QR on phone) or printed pass; UPI payment with reference entry; cancel an unpaid booking

**Committee** (approved by the super admin)
- Events: one-time or multi-session, at cost / discounted / free, booking window, optional rate increase after a date, capacity, all-sessions package
- Bookings: filters, mark paid (cash / UPI / waived), bulk actions, desk bookings for residents without a phone
- Pass delivery: WhatsApp message with per-person pass links, email with QR images, downloadable pass images, A4 print sheets (8 per page)
- Counter: **live camera QR scanner**, per-person hand-over, double-use protection
- Reports: overview, session headcount for the caterer, block-wise totals, Excel export
- Super admin: approve / reject / revoke committee members

## How it's built

| Part | Folder | Notes |
|---|---|---|
| Database + privacy rules | `supabase/migrations/` | Postgres with Row Level Security; bookings are created and priced only by server functions |
| SMS OTP sender | `supabase/functions/sms-hook/` | Supabase Auth "Send SMS" hook → MSG91 |
| Pass emails | `supabase/functions/send-pass/` | Resend, one QR image per person |
| Web app | `web/` | Plain HTML/CSS/JS, no build step; libraries vendored in `web/vendor/` |
| Tests | `tests/` | `db.test.mjs` runs the migration in embedded Postgres and checks the privacy rules; `web.test.py` clicks through the app |
| Deployment | `.github/workflows/` | Tests, Supabase deploy, GitHub Pages deploy |

See **[docs/SETUP.md](docs/SETUP.md)** for the step-by-step setup.

## Run the tests

```bash
cd tests && npm install && node db.test.mjs      # database rules (41 checks)
python3 tests/web.test.py                         # browser smoke test (needs Playwright)
```

## Local preview

```bash
cp web/config.example.js web/config.js   # fill in your Supabase URL and anon key
cd web && python3 -m http.server 5173     # open http://localhost:5173
```
