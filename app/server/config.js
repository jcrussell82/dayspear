// Loads configuration from environment variables (and an optional .env file).
// Secrets live ONLY here on the server — never in client code.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Minimal .env loader (KEY=value per line, # comments). Real env vars win.
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}

const env = (k, d = '') => (process.env[k] ?? d).trim();

export const config = {
  root: ROOT,
  port: Number(env('PORT', '3000')),
  appUrl: env('APP_URL', 'http://localhost:3000').replace(/\/$/, ''),
  nodeEnv: env('NODE_ENV', 'development'),
  dbPath: env('DATABASE_PATH', path.join(ROOT, 'data', 'dayspear.db')),
  // Used to hash one-time codes and tokens. MUST be a long random value in production.
  secret: env('APP_SECRET', ''),

  contactEmail: env('CONTACT_EMAIL'), // where the homepage contact form is delivered
  email: {
    provider: env('EMAIL_PROVIDER', 'console'), // console | resend | postmark
    from: env('EMAIL_FROM', 'DaySpear <no-reply@example.com>'),
    resendKey: env('RESEND_API_KEY'),
    postmarkToken: env('POSTMARK_SERVER_TOKEN'),
  },
  sms: {
    provider: env('SMS_PROVIDER', 'none'), // none | console | twilio
    twilioSid: env('TWILIO_ACCOUNT_SID'),
    twilioToken: env('TWILIO_AUTH_TOKEN'),
    twilioFrom: env('TWILIO_FROM_NUMBER'),
  },
  stripe: {
    secretKey: env('STRIPE_SECRET_KEY'),
    apiBase: env('STRIPE_API_BASE', 'https://api.stripe.com'), // only changed in automated tests
    webhookSecret: env('STRIPE_WEBHOOK_SECRET'),
    allowLive: env('ALLOW_LIVE_PAYMENTS') === 'true',
    prices: { STRIPE_PRICE_TEAM: env('STRIPE_PRICE_TEAM'), STRIPE_PRICE_BUSINESS: env('STRIPE_PRICE_BUSINESS') },
  },
};

config.isProd = config.nodeEnv === 'production';
config.secureCookies = config.appUrl.startsWith('https://');

export function checkConfig(log = console) {
  const problems = [];
  if (!config.secret || config.secret.length < 32) {
    if (config.isProd) problems.push('APP_SECRET must be set to a random value of at least 32 characters.');
    else { config.secret = 'dev-only-secret-change-me-dev-only-secret'; log.warn('[config] APP_SECRET not set — using an insecure development value.'); }
  }
  if (config.isProd && config.email.provider === 'console') problems.push('EMAIL_PROVIDER is "console" in production — invites and sign-in codes would not be delivered.');
  const sk = config.stripe.secretKey;
  if (sk && sk.startsWith('sk_live_') && !config.stripe.allowLive) {
    problems.push('A live Stripe key is set but ALLOW_LIVE_PAYMENTS is not "true". Live charges stay disabled until you approve them.');
    config.stripe.secretKey = ''; // refuse to use it
  }
  return problems;
}

export const stripeEnabled = () => Boolean(config.stripe.secretKey);
export const stripeMode = () => (config.stripe.secretKey.startsWith('sk_live_') ? 'live' : config.stripe.secretKey ? 'test' : 'off');
export const smsEnabled = () => config.sms.provider === 'twilio' ? Boolean(config.sms.twilioSid && config.sms.twilioToken && config.sms.twilioFrom) : config.sms.provider === 'console';
