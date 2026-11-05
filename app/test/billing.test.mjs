// Checks the Stripe requests DaySpear makes, against a fake Stripe server (no network, no real keys).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 3800 + Math.floor(Math.random() * 300), BASE = `http://127.0.0.1:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dayspear-bill-'));
const seen = []; let fake, srv, fakePort;

before(async () => {
  fake = http.createServer((req, res) => {
    let body = ''; req.on('data', c => body += c); req.on('end', () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: new URLSearchParams(body) });
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/v1/customers') return res.end(JSON.stringify({ id: 'cus_fake' }));
      if (req.url === '/v1/checkout/sessions') return res.end(JSON.stringify({ id: 'cs_fake', url: 'https://checkout.stripe.test/c/cs_fake' }));
      if (req.url === '/v1/billing_portal/sessions') return res.end(JSON.stringify({ url: 'https://billing.stripe.test/p/1' }));
      res.statusCode = 404; res.end('{}');
    });
  });
  await new Promise(r => fake.listen(0, r)); fakePort = fake.address().port;
  srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], { env: { ...process.env, PORT: String(PORT), APP_URL: BASE,
    DATABASE_PATH: path.join(dir, 'b.db'), EMAIL_PROVIDER: 'console', STRIPE_SECRET_KEY: 'sk_test_fake', STRIPE_WEBHOOK_SECRET: 'whsec_x',
    STRIPE_PRICE_TEAM: 'price_team_test', STRIPE_PRICE_BUSINESS: 'price_biz_test', STRIPE_API_BASE: `http://127.0.0.1:${fakePort}`, NODE_ENV: 'test', APP_SECRET: 'y'.repeat(40) }, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) { try { await fetch(BASE + '/api/health'); return; } catch { await new Promise(r => setTimeout(r, 100)); } }
});
after(() => { srv.kill(); fake.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('a live key is refused unless ALLOW_LIVE_PAYMENTS=true', async () => {
  const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', "const c=await import('./server/config.js'); console.log(JSON.stringify(c.checkConfig({warn(){}})), c.stripeMode())"],
    { env: { ...process.env, STRIPE_SECRET_KEY: 'sk_live_abc', ALLOW_LIVE_PAYMENTS: 'false', DATABASE_PATH: path.join(dir, 'x.db') } });
  let out = ''; p.stdout.on('data', d => out += d); await new Promise(r => p.on('close', r));
  assert.match(out, /ALLOW_LIVE_PAYMENTS/); assert.match(out, /off\s*$/);
});

test('owner checkout creates a Stripe customer and a subscription Checkout Session', async () => {
  let cookie = '';
  const call = async (m, u, b) => { const r = await fetch(BASE + u, { method: m, headers: { 'X-DaySpear': '1', 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: b ? JSON.stringify(b) : undefined }); const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]; return { status: r.status, ...(await r.json()) }; };
  const code = async to => (await (await fetch(BASE + '/api/dev/outbox')).json()).find(x => x.recipient === to).body.match(/\b(\d{6})\b/)[1];
  await call('POST', '/api/signup/start', { name: 'Pat Payer', email: 'pat@shop.test' });
  const { token } = await call('POST', '/api/signup/verify', { email: 'pat@shop.test', code: await code('pat@shop.test') });
  assert.equal((await call('POST', '/api/signup/complete', { token, business: { name: 'Pay Shop' }, locations: [{ name: 'One' }], roles: ['Clerk'] })).status, 200);
  const r = await call('POST', '/api/billing/checkout', { planId: 'team' });
  assert.equal(r.url, 'https://checkout.stripe.test/c/cs_fake');
  const cs = seen.find(s => s.url === '/v1/checkout/sessions');
  assert.equal(cs.auth, 'Bearer sk_test_fake');
  assert.equal(cs.body.get('mode'), 'subscription');
  assert.equal(cs.body.get('line_items[0][price]'), 'price_team_test');
  assert.equal(cs.body.get('customer'), 'cus_fake');
  assert.ok(cs.body.get('client_reference_id'));
  assert.match(cs.body.get('success_url'), /#app\/settings\/plan\?checkout=success$/);
  const p = await call('POST', '/api/billing/portal');
  assert.equal(p.url, 'https://billing.stripe.test/p/1');
});
