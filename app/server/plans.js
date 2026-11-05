// ---------------------------------------------------------------------------
// DaySpear plans — the ONE place pricing and limits are defined.
// The client reads these through GET /api/config, and the server uses them for
// plan limits and Stripe checkout. Prices here are for display only: the amount
// actually charged comes from the Stripe Price referenced by `stripePriceEnv`.
// Provisional example pricing — review before launch.
// ---------------------------------------------------------------------------
export const PLANS = [
  { id: 'free',     name: 'Free',     price: 0,  limit: 10, blurb: 'For a small team getting started.',          cta: 'Start free' },
  { id: 'team',     name: 'Team',     price: 8,  limit: 25, blurb: 'For a growing team, or a second location.',  cta: 'Choose Team', featured: true, stripePriceEnv: 'STRIPE_PRICE_TEAM' },
  { id: 'business', name: 'Business', price: 18, limit: 75, blurb: 'For busier teams across several locations.', cta: 'Choose Business', stripePriceEnv: 'STRIPE_PRICE_BUSINESS' },
];

export const PRICING = {
  currency: '$',
  period: '/month',
  provisional: true,
  contactAbove: 75, // teams larger than the biggest plan are asked to contact us
  graceDays: 14,    // days an owner has to upgrade after acceptances push them over
  included: ['Unlimited locations', 'Schedule, time off & coverage', 'Announcements & team chat', 'Checklists & to-dos', 'Phone access for everyone'],
};

// Optional override without editing code: PLANS_JSON='[{"id":"team","price":9,"limit":30}, ...]'
// (matched by id; only name, price, limit, blurb and cta can change).
if (process.env.PLANS_JSON) {
  try {
    for (const o of JSON.parse(process.env.PLANS_JSON)) {
      const p = PLANS.find(x => x.id === o.id); if (!p) continue;
      for (const k of ['name', 'price', 'limit', 'blurb', 'cta']) if (o[k] !== undefined) p[k] = o[k];
    }
    PRICING.contactAbove = PLANS[PLANS.length - 1].limit;
  } catch (e) { console.error('[plans] PLANS_JSON is not valid JSON — using the defaults.'); }
}

export const planById = id => PLANS.find(p => p.id === id) || PLANS[0];
export const planByName = name => PLANS.find(p => p.name === name) || PLANS[0];
