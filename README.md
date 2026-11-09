# DaySpear

Team scheduling, made simple. The website is static files on **GitHub Pages**. Accounts, data, billing and email run on **Supabase**.

```
Browser ──► GitHub Pages (index.html, app.js, app.css, config.js)
   │
   ├─► Supabase Auth ........ one-time sign-in codes by email (text optional)
   └─► Edge Function "api" .. checks who you are and what your role allows,
                              then reads/writes the database, calls Stripe, sends invites
                                   │
                                   └─► Postgres (locked: browsers can't touch the tables)
```

## What's where

| Path | What it is |
|---|---|
| `client/src/` | The app's screens, split into parts. `p5q_real.html` connects them to Supabase. |
| `client/assets/` | Logos and photos. The `demo-av-*` photos are used only by the demo. |
| `build.mjs` | Builds the site into `public/`. Run `npm run build`; there's nothing to install. |
| `supabase/migrations/` | The database tables. Every table is locked to browsers (row level security with no policies, no grants). |
| `supabase/functions/api/` | The Edge Function: permission checks, invites, Stripe, contact form. |
| `supabase/templates/` | Sign-in emails that show a 6-digit code. |
| `supabase/config.toml` | Supabase CLI settings: email codes, function settings. |
| `github-workflows/` | Two GitHub Actions: publish the site, deploy Supabase. **Move them to `.github/workflows/`.** |
| `test/` | End-to-end tests (18 checks) plus a local stand-in for Supabase. |

### How data is kept safe

- **Locked database:** the browser only ever has the *public* Supabase key. With that key, every table refuses access, and signed-in users are refused too. The tests check this.
- **One gatekeeper:** all data goes through the `api` function. It confirms the session with Supabase Auth, then checks each change against the person's role:
  - **Owner:** everything.
  - **Manager:** only the locations they manage.
  - **Employee:** their own profile and requests, picking up or offering shifts, checklists and to-dos, and their own chats.
- **Set by the server:** approvals, publishing, message authors and pickups. The browser can't fake them.
- **Separate businesses:** each business's data is loaded only through the signed-in person's membership. Asking for another business's id is ignored.
- **Phone numbers:** a coworker's number is shown only when the business allows sharing *and* that person opts in. Managers see contact details for their team.
- **Invite links:** single-use, expire after 7 days, and are stored as hashes.
- **Secrets stay in Supabase:** Stripe and email keys live only in Supabase's function secrets. The build refuses to put a secret key into the site.
- **Stripe live keys** (`sk_live_` or restricted `rk_live_`) are refused unless `ALLOW_LIVE_PAYMENTS=true`.

### Demo vs real

The site runs the **demo** (sample bakery, a "Demo — sample data" bar, saved only in that browser) when:
- it's built without `SUPABASE_URL` / `SUPABASE_ANON_KEY`, or
- the address has `?demo`.

On the real site, the homepage "preview" buttons open the demo.

---

## Set up (once)

### 1. Create the Supabase project

1. supabase.com → **New project**. Pick a region near you and save the **database password**.
2. **Project Settings → API**: note the **Project URL** (`https://<ref>.supabase.co`), the **project ref**, and the **anon / publishable** key. Leave the service / secret key alone; you won't need it.

### 2. Supabase Auth settings (Dashboard → Authentication)

- **Sign In / Providers → Email:**
  - Email provider **on**.
  - **Confirm email** on.
  - **Secure email change off.** One code to the new address is enough.
  - Email OTP length **6**, expiry **600** seconds.
- **Emails → Templates:** paste the contents of these files so the emails show a **code** instead of a link:
  - **Magic Link** ← `supabase/templates/magic_link.html`
  - **Confirm signup** ← `confirmation.html`
  - **Change Email Address** ← `email_change.html`
- **Emails → SMTP Settings:** turn on **custom SMTP**. Supabase's built-in email is only for trying things out: it sends very few emails per hour. With Resend: host `smtp.resend.com`, port `465`, user `resend`, password = your Resend API key, sender = an address on your verified domain.
- **URL Configuration:** set **Site URL** to your site address, e.g. `https://app.yourdomain.com`.
- *(Optional)* **Phone** provider with Twilio for sign-in by text. Then also set the function secret `SMS_ENABLED=true`.

### 3. Function secrets (Dashboard → Edge Functions → Secrets)

| Secret | Value |
|---|---|
| `APP_URL` | Your site address, e.g. `https://app.yourdomain.com`. Used in invite links and Stripe return pages. |
| `ALLOWED_ORIGINS` | The sites allowed to call the API, comma-separated: your domain and `https://<you>.github.io` |
| `RESEND_API_KEY`, `EMAIL_FROM`, `CONTACT_EMAIL` | Invite emails and the contact form. Without them, managers get each invite link to share themselves. |
| `STRIPE_SECRET_KEY` (`sk_test_…`), `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_TEAM`, `STRIPE_PRICE_BUSINESS` | Billing. Without them, the plan page says payments aren't connected. |
| `ALLOW_LIVE_PAYMENTS` | `false`. Leave it until you've decided to take real payments. |
| `PLANS_JSON` | *(optional)* Change the prices and limits the app displays without editing code. |
| `PRICING_PROVISIONAL` | *(optional)* `true` shows "Early-access pricing" on the site. Leave unset now that prices are final. |
| `STRIPE_REQUIRE_TERMS` | `true` once your Terms of Service page is live and its URL is set in Stripe. Checkout then asks people to agree before paying. |

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are provided to the function automatically.

### 4. GitHub

1. Put `github-workflows/pages.yml` and `github-workflows/supabase.yml` in **`.github/workflows/`** at the very top of the repo (next to `app/`, not inside it). GitHub only runs Actions from there. They expect this app to live in an `app/` folder of the repo.
2. Repo → **Settings → Secrets and variables → Actions**:
   - **Variables:** `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_PROJECT_REF`
   - **Secrets:** `SUPABASE_ACCESS_TOKEN` (supabase.com → Account → Access Tokens) and `SUPABASE_DB_PASSWORD`
3. Repo → **Settings → Pages → Source: GitHub Actions**.
4. Push to `main`. *Deploy Supabase* creates the tables and deploys the `api` function. *Publish site* builds and publishes the site. If either fails, open the **Actions** tab to see why.

Prefer your own computer? Install the Supabase CLI, then:

```
supabase link --project-ref <ref>
supabase db push
supabase functions deploy api --no-verify-jwt
supabase secrets set --env-file supabase/functions/.env
```

### 5. Your GoDaddy domain

1. GitHub repo → **Settings → Pages → Custom domain**: enter e.g. `app.yourdomain.com` and save.
2. GoDaddy → your domain → **DNS** → add:
   - **For a subdomain** (recommended, e.g. `app.yourdomain.com`): **CNAME**, name `app`, value `<your-github-username>.github.io`
   - **For the root domain** (`yourdomain.com`): four **A** records, name `@`, values `185.199.108.153`, `185.199.109.153`, `185.199.110.153` and `185.199.111.153`. Also add a **CNAME** with name `www` and value `<your-github-username>.github.io`.
3. Wait for GitHub to show the domain as verified, then tick **Enforce HTTPS**.
4. Update `APP_URL`, `ALLOWED_ORIGINS` and Supabase's **Site URL** to the new address.

### 6. Stripe (test first, then live)

Do the whole thing in a **sandbox / test mode** first, then repeat it in **live mode**. Test and live have separate products, prices, keys, webhooks and portal settings — nothing carries over.

1. **Products** → add:
   - "DaySpear Team": recurring, monthly, flat price (e.g. $8).
   - "DaySpear Business": recurring, monthly, flat price (e.g. $18).
   - Copy each `price_…` into `STRIPE_PRICE_TEAM` / `STRIPE_PRICE_BUSINESS`.
2. **Developers → API keys** → create a **restricted key** with only:
   - Customers: **Write**
   - Checkout Sessions: **Write**
   - Customer portal: **Write**
   - Subscriptions: **Read**
   Put it in `STRIPE_SECRET_KEY` (`rk_test_…` / `rk_live_…`). A full secret key works too, but a restricted one limits the damage if it ever leaks.
3. **Developers → Webhooks** → add an endpoint at `https://<ref>.supabase.co/functions/v1/api/stripe/webhook` with the events `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted` and `invoice.payment_failed`. Copy its signing secret into `STRIPE_WEBHOOK_SECRET`.
4. **Settings → Billing → Customer portal** → turn it on. Allow: update payment method, view invoices, cancel (at end of period), and **switch plans** between the Team and Business products.
5. **Test it:** owner → Settings › Plan → Choose Team → pay with `4242 4242 4242 4242`. The plan switches within seconds. Then use Manage billing to switch to Business, and to cancel.
6. **Going live** (only when you're ready to charge real cards):
   - In Stripe **Settings → Public details**: business name, support email, and your Terms of Service and Privacy Policy URLs.
   - Repeat steps 1–4 in live mode and replace the four Stripe secrets with the live values.
   - Set `ALLOW_LIVE_PAYMENTS=true`, and `STRIPE_REQUIRE_TERMS=true` (the Terms page is at `https://dayspear.com/#terms`, Privacy at `https://dayspear.com/#privacy`).
   - **Settings → Billing → Subscriptions and emails**: turn on emails for failed payments and expiring cards, and keep Smart Retries on (the Terms say Stripe retries and emails the owner).
   - Run **Deploy Supabase** (secrets apply when the function restarts; deploying guarantees it).
   - Make one real purchase with your own card, check the plan switches, then refund and cancel it in Stripe.

`supabase/functions/api/plans.js` controls what the app shows. Stripe's prices control what's charged, so keep them matching.

---

## Developing and testing

- **See the site:** `npm run serve` → http://localhost:5173. This is the demo unless you build with `SUPABASE_URL` / `SUPABASE_ANON_KEY` set.
- **Against a local Supabase:** install Docker and the Supabase CLI. Run `supabase start`, then `supabase functions serve api --no-verify-jwt`, and build with the local URL and key it prints.
- **Tests:** `npm test` runs 18 end-to-end checks against a Supabase project, by default the local stand-in in `test/stack/` (`npm run stack`). That stand-in runs Supabase's own Auth server and PostgREST without Docker. It needs those binaries, which it was built for; most people should use `supabase start` instead.

## What's real and what isn't yet

- **Saved in Supabase:** businesses, people and profiles, roles and locations, settings, schedules, drafts and publishing, time off, coverage and swaps, checklists, to-dos, announcements, all chats, invites, plan and subscription status, and the grace period.
- **Not yet:**
  - Push notifications. Preferences are saved, but nothing is pushed.
  - Chat refreshes every 10 seconds rather than instantly. Supabase Realtime can make it instant later.
  - Account recovery for an owner who lost both email and phone goes through the contact form.
  - Photos are stored with the team's data. Move them to Supabase Storage if teams grow.
- **Not included on purpose:** payroll, time clocks, inventory, CRM.
