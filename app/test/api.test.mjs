// End-to-end tests against a running Supabase project (or the local stand-in in test/stack):
// sign-up, invites, permissions, privacy, business isolation, plan limits and billing safeguards.
//
//   test/stack/stack.sh start && npm test          (local stand-in, uses its fake email + Stripe)
//
// Needs: SUPABASE_URL, SUPABASE_ANON_KEY, plus MAIL_URL and STRIPE_LOG_URL to read captured
// emails / Stripe calls. Defaults point at the local stand-in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';

const STACK = '/tmp/dayspear-stack/env.json';
const local = fs.existsSync(STACK) ? JSON.parse(fs.readFileSync(STACK, 'utf8')) : {};
const URL_ = process.env.SUPABASE_URL || local.url;
const ANON = process.env.SUPABASE_ANON_KEY || local.anon;
const SERVICE = local.service;
const MAIL = process.env.MAIL_URL || (URL_ + '/_mail');
const STRIPE_LOG = process.env.STRIPE_LOG_URL || (URL_ + '/_stripe');
const WHSEC = process.env.STRIPE_WEBHOOK_SECRET || 'whsec_test_local';
const skip = !URL_ || !ANON ? 'no Supabase stack running (test/stack/stack.sh start)' : false;
const run = Math.random().toString(36).slice(2, 7); // unique emails per run
const em = n => `${n}.${run}@dayspear.test`;

const json = async r => { const t = await r.text(); try { return t ? JSON.parse(t) : {}; } catch { return { raw: t }; } };
async function lastCode(to) {
  for (let i = 0; i < 30; i++) {
    const m = (await (await fetch(MAIL)).json()).find(x => x.to.includes(to));
    if (m) { const c = m.body.match(/\b(\d{6,10})\b/); if (c) return c[1]; }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('no code for ' + to);
}
async function clearMailFor() { /* codes are matched by recipient; newest first */ }

// one person in a browser: a Supabase Auth session + calls to the api function
function person() {
  let token = null; const self = {};
  self.otp = (email, create = true, data) => fetch(URL_ + '/auth/v1/otp', { method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, create_user: create, data }) });
  self.signIn = async (email, create = true, data) => {
    const r = await self.otp(email, create, data); assert.equal(r.status, 200, JSON.stringify(await json(r)));
    const code = await lastCode(email);
    const v = await fetch(URL_ + '/auth/v1/verify', { method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, type: 'email', token: code }) });
    const s = await json(v); assert.equal(v.status, 200, JSON.stringify(s)); token = s.access_token; return s;
  };
  self.api = async (method, path, body, extra = {}) => {
    const r = await fetch(URL_ + '/functions/v1/api' + path, { method, headers: { apikey: ANON, Authorization: `Bearer ${token || ANON}`, ...(body ? { 'Content-Type': 'application/json' } : {}), ...extra }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, ...(await json(r)) };
  };
  self.token = () => token;
  self.forget = () => { token = null; };
  return self;
}
async function signup(p, email, biz, invites = []) {
  await p.signIn(email, true, { name: 'Olivia Owner' });
  const r = await p.api('POST', '/signup/complete', { name: 'Olivia Owner', business: { name: biz, type: 'Café' }, locations: [{ name: 'Main' }, { name: 'Second' }], roles: ['Barista', 'Shift lead'], invites, templates: true });
  assert.equal(r.status, 200, JSON.stringify(r));
  return r;
}
async function acceptInvite(p, link, email, name) {
  const token = link.split('#invite/')[1];
  const info = await p.api('GET', '/invites/' + token);
  assert.equal(info.status, 200, JSON.stringify(info));
  await p.signIn(email, true);
  const r = await p.api('POST', `/invites/${token}/accept`, { name });
  assert.equal(r.status, 200, JSON.stringify(r));
  return token;
}

const owner = person(), emp = person(), emp2 = person(), mgr = person(), other = person();
let ws, erinLink;

test('the database is locked to browsers (public key and signed-in users)', { skip }, async () => {
  for (const table of ['workspaces', 'businesses', 'memberships', 'invites']) {
    const r = await fetch(`${URL_}/rest/v1/${table}?select=*`, { headers: { apikey: ANON, Authorization: `Bearer ${ANON}` } });
    assert.ok([401, 403].includes(r.status), `${table} readable with the public key: ${r.status}`);
  }
  const rpc = await fetch(`${URL_}/rest/v1/rpc/create_business`, { method: 'POST', headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json' }, body: '{}' });
  assert.ok(rpc.status >= 400);
});

test('owner signs up; workspace is created and invite links come back when email isn’t set up', { skip }, async () => {
  const r = await signup(owner, em('owner'), 'Test Café', [{ name: 'Erin Employee', contact: em('erin') }]);
  assert.equal(r.shareLinks.length, 1); erinLink = r.shareLinks[0].link;
  assert.match(erinLink, /#invite\/[\w-]{20,}$/);
  ws = await owner.api('GET', '/workspace');
  assert.equal(ws.doc.settings.business.name, 'Test Café');
  assert.equal(ws.doc.people[ws.doc.me].access, 'owner');
  assert.equal(ws.doc.billing.plan, 'Free');
  const asUser = await fetch(`${URL_}/rest/v1/workspaces?select=doc`, { headers: { apikey: ANON, Authorization: 'Bearer ' + owner.token() } });
  assert.ok([401, 403].includes(asUser.status), 'signed-in users can’t read tables directly either');
  const again = await owner.api('POST', '/signup/complete', { name: 'X', business: { name: 'Dup' }, locations: [{ name: 'A' }], roles: ['R'] });
  assert.equal(again.status, 409, 'one sign-up per account');
});

test('the signed-in user list and data need a real session', { skip }, async () => {
  assert.equal((await other.api('GET', '/workspace')).status, 401);
  const fake = await other.api('GET', '/workspace', null, { Authorization: 'Bearer ' + SERVICE });
  assert.equal(fake.status, 401, 'a non-user token is not a session');
});

test('sign-in for an unknown email does not create an account', { skip }, async () => {
  const r = await other.otp(em('nobody'), false);
  assert.notEqual(r.status, 200);
  // the browser shows the same "check your email" screen either way (see realAuth in the client)
});

test('employee accepts the invite and gets a filtered view', { skip }, async () => {
  await acceptInvite(emp, erinLink, em('erin'), 'Erin E.');
  const v = await emp.api('GET', '/workspace');
  const me = v.doc.people[v.doc.me];
  assert.equal(me.status, 'active'); assert.equal(me.name, 'Erin E.'); assert.equal(me.verified.email, true);
  const ownerP = Object.values(v.doc.people).find(p => p.access === 'owner');
  assert.equal(ownerP.email, undefined, 'owner email hidden from employees');
  assert.equal(v.doc.billing.hasSubscription, undefined);
});

test('invite links work once', { skip }, async () => {
  assert.equal((await other.api('GET', '/invites/' + erinLink.split('#invite/')[1])).status, 410);
  assert.equal((await other.api('GET', '/invites/not-a-real-token-at-all-xxxxxx')).status, 410);
});

test('owner schedules a draft shift; employee cannot see drafts until published', { skip }, async () => {
  ws = await owner.api('GET', '/workspace');
  const erin = Object.values(ws.doc.people).find(p => p.name === 'Erin E.').id;
  const loc = Object.keys(ws.doc.locs)[0], role = Object.keys(ws.doc.roles)[0], wk = '2030-01-07';
  let r = await owner.api('POST', '/workspace/ops', { ops: [{ c: 'shifts', id: 'stest1', v: { wk, d: 2, emp: erin, s: '09:00', e: '17:00', role, loc, draft: true } }] });
  assert.equal(r.status, 200, JSON.stringify(r));
  let v = await emp.api('GET', '/workspace');
  assert.equal(v.doc.shifts.find(s => s.id === 'stest1'), undefined);
  r = await owner.api('POST', '/workspace/ops', { ops: [{ c: 'shifts', id: 'stest1', v: { wk, d: 2, emp: erin, s: '09:00', e: '17:00', role, loc, draft: false } }, { c: 'published', id: wk, v: { [loc]: { by: 'x' } } }] });
  assert.equal(r.status, 200);
  v = await emp.api('GET', '/workspace');
  assert.ok(v.doc.shifts.find(s => s.id === 'stest1'));
  assert.equal(r.doc.published[wk][loc].by, r.doc.me, 'published "by" is set by the server');
  const since = await emp.api('GET', '/workspace?since=' + v.version);
  assert.equal(since.unchanged, true);
});

test('employee permissions: can request time off and post coverage, cannot edit shifts or others', { skip }, async () => {
  const v = await emp.api('GET', '/workspace');
  const me = v.doc.me, ownerId = Object.values(v.doc.people).find(p => p.access === 'owner').id;
  assert.equal((await emp.api('POST', '/workspace/ops', { ops: [{ c: 'shifts', id: 'stest1', v: { ...v.doc.shifts[0], s: '06:00' } }] })).status, 403);
  assert.equal((await emp.api('POST', '/workspace/ops', { ops: [{ c: 'people', id: ownerId, v: { name: 'Hacked' } }] })).status, 403);
  assert.equal((await emp.api('POST', '/workspace/ops', { ops: [{ c: 'people', id: me, v: { access: 'owner' } }] })).status, 403);
  let r = await emp.api('POST', '/workspace/ops', { ops: [{ c: 'timeoff', id: 'to1', v: { wk: '2030-01-14', d: 1, reason: 'Trip', status: 'approved' } }] });
  assert.equal(r.status, 200);
  assert.equal(r.doc.timeoff.find(t => t.id === 'to1').status, 'pending', 'employees cannot self-approve');
  r = await emp.api('POST', '/workspace/ops', { ops: [{ c: 'shifts', id: 'stest1', v: { cover: { status: 'needed', from: me, note: 'Sorry' } } }, { c: 'messages', id: 'sh-stest1', append: [{ text: 'Anyone?', from: ownerId }] }] });
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.equal(r.doc.messages['sh-stest1'][0].from, me, 'message author is set by the server');
});

test('owner decides time off; a second decision is refused', { skip }, async () => {
  let r = await owner.api('POST', '/workspace/ops', { ops: [{ c: 'timeoff', id: 'to1', v: { status: 'approved' } }] });
  assert.equal(r.status, 200);
  assert.equal(r.doc.timeoff.find(x => x.id === 'to1').decidedBy, r.doc.me);
  r = await owner.api('POST', '/workspace/ops', { ops: [{ c: 'timeoff', id: 'to1', v: { status: 'declined' } }] });
  assert.equal(r.status, 409);
});

test('phone numbers stay private unless the business allows sharing AND the employee opts in', { skip }, async () => {
  const v = await emp.api('GET', '/workspace'); const erinId = v.doc.me;
  assert.equal((await emp.api('POST', '/workspace/ops', { ops: [{ c: 'people', id: erinId, v: { phone: '6125550111', sharePhone: true } }] })).status, 200);
  ws = await owner.api('GET', '/workspace');
  const loc = Object.keys(ws.doc.locs)[0];
  const r = await owner.api('POST', '/workspace/ops', { ops: [{ c: 'people', id: 'pnew2', v: { name: 'Sam Second', email: em('sam'), locs: [loc] } }] });
  assert.equal(r.status, 200, JSON.stringify(r));
  await acceptInvite(emp2, r.shareLinks[0].link, em('sam'), 'Sam Second');
  let s = await emp2.api('GET', '/workspace');
  assert.equal(s.doc.people[erinId].phone, undefined, 'hidden while business sharing is off');
  const settings = structuredClone(ws.doc.settings); settings.messages.phoneSharing = true;
  assert.equal((await owner.api('POST', '/workspace/ops', { ops: [{ c: 'settings', v: settings }] })).status, 200);
  s = await emp2.api('GET', '/workspace');
  assert.equal(s.doc.people[erinId].phone, '6125550111');
  await emp.api('POST', '/workspace/ops', { ops: [{ c: 'people', id: erinId, v: { sharePhone: false } }] });
  s = await emp2.api('GET', '/workspace');
  assert.equal(s.doc.people[erinId].phone, undefined, 'hidden once the employee opts out');
});

test('two-way trades: ask, decline, accept, manager approves; auto-approve swaps at once', { skip }, async () => {
  ws = await owner.api('GET', '/workspace');
  const P = Object.values(ws.doc.people), erin = P.find(p => p.name === 'Erin E.').id, sam = P.find(p => p.name === 'Sam Second').id;
  const loc = Object.keys(ws.doc.locs)[0], role = Object.keys(ws.doc.roles)[0], wk = '2030-02-04';
  const sh = (id, d, emp) => ({ c: 'shifts', id, v: { wk, d, emp, s: '09:00', e: '17:00', role, loc, draft: false } });
  let r = await owner.api('POST', '/workspace/ops', { ops: [sh('tA', 1, erin), sh('tB', 3, sam), sh('tC', 2, erin), sh('tD', 4, sam), sh('tDraft', 5, sam), { c: 'published', id: wk, v: { [loc]: { by: 'x' } } }] });
  assert.equal(r.status, 200, JSON.stringify(r));
  await owner.api('POST', '/workspace/ops', { ops: [{ ...sh('tDraft', 5, sam), v: { ...sh('tDraft', 5, sam).v, draft: true, pub: { emp: sam, d: 5, s: '09:00', e: '17:00', role, loc } } }] });
  const ask = (id, trade) => emp.api('POST', '/workspace/ops', { ops: [{ c: 'shifts', id, v: { cover: { status: 'needed', from: erin, trade, note: 'Swap?' } } }] });
  assert.equal((await ask('tA', 'tDraft')).status, 409, 'a shift being edited can’t be traded');
  assert.equal((await ask('tA', 'tC')).status, 409, 'can’t trade with yourself');
  r = await ask('tA', 'tB'); assert.equal(r.status, 200, JSON.stringify(r));
  let c = r.doc.shifts.find(s => s.id === 'tA').cover;
  assert.equal(c.target, sam, 'the teammate is taken from their shift, not the request'); assert.equal(c.trade, 'tB');
  // Sam can't turn a trade into a one-way pickup; declining clears it
  r = await emp2.api('POST', '/workspace/ops', { ops: [{ c: 'shifts', id: 'tA', v: { cover: { status: 'offered', offerBy: erin } } }] });
  assert.equal(r.status, 403);
  r = await emp2.api('POST', '/workspace/ops', { ops: [{ c: 'shifts', id: 'tA', v: {} }] });
  assert.equal(r.status, 200); assert.equal(r.doc.shifts.find(s => s.id === 'tA').cover, undefined);
  // ask again, Sam accepts, owner approves the swap
  await ask('tA', 'tB');
  r = await emp2.api('POST', '/workspace/ops', { ops: [{ c: 'shifts', id: 'tA', v: { cover: { status: 'offered', offerBy: sam } } }] });
  assert.equal(r.status, 200, JSON.stringify(r));
  c = (await owner.api('GET', '/workspace')).doc.shifts.find(s => s.id === 'tA').cover;
  assert.equal(c.status, 'offered'); assert.equal(c.offerBy, sam); assert.equal(c.trade, 'tB');
  r = await owner.api('POST', '/workspace/ops', { ops: [sh('tA', 1, sam), sh('tB', 3, erin), { c: 'coverLog', id: 'cl1', v: { id: 'cl1', shiftId: 'tA', from: erin, to: sam, trade: 'tB' } }] });
  assert.equal(r.status, 200);
  assert.equal(r.doc.shifts.find(s => s.id === 'tA').emp, sam); assert.equal(r.doc.shifts.find(s => s.id === 'tB').emp, erin);
  // with auto-approve on, accepting swaps both shifts straight away (Erin now has tB, Sam has tD)
  const settings = r.doc.settings; settings.requests.autoApprove = true;
  assert.equal((await owner.api('POST', '/workspace/ops', { ops: [{ c: 'settings', v: settings }] })).status, 200);
  assert.equal((await ask('tB', 'tD')).status, 200);
  r = await emp2.api('POST', '/workspace/ops', { ops: [{ c: 'shifts', id: 'tB', v: { cover: { status: 'offered', offerBy: sam } } }] });
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.equal(r.doc.shifts.find(s => s.id === 'tB').emp, sam); assert.equal(r.doc.shifts.find(s => s.id === 'tD').emp, erin);
  assert.equal(r.doc.shifts.find(s => s.id === 'tB').cover, undefined);
  settings.requests.autoApprove = false; await owner.api('POST', '/workspace/ops', { ops: [{ c: 'settings', v: settings }] });
  // Erin can withdraw her own request
  await emp.api('POST', '/workspace/ops', { ops: [{ c: 'shifts', id: 'tC', v: { cover: { status: 'needed', from: erin, note: '' } } }] });
  r = await emp.api('POST', '/workspace/ops', { ops: [{ c: 'shifts', id: 'tC', v: {} }] });
  assert.equal(r.status, 200); assert.equal(r.doc.shifts.find(s => s.id === 'tC').cover, undefined);
});

test('changing your sign-in email: the new one works only after its code is confirmed', { skip }, async () => {
  const newEmail = em('erin-new');
  const v = await emp.api('GET', '/workspace');
  assert.equal((await emp.api('POST', '/workspace/ops', { ops: [{ c: 'people', id: v.doc.me, v: { email: newEmail } }] })).status, 200);
  let me = (await emp.api('GET', '/workspace')).doc.people[v.doc.me];
  assert.equal(me.verified.email, false, 'not verified until confirmed');
  const put = await fetch(URL_ + '/auth/v1/user', { method: 'PUT', headers: { apikey: ANON, Authorization: 'Bearer ' + emp.token(), 'Content-Type': 'application/json' }, body: JSON.stringify({ email: newEmail }) });
  assert.equal(put.status, 200, await put.text());
  const code = await lastCode(newEmail);
  const ver = await fetch(URL_ + '/auth/v1/verify', { method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: newEmail, type: 'email_change', token: code }) });
  assert.equal(ver.status, 200, await ver.text());
  me = (await emp.api('GET', '/workspace')).doc.people[v.doc.me];
  assert.equal(me.verified.email, true);
  const again = person(); await again.signIn(newEmail, false);
  assert.equal((await again.api('GET', '/workspace')).doc.me, v.doc.me, 'signs in to the same person with the new email');
});

test('a manager only manages their own locations', { skip }, async () => {
  ws = await owner.api('GET', '/workspace');
  const [l1, l2] = Object.keys(ws.doc.locs);
  let r = await owner.api('POST', '/workspace/ops', { ops: [{ c: 'people', id: 'pmgr', v: { name: 'Max Manager', email: em('max'), locs: [l2], access: 'manager' } }] });
  assert.equal(r.status, 200, JSON.stringify(r));
  await acceptInvite(mgr, r.shareLinks[0].link, em('max'), 'Max Manager');
  const role = Object.keys(ws.doc.roles)[0];
  assert.equal((await mgr.api('POST', '/workspace/ops', { ops: [{ c: 'shifts', id: 'sm1', v: { wk: '2030-01-07', d: 1, emp: null, s: '08:00', e: '12:00', role, loc: l1, draft: true } }] })).status, 403);
  assert.equal((await mgr.api('POST', '/workspace/ops', { ops: [{ c: 'shifts', id: 'sm1', v: { wk: '2030-01-07', d: 1, emp: null, s: '08:00', e: '12:00', role, loc: l2, draft: true } }] })).status, 200);
  assert.equal((await mgr.api('POST', '/workspace/ops', { ops: [{ c: 'settings', v: ws.doc.settings }] })).status, 403);
  assert.equal((await mgr.api('POST', '/billing/checkout', { planId: 'team' })).status, 403, 'only the owner can pay');
});

test('businesses are isolated from each other', { skip }, async () => {
  const o2 = person();
  await signup(o2, em('owner2'), 'Other Shop');
  const a = await o2.api('GET', '/workspace');
  assert.equal(a.doc.settings.business.name, 'Other Shop');
  assert.ok(!JSON.stringify(a.doc).includes('Test Café'));
  const bizA = (await owner.api('GET', '/session')).businesses[0].businessId;
  const r = await o2.api('GET', '/workspace', null, { 'X-Business': bizA });
  assert.equal(r.doc.settings.business.name, 'Other Shop', 'asking for another business by id is ignored');
  await o2.api('POST', '/workspace/ops', { ops: [{ c: 'shifts', id: 'stest1', v: null }] });
  assert.ok((await owner.api('GET', '/workspace')).doc.shifts.find(s => s.id === 'stest1'), 'the other business’s shift is untouched');
});

test('plan limit: inviting past the Free plan needs an upgrade', { skip }, async () => {
  ws = await owner.api('GET', '/workspace');
  const loc = Object.keys(ws.doc.locs)[0];
  const count = Object.values(ws.doc.people).filter(p => p.status !== 'archived').length;
  const ops = []; for (let i = 0; i < 10 - count; i++) ops.push({ c: 'people', id: 'pfill' + i, v: { name: 'Fill ' + i, email: em('fill' + i), locs: [loc] } });
  assert.equal((await owner.api('POST', '/workspace/ops', { ops })).status, 200);
  const r = await owner.api('POST', '/workspace/ops', { ops: [{ c: 'people', id: 'pover', v: { name: 'One Too Many', email: em('over'), locs: [loc] } }] });
  assert.equal(r.status, 402); assert.equal(r.code, 'upgrade_required'); assert.equal(r.next, 'team');
});

test('billing: owner checkout creates a Stripe subscription session (test mode)', { skip }, async () => {
  const r = await owner.api('POST', '/billing/checkout', { planId: 'team' });
  assert.equal(r.url, 'https://checkout.stripe.test/c/cs_fake', JSON.stringify(r));
  const calls = await (await fetch(STRIPE_LOG)).json();
  const cs = calls.find(s => s.url === '/v1/checkout/sessions');
  assert.equal(cs.auth, 'Bearer sk_test_fake');
  assert.equal(cs.body.mode, 'subscription');
  assert.equal(cs.body['line_items[0][price]'], 'price_team_test');
  assert.match(cs.body.success_url, /#app\/settings\/plan\?checkout=success$/);
  assert.equal((await owner.api('POST', '/billing/portal')).url, 'https://billing.stripe.test/p/1');
});

test('billing: a customer saved in another Stripe mode is replaced, not reused', { skip }, async () => {
  const o4 = person();
  await signup(o4, em('owner4'), 'Mode Switch Café');
  const bizId = (await o4.api('GET', '/session')).businesses[0].businessId;
  await fetch(`${URL_}/rest/v1/businesses?id=eq.${bizId}`, { method: 'PATCH', headers: { apikey: SERVICE, Authorization: 'Bearer ' + SERVICE, 'Content-Type': 'application/json' }, body: JSON.stringify({ stripe_customer_id: 'cus_from_test_mode' }) });
  assert.equal((await o4.api('POST', '/billing/portal')).status, 400, 'no portal for a customer Stripe doesn’t know');
  const r = await o4.api('POST', '/billing/checkout', { planId: 'team' });
  assert.equal(r.status, 200, JSON.stringify(r));
  const calls = await (await fetch(STRIPE_LOG)).json();
  const cs = calls.find(c => c.url === '/v1/checkout/sessions');
  assert.match(cs.body.customer, /^cus_fake_/, 'a fresh customer was created');
  assert.equal(cs.body.billing_address_collection, 'auto');
});

test('Stripe webhooks: newer API versions (period end on the item, invoice parent) are understood', { skip }, async () => {
  const bizId = (await owner.api('GET', '/session')).businesses[0].businessId;
  const sign = raw => { const t = Math.floor(Date.now() / 1000); return { t, s: crypto.createHmac('sha256', WHSEC).update(`${t}.${raw}`).digest('hex') }; };
  const send = async ev => { const raw = JSON.stringify(ev); const { t, s } = sign(raw); return fetch(URL_ + '/functions/v1/api/stripe/webhook', { method: 'POST', headers: { 'Stripe-Signature': `t=${t},v1=${s}` }, body: raw }); };
  const subId = 'sub_new_' + run;
  let r = await send({ id: 'evt_n1' + run, type: 'customer.subscription.updated', data: { object: { id: subId, customer: 'cus_n_' + run, status: 'active', metadata: { business_id: bizId }, items: { data: [{ current_period_end: 1900000000, price: { id: 'price_team_test' } }] } } } });
  assert.equal(r.status, 200);
  const rows = async () => (await (await fetch(`${URL_}/rest/v1/businesses?id=eq.${bizId}&select=subscription_status,current_period_end`, { headers: { apikey: SERVICE, Authorization: 'Bearer ' + SERVICE } })).json())[0];
  assert.ok((await rows()).current_period_end, 'period end read from the subscription item');
  r = await send({ id: 'evt_n2' + run, type: 'invoice.payment_failed', data: { object: { id: 'in_1', parent: { subscription_details: { subscription: subId } } } } });
  assert.equal(r.status, 200);
  assert.equal((await rows()).subscription_status, 'past_due');
});

test('Stripe webhooks: bad signatures are rejected, good ones change the plan once', { skip }, async () => {
  const bizId = (await owner.api('GET', '/session')).businesses[0].businessId;
  const event = { id: 'evt_' + crypto.randomBytes(6).toString('hex'), type: 'customer.subscription.updated',
    data: { object: { id: 'sub_' + run, customer: 'cus_x_' + run, status: 'active', metadata: { business_id: bizId }, current_period_end: 1900000000, items: { data: [{ price: { id: 'price_team_test' } }] } } } };
  const raw = JSON.stringify(event); const t = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', WHSEC).update(`${t}.${raw}`).digest('hex');
  const hook = s => fetch(URL_ + '/functions/v1/api/stripe/webhook', { method: 'POST', headers: { 'Stripe-Signature': `t=${t},v1=${s}` }, body: raw });
  assert.equal((await hook('0'.repeat(64))).status, 400);
  assert.equal((await hook(sig)).status, 200);
  assert.equal((await json(await hook(sig))).received, 'duplicate');
  const v = await owner.api('GET', '/workspace');
  assert.equal(v.doc.billing.plan, 'Team'); assert.equal(v.doc.billing.hasSubscription, true);
  // now the 11th person fits
  const loc = Object.keys(v.doc.locs)[0];
  assert.equal((await owner.api('POST', '/workspace/ops', { ops: [{ c: 'people', id: 'pover', v: { name: 'Now Fits', email: em('over'), locs: [loc] } }] })).status, 200);
});

test('archived people lose access', { skip }, async () => {
  ws = await owner.api('GET', '/workspace');
  const sam = Object.values(ws.doc.people).find(p => p.name === 'Sam Second').id;
  assert.equal((await owner.api('POST', '/workspace/ops', { ops: [{ c: 'people', id: sam, v: { status: 'archived' } }] })).status, 200);
  assert.equal((await emp2.api('GET', '/workspace')).status, 403);
});

test('CORS: only the site’s own address may call the API from a browser', { skip }, async () => {
  const good = await fetch(URL_ + '/functions/v1/api/config', { method: 'OPTIONS', headers: { Origin: 'http://localhost:5173' } });
  assert.equal(good.headers.get('access-control-allow-origin'), 'http://localhost:5173');
  const bad = await fetch(URL_ + '/functions/v1/api/config', { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } });
  assert.equal(bad.headers.get('access-control-allow-origin'), null);
});

test('deleting an account: employees leave the team, their sign-in is removed', { skip }, async () => {
  assert.equal((await emp.api('POST', '/account/delete', { confirm: 'nope' })).status, 400);
  const erinId = (await emp.api('GET', '/workspace')).doc.me;
  assert.equal((await emp.api('POST', '/account/delete', { confirm: 'DELETE' })).status, 200);
  assert.equal((await emp.api('GET', '/workspace')).status, 401, 'the old session no longer works');
  assert.notEqual((await other.otp(em('erin'), false)).status, 200, 'the sign-in is gone');
  const v = await owner.api('GET', '/workspace'); const erin = v.doc.people[erinId];
  assert.equal(erin.status, 'archived'); assert.equal(erin.email, ''); assert.ok(erin.accountDeleted);
  assert.equal((await owner.api('POST', '/workspace/ops', { ops: [{ c: 'people', id: erinId, v: { status: 'active' } }] })).status, 403, 'can’t be restored without a new invite');
});

test('deleting an account: an owner with a paid plan must cancel it first', { skip }, async () => {
  const r = await owner.api('POST', '/account/delete', { confirm: 'DELETE' });
  assert.equal(r.status, 409); assert.equal(r.code, 'paid_plan');
  assert.equal((await owner.api('GET', '/workspace')).status, 200, 'nothing was deleted');
});

test('deleting an account: an owner on the Free plan deletes the whole business', { skip }, async () => {
  const o3 = person(), e3 = person();
  const s = await signup(o3, em('owner3'), 'Gone Soon', [{ name: 'Gail Gone', contact: em('gail') }]);
  await acceptInvite(e3, s.shareLinks[0].link, em('gail'), 'Gail');
  const bizId = (await o3.api('GET', '/session')).businesses[0].businessId;
  assert.equal((await o3.api('POST', '/account/delete', { confirm: 'delete' })).status, 200);
  assert.equal((await e3.api('GET', '/workspace')).status, 403, 'the team loses access');
  const rows = await (await fetch(`${URL_}/rest/v1/businesses?id=eq.${bizId}&select=id`, { headers: { apikey: SERVICE, Authorization: 'Bearer ' + SERVICE } })).json();
  assert.deepEqual(rows, [], 'the business and its data are gone');
});
