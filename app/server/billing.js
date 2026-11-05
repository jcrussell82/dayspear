// Stripe subscription billing through Stripe's REST API (no SDK needed).
//   POST /api/billing/checkout  → hosted Checkout page for the chosen plan (owner only)
//   POST /api/billing/portal    → hosted Customer Portal (change card, cancel, invoices)
//   POST /api/stripe/webhook    → keeps each business's plan in sync with Stripe
// Card details are only ever entered on Stripe's pages — DaySpear never sees them.
// Live keys are refused unless ALLOW_LIVE_PAYMENTS=true (see config.js).
import crypto from 'node:crypto';
import { config, stripeEnabled } from './config.js';
import { q, now } from './db.js';
import { HttpError } from './auth.js';
import { PLANS, planById } from './plans.js';

async function stripe(method, path, params) {
  if (!stripeEnabled()) throw new HttpError(501, 'Payments aren’t set up yet. Add your Stripe test keys to the server settings.', { code: 'stripe_not_configured' });
  const body = params ? new URLSearchParams(flatten(params)) : undefined;
  const r = await fetch(`${config.stripe.apiBase}/v1${path}`, {
    method, body,
    headers: { Authorization: `Bearer ${config.stripe.secretKey}`, ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}), 'Stripe-Version': '2024-06-20' },
  });
  const json = await r.json();
  if (!r.ok) { console.error('[stripe]', r.status, json.error?.message); throw new HttpError(502, 'Stripe couldn’t complete that request. Please try again.'); }
  return json;
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
  if (biz.stripe_subscription_id && ['active', 'trialing', 'past_due'].includes(biz.subscription_status)) {
    return createPortal(biz); // already subscribed — change plans in the portal
  }
  let customer = biz.stripe_customer_id;
  if (!customer) {
    const c = await stripe('POST', '/customers', { name: biz.name, email: owner.email || undefined, metadata: { business_id: biz.id } });
    customer = c.id;
    q.run('UPDATE businesses SET stripe_customer_id = ? WHERE id = ?', customer, biz.id);
  }
  const session = await stripe('POST', '/checkout/sessions', {
    mode: 'subscription', customer, client_reference_id: biz.id,
    line_items: [{ price, quantity: 1 }],
    subscription_data: { metadata: { business_id: biz.id, plan_id: plan.id } },
    metadata: { business_id: biz.id, plan_id: plan.id },
    success_url: `${config.appUrl}/#app/settings/plan?checkout=success`,
    cancel_url: `${config.appUrl}/#app/settings/plan?checkout=cancelled`,
    allow_promotion_codes: 'true',
  });
  return { url: session.url };
}

export async function createPortal(biz) {
  if (!biz.stripe_customer_id) throw new HttpError(400, 'There’s no billing account yet — choose a paid plan first.');
  const s = await stripe('POST', '/billing_portal/sessions', { customer: biz.stripe_customer_id, return_url: `${config.appUrl}/#app/settings/plan` });
  return { url: s.url };
}

// Verify the Stripe-Signature header (HMAC-SHA256 over "timestamp.payload").
export function verifyWebhook(raw, header) {
  if (!config.stripe.webhookSecret) throw new HttpError(501, 'STRIPE_WEBHOOK_SECRET is not set.');
  const parts = Object.fromEntries(String(header || '').split(',').map(p => p.split('=')).filter(p => p.length === 2).map(([k, v]) => [k, v]));
  const sigs = String(header || '').split(',').filter(p => p.startsWith('v1=')).map(p => p.slice(3));
  const t = Number(parts.t);
  if (!t || !sigs.length) throw new HttpError(400, 'Missing signature');
  if (Math.abs(Date.now() / 1000 - t) > 300) throw new HttpError(400, 'Signature too old');
  const expected = crypto.createHmac('sha256', config.stripe.webhookSecret).update(`${t}.${raw}`).digest('hex');
  const ok = sigs.some(s => s.length === expected.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
  if (!ok) throw new HttpError(400, 'Bad signature');
  return JSON.parse(raw);
}

export async function handleWebhook(event) {
  if (q.one('SELECT id FROM stripe_events WHERE id = ?', event.id)) return 'duplicate';
  q.run('INSERT INTO stripe_events (id, type, received_at) VALUES (?,?,?)', event.id, event.type, now());
  const o = event.data?.object || {};
  switch (event.type) {
    case 'checkout.session.completed': {
      const bizId = o.client_reference_id || o.metadata?.business_id;
      if (bizId && o.subscription) {
        q.run('UPDATE businesses SET stripe_customer_id = COALESCE(stripe_customer_id, ?), stripe_subscription_id = ? WHERE id = ?', o.customer, o.subscription, bizId);
        try { applySubscription(await stripe('GET', `/subscriptions/${o.subscription}`)); } catch (e) { console.error('[stripe] fetch subscription failed', e.message); }
      }
      break;
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
      applySubscription(o);
      break;
    case 'invoice.payment_failed':
      if (o.subscription) q.run("UPDATE businesses SET subscription_status = 'past_due' WHERE stripe_subscription_id = ?", o.subscription);
      break;
    default: break;
  }
  return 'ok';
}

function applySubscription(sub) {
  const biz = q.one('SELECT * FROM businesses WHERE stripe_subscription_id = ? OR id = ? OR stripe_customer_id = ?', sub.id, sub.metadata?.business_id || '', sub.customer || '');
  if (!biz) return;
  const priceId = sub.items?.data?.[0]?.price?.id;
  const plan = planForPrice(priceId);
  const ended = ['canceled', 'incomplete_expired', 'unpaid'].includes(sub.status);
  q.run('UPDATE businesses SET stripe_subscription_id = ?, subscription_status = ?, plan_id = ?, current_period_end = ? WHERE id = ?',
    sub.id, sub.status, ended || !plan ? 'free' : plan.id,
    sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null, biz.id);
}
