// End-to-end API tests: start a real server on a temporary database and walk through
// sign-up, invites, permissions, privacy, business isolation and billing safeguards.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const PORT = 3200 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dayspear-test-'));
const WHSEC = 'whsec_test_' + crypto.randomBytes(8).toString('hex');
let srv;

before(async () => {
  srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], {
    env: { ...process.env, PORT: String(PORT), APP_URL: BASE, DATABASE_PATH: path.join(dir, 't.db'), EMAIL_PROVIDER: 'console', SMS_PROVIDER: 'none',
      STRIPE_SECRET_KEY: '', STRIPE_WEBHOOK_SECRET: WHSEC, NODE_ENV: 'test', APP_SECRET: 'x'.repeat(40) }, stdio: ['ignore', 'pipe', 'pipe'] });
  srv.stderr.on('data', d => process.stderr.write(d));
  for (let i = 0; i < 50; i++) { try { await fetch(BASE + '/api/health'); return; } catch { await new Promise(r => setTimeout(r, 100)); } }
  throw new Error('server did not start');
});
after(() => { srv.kill(); fs.rmSync(dir, { recursive: true, force: true }); });

// a tiny cookie-keeping client per person
function client() {
  let cookie = '';
  return async (method, url, body, headers = {}) => {
    const r = await fetch(BASE + url, { method, headers: { 'X-DaySpear': '1', ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const j = await r.json().catch(() => ({}));
    return { status: r.status, ...j };
  };
}
const outbox = async () => (await fetch(BASE + '/api/dev/outbox')).json();
const lastCode = async to => { const m = (await outbox()).find(x => x.recipient === to); return m && (m.body.match(/\b(\d{6})\b/) || [])[1]; };
const lastInvite = async to => { const m = (await outbox()).find(x => x.recipient === to && x.body.includes('#invite/')); return m.body.match(/#invite\/([\w-]+)/)[1]; };

async function signup(c, email, biz, invites = []) {
  assert.equal((await c('POST', '/api/signup/start', { name: 'Olivia Owner', email })).status, 200);
  const v = await c('POST', '/api/signup/verify', { email, code: await lastCode(email) });
  assert.ok(v.token);
  const r = await c('POST', '/api/signup/complete', { token: v.token, business: { name: biz, type: 'Café' }, locations: [{ name: 'Main' }, { name: 'Second' }], roles: ['Barista', 'Shift lead'], invites, templates: true });
  assert.equal(r.status, 200, JSON.stringify(r));
}
async function acceptInvite(c, contact, name) {
  const token = await lastInvite(contact);
  const info = await c('GET', '/api/invites/' + token);
  assert.equal(info.status, 200);
  assert.equal((await c('POST', `/api/invites/${token}/start`, { name, contact })).status, 200);
  const r = await c('POST', `/api/invites/${token}/accept`, { contact, code: await lastCode(contact) });
  assert.equal(r.status, 200, JSON.stringify(r));
  return token;
}

const owner = client(), emp = client(), emp2 = client(), mgr = client(), other = client();
let ws;

test('requests without the DaySpear header are refused (CSRF)', async () => {
  const r = await fetch(BASE + '/api/auth/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"identifier":"a@b.co"}' });
  assert.equal(r.status, 403);
});

test('owner signs up; workspace is created with invites sent', async () => {
  await signup(owner, 'owner@cafe.test', 'Test Café', [{ name: 'Erin Employee', contact: 'erin@cafe.test' }]);
  ws = await owner('GET', '/api/workspace');
  assert.equal(ws.doc.settings.business.name, 'Test Café');
  const me = ws.doc.people[ws.doc.me];
  assert.equal(me.access, 'owner');
  const invited = Object.values(ws.doc.people).find(p => p.status === 'invited');
  assert.equal(invited.email, 'erin@cafe.test');
  assert.equal(ws.doc.billing.plan, 'Free');
});

test('sign-in start never reveals whether an account exists', async () => {
  const a = await other('POST', '/api/auth/start', { identifier: 'nobody@nowhere.test' });
  const b = await other('POST', '/api/auth/start', { identifier: 'owner@cafe.test' });
  assert.equal(a.sent, true); assert.equal(b.sent, true);
  assert.equal(await lastCode('nobody@nowhere.test'), undefined);
});

test('wrong codes are rejected and limited', async () => {
  await other('POST', '/api/auth/start', { identifier: 'owner@cafe.test' });
  for (let i = 0; i < 5; i++) assert.equal((await other('POST', '/api/auth/verify', { identifier: 'owner@cafe.test', code: '000000' })).status >= 400, true);
  const r = await other('POST', '/api/auth/verify', { identifier: 'owner@cafe.test', code: await lastCode('owner@cafe.test') });
  assert.equal(r.status, 429); // locked after 5 wrong tries — a new code is needed
});

test('employee accepts the invite and gets a filtered view', async () => {
  await acceptInvite(emp, 'erin@cafe.test', 'Erin E.');
  const v = await emp('GET', '/api/workspace');
  const me = v.doc.people[v.doc.me];
  assert.equal(me.status, 'active'); assert.equal(me.name, 'Erin E.');
  const ownerP = Object.values(v.doc.people).find(p => p.access === 'owner');
  assert.equal(ownerP.email, undefined, 'owner email hidden from employees');
  assert.equal(ownerP.phone, undefined);
  assert.equal(v.doc.billing.hasSubscription, undefined);
});

test('invite links work once', async () => {
  const token = await lastInvite('erin@cafe.test');
  assert.equal((await other('GET', '/api/invites/' + token)).status, 410);
});

test('owner schedules a draft shift; employee cannot see drafts until published', async () => {
  ws = await owner('GET', '/api/workspace');
  const erin = Object.values(ws.doc.people).find(p => p.name === 'Erin E.').id;
  const loc = Object.keys(ws.doc.locs)[0], role = Object.keys(ws.doc.roles)[0];
  const wk = '2030-01-07';
  let r = await owner('POST', '/api/workspace/ops', { ops: [{ c: 'shifts', id: 'stest1', v: { wk, d: 2, emp: erin, s: '09:00', e: '17:00', role, loc, draft: true } }] });
  assert.equal(r.status, 200, JSON.stringify(r));
  let v = await emp('GET', '/api/workspace');
  assert.equal(v.doc.shifts.find(s => s.id === 'stest1'), undefined);
  r = await owner('POST', '/api/workspace/ops', { ops: [{ c: 'shifts', id: 'stest1', v: { wk, d: 2, emp: erin, s: '09:00', e: '17:00', role, loc, draft: false } }, { c: 'published', id: wk, v: { [loc]: { by: 'x' } } }] });
  assert.equal(r.status, 200);
  v = await emp('GET', '/api/workspace');
  assert.ok(v.doc.shifts.find(s => s.id === 'stest1'));
  assert.equal(r.doc.published[wk][loc].by, r.doc.me, 'published "by" is set by the server');
});

test('employee permissions: can request time off and post coverage, cannot edit shifts or others', async () => {
  const v = await emp('GET', '/api/workspace');
  const me = v.doc.me;
  let r = await emp('POST', '/api/workspace/ops', { ops: [{ c: 'shifts', id: 'stest1', v: { ...v.doc.shifts[0], s: '06:00' } }] });
  assert.equal(r.status, 403);
  const ownerId = Object.values(v.doc.people).find(p => p.access === 'owner').id;
  r = await emp('POST', '/api/workspace/ops', { ops: [{ c: 'people', id: ownerId, v: { name: 'Hacked' } }] });
  assert.equal(r.status, 403);
  r = await emp('POST', '/api/workspace/ops', { ops: [{ c: 'people', id: me, v: { access: 'owner' } }] });
  assert.equal(r.status, 403);
  r = await emp('POST', '/api/workspace/ops', { ops: [{ c: 'timeoff', id: 'to1', v: { wk: '2030-01-14', d: 1, reason: 'Trip', status: 'approved' } }] });
  assert.equal(r.status, 200);
  assert.equal(r.doc.timeoff.find(t => t.id === 'to1').status, 'pending', 'employees cannot self-approve');
  r = await emp('POST', '/api/workspace/ops', { ops: [{ c: 'shifts', id: 'stest1', v: { cover: { status: 'needed', from: me, note: 'Sorry' } } }, { c: 'messages', id: 'sh-stest1', append: [{ text: 'Anyone?', from: ownerId }] }] });
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.equal(r.doc.messages['sh-stest1'][0].from, me, 'message author is set by the server');
});

test('owner decides time off; a second decision is refused', async () => {
  let r = await owner('POST', '/api/workspace/ops', { ops: [{ c: 'timeoff', id: 'to1', v: { status: 'approved' } }] });
  assert.equal(r.status, 200);
  const t = r.doc.timeoff.find(x => x.id === 'to1');
  assert.equal(t.status, 'approved'); assert.equal(t.decidedBy, r.doc.me);
  r = await owner('POST', '/api/workspace/ops', { ops: [{ c: 'timeoff', id: 'to1', v: { status: 'declined' } }] });
  assert.equal(r.status, 409);
});

test('phone numbers stay private unless the business allows sharing AND the employee opts in', async () => {
  let v = await emp('GET', '/api/workspace');
  await emp('POST', '/api/workspace/ops', { ops: [{ c: 'people', id: v.doc.me, v: { phone: '6125550111', sharePhone: true } }] });
  // a second employee
  ws = await owner('GET', '/api/workspace');
  const loc = Object.keys(ws.doc.locs)[0];
  let r = await owner('POST', '/api/workspace/ops', { ops: [{ c: 'people', id: 'pnew2', v: { name: 'Sam Second', email: 'sam@cafe.test', locs: [loc] } }] });
  assert.equal(r.status, 200, JSON.stringify(r));
  await acceptInvite(emp2, 'sam@cafe.test', 'Sam Second');
  const erinId = v.doc.me;
  let s = await emp2('GET', '/api/workspace');
  assert.equal(s.doc.people[erinId].phone, undefined, 'hidden while business sharing is off');
  const settings = structuredClone(ws.doc.settings); settings.messages.phoneSharing = true;
  assert.equal((await owner('POST', '/api/workspace/ops', { ops: [{ c: 'settings', v: settings }] })).status, 200);
  s = await emp2('GET', '/api/workspace');
  assert.equal(s.doc.people[erinId].phone, '6125550111');
  await emp('POST', '/api/workspace/ops', { ops: [{ c: 'people', id: erinId, v: { sharePhone: false } }] });
  s = await emp2('GET', '/api/workspace');
  assert.equal(s.doc.people[erinId].phone, undefined, 'hidden once the employee opts out');
});

test('a manager only manages their own locations', async () => {
  ws = await owner('GET', '/api/workspace');
  const [l1, l2] = Object.keys(ws.doc.locs);
  let r = await owner('POST', '/api/workspace/ops', { ops: [{ c: 'people', id: 'pmgr', v: { name: 'Max Manager', email: 'max@cafe.test', locs: [l2], access: 'manager' } }] });
  assert.equal(r.status, 200, JSON.stringify(r));
  await acceptInvite(mgr, 'max@cafe.test', 'Max Manager');
  const role = Object.keys(ws.doc.roles)[0];
  r = await mgr('POST', '/api/workspace/ops', { ops: [{ c: 'shifts', id: 'sm1', v: { wk: '2030-01-07', d: 1, emp: null, s: '08:00', e: '12:00', role, loc: l1, draft: true } }] });
  assert.equal(r.status, 403);
  r = await mgr('POST', '/api/workspace/ops', { ops: [{ c: 'shifts', id: 'sm1', v: { wk: '2030-01-07', d: 1, emp: null, s: '08:00', e: '12:00', role, loc: l2, draft: true } }] });
  assert.equal(r.status, 200);
  r = await mgr('POST', '/api/workspace/ops', { ops: [{ c: 'settings', v: ws.doc.settings }] });
  assert.equal(r.status, 403);
  r = await mgr('POST', '/api/billing/checkout', { planId: 'team' });
  assert.equal(r.status, 403, 'only the owner can pay');
});

test('businesses are isolated from each other', async () => {
  const o2 = client();
  await signup(o2, 'owner2@other.test', 'Other Shop');
  const a = await o2('GET', '/api/workspace');
  assert.equal(a.doc.settings.business.name, 'Other Shop');
  assert.ok(!JSON.stringify(a.doc).includes('Test Café'));
  const r = await o2('POST', '/api/workspace/ops', { ops: [{ c: 'shifts', id: 'stest1', v: null }] });
  assert.equal(r.status, 200); // only touches its own (empty) workspace
  const v = await owner('GET', '/api/workspace');
  assert.ok(v.doc.shifts.find(s => s.id === 'stest1'), 'the other business’s shift is untouched');
});

test('plan limit: inviting past the Free plan needs an upgrade', async () => {
  ws = await owner('GET', '/api/workspace');
  const loc = Object.keys(ws.doc.locs)[0];
  const count = Object.values(ws.doc.people).filter(p => p.status !== 'archived').length;
  const ops = []; for (let i = 0; i < 10 - count; i++) ops.push({ c: 'people', id: 'pfill' + i, v: { name: 'Fill ' + i, email: `fill${i}@cafe.test`, locs: [loc] } });
  assert.equal((await owner('POST', '/api/workspace/ops', { ops })).status, 200);
  const r = await owner('POST', '/api/workspace/ops', { ops: [{ c: 'people', id: 'pover', v: { name: 'One Too Many', email: 'over@cafe.test', locs: [loc] } }] });
  assert.equal(r.status, 402); assert.equal(r.code, 'upgrade_required'); assert.equal(r.next, 'team');
});

test('billing: checkout is refused until Stripe keys are set', async () => {
  const r = await owner('POST', '/api/billing/checkout', { planId: 'team' });
  assert.equal(r.status, 501); assert.equal(r.code, 'stripe_not_configured');
});

test('Stripe webhooks: bad signatures are rejected, good ones change the plan once', async () => {
  const bizId = (await owner('GET', '/api/session')).current.businessId;
  const event = { id: 'evt_' + crypto.randomBytes(6).toString('hex'), type: 'customer.subscription.updated',
    data: { object: { id: 'sub_123', customer: 'cus_123', status: 'active', metadata: { business_id: bizId }, current_period_end: 1900000000, items: { data: [{ price: { id: 'price_unknown' } }] } } } };
  const raw = JSON.stringify(event); const t = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', WHSEC).update(`${t}.${raw}`).digest('hex');
  let r = await fetch(BASE + '/api/stripe/webhook', { method: 'POST', headers: { 'Stripe-Signature': `t=${t},v1=${'0'.repeat(64)}` }, body: raw });
  assert.equal(r.status, 400);
  r = await fetch(BASE + '/api/stripe/webhook', { method: 'POST', headers: { 'Stripe-Signature': `t=${t},v1=${sig}` }, body: raw });
  assert.equal(r.status, 200);
  const again = await (await fetch(BASE + '/api/stripe/webhook', { method: 'POST', headers: { 'Stripe-Signature': `t=${t},v1=${sig}` }, body: raw })).json();
  assert.equal(again.received, 'duplicate');
  const v = await owner('GET', '/api/workspace');
  assert.equal(v.doc.billing.hasSubscription, true);
  assert.equal(v.doc.billing.plan, 'Free', 'an unknown price never upgrades the plan');
});

test('archived people lose access', async () => {
  ws = await owner('GET', '/api/workspace');
  const sam = Object.values(ws.doc.people).find(p => p.name === 'Sam Second').id;
  assert.equal((await owner('POST', '/api/workspace/ops', { ops: [{ c: 'people', id: sam, v: { status: 'archived' } }] })).status, 200);
  assert.equal((await emp2('GET', '/api/workspace')).status, 403);
});

test('sign out ends the session', async () => {
  await emp('POST', '/api/auth/logout');
  assert.equal((await emp('GET', '/api/workspace')).status, 401);
});
