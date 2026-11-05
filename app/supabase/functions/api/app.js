// DaySpear API — one Supabase Edge Function with a small router.
// The browser calls https://<project>.supabase.co/functions/v1/api/<route>.
// Deploy with `--no-verify-jwt` (Stripe's webhook has no Supabase token); every
// private route checks the caller's Supabase Auth session itself.
import { config, stripeMode, emailEnabled } from './config.js';
import { db } from './db.js';
import { HttpError } from './errors.js';
import { getUser, sha256, randomToken, newId, normIdent } from './auth.js';
import { sendEmail } from './mail.js';
import { PLANS, PRICING } from './plans.js';
import { actorFor, viewFor, applyOps, planState, graceChange, resetChecklists, defaultSettings, blankPerson, isMgr, isOwner } from './workspace.js';
import { createCheckout, createPortal, verifyWebhook, handleWebhook } from './billing.js';

const INVITE_DAYS = 7;
const now = () => new Date().toISOString();
const first = name => String(name || '').trim().split(/\s+/)[0] || 'there';

// ------------------------------------------------------------------ storage
function business(id) { return db.one('businesses', `id=${db.eq(id)}`); }
async function loadWorkspace(bizId) {
  const row = await db.one('workspaces', `business_id=${db.eq(bizId)}&select=doc,version`);
  if (!row) throw new HttpError(404, 'Workspace not found');
  const ws = { doc: row.doc, version: row.version };
  if (resetChecklists(ws.doc)) { try { ws.version = await saveWorkspace(bizId, ws.doc, ws.version); } catch { /* someone else saved; fine */ } }
  return ws;
}
async function saveWorkspace(bizId, doc, version) {
  const json = JSON.stringify(doc);
  if (json.length > 8_000_000) throw new HttpError(413, 'This workspace has grown too large to save.');
  const rows = await db.update('workspaces', `business_id=${db.eq(bizId)}&version=eq.${Number(version)}&select=version`, { doc, version: version + 1, updated_at: now() });
  if (!rows.length) throw new HttpError(409, 'Someone else just made a change. Your view has been refreshed.');
  return version + 1;
}
async function applyGrace(biz, doc) {
  const ch = graceChange(biz, doc);
  if (ch) { await db.update('businesses', `id=${db.eq(biz.id)}`, ch); Object.assign(biz, ch); }
}

// ------------------------------------------------------------------ who's calling
function memberships(userId) {
  return db.all('memberships', `user_id=${db.eq(userId)}&select=business_id,person_id,businesses(name)&order=created_at.asc`);
}
async function requireUser(req) {
  const user = await getUser(req);
  if (!user) throw new HttpError(401, 'Please sign in.');
  return user;
}
// The signed-in person in the business they're working in (header X-Business picks one when they belong to several).
async function context(req) {
  const user = await requireUser(req);
  const mems = await memberships(user.id);
  const want = req.headers.get('x-business');
  const ordered = [...mems.filter(m => m.business_id === want), ...mems.filter(m => m.business_id !== want)];
  for (const m of ordered) {
    const ws = await loadWorkspace(m.business_id);
    const p = ws.doc.people[m.person_id];
    if (!p || p.status !== 'active') continue;
    const biz = await business(m.business_id);
    const actor = actorFor(ws.doc, m.person_id);
    await syncVerified(biz, ws, actor, user);
    return { user, biz, ws, actor };
  }
  throw new HttpError(403, 'Your account isn’t part of an active business. Ask your manager for a new invite.');
}
// A profile email or number counts as verified once it matches what Supabase Auth has confirmed.
async function syncVerified(biz, ws, actor, user) {
  const p = actor.p, v = { ...(p.verified || {}) };
  const authEmail = (user.email_confirmed_at && user.email || '').toLowerCase();
  const authPhone = user.phone_confirmed_at && user.phone ? '+' + String(user.phone).replace(/\D/g, '') : '';
  const want = { email: Boolean(p.email && p.email.toLowerCase() === authEmail), phone: Boolean(p.phone && authPhone && normIdent(p.phone)?.value === authPhone) };
  if (want.email === Boolean(v.email) && want.phone === Boolean(v.phone)) return;
  p.verified = { ...v, ...want };
  try { ws.version = await saveWorkspace(biz.id, ws.doc, ws.version); } catch { /* try again next time */ }
}

// ------------------------------------------------------------------ invites
async function sendInvite(biz, doc, personId, inviterId) {
  const p = doc.people[personId];
  await db.update('invites', `business_id=${db.eq(biz.id)}&person_id=${db.eq(personId)}&used_at=is.null`, { revoked: true });
  const token = randomToken();
  await db.insert('invites', { token_hash: await sha256(token), business_id: biz.id, person_id: personId, expires_at: new Date(Date.now() + INVITE_DAYS * 864e5).toISOString() });
  const link = `${config.appUrl}/#invite/${token}`;
  const by = doc.people[inviterId]?.first || 'Your manager';
  const email = normIdent(p.email);
  const sent = email && email.kind === 'email' ? await sendEmail(email.value, `${by} invited you to ${doc.settings.business.name} on DaySpear`,
    `Hi ${first(p.name)},\n\n${by} invited you to join ${doc.settings.business.name} on DaySpear, where you’ll see your schedule, swap shifts and chat with your team.\n\nThis link works once and expires in ${INVITE_DAYS} days.`, link, 'Set up my account') : false;
  // If it couldn't be emailed (no email provider yet, or only a mobile number), the manager gets the link to share.
  return sent ? null : { personId, name: p.name, link };
}
async function inviteRow(token) {
  const r = await db.one('invites', `token_hash=${db.eq(await sha256(String(token)))}`);
  if (!r || r.revoked || r.used_at || r.expires_at < now()) throw new HttpError(410, 'This invite link has expired or was already used.', { code: 'invite_expired' });
  return r;
}

// ------------------------------------------------------------------ routes
const routes = [];
const route = (method, pattern, fn) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), fn });
const body = async req => { const t = await req.text(); if (t.length > 2_000_000) throw new HttpError(413, 'Request too large'); try { return t ? JSON.parse(t) : {}; } catch { throw new HttpError(400, 'Invalid JSON'); } };

route('GET', '/health', () => ({ ok: true }));

route('GET', '/config', () => ({
  plans: PLANS.map(({ stripePriceEnv, ...p }) => p), pricing: PRICING,
  stripe: stripeMode(), sms: config.sms, email: emailEnabled(),
}));

route('GET', '/session', async ({ req }) => {
  const user = await getUser(req);
  if (!user) return { signedIn: false };
  const mems = await memberships(user.id);
  return { signedIn: true, email: user.email, businesses: mems.map(m => ({ businessId: m.business_id, personId: m.person_id, name: m.businesses?.name })) };
});

// ---- sign up a new business (the owner has already confirmed their email with Supabase Auth)
route('POST', '/signup/complete', async ({ req }) => {
  const user = await requireUser(req);
  if (!user.email || !user.email_confirmed_at) throw new HttpError(400, 'Please confirm your email first.');
  const b = await body(req);
  const existing = await memberships(user.id);
  if (existing.length) throw new HttpError(409, 'You already have a DaySpear account. Sign in to reach your business.', { code: 'exists' });
  const ownerName = String(b.name || user.user_metadata?.name || '').trim().slice(0, 80);
  const bizName = String(b.business?.name || '').trim().slice(0, 80);
  const locs = (b.locations || []).map(l => ({ name: String(l.name || '').trim().slice(0, 80), address: String(l.address || '').trim().slice(0, 200) })).filter(l => l.name).slice(0, 20);
  const roles = [...new Set((b.roles || []).map(r => String(r).trim().slice(0, 60)).filter(Boolean))].slice(0, 20);
  const invites = (b.invites || []).map(v => ({ name: String(v.name || '').trim().slice(0, 80), c: normIdent(v.contact) })).filter(v => v.name && v.c);
  if (!ownerName) throw new HttpError(400, 'Please add your name.');
  if (!bizName || !locs.length || !roles.length) throw new HttpError(400, 'Add your business name, at least one location and one role.');
  if (invites.length + 1 > PLANS[0].limit) throw new HttpError(400, `The free plan covers ${PLANS[0].limit} people. Invite the rest later.`);
  const phone = b.phone ? normIdent(b.phone) : null;
  const ids = { biz: newId('b'), owner: newId('p') };
  const locMap = {}; locs.forEach((l, i) => { locMap['l' + (i + 1)] = { name: l.name, short: l.name.replace(/[^A-Za-z0-9 ]/g, '').split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase() || 'L' + (i + 1), address: l.address, hours: '' }; });
  const lk = Object.keys(locMap); const roleMap = {}; roles.forEach((r, i) => { roleMap['r' + (i + 1)] = r; }); const rk = Object.keys(roleMap);
  const people = { [ids.owner]: blankPerson({ id: ids.owner, name: ownerName, first: first(ownerName), access: 'owner', manages: lk, locs: lk, role: rk[0], roles: [rk[0]], email: user.email.toLowerCase(), phone: phone && phone.kind === 'phone' ? phone.value : '', verified: { email: true, phone: false }, prefHours: [30, 45], notif: { channels: { push: true, email: true, sms: false }, events: { schedule: true, openShifts: true, requests: true, messages: true, announcements: true }, follow: lk } }) };
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
  await db.rpc('create_business', { p_id: ids.biz, p_name: bizName, p_doc: doc, p_user: user.id, p_person: ids.owner });
  const biz = await business(ids.biz); const shareLinks = [];
  for (const pid of order) { const l = await sendInvite(biz, doc, pid, ids.owner); if (l) shareLinks.push(l); }
  return { ok: true, businessId: ids.biz, shareLinks };
});

// ---- invites
route('GET', '/invites/:token', async ({ params }) => {
  const r = await inviteRow(params.token); const { doc } = await loadWorkspace(r.business_id); const p = doc.people[r.person_id];
  if (!p || p.status !== 'invited') throw new HttpError(410, 'This invite link has expired or was already used.', { code: 'invite_expired' });
  const c = normIdent(p.email) || normIdent(p.phone);
  return { business: doc.settings.business.name, name: p.name, role: doc.roles[p.role] || '', locations: p.locs.map(l => doc.locs[l]?.name).filter(Boolean),
    invitedBy: doc.people[p.invitedBy]?.first || 'Your manager', contactKind: c?.kind || null, contact: c ? (c.kind === 'email' ? c.value : p.phone) : '', expiresAt: r.expires_at, smsAvailable: config.sms };
});
route('POST', '/invites/:token/accept', async ({ req, params }) => {
  const user = await requireUser(req);
  const { name } = await body(req);
  const tokenHash = await sha256(String(params.token));
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await inviteRow(params.token);
    const mine = (await memberships(user.id)).find(m => m.business_id === r.business_id && m.person_id !== r.person_id);
    if (mine) throw new HttpError(409, 'You’re already part of this business. Sign in instead.');
    const ws = await loadWorkspace(r.business_id);
    const p = ws.doc.people[r.person_id];
    if (!p || p.status !== 'invited') throw new HttpError(410, 'This invite was cancelled.', { code: 'invite_expired' });
    const n = String(name || '').trim().slice(0, 80); if (n) { p.name = n; p.first = first(n); }
    if (user.email && user.email_confirmed_at) p.email = user.email.toLowerCase();
    if (user.phone && user.phone_confirmed_at) p.phone = '+' + String(user.phone).replace(/\D/g, '');
    p.verified = { email: Boolean(user.email && user.email_confirmed_at), phone: Boolean(user.phone && user.phone_confirmed_at) };
    p.status = 'active'; delete p.invited; delete p.inviteExpires;
    try { await db.rpc('accept_invite', { p_token_hash: tokenHash, p_user: user.id, p_doc: ws.doc, p_version: ws.version }); }
    catch (e) {
      if (/version_conflict/.test(String(e.dbMessage))) continue;
      if (/invite_expired/.test(String(e.dbMessage))) throw new HttpError(410, 'This invite link has expired or was already used.', { code: 'invite_expired' });
      throw e;
    }
    await applyGrace(await business(r.business_id), ws.doc);
    return { ok: true, businessId: r.business_id };
  }
  throw new HttpError(409, 'Your team is busy making changes — please try again.');
});
route('POST', '/invites/resend/:personId', async ({ req, params }) => {
  const { biz, ws, actor } = await context(req);
  const p = ws.doc.people[params.personId];
  if (!p || p.status !== 'invited') throw new HttpError(400, 'That person isn’t waiting on an invite.');
  if (!isMgr(actor.p) || !(isOwner(actor.p) || p.locs.some(l => (actor.p.manages || []).includes(l)))) throw new HttpError(403, 'You can’t resend that invite.');
  const share = await sendInvite(biz, ws.doc, p.id, actor.id);
  p.inviteExpires = INVITE_DAYS; p.invited = 'Invite resent'; p.invitedAt = now();
  const version = await saveWorkspace(biz.id, ws.doc, ws.version);
  return { ok: true, version, doc: viewFor(ws.doc, actor, biz), shareLinks: share ? [share] : [] };
});

// ---- the workspace
route('GET', '/workspace', async ({ req, url }) => {
  const { biz, ws, actor } = await context(req);
  if (url.searchParams.get('since') === String(ws.version)) return { unchanged: true, version: ws.version };
  return { version: ws.version, doc: viewFor(ws.doc, actor, biz) };
});
const opsBuckets = new Map();
route('POST', '/workspace/ops', async ({ req }) => {
  const b = await body(req);
  const { biz, ws, actor } = await context(req);
  const t = Date.now(), bk = opsBuckets.get(actor.id) || { n: 0, reset: t + 60e3 };
  if (bk.reset < t) { bk.n = 0; bk.reset = t + 60e3; }
  if (++bk.n > 240) throw new HttpError(429, 'Too many changes at once. Please wait a moment.');
  opsBuckets.set(actor.id, bk);
  const { doc, effects } = applyOps(ws.doc, actor, b.ops, biz);
  const version = await saveWorkspace(biz.id, doc, ws.version);
  const shareLinks = [];
  for (const pid of effects.invites) { const l = await sendInvite(biz, doc, pid, actor.id); if (l) shareLinks.push(l); }
  for (const pid of effects.archived) await db.update('invites', `business_id=${db.eq(biz.id)}&person_id=${db.eq(pid)}&used_at=is.null`, { revoked: true });
  if (effects.businessName) await db.update('businesses', `id=${db.eq(biz.id)}`, { name: effects.businessName });
  await applyGrace(biz, doc);
  return { version, doc: viewFor(doc, actor, biz), shareLinks };
});

// ---- billing (owner only)
route('POST', '/billing/checkout', async ({ req }) => {
  const { biz, actor } = await context(req); const { planId } = await body(req);
  if (!isOwner(actor.p)) throw new HttpError(403, 'Only the owner can change the plan.');
  return createCheckout(biz, actor.p, planId);
});
route('POST', '/billing/portal', async ({ req }) => {
  const { biz, actor } = await context(req);
  if (!isOwner(actor.p)) throw new HttpError(403, 'Only the owner can manage billing.');
  return createPortal(biz);
});
route('POST', '/stripe/webhook', async ({ req }) => {
  const raw = await req.text();
  const event = await verifyWebhook(raw, req.headers.get('stripe-signature'));
  return { received: await handleWebhook(event) };
});

// ---- contact form (homepage) → CONTACT_EMAIL
route('POST', '/contact', async ({ req }) => {
  const b = await body(req);
  const ip = (req.headers.get('x-forwarded-for') || 'unknown').split(',')[0].trim();
  if (!(await db.rpc('rate_hit', { p_key: 'contact:' + ip, p_window_seconds: 3600, p_max: 5 }))) throw new HttpError(429, 'Too many messages. Please try again later.');
  const e = normIdent(b.email);
  if (!String(b.name || '').trim() || !e || e.kind !== 'email' || !String(b.message || '').trim()) throw new HttpError(400, 'Please add your name, a valid email and a message.');
  const text = ['Name: ' + String(b.name).slice(0, 80), 'Email: ' + e.value, 'Business: ' + String(b.business || '').slice(0, 80), 'Team size: ' + String(b.size || '').slice(0, 40),
    'Topic: ' + String(b.topic || '').slice(0, 40), '', String(b.message).slice(0, 4000)].join('\n');
  const sent = config.email.contact ? await sendEmail(config.email.contact, `DaySpear contact: ${String(b.topic || 'question').slice(0, 40)}`, text) : false;
  if (!sent) console.log('[contact] not emailed (set RESEND_API_KEY and CONTACT_EMAIL):\n' + text);
  return { ok: true };
});

// ------------------------------------------------------------------ the handler
function cors(req) {
  const origin = (req.headers.get('origin') || '').replace(/\/$/, '');
  const ok = origin && config.allowedOrigins.includes(origin);
  return ok ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-business, x-client-info',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Max-Age': '600', Vary: 'Origin' } : { Vary: 'Origin' };
}
export async function handle(req) {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^.*?\/api(?=\/|$)/, '') || '/';
  const h = cors(req);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: h });
  const send = (status, data) => new Response(JSON.stringify(data), { status, headers: { ...h, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
  try {
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = path.match(r.re); if (!m) continue;
      return send(200, (await r.fn({ req, params: m.groups || {}, url })) ?? { ok: true });
    }
    throw new HttpError(404, 'Not found');
  } catch (err) {
    const e = err instanceof HttpError ? err : (console.error(err), new HttpError(500, 'Something went wrong on our side.'));
    return send(e.status, { error: e.message, ...e.extra });
  }
}
