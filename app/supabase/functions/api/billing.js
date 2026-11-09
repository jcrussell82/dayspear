// Stripe subscription billing through Stripe's REST API (no SDK needed).
//   POST /billing/checkout → Stripe-hosted Checkout page for the chosen plan (owner only)
//   POST /billing/portal   → Stripe-hosted Customer Portal (change plan or card, invoices, cancel)
//   POST /stripe/webhook   → keeps each business's plan in sync with Stripe
// Card details are only ever entered on Stripe's pages — DaySpear never sees them.
import { config, stripeEnabled } from './config.js';
import { db } from './db.js';
import { HttpError } from './errors.js';
import { PLANS, planById } from './plans.js';

async function stripe(method, path, params) {
  if (!stripeEnabled()) throw new HttpError(501, 'Payments aren’t set up yet. Add your Stripe test keys to the Supabase function secrets.', { code: 'stripe_not_configured' });
  const body = params ? new URLSearchParams(flatten(params)) : undefined;
  const r = await fetch(`${config.stripe.apiBase}/v1${path}`, {
    method, body,
    headers: { Authorization: `Bearer ${config.stripe.secretKey}`, ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}), 'Stripe-Version': '2024-06-20' },
  });
  const json = await r.json();
  if (!r.ok) { console.error('[stripe]', r.status, json.error?.message); throw new HttpError(502, 'Stripe couldn’t complete that request. Please try again.'); }
  return json;
}
// true if the object exists in this Stripe account and mode (and isn't deleted)
async function stripeExists(path) {
  const r = await fetch(`${config.stripe.apiBase}/v1${path}`, { headers: { Authorization: `Bearer ${config.stripe.secretKey}`, 'Stripe-Version': '2024-06-20' } });
  if (r.status === 404) return false;
  if (!r.ok) return true; // unsure (rate limit, outage): let the real request decide
  const j = await r.json().catch(() => ({}));
  return !j.deleted;
}
// Stripe expects nested form fields like line_items[0][price]=...
function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') flatten(v, key, out); else out[key] = String(v);
  }
  return out;
}

const priceFor = plan => config.stripe.prices[plan.stripePriceEnv] || '';
const planForPrice = priceId => PLANS.find(p => p.stripePriceEnv && config.stripe.prices[p.stripePriceEnv] === priceId);

export async function createCheckout(biz, owner, planId) {
  const plan = planById(planId);
  if (!plan.stripePriceEnv) throw new HttpError(400, 'Choose a paid plan.');
  const price = priceFor(plan);
  if (!price && stripeEnabled()) throw new HttpError(501, `The Stripe price for ${plan.name} isn’t set (${plan.stripePriceEnv}).`, { code: 'stripe_price_missing' });
  if (biz.stripe_subscription_id && ['active', 'trialing', 'past_due'].includes(biz.subscription_status)) return createPortal(biz); // already subscribed
  let customer = biz.stripe_customer_id;
  // A customer saved while testing doesn't exist in live mode (or another Stripe account): start a fresh one.
  if (customer && !(await stripeExists(`/customers/${customer}`))) {
    customer = null;
    await db.update('businesses', `id=${db.eq(biz.id)}`, { stripe_customer_id: null, stripe_subscription_id: null, subscription_status: null });
  }
  if (!customer) {
    const c = await stripe('POST', '/customers', { name: biz.name, email: owner.email || undefined, metadata: { business_id: biz.id } });
    customer = c.id;
    await db.update('businesses', `id=${db.eq(biz.id)}`, { stripe_customer_id: customer });
  }
  const session = await stripe('POST', '/checkout/sessions', {
    mode: 'subscription', customer, client_reference_id: biz.id,
    line_items: [{ price, quantity: 1 }],
    subscription_data: { metadata: { business_id: biz.id, plan_id: plan.id } },
    metadata: { business_id: biz.id, plan_id: plan.id },
    success_url: `${config.appUrl}/#app/settings/plan?checkout=success`,
    cancel_url: `${config.appUrl}/#app/settings/plan?checkout=cancelled`,
    allow_promotion_codes: 'true',
    billing_address_collection: 'auto',
    ...(config.stripe.requireTerms ? { consent_collection: { terms_of_service: 'required' } } : {}),
  });
  return { url: session.url };
}

export async function createPortal(biz) {
  if (!biz.stripe_customer_id || !(await stripeExists(`/customers/${biz.stripe_customer_id}`))) throw new HttpError(400, 'There’s no billing account yet — choose a paid plan first.');
  const s = await stripe('POST', '/billing_portal/sessions', { customer: biz.stripe_customer_id, return_url: `${config.appUrl}/#app/settings/plan` });
  return { url: s.url };
}

// Verify the Stripe-Signature header (HMAC-SHA256 over "timestamp.payload").
export async function verifyWebhook(raw, header) {
  if (!config.stripe.webhookSecret) throw new HttpError(501, 'STRIPE_WEBHOOK_SECRET is not set.');
  const parts = String(header || '').split(',').map(p => p.split('='));
  const t = Number((parts.find(p => p[0] === 't') || [])[1]);
  const sigs = parts.filter(p => p[0] === 'v1').map(p => p[1]);
  if (!t || !sigs.length) throw new HttpError(400, 'Missing signature');
  if (Math.abs(Date.now() / 1000 - t) > 300) throw new HttpError(400, 'Signature too old');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(config.stripe.webhookSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${raw}`));
  const expected = [...new Uint8Array(mac)].map(b => b.toString(16).padStart(2, '0')).join('');
  const same = (a, b) => { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; };
  if (!sigs.some(s => same(s, expected))) throw new HttpError(400, 'Bad signature');
  return JSON.parse(raw);
}

export async function handleWebhook(event) {
  const fresh = await db.insert('stripe_events', { id: event.id, type: event.type }, 'resolution=ignore-duplicates,return=representation');
  if (!fresh || !fresh.length) return 'duplicate';
  const o = event.data?.object || {};
  switch (event.type) {
    case 'checkout.session.completed': {
      const bizId = o.client_reference_id || o.metadata?.business_id;
      if (bizId && o.subscription) {
        const biz = await db.one('businesses', `id=${db.eq(bizId)}`);
        if (biz) await db.update('businesses', `id=${db.eq(bizId)}`, { stripe_customer_id: biz.stripe_customer_id || o.customer, stripe_subscription_id: o.subscription });
        try { await applySubscription(await stripe('GET', `/subscriptions/${o.subscription}`)); } catch (e) { console.error('[stripe] fetch subscription failed', e.message); }
      }
      break;
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
      await applySubscription(o);
      break;
    case 'invoice.payment_failed':
    { // the subscription id moved under `parent` in newer Stripe API versions
      const subId = o.subscription || o.parent?.subscription_details?.subscription;
      if (subId) await db.update('businesses', `stripe_subscription_id=${db.eq(typeof subId === 'string' ? subId : subId.id)}`, { subscription_status: 'past_due' });
    }
      break;
    default: break;
  }
  return 'ok';
}

async function applySubscription(sub) {
  let biz = await db.one('businesses', `stripe_subscription_id=${db.eq(sub.id)}`);
  if (!biz && sub.metadata?.business_id) biz = await db.one('businesses', `id=${db.eq(sub.metadata.business_id)}`);
  if (!biz && sub.customer) biz = await db.one('businesses', `stripe_customer_id=${db.eq(sub.customer)}`);
  if (!biz) return;
  const plan = planForPrice(sub.items?.data?.[0]?.price?.id);
  const ended = ['canceled', 'incomplete_expired', 'unpaid'].includes(sub.status);
  await db.update('businesses', `id=${db.eq(biz.id)}`, {
    stripe_subscription_id: sub.id, subscription_status: sub.status, plan_id: ended || !plan ? 'free' : plan.id,
    // newer Stripe API versions keep the period end on the subscription item instead
    current_period_end: (() => { const t = sub.current_period_end || sub.items?.data?.[0]?.current_period_end; return t ? new Date(t * 1000).toISOString() : null; })(),
  });
}
