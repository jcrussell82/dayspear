# DaySpear — working app

Team scheduling, made simple. This folder is the real, working version of the DaySpear prototype: real accounts, separate businesses, saved data, invites, and Stripe subscription billing in **test mode**.

It has **no third-party packages**. It needs only Node.js 22.13 or newer, which includes a database (SQLite), cryptography and networking.

```
npm test          # builds the app and runs the automated tests (19 checks)
npm run dev       # builds and starts it at http://localhost:3000
```

In development nothing is really sent. Sign-in codes and invite links are printed in the terminal. Invite links also appear in the app as a "Development mode" notice.

---

## How it fits together

| Part | What it does |
|---|---|
| `client/src/*.html` | The prototype's screens, split into parts, with a few hooks added. `p5q_real.html` is new: it connects the screens to the server. |
| `client/assets/` | Logo, photos and the demo profile pictures. |
| `build.mjs` | Builds `public/` from the parts: `index.html`, `app.css`, `app.js` and assets. `--single` also writes `public/dayspear-demo.html`, a single self-contained file with the demo. |
| `server/index.js` | Web server and JSON API. Also handles security headers and CSRF protection. |
| `server/auth.js` | Passwordless sign-in. One-time 6-digit codes, sessions, rate limits. |
| `server/workspace.js` | Permission checks for every change. It also builds the privacy-filtered view each person receives. |
| `server/billing.js` | Stripe Checkout, the Customer Portal and webhooks. |
| `server/messaging.js` | Email (Resend or Postmark) and texts (Twilio). Without a provider, it only logs. |
| `server/plans.js` | **The one place pricing and plan limits are defined.** |
| `server/db.js` | SQLite tables and migrations. |
| `test/` | End-to-end API tests, plus Stripe tests against a fake Stripe server. |
| `setup/github-actions-test.yml` | Optional: move it to `.github/workflows/test.yml` in your repo so GitHub runs the tests on every push. |

### Two modes, one app

- **Real mode** is used when the page is served by this server. The homepage, sign-up, sign-in, invites and the app all use real accounts.
- **Demo mode** is used when there is no server (GitHub Pages, opening the file directly) or the address has `?demo`. It loads the sample bakery, shows a **"Demo — sample data"** bar, and saves changes only in that browser. On the real site, the homepage "preview" buttons open the demo.

### How data is kept safe

- Each business's schedule data is one record, always loaded by the signed-in person's business. One business can't reach another's data, and a test checks this.
- The browser sends small "changes" (ops). The server checks every op against the person's role before saving:
  - **Owner:** everything.
  - **Manager:** only the locations they manage.
  - **Employee:** their own profile and requests, picking up or offering shifts, ticking their checklists and to-dos, and chatting in their own channels.
- The server, not the browser, sets who did something and when: approvals, publishing, message authors and pickups.
- **Phone numbers:** employees never receive a coworker's number unless the business turns on phone sharing *and* that person opts in. Managers see contact details for their team.
- **Drafts:** employees only ever receive the published version of a shift.
- **Codes, sessions and invite links** are stored only as keyed hashes. Codes expire in 10 minutes and lock after 5 wrong tries. Invite links work once and expire after 7 days. Starting a sign-in gives the same answer whether or not an account exists.
- **Cookies** are HttpOnly and SameSite=Lax, plus Secure on https. A strict Content-Security-Policy and a custom request header protect against CSRF.
- **No secret is ever sent to the browser.** All keys live in server environment variables.

---

## Setup

### 1. Settings

Copy `.env.example` to `.env` and fill it in. On a host, enter the same values in its "Environment" settings. Never commit `.env`.

| Variable | Needed for | Notes |
|---|---|---|
| `APP_URL` | everything | Public address, e.g. `https://app.yourdomain.com`. Invite links and Stripe return pages use it. |
| `APP_SECRET` | everything | Long random value. `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"` |
| `DATABASE_PATH` | everything | Must be on a **persistent disk** when hosted. |
| `EMAIL_PROVIDER` + `RESEND_API_KEY` *or* `POSTMARK_SERVER_TOKEN`, `EMAIL_FROM` | sign-in codes, invites | Production refuses to start with `console`, because nobody could sign in. |
| `CONTACT_EMAIL` | homepage contact form | Where contact messages go. |
| `SMS_PROVIDER=twilio` + `TWILIO_*` | optional | Sign-in by text. Off by default, so everyone signs in by email. |
| `STRIPE_SECRET_KEY` (`sk_test_…`), `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_TEAM`, `STRIPE_PRICE_BUSINESS` | billing | Without these, the plan page says payments aren't connected and nothing can be charged. |
| `ALLOW_LIVE_PAYMENTS` | live billing | Leave `false`. A live key (`sk_live_…`) is **refused** unless this is `true`. |
| `PLANS_JSON` | optional | Change display prices or limits without editing code. |

### 2. Email (sign-in codes and invites)

1. Create a Resend (or Postmark) account and verify your domain. They give you DNS records to add at GoDaddy.
2. Set `EMAIL_PROVIDER=resend`, `RESEND_API_KEY=…` and `EMAIL_FROM=DaySpear <no-reply@yourdomain.com>`.

Once a real provider is set, codes and invite links are blanked out in the database's message log.

### 3. Stripe in test mode

1. Stripe Dashboard → turn on **Test mode**.
2. **Products** → create "DaySpear Team" with a recurring monthly price ($8), and "DaySpear Business" ($18). Copy each **price ID** (`price_…`) into `STRIPE_PRICE_TEAM` and `STRIPE_PRICE_BUSINESS`. Stripe charges these amounts. `server/plans.js` only controls what the app displays, so keep them matching.
3. **Developers → API keys** → copy the secret test key (`sk_test_…`) into `STRIPE_SECRET_KEY`.
4. **Settings → Billing → Customer portal** → turn it on (lets owners change plan, update their card and cancel).
5. Webhooks:
   - **Hosted:** Developers → Webhooks → add endpoint `https://YOUR-APP/api/stripe/webhook`. Choose the events `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted` and `invoice.payment_failed`. Copy the signing secret (`whsec_…`) into `STRIPE_WEBHOOK_SECRET`.
   - **Locally:** `stripe listen --forward-to localhost:3000/api/stripe/webhook` and use the `whsec_…` it prints.
6. Test it: sign in as an owner → Settings › Plan → Choose Team. On Stripe's page, pay with `4242 4242 4242 4242`, any future date and any CVC. Back in DaySpear, the plan switches to Team within a few seconds, once the webhook arrives.

Only the owner can start checkout or open billing. Going live needs a deliberate decision: live keys, live prices, `ALLOW_LIVE_PAYMENTS=true`, plus terms, a privacy policy and tax settings.

---

## Hosting (GitHub + your GoDaddy domain)

**GitHub Pages can't run this app.** It only serves static files, and DaySpear needs a server for accounts and data. GitHub stays your code home. A host that deploys from GitHub runs the server:

- **Render** (easiest): push this folder to a GitHub repo → Render → *New → Blueprint* → pick the repo. `render.yaml` sets up the web service, a 1 GB persistent disk at `/var/data` and the settings. You fill in the secrets. A persistent disk needs a paid instance, so check Render's current price before confirming.
- **Railway / Fly.io:** use the `Dockerfile` and mount a volume at `/data`.

Run **one instance**. The database file and rate limits live on that one machine. Back up the database file regularly; Render disks have snapshots.

### Pointing your GoDaddy domain

Recommended: keep the marketing site and app together on the host, at `app.yourdomain.com` or the root domain.

1. In the host, add your custom domain. It shows a target such as `dayspear.onrender.com`.
2. GoDaddy → My Products → your domain → **DNS** → Add record:
   - Subdomain (`app.yourdomain.com`): **CNAME**, name `app`, value = the host's target.
   - Root domain (`yourdomain.com`): use the **A** record IP the host gives you. For `www`, add a **CNAME** `www` → the host's target.
3. Wait for DNS (minutes to a few hours). The host issues the https certificate automatically.
4. Set `APP_URL` to the final https address and redeploy.

GitHub Pages can still host the **demo** if you want a free public preview: publish `public/` (built with `npm run build`). It runs in demo mode automatically.

---

## What's real and what's simulated

**Saved on the server:** businesses, owners, managers and employees, and their profiles and preferences. Also locations, roles, settings, schedules, drafts and publishing, time off, coverage, swaps and the pickup log, checklists, to-dos, announcements and read receipts, team, shift and direct messages, invites, sessions, plan and subscription status, and the grace period.

**Simulated or not built yet:**
- Push notifications. Notification preferences are saved, but nothing is pushed yet.
- Messages update every 20 seconds, not instantly.
- Print uses the browser.
- Photos are stored in the database (fine for small teams; move them to object storage later).
- Account recovery for owners and managers who lose both email and phone goes through the contact form. Support has no admin tool yet.
- Managers can fix an *invited* person's contact details and resend. Changing an *active* employee's sign-in details is up to that employee.

**Not included on purpose:** payroll, time clocks, inventory, CRM.
