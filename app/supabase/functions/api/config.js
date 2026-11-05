// Settings for the `api` Edge Function. Secrets are set with `supabase secrets set`
// (or in the Supabase dashboard) and never reach the browser.
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase automatically.
const env = (k, d = '') => (Deno.env.get(k) ?? d).trim();

export const config = {
  supabaseUrl: env('SUPABASE_URL').replace(/\/$/, ''),
  serviceKey: env('SUPABASE_SERVICE_ROLE_KEY'),
  // The public site address (GitHub Pages / your domain). Invite links and Stripe return pages use it.
  appUrl: env('APP_URL', 'http://localhost:5173').replace(/\/$/, ''),
  // Sites allowed to call this function from a browser (comma-separated). Defaults to APP_URL.
  allowedOrigins: env('ALLOWED_ORIGINS', env('APP_URL', 'http://localhost:5173')).split(',').map(s => s.trim().replace(/\/$/, '')).filter(Boolean),
  // Set to "true" only after turning on phone sign-in (Twilio) in Supabase Auth.
  sms: env('SMS_ENABLED') === 'true',
  email: { resendKey: env('RESEND_API_KEY'), from: env('EMAIL_FROM', 'DaySpear <no-reply@example.com>'), contact: env('CONTACT_EMAIL') },
  stripe: {
    secretKey: env('STRIPE_SECRET_KEY'),
    webhookSecret: env('STRIPE_WEBHOOK_SECRET'),
    allowLive: env('ALLOW_LIVE_PAYMENTS') === 'true',
    apiBase: env('STRIPE_API_BASE', 'https://api.stripe.com'), // only changed in automated tests
    prices: { STRIPE_PRICE_TEAM: env('STRIPE_PRICE_TEAM'), STRIPE_PRICE_BUSINESS: env('STRIPE_PRICE_BUSINESS') },
  },
};

// Live Stripe keys are refused unless ALLOW_LIVE_PAYMENTS=true — nothing real is charged by accident.
if (config.stripe.secretKey.startsWith('sk_live_') && !config.stripe.allowLive) {
  console.error('[config] A live Stripe key is set but ALLOW_LIVE_PAYMENTS is not "true" — payments stay off.');
  config.stripe.secretKey = '';
}
export const stripeEnabled = () => Boolean(config.stripe.secretKey);
export const stripeMode = () => (config.stripe.secretKey.startsWith('sk_live_') ? 'live' : config.stripe.secretKey ? 'test' : 'off');
export const emailEnabled = () => Boolean(config.email.resendKey);
