// DaySpear server — plain Node.js (no external packages).
// Serves the web app from /public and a JSON API under /api.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config, checkConfig, stripeMode, smsEnabled } from './config.js';
import { db, q, tx, newId, now, hmac } from './db.js';
import { HttpError, normIdent, mask, findIdentity, userIdentities, rateLimit, createCode, consumeCode, createSession, getSession, destroySession, setSessionBusiness } from './auth.js';
import { deliver } from './messaging.js';
import { PLANS, PRICING } from './plans.js';
import { loadWorkspace, saveWorkspace, business, actorFor, viewFor, applyOps, planState, syncGrace, defaultSettings, blankPerson, isMgr, isOwner } from './workspace.js';
import { createCheckout, createPortal, verifyWebhook, handleWebhook } from './billing.js';

const problems = checkConfig(console);
if (problems.length) { problems.forEach(p => console.error('[config] ' + p)); if (config.isProd) process.exit(1); }

const PUBLIC = path.join(config.root, 'public');
const INVITE_DAYS = 7;

// ------------------------------------------------------------------ helpers
const send = (res, status, data, headers = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(data));
};
async function readBody(req, limit = 2_000_000) {
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > limit) throw new HttpError(413, 'Request too large'); chunks.push(c); }
  return Buffer.concat(chunks).toString('utf8');
}
const json = async req => { const raw = await readBody(req); try { return raw ? JSON.parse(raw) : {}; } catch { throw new HttpError(400, 'Invalid JSON'); } };
const ip = req => (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
const first = name => String(name || '').trim().split(/\s+/)[0] || 'there';

function requireSession(req) {
  const s = getSession(req);
  if (!s) throw new HttpError(401, 'Please sign in.');
  return s;
}
function activeMemberships(userId) {
  return q.all('SELECT m.business_id, m.person_id, b.name FROM memberships m JOIN businesses b ON b.id = m.business_id WHERE m.user_id = ?', userId)
    .map(m => { const { doc } = loadWorkspace(m.business_id); const p = doc.people[m.person_id]; return p && p.status === 'active' ? { businessId: m.business_id, personId: m.person_id, name: m.name, access: p.access } : null; })
    .filter(Boolean);
}
function context(req) {
  const s = requireSession(req);
  const mems = activeMemberships(s.user_id);
  const m = mems.find(x => x.businessId === s.business_id) || mems[0];
  if (!m) throw new HttpError(403, 'You don’t have access to any business yet.');
  if (m.businessId !== s.business_id) setSessionBusiness(s, m.businessId);
  const biz = business(m.businessId);
  const ws = loadWorkspace(m.businessId);
  const actor = actorFor(ws.doc, m.personId);
  return { s, biz, ws, actor };
}

// ------------------------------------------------------------------ invites & identities
function upsertIdentity(userId, kind, value, verified) {
  const ex = findIdentity(kind, value);
  if (ex && ex.user_id !== userId) throw new HttpError(409, `That ${kind === 'email' ? 'email' : 'number'} is already used by another account.`);
  if (ex) { if (verified && !ex.verified) q.run('UPDATE identities SET verified = 1 WHERE id = ?', ex.id); return; }
  q.run('INSERT INTO identities (id, user_id, kind, value, verified, created_at) VALUES (?,?,?,?,?,?)', newId('i_'), userId, kind, value, verified ? 1 : 0, now());
}
async function sendInvite(biz, doc, personId, inviterId) {
  const p = doc.people[personId];
  q.run('UPDATE invites SET revoked = 1 WHERE business_id = ? AND person_id = ? AND used_at IS NULL', biz.id, personId);
  const token = crypto.randomBytes(24).toString('base64url');
  q.run('INSERT INTO invites (token_hash, business_id, person_id, expires_at, created_at) VALUES (?,?,?,?,?)',
    hmac(token), biz.id, personId, new Date(Date.now() + INVITE_DAYS * 864e5).toISOString(), now());
  const contact = normIdent(p.email) || normIdent(p.phone);
  const link = `${config.appUrl}/#invite/${token}`;
  const by = doc.people[inviterId]?.first || 'Your manager';
  const text = `Hi ${first(p.name)},\n\n${by} invited you to join ${doc.settings.business.name} on DaySpear, where you’ll see your schedule, swap shifts and chat with your team.\n\nThis link works once and expires in ${INVITE_DAYS} days.`;
  if (contact) await deliver(contact.kind, contact.value, `${by} invited you to ${doc.settings.business.name} on DaySpear`, text, link);
  return config.isProd ? null : link; // dev convenience: return the link so it can be opened without email
}
function inviteRow(token) {
  const r = q.one('SELECT * FROM invites WHERE token_hash = ?', hmac(token));
  if (!r || r.revoked || r.used_at || r.expires_at < now()) throw new HttpError(410, 'This invite link has expired or was already used.', { code: 'invite_expired' });
  return r;
}

// signup tokens: short-lived, signed, carry the verified email between steps
const signToken = obj => { const b = Buffer.from(JSON.stringify(obj)).toString('base64url'); return `${b}.${hmac('signup:' + b)}`; };
const readToken = t => { const [b, sig] = String(t || '').split('.'); if (!b || hmac('signup:' + b) !== sig) throw new HttpError(400, 'Your sign-up session expired. Please start again.'); const o = JSON.parse(Buffer.from(b, 'base64url').toString()); if (o.exp < Date.now()) throw new HttpError(400, 'Your sign-up session expired. Please start again.'); return o; };

// ------------------------------------------------------------------ routes
const routes = [];
const route = (method, pattern, fn) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), fn });

route('GET', '/api/health', () => ({ ok: true }));

route('GET', '/api/config', () => ({
  plans: PLANS.map(({ stripePriceEnv, ...p }) => p), pricing: PRICING,
  stripe: stripeMode(), sms: smsEnabled(), emailProvider: config.email.provider === 'console' ? 'console' : 'live',
}));

route('GET', '/api/session', ({ req }) => {
  const s = getSession(req);
  if (!s) return { signedIn: false };
  const mems = activeMemberships(s.user_id);
  const cur = mems.find(m => m.businessId === s.business_id) || mems[0] || null;
  return { signedIn: true, businesses: mems, current: cur };
});
route('POST', '/api/session/business', async ({ req }) => {
  const s = requireSession(req); const { businessId } = await json(req);
  if (!activeMemberships(s.user_id).some(m => m.businessId === businessId)) throw new HttpError(403, 'No access');
  setSessionBusiness(s, businessId); return { ok: true };
});

// ---- sign in (passwordless)
route('POST', '/api/auth/start', async ({ req }) => {
  const { identifier } = await json(req);
  const id = normIdent(identifier);
  if (!id) throw new HttpError(400, 'Enter a full email address or mobile number.');
  rateLimit('start:' + ip(req), 20, 15 * 60e3); rateLimit('start:' + id.value, 5, 15 * 60e3);
  if (id.kind === 'phone' && !smsEnabled()) throw new HttpError(400, 'Text messages aren’t available yet — sign in with your email instead.');
  const ident = findIdentity(id.kind, id.value);
  if (ident && ident.verified) {
    const code = createCode('login', id.kind, id.value, { userId: ident.user_id });
    await deliver(id.kind, id.value, `Your DaySpear code: ${code}`, `Your DaySpear sign-in code is ${code}. It expires in 10 minutes.`);
  }
  // Same response whether or not an account exists, so this can't be used to discover who has an account.
  return { sent: true, via: id.kind, masked: mask(id.kind, id.value) };
});
route('POST', '/api/auth/alternate', async ({ req }) => {
  const { identifier } = await json(req);
  const id = normIdent(identifier); if (!id) throw new HttpError(400, 'Enter your email or mobile number.');
  rateLimit('alt:' + id.value, 3, 15 * 60e3);
  const ident = findIdentity(id.kind, id.value);
  const other = ident && userIdentities(ident.user_id).find(i => i.kind !== id.kind && i.verified && (i.kind === 'email' || smsEnabled()));
  if (!other) return { none: true };
  const code = createCode('login', other.kind, other.value, { userId: other.user_id });
  await deliver(other.kind, other.value, `Your DaySpear code: ${code}`, `Your DaySpear sign-in code is ${code}. Someone asked to sign in with your other contact. If that wasn’t you, ignore this.`);
  return { sent: true, via: other.kind, masked: mask(other.kind, other.value), ref: other.id };
});
route('POST', '/api/auth/verify', async ({ req, res }) => {
  const { identifier, ref, code, keep } = await json(req);
  const ident = ref ? q.one('SELECT * FROM identities WHERE id = ?', String(ref)) : (() => { const id = normIdent(identifier); return id && findIdentity(id.kind, id.value); })();
  rateLimit('verify:' + ip(req), 30, 15 * 60e3);
  if (!ident || !ident.verified) throw new HttpError(400, 'That code isn’t right. Check it and try again.');
  consumeCode('login', ident.kind, ident.value, code);
  const mems = activeMemberships(ident.user_id);
  if (!mems.length) throw new HttpError(403, 'Your account isn’t part of an active business. Ask your manager for a new invite.');
  createSession(res, ident.user_id, mems[0].businessId, keep !== false);
  return { ok: true, recovered: Boolean(ref) };
});
route('POST', '/api/auth/logout', ({ req, res }) => { destroySession(req, res); return { ok: true }; });

// ---- sign up a new business
route('POST', '/api/signup/start', async ({ req }) => {
  const { name, email, phone } = await json(req);
  const e = normIdent(email);
  if (!String(name || '').trim()) throw new HttpError(400, 'Please add your name.');
  if (!e || e.kind !== 'email') throw new HttpError(400, 'Enter a valid email address — you’ll use it to sign in and recover your account.');
  if (phone && !normIdent(phone)) throw new HttpError(400, 'That mobile number looks incomplete.');
  rateLimit('signup:' + ip(req), 10, 60 * 60e3); rateLimit('signup:' + e.value, 5, 60 * 60e3);
  if (findIdentity('email', e.value)) throw new HttpError(409, 'There’s already an account with this email.', { code: 'exists' });
  const code = createCode('signup', 'email', e.value, { meta: { name: String(name).trim().slice(0, 80), phone: phone ? normIdent(phone).value : '' } });
  await deliver('email', e.value, `Your DaySpear code: ${code}`, `Welcome to DaySpear! Your code is ${code}. It expires in 10 minutes.`);
  return { sent: true };
});
route('POST', '/api/signup/verify', async ({ req }) => {
  const { email, code } = await json(req);
  const e = normIdent(email); if (!e) throw new HttpError(400, 'Invalid email');
  const row = consumeCode('signup', 'email', e.value, code);
  return { token: signToken({ email: e.value, name: row.meta?.name, phone: row.meta?.phone, exp: Date.now() + 60 * 60e3 }) };
});
route('POST', '/api/signup/complete', async ({ req, res }) => {
  const b = await json(req);
  const t = readToken(b.token);
  const bizName = String(b.business?.name || '').trim().slice(0, 80);
  const locs = (b.locations || []).map(l => ({ name: String(l.name || '').trim().slice(0, 80), address: String(l.address || '').trim().slice(0, 200) })).filter(l => l.name);
  const roles = [...new Set((b.roles || []).map(r => String(r).trim().slice(0, 60)).filter(Boolean))].slice(0, 20);
  const invites = (b.invites || []).map(v => ({ name: String(v.name || '').trim().slice(0, 80), c: normIdent(v.contact) })).filter(v => v.name && v.c);
  if (!bizName || !locs.length || !roles.length) throw new HttpError(400, 'Add your business name, at least one location and one role.');
  if (invites.length + 1 > PLANS[0].limit) throw new HttpError(400, `The free plan covers ${PLANS[0].limit} people. Invite the rest later.`);
  if (findIdentity('email', t.email)) throw new HttpError(409, 'There’s already an account with this email.');
  const ids = { biz: newId('b_'), user: newId('u_'), owner: newId('p') };
  const locMap = {}; locs.forEach((l, i) => { locMap['l' + (i + 1)] = { name: l.name, short: l.name.replace(/[^A-Za-z0-9 ]/g, '').split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase() || 'L' + (i + 1), address: l.address, hours: '' }; });
  const lk = Object.keys(locMap); const roleMap = {}; roles.forEach((r, i) => { roleMap['r' + (i + 1)] = r; }); const rk = Object.keys(roleMap);
  const people = { [ids.owner]: blankPerson({ id: ids.owner, name: t.name, first: first(t.name), access: 'owner', manages: lk, locs: lk, role: rk[0], roles: [rk[0]], email: t.email, phone: t.phone || '', verified: { email: true, phone: false }, prefHours: [30, 45], notif: { channels: { push: true, email: true, sms: false }, events: { schedule: true, openShifts: true, requests: true, messages: true, announcements: true }, follow: lk } }) };
  const order = [];
  for (const v of invites) {
    const pid = newId('p');
    people[pid] = blankPerson({ id: pid, name: v.name, first: first(v.name), status: 'invited', invited: 'Invite sent', inviteExpires: INVITE_DAYS, invitedBy: ids.owner, invitedAt: now(), role: rk[0], roles: [rk[0]], locs: [lk[0]], email: v.c.kind === 'email' ? v.c.value : '', phone: v.c.kind === 'phone' ? v.c.value : '' });
    order.push(pid);
  }
  const checklists = b.templates ? lk.flatMap(l => [
    { id: newId('cl'), name: 'Opening duties', loc: l, assign: { type: 'shift', label: 'Attach to opening shifts' }, items: ['Unlock and turn on lights', 'Count the cash drawer', 'Check supplies and restock', 'Open the doors on time'].map(x => ({ t: x, done: false })) },
    { id: newId('cl'), name: 'Closing duties', loc: l, assign: { type: 'shift', label: 'Attach to closing shifts' }, items: ['Clean and tidy work areas', 'Count the drawer and log the deposit', 'Take out trash', 'Lights off, lock up and set the alarm'].map(x => ({ t: x, done: false })) }]) : [];
  const messages = { 'team-all': [] }; lk.forEach(l => { messages['team-' + l] = []; });
  const doc = { people, order, locs: locMap, roles: roleMap, settings: defaultSettings(bizName, String(b.business?.type || 'Business').slice(0, 60)),
    shifts: [], timeoff: [], coverLog: [], checklists, tasks: [], published: {}, deleted: {}, messages,
    announcements: [{ id: newId('a'), title: `Welcome to ${bizName} on DaySpear`, text: 'This is where announcements show up. Your team will see the schedule here once it’s published.', from: ids.owner, loc: null, at: now(), pinned: true, seen: [] }] };
  tx(() => {
    q.run('INSERT INTO businesses (id, name, created_at, plan_id) VALUES (?,?,?,?)', ids.biz, bizName, now(), 'free');
    q.run('INSERT INTO workspaces (business_id, doc, version, updated_at) VALUES (?,?,1,?)', ids.biz, JSON.stringify(doc), now());
    q.run('INSERT INTO users (id, created_at) VALUES (?,?)', ids.user, now());
    q.run('INSERT INTO identities (id, user_id, kind, value, verified, created_at) VALUES (?,?,?,?,1,?)', newId('i_'), ids.user, 'email', t.email, now());
    if (t.phone && !findIdentity('phone', t.phone)) q.run('INSERT INTO identities (id, user_id, kind, value, verified, created_at) VALUES (?,?,?,?,0,?)', newId('i_'), ids.user, 'phone', t.phone, now());
    q.run('INSERT INTO memberships (business_id, person_id, user_id, created_at) VALUES (?,?,?,?)', ids.biz, ids.owner, ids.user, now());
  });
  const biz = business(ids.biz); const devLinks = [];
  for (const pid of order) { const l = await sendInvite(biz, doc, pid, ids.owner); if (l) devLinks.push(l); }
  createSession(res, ids.user, ids.biz, true);
  return { ok: true, devInviteLinks: devLinks };
});

// ---- invites
route('GET', '/api/invites/:token', ({ params }) => {
  const r = inviteRow(params.token); const { doc } = loadWorkspace(r.business_id); const p = doc.people[r.person_id];
  if (!p || p.status !== 'invited') throw new HttpError(410, 'This invite link has expired or was already used.', { code: 'invite_expired' });
  const c = normIdent(p.email) || normIdent(p.phone);
  return { business: doc.settings.business.name, name: p.name, role: doc.roles[p.role] || '', locations: p.locs.map(l => doc.locs[l]?.name).filter(Boolean),
    invitedBy: doc.people[p.invitedBy]?.first || 'Your manager', contactKind: c?.kind, contact: c ? (c.kind === 'email' ? c.value : p.phone) : '', expiresAt: r.expires_at,
    smsAvailable: smsEnabled() };
});
route('POST', '/api/invites/:token/start', async ({ req, params }) => {
  const r = inviteRow(params.token); const { name, contact } = await json(req);
  rateLimit('invstart:' + r.token_hash, 6, 30 * 60e3);
  const c = normIdent(contact); if (!c) throw new HttpError(400, 'Enter a full mobile number or email.');
  if (c.kind === 'phone' && !smsEnabled()) throw new HttpError(400, 'Text messages aren’t available yet — use your email instead.');
  const ex = findIdentity(c.kind, c.value);
  const code = createCode('invite', c.kind, c.value, { meta: { invite: r.token_hash, name: String(name || '').trim().slice(0, 80), existingUser: ex && ex.verified ? ex.user_id : null } });
  await deliver(c.kind, c.value, `Your DaySpear code: ${code}`, `Your code to join your team on DaySpear is ${code}. It expires in 10 minutes.`);
  return { sent: true, via: c.kind, masked: mask(c.kind, c.value) };
});
route('POST', '/api/invites/:token/accept', async ({ req, res, params }) => {
  const r = inviteRow(params.token); const { contact, code } = await json(req);
  const c = normIdent(contact); if (!c) throw new HttpError(400, 'Invalid contact');
  const row = consumeCode('invite', c.kind, c.value, code);
  if (row.meta?.invite !== r.token_hash) throw new HttpError(400, 'That code is for a different invite.');
  let userId = row.meta.existingUser;
  tx(() => {
    const { doc, version } = loadWorkspace(r.business_id);
    const p = doc.people[r.person_id]; if (!p || p.status !== 'invited') throw new HttpError(410, 'This invite was cancelled.');
    if (!userId) { userId = newId('u_'); q.run('INSERT INTO users (id, created_at) VALUES (?,?)', userId, now()); }
    upsertIdentity(userId, c.kind, c.value, true);
    q.run('INSERT OR REPLACE INTO memberships (business_id, person_id, user_id, created_at) VALUES (?,?,?,?)', r.business_id, r.person_id, userId, now());
    if (row.meta.name) { p.name = row.meta.name; p.first = first(p.name); }
    p[c.kind] = c.kind === 'phone' ? (p.phone && normIdent(p.phone)?.value === c.value ? p.phone : c.value) : c.value;
    p.verified = { ...(p.verified || {}), [c.kind]: true };
    p.status = 'active'; delete p.invited; delete p.inviteExpires;
    saveWorkspace(r.business_id, doc, version);
    q.run('UPDATE invites SET used_at = ? WHERE token_hash = ?', now(), r.token_hash);
    syncGrace(business(r.business_id), doc);
  });
  createSession(res, userId, r.business_id, true);
  return { ok: true };
});
route('POST', '/api/invites/resend/:personId', async ({ req, params }) => {
  const { biz, ws, actor } = context(req);
  const p = ws.doc.people[params.personId];
  if (!p || p.status !== 'invited') throw new HttpError(400, 'That person isn’t waiting on an invite.');
  if (!isMgr(actor.p) || !(isOwner(actor.p) || p.locs.some(l => (actor.p.manages || []).includes(l)))) throw new HttpError(403, 'You can’t resend that invite.');
  const link = await sendInvite(biz, ws.doc, p.id, actor.id);
  p.inviteExpires = INVITE_DAYS; p.invited = 'Invite resent'; p.invitedAt = now();
  const version = saveWorkspace(biz.id, ws.doc, ws.version);
  return { ok: true, version, doc: viewFor(ws.doc, actor, business(biz.id)), devInviteLink: link };
});

// ---- the workspace
route('GET', '/api/workspace', ({ req }) => {
  const { biz, ws, actor } = context(req);
  return { version: ws.version, doc: viewFor(ws.doc, actor, biz) };
});
route('POST', '/api/workspace/ops', async ({ req }) => {
  const body = await json(req);
  const { biz, ws, actor } = context(req);
  rateLimit('ops:' + actor.id, 240, 60e3);
  const { doc, effects } = applyOps(ws.doc, actor, body.ops, biz);
  const version = saveWorkspace(biz.id, doc, ws.version);
  // side effects after a successful save
  const devInviteLinks = [];
  for (const pid of effects.invites) { const l = await sendInvite(biz, doc, pid, actor.id); if (l) devInviteLinks.push(l); }
  for (const pid of effects.archived) q.run('UPDATE invites SET revoked = 1 WHERE business_id = ? AND person_id = ? AND used_at IS NULL', biz.id, pid);
  const verify = [];
  for (const ch of effects.contactChanges) {
    const id = normIdent(ch.value); if (!id) continue;
    if (id.kind === 'phone' && !smsEnabled()) { verify.push({ kind: 'phone', unavailable: true }); continue; }
    const code = createCode('verify', id.kind, id.value, { meta: { business: biz.id, person: actor.id } });
    await deliver(id.kind, id.value, `Confirm your new ${id.kind === 'email' ? 'email' : 'number'}: ${code}`, `Your DaySpear confirmation code is ${code}. It expires in 10 minutes.`);
    verify.push({ kind: id.kind, masked: mask(id.kind, id.value) });
  }
  syncGrace(business(biz.id), doc);
  return { version, doc: viewFor(doc, actor, business(biz.id)), verify, devInviteLinks };
});
route('POST', '/api/me/verify', async ({ req }) => {
  const { kind, code } = await json(req);
  const { s, biz, ws, actor } = context(req);
  const v = normIdent(actor.p[kind]); if (!v) throw new HttpError(400, 'Nothing to confirm.');
  consumeCode('verify', v.kind, v.value, code);
  const old = userIdentities(s.user_id).filter(i => i.kind === v.kind && i.value !== v.value);
  tx(() => {
    upsertIdentity(s.user_id, v.kind, v.value, true);
    for (const o of old) q.run('DELETE FROM identities WHERE id = ?', o.id); // the old address stops working for sign-in
  });
  actor.p.verified = { ...(actor.p.verified || {}), [v.kind]: true };
  const version = saveWorkspace(biz.id, ws.doc, ws.version);
  return { version, doc: viewFor(ws.doc, actor, biz) };
});

// ---- billing (owner only)
route('POST', '/api/billing/checkout', async ({ req }) => {
  const { biz, actor } = context(req); const { planId } = await json(req);
  if (!isOwner(actor.p)) throw new HttpError(403, 'Only the owner can change the plan.');
  return createCheckout(biz, actor.p, planId);
});
route('POST', '/api/billing/portal', async ({ req }) => {
  const { biz, actor } = context(req);
  if (!isOwner(actor.p)) throw new HttpError(403, 'Only the owner can manage billing.');
  return createPortal(biz);
});
route('POST', '/api/stripe/webhook', async ({ req }) => {
  const raw = await readBody(req, 1_000_000);
  const event = verifyWebhook(raw, req.headers['stripe-signature']);
  return { received: await handleWebhook(event) };
});

// ---- contact form (homepage) — delivered to CONTACT_EMAIL through the email provider
route('POST', '/api/contact', async ({ req }) => {
  const b = await json(req);
  rateLimit('contact:' + ip(req), 5, 60 * 60e3);
  const e = normIdent(b.email);
  if (!String(b.name || '').trim() || !e || e.kind !== 'email' || !String(b.message || '').trim()) throw new HttpError(400, 'Please add your name, a valid email and a message.');
  const text = ['Name: ' + String(b.name).slice(0, 80), 'Email: ' + e.value, 'Business: ' + String(b.business || '').slice(0, 80), 'Team size: ' + String(b.size || '').slice(0, 40),
    'Topic: ' + String(b.topic || '').slice(0, 40), '', String(b.message).slice(0, 4000)].join('\n');
  if (config.contactEmail) await deliver('email', config.contactEmail, `DaySpear contact: ${String(b.topic || 'question').slice(0, 40)}`, text);
  else console.log('[contact] CONTACT_EMAIL is not set — message only logged:\n' + text);
  return { ok: true };
});

// dev-only: read the outbox (codes and invite links) when no real email provider is configured
route('GET', '/api/dev/outbox', ({ req }) => {
  const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) && !req.headers['x-forwarded-for'];
  if (config.isProd || config.email.provider !== 'console' || !local) throw new HttpError(404, 'Not found');
  return q.all('SELECT channel, recipient, subject, body, status, created_at FROM outbox ORDER BY created_at DESC LIMIT 20');
});

// ------------------------------------------------------------------ static files
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };
function serveStatic(req, res, urlPath) {
  let p = decodeURIComponent(urlPath.split('?')[0]);
  if (p === '/' || p === '') p = '/index.html';
  const file = path.normalize(path.join(PUBLIC, p));
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
  const ext = path.extname(file);
  res.writeHead(200, { 'Content-Type': TYPES[ext] || 'application/octet-stream', 'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600' });
  fs.createReadStream(file).pipe(res);
}

const CSP = ["default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com", "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob:", "connect-src 'self'", "frame-ancestors 'none'", "base-uri 'self'", "form-action 'self'"].join('; ');

const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  if (config.secureCookies) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  const url = new URL(req.url, 'http://x');
  if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url.pathname);
  try {
    // CSRF protection: state-changing API calls must come from our own pages.
    if (req.method !== 'GET' && url.pathname !== '/api/stripe/webhook') {
      if (req.headers['x-dayspear'] !== '1') throw new HttpError(403, 'Missing request header');
      const origin = req.headers.origin;
      if (origin && origin !== new URL(config.appUrl).origin && origin !== `http://${req.headers.host}` && origin !== `https://${req.headers.host}`) throw new HttpError(403, 'Bad origin');
    }
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = url.pathname.match(r.re); if (!m) continue;
      const out = await r.fn({ req, res, params: m.groups || {}, url });
      return send(res, 200, out ?? { ok: true });
    }
    throw new HttpError(404, 'Not found');
  } catch (e) {
    if (!(e instanceof HttpError)) { console.error(e); e = new HttpError(500, 'Something went wrong on our side.'); }
    send(res, e.status, { error: e.message, ...e.extra });
  }
});

server.listen(config.port, () => {
  console.log(`DaySpear running at ${config.appUrl} (port ${config.port}) · email: ${config.email.provider} · sms: ${smsEnabled() ? config.sms.provider : 'off'} · stripe: ${stripeMode()}`);
});
export default server;
