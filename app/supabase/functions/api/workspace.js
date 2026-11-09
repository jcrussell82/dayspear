// Workspace data: loading, privacy-filtered views, and permission-checked changes.
//
// The browser sends a list of entity-level changes ("ops"). Each op is checked
// against the signed-in person's role BEFORE anything is written:
//   owner    – everything in their business
//   manager  – people, shifts, requests, tasks and announcements for the
//              locations they manage
//   employee – their own profile, their own requests, picking up shifts,
//              ticking checklists/to-dos, and messages in channels they belong to
// Server-managed fields (verification, invite status, billing, timestamps,
// "decided by", ids of who did something) are never trusted from the client.
import { HttpError } from './errors.js';
import { PLANS, PRICING, planById } from './plans.js';
import { stripeMode } from './config.js';

const now = () => new Date().toISOString();

// ---------------------------------------------------------------- helpers
const isMgr = p => p && (p.access === 'owner' || p.access === 'manager');
const isOwner = p => p && p.access === 'owner';
const manages = (p, loc) => isOwner(p) || (isMgr(p) && (p.manages || []).includes(loc));
const str = (v, max = 500) => (typeof v === 'string' ? v.slice(0, max) : '');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const deny = (msg = 'You don’t have permission to do that.') => { throw new HttpError(403, msg); };
const byId = (arr, id) => (arr || []).find(x => x.id === id);

export function actorFor(doc, personId) {
  const p = doc.people[personId];
  if (!p || p.status !== 'active') throw new HttpError(403, 'Your access to this business has ended.');
  return { id: personId, p };
}

// checklist "today" state resets once a day at settings.tasks.resetAt in the business's timezone
function checklistDay(doc) {
  const tz = doc.settings?.business?.timezone || 'America/Chicago';
  const [h, m] = String(doc.settings?.tasks?.resetAt || '04:00').split(':').map(Number);
  const t = new Date(Date.now() - (h * 60 + (m || 0)) * 60000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(t);
}
export function resetChecklists(doc) {
  const day = checklistDay(doc); let changed = false;
  for (const c of doc.checklists || []) {
    if (c.day !== day) { if (c.day) c.items.forEach(i => { i.done = false; }); c.day = day; changed = true; }
  }
  return changed;
}

// ---------------------------------------------------------------- plan state
export function planState(biz, doc) {
  let plan = planById(biz.plan_id);
  if (plan.id !== 'free' && !['active', 'trialing', 'past_due'].includes(biz.subscription_status || '')) plan = PLANS[0];
  const people = Object.values(doc.people);
  const active = people.filter(p => p.status === 'active').length;
  const pending = people.filter(p => p.status === 'invited').length;
  return { plan, active, pending, over: active > plan.limit };
}
// Returns the change to make to the business's grace period, or null if none.
export function graceChange(biz, doc) {
  const st = planState(biz, doc);
  if (st.over && !biz.grace_until) return { grace_until: new Date(Date.now() + PRICING.graceDays * 864e5).toISOString() };
  if (!st.over && biz.grace_until) return { grace_until: null };
  return null;
}
function needRoom(biz, doc, extra) {
  const st = planState(biz, doc);
  if (st.active + st.pending + extra > st.plan.limit) {
    const next = PLANS.find(p => st.active + st.pending + extra <= p.limit);
    throw new HttpError(402, `The ${st.plan.name} plan covers ${st.plan.limit} people.`, { code: 'upgrade_required', next: next ? next.id : null });
  }
}

// ---------------------------------------------------------------- views
export function viewFor(doc, actor, biz) {
  const v = structuredClone(doc);
  const me = actor.p;
  const st = planState(biz, doc);
  v.billing = {
    plan: st.plan.name, planId: st.plan.id, status: biz.subscription_status || (st.plan.id === 'free' ? 'free' : null),
    periodEnd: biz.current_period_end, cancelAt: biz.cancel_at || null, graceUntil: biz.grace_until, stripe: stripeMode(),
    hasSubscription: Boolean(biz.stripe_subscription_id),
  };
  v.me = actor.id;
  if (isMgr(me)) {
    if (!isOwner(me)) { delete v.billing.periodEnd; delete v.billing.cancelAt; }
    return v;
  }
  // ---- employee view: only what they need, nothing private about others ----
  const myLocs = me.locs || [];
  const sharing = doc.settings?.messages?.phoneSharing;
  for (const [id, p] of Object.entries(v.people)) {
    if (id === actor.id) continue;
    const keep = { id: p.id, name: p.name, first: p.first, role: p.role, roles: p.roles, locs: p.locs, access: p.access, manages: p.manages, status: p.status, photo: p.photo, theme: 'system' };
    if (sharing && p.sharePhone) keep.phone = p.phone, keep.sharePhone = true;
    if (doc.settings?.messages?.birthdays && p.bdayOptIn && p.birthday) keep.birthday = p.birthday, keep.bdayOptIn = true;
    v.people[id] = keep;
  }
  // shifts: drafts are private to managers — show the last published version or nothing
  v.shifts = (v.shifts || []).map(s => s.draft ? (s.pub ? { ...s, ...s.pub, draft: false, pub: undefined, draftBy: undefined } : null) : s)
    .filter(Boolean).map(s => { delete s.pub; delete s.draftBy; return s; });
  v.timeoff = (v.timeoff || []).filter(t => t.emp === actor.id);
  v.coverLog = (v.coverLog || []).filter(l => l.to === actor.id || l.from === actor.id);
  v.announcements = (v.announcements || []).filter(a => !a.loc || myLocs.includes(a.loc));
  v.checklists = (v.checklists || []).filter(c => myLocs.includes(c.loc));
  v.messages = Object.fromEntries(Object.entries(v.messages || {}).filter(([ch]) => canUseChannel(doc, actor, ch)));
  v.deleted = {}; v.published = {};
  delete v.billing.periodEnd; delete v.billing.cancelAt; delete v.billing.hasSubscription;
  return v;
}

function canUseChannel(doc, actor, ch) {
  const me = actor.p;
  if (ch === 'team-all') return doc.settings?.messages?.teamChat !== false || isMgr(me);
  if (ch.startsWith('team-')) return (doc.settings?.messages?.teamChat !== false || isMgr(me)) && (isOwner(me) || (me.locs || []).includes(ch.slice(5)) || (me.manages || []).includes(ch.slice(5)));
  if (ch.startsWith('dm-')) {
    const ids = ch.slice(3).split('-');
    return ids.length === 2 && ids.includes(actor.id) && ids.every(i => doc.people[i]);
  }
  if (ch.startsWith('sh-')) {
    const s = byId(doc.shifts, ch.slice(3));
    return Boolean(s) && (manages(me, s.loc) || (me.locs || []).includes(s.loc));
  }
  return false;
}

// ---------------------------------------------------------------- applying changes
const SELF_FIELDS = ['phone', 'email', 'sharePhone', 'avail', 'prefHours', 'prefShifts', 'notif', 'birthday', 'bdayOptIn', 'theme', 'photo'];
const MGR_FIELDS = ['role', 'roles', 'locs', 'status'];
const OWNER_FIELDS = [...MGR_FIELDS, 'access', 'manages', 'name', 'first', 'notif'];
const INVITEE_FIELDS = ['name', 'first', 'email', 'phone']; // fixable by a manager until the person accepts
const SERVER_FIELDS = ['verified', 'invited', 'inviteExpires', 'invitedBy', 'invitedAt', 'id', 'userId', 'archived', 'archivedAt', 'accountDeleted'];

// Returns { doc, effects } where effects are side effects the route performs after saving
// (invites to send, identities to update).
export function applyOps(doc, actor, ops, biz) {
  if (!Array.isArray(ops) || ops.length > 500) throw new HttpError(400, 'Invalid change list.');
  const me = actor.p, effects = { invites: [], contactChanges: [], archived: [], restored: [] };
  const settings = doc.settings || {};
  const ts = now();
  const locName = l => doc.locs[l]?.name || 'that location';

  for (const op of ops) {
    const { c, id } = op || {};
    const v = op.v === undefined ? undefined : op.v;
    switch (c) {
      case 'people': people(id, v); break;
      case 'order': if (!isMgr(me)) deny(); if (!Array.isArray(v) || !v.every(x => doc.people[x])) throw new HttpError(400, 'Bad order'); doc.order = [...new Set(v)]; break;
      case 'locs': if (!isOwner(me)) deny('Only the owner can change locations.'); if (v === null) deny('Locations can’t be deleted here.'); doc.locs[id] = { name: str(v.name, 80) || 'Location', short: str(v.short, 3).toUpperCase(), address: str(v.address, 200), hours: str(v.hours, 80) }; doc.messages[`team-${id}`] ||= []; break;
      case 'roles': if (!isOwner(me)) deny('Only the owner can change roles.'); if (v === null) deny(); doc.roles[id] = str(v, 60) || 'Role'; break;
      case 'settings': if (!isOwner(me)) deny('Only the owner can change business settings.'); doc.settings = sanitizeSettings(v, doc.settings); effects.businessName = doc.settings.business.name; break;
      case 'shifts': shift(id, v); break;
      case 'timeoff': timeoff(id, v); break;
      case 'coverLog': if (!isMgr(me)) break; /* employees' pickups are logged by the server */ coverLog(v); break;
      case 'checklists': checklist(id, v); break;
      case 'tasks': task(id, v); break;
      case 'taskOrder': if (!isMgr(me)) deny(); if (Array.isArray(v)) doc.tasks.sort((a, b) => v.indexOf(a.id) - v.indexOf(b.id)); break;
      case 'announcements': announcement(id, v); break;
      case 'messages': message(id, op.append); break;
      case 'published': published(id, v); break;
      case 'deleted': if (!isMgr(me)) deny(); { const loc = String(id).split('|')[1]; if (!manages(me, loc)) deny(); doc.deleted[id] = Math.max(0, Number(v) || 0); } break;
      default: throw new HttpError(400, `Unknown change type: ${c}`);
    }
  }
  return { doc, effects };

  // ---------------- people
  function people(pid, v) {
    const before = doc.people[pid];
    if (v === null) deny('People can’t be deleted — archive them instead.');
    if (!before) {                                  // invite someone new
      if (!isMgr(me)) deny();
      const access = v.access === 'manager' && isOwner(me) ? 'manager' : 'employee';
      const locs = (Array.isArray(v.locs) ? v.locs : []).filter(l => doc.locs[l]);
      if (!locs.length) throw new HttpError(400, 'Pick at least one location.');
      if (!isOwner(me) && !locs.every(l => manages(me, l))) deny('You can only invite people to locations you manage.');
      const email = str(v.email, 254).trim(), phone = str(v.phone, 30).trim();
      if (!email && !phone) throw new HttpError(400, 'Add a mobile number or email for their invite.');
      if (access === 'manager' && !email) throw new HttpError(400, 'Managers need an email address for account recovery.');
      needRoom(biz, doc, 1);
      const role = doc.roles[v.role] ? v.role : Object.keys(doc.roles)[0];
      doc.people[pid] = {
        id: pid, name: str(v.name, 80).trim() || 'New teammate', first: str(v.name, 80).trim().split(' ')[0] || 'New',
        access, manages: access === 'manager' ? locs : [], role, roles: [role], locs, email, phone,
        status: 'invited', invited: 'Invite sent', inviteExpires: 7, invitedBy: actor.id, invitedAt: ts,
        verified: { email: false, phone: false }, photo: '',
        avail: Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map(d => [d, { t: 'any', s: '06:00', e: '18:00' }])),
        prefHours: [0, 40], prefShifts: [],
        notif: { channels: { ...(settings.messages?.defaults || { push: true, email: true, sms: false }) }, events: { schedule: true, openShifts: true, requests: true, messages: true, announcements: true }, follow: access === 'manager' ? locs : undefined },
        birthday: null, bdayOptIn: false, sharePhone: false, theme: 'system',
      };
      if (access === 'employee' && !doc.order.includes(pid)) doc.order.push(pid);
      effects.invites.push(pid);
      return;
    }
    const changed = Object.keys(v || {}).filter(k => !same(before[k], v[k])); // v is a patch: only the fields that changed
    const self = pid === actor.id;
    for (const k of changed) {
      if (SERVER_FIELDS.includes(k)) continue; // server-managed: ignore
      if (self && SELF_FIELDS.includes(k)) continue;
      if (self && isOwner(me) && ['role', 'roles', 'locs', 'manages', 'name', 'first'].includes(k)) continue;
      if (!self && isOwner(me) && (OWNER_FIELDS.includes(k) || (before.status === 'invited' && INVITEE_FIELDS.includes(k)))) continue;
      if (!self && isMgr(me) && !isMgr(before) && (MGR_FIELDS.includes(k) || (before.status === 'invited' && INVITEE_FIELDS.includes(k))) && (before.locs || []).some(l => manages(me, l))) continue;
      deny(self ? `You can’t change your own ${k}.` : `You can’t change ${before.first}’s ${k}.`);
    }
    const next = { ...before };
    for (const k of changed) if (!SERVER_FIELDS.includes(k)) next[k] = v[k];
    // validations
    if (changed.includes('status')) {
      const t = `${before.status}->${next.status}`;
      if (self) deny('You can’t change your own status.');
      if (isOwner(before)) deny('The owner can’t be archived.');
      if (!['active->archived', 'invited->archived', 'archived->active'].includes(t)) deny('That status change isn’t allowed.');
      if (t === 'archived->active' && before.accountDeleted) deny(`${before.first || 'This person'} deleted their DaySpear account. Add them again with a new invite.`);
      if (t === 'archived->active') { needRoom(biz, doc, 1); effects.restored.push(pid); }
      if (t.endsWith('archived')) effects.archived.push(pid), next.archived = 'Archived', next.archivedAt = ts;
      if (t === 'archived->active') { delete next.archived; delete next.archivedAt; }
    }
    if (changed.includes('locs')) {
      next.locs = (next.locs || []).filter(l => doc.locs[l]);
      if (!next.locs.length) throw new HttpError(400, 'Pick at least one location.');
      if (!isOwner(me)) { const touched = [...new Set([...before.locs, ...next.locs])].filter(l => before.locs.includes(l) !== next.locs.includes(l)); if (!touched.every(l => manages(me, l))) deny('You can only change locations you manage.'); }
    }
    if (changed.includes('access')) {
      if (!['employee', 'manager'].includes(next.access)) deny();
      if (next.access === 'manager' && !next.email) throw new HttpError(400, 'Managers need an email address for account recovery.');
      if (next.access === 'employee') { next.manages = []; if (!doc.order.includes(pid)) doc.order.push(pid); }
    }
    if (changed.includes('manages')) next.manages = (next.manages || []).filter(l => doc.locs[l]);
    if (self && (changed.includes('email') || changed.includes('phone'))) {
      if (isMgr(before) && !next.email) throw new HttpError(400, 'Owners and managers need a verified email for account recovery.');
      if (!next.email && !next.phone) throw new HttpError(400, 'Keep at least one way to sign in.');
      next.verified = { ...(before.verified || {}) };
      for (const kind of ['email', 'phone']) if (changed.includes(kind)) { next.verified[kind] = false; effects.contactChanges.push({ kind, value: next[kind], old: before[kind] }); }
    }
    if (!self && before.status === 'invited' && (changed.includes('email') || changed.includes('phone'))) {
      if (!next.email && !next.phone) throw new HttpError(400, 'Add a mobile number or email for their invite.');
      effects.invites.push(pid);
    }
    if (changed.includes('photo') && String(next.photo || '').length > 300_000) throw new HttpError(413, 'That photo is too large.');
    if (changed.includes('name')) next.first = str(next.name, 80).split(' ')[0];
    doc.people[pid] = next;
  }

  // ---------------- shifts
  function shift(sid, v) {
    const before = byId(doc.shifts, sid);
    if (isMgr(me)) {
      if (before && !manages(me, before.loc)) deny(`Only ${locName(before.loc)} managers can change that shift.`);
      if (v === null) { doc.shifts = doc.shifts.filter(s => s.id !== sid); return; }
      if (!manages(me, v.loc)) deny(`You don’t manage ${locName(v.loc)}.`);
      const clean = cleanShift(sid, v);
      if (clean.draft && (!before || !same({ ...before, draftBy: 0 }, { ...clean, draftBy: 0 }))) clean.draftBy = actor.id;
      if (before) Object.assign(before, clean); else doc.shifts.push(clean);
      for (const k of Object.keys(before || {})) if (!(k in clean)) delete before[k];
      return;
    }
    // employee: only coverage actions on visible shifts
    if (!before || v === null || (before.draft && !before.pub)) deny();
    const visibleEmp = before.draft ? before.pub.emp : before.emp;
    if (!(me.locs || []).includes(before.loc)) deny();
    const pubEmp = x => (x.draft ? x.pub && x.pub.emp : x.emp);
    // ---- two-way trades: A offers their shift X for teammate B's shift Y
    if (v.cover && v.cover.trade && v.cover.from === actor.id && visibleEmp === actor.id && !before.cover) {   // A asks
      if (settings.requests?.namedSwaps === false) deny('Your team doesn’t allow asking a specific teammate.');
      const y = byId(doc.shifts, v.cover.trade), b = y && pubEmp(y), bp = b && doc.people[b];
      if (!y || y.id === sid || y.draft || before.draft || !b || b === actor.id || bp.status !== 'active' || y.cover) throw new HttpError(409, 'That shift can’t be traded right now.');
      if (!(me.locs || []).includes(y.loc) || !(bp.locs || []).includes(before.loc)) deny('You can only trade with someone who works at both locations.');
      before.cover = { status: 'needed', from: actor.id, note: str(v.cover.note, 300), target: b, trade: y.id };
      return;
    }
    if (before.cover && before.cover.trade) {
      const c = before.cover;
      if (c.from === actor.id && visibleEmp === actor.id && !v.cover) { delete before.cover; return; }       // A cancels
      if (c.target !== actor.id || c.status !== 'needed') deny('That shift change isn’t allowed.');
      if (!v.cover) { delete before.cover; return; }                                                        // B declines
      if (v.cover.status !== 'offered' || v.cover.offerBy !== actor.id) deny('That shift change isn’t allowed.');
      const y = byId(doc.shifts, c.trade);
      if (!y || y.draft || before.draft || y.emp !== actor.id || y.cover || before.emp !== c.from) { throw new HttpError(409, 'That trade is no longer possible — one of the shifts changed.'); }
      if (settings.requests?.autoApprove) {                                                                 // B accepts, auto-approved
        const id = 'c' + Date.now().toString(36);
        doc.coverLog.push({ id: id + 'a', shiftId: sid, from: c.from, to: actor.id, at: ts, by: 'auto', trade: y.id });
        doc.coverLog.push({ id: id + 'b', shiftId: y.id, from: actor.id, to: c.from, at: ts, by: 'auto', trade: sid });
        before.emp = actor.id; y.emp = c.from; delete before.cover; return;
      }
      before.cover = { ...c, status: 'offered', offerBy: actor.id }; return;                               // B accepts → manager approves
    }
    if (v.cover && v.cover.from === actor.id && visibleEmp === actor.id && !before.cover) {           // ask for coverage
      const target = v.cover.target && doc.people[v.cover.target]?.status === 'active' && settings.requests?.namedSwaps !== false ? v.cover.target : undefined;
      before.cover = { status: 'needed', from: actor.id, note: str(v.cover.note, 300), ...(target ? { target } : {}) };
      return;
    }
    if (before.cover && before.cover.from === actor.id && visibleEmp === actor.id && before.cover.status === 'needed' && !v.cover) { delete before.cover; return; } // cancel my request
    if (before.cover && before.cover.status === 'needed' && visibleEmp !== actor.id && (!before.cover.target || before.cover.target === actor.id)) {
      if (settings.requests?.autoApprove && v.emp === actor.id) {                                     // pick up, auto-approved
        doc.coverLog.push({ id: 'c' + Date.now().toString(36), shiftId: sid, from: before.cover.from || before.emp || null, to: actor.id, at: ts, by: 'auto' });
        before.emp = actor.id; delete before.cover; return;
      }
      if (v.cover && v.cover.status === 'offered' && v.cover.offerBy === actor.id) { before.cover = { ...before.cover, status: 'offered', offerBy: actor.id }; return; }
    }
    deny('That shift change isn’t allowed.');
  }
  function cleanShift(sid, v) {
    const s = { id: sid, wk: str(v.wk, 10), d: Math.min(6, Math.max(0, Number(v.d) || 0)), emp: v.emp && doc.people[v.emp] ? v.emp : null,
      s: str(v.s, 5), e: str(v.e, 5), role: doc.roles[v.role] ? v.role : Object.keys(doc.roles)[0], loc: v.loc, ck: v.ck || null, draft: Boolean(v.draft) };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s.wk) || !/^\d\d:\d\d$/.test(s.s) || !/^\d\d:\d\d$/.test(s.e)) throw new HttpError(400, 'Invalid shift.');
    if (v.cover) s.cover = { status: v.cover.status === 'offered' ? 'offered' : 'needed', from: v.cover.from || null, note: str(v.cover.note, 300), ...(v.cover.offerBy ? { offerBy: v.cover.offerBy } : {}), ...(v.cover.target ? { target: v.cover.target } : {}), ...(v.cover.trade ? { trade: str(v.cover.trade, 40) } : {}) };
    if (v.pub) s.pub = { emp: v.pub.emp && doc.people[v.pub.emp] ? v.pub.emp : null, d: Math.min(6, Math.max(0, Number(v.pub.d) || 0)), s: str(v.pub.s, 5), e: str(v.pub.e, 5), role: str(v.pub.role, 40), loc: str(v.pub.loc, 40) };
    if (v.draftBy) s.draftBy = v.draftBy;
    return s;
  }

  // ---------------- time off
  function timeoff(tid, v) {
    const before = byId(doc.timeoff, tid);
    if (!before) {
      if (v === null) return;
      const emp = isMgr(me) && v.emp ? v.emp : actor.id;
      if (emp !== actor.id && !(doc.people[emp]?.locs || []).some(l => manages(me, l))) deny();
      const t = { id: tid, emp, wk: str(v.wk, 10), d: Math.min(6, Math.max(0, Number(v.d) || 0)), status: 'pending', reason: str(v.reason, 200) || 'Personal', sentAt: ts };
      if (settings.requests?.multiDay !== false && Number(v.days) > 1) t.days = Math.min(60, Number(v.days));
      if (settings.requests?.partialDay !== false && v.s && v.e) { t.s = str(v.s, 5); t.e = str(v.e, 5); }
      doc.timeoff.push(t); return;
    }
    if (!isMgr(me) || !(doc.people[before.emp]?.locs || []).some(l => manages(me, l))) deny('Only a manager of their location can decide this request.');
    if (v === null) deny();
    if (v.status === before.status) return;
    if (before.status === 'pending' && ['approved', 'declined'].includes(v.status)) { before.status = v.status; before.decidedBy = actor.id; before.decidedAt = ts; return; }
    if (v.status === 'pending' && before.decidedBy === actor.id) { before.status = 'pending'; delete before.decidedBy; delete before.decidedAt; return; } // undo
    throw new HttpError(409, `This request was already ${before.status}${before.decidedBy && doc.people[before.decidedBy] ? ` by ${doc.people[before.decidedBy].first}` : ''}.`);
  }
  function coverLog(v) {
    if (!v || !v.shiftId) return;
    const s = byId(doc.shifts, v.shiftId);
    if (!s || !manages(me, s.loc)) deny();
    if (!byId(doc.coverLog, v.id)) doc.coverLog.push({ id: str(v.id, 40), shiftId: v.shiftId, from: v.from || null, to: v.to, at: ts, by: actor.id, ...(v.trade ? { trade: str(v.trade, 40) } : {}) });
  }

  // ---------------- checklists
  function checklist(cid, v) {
    const before = byId(doc.checklists, cid);
    if (isMgr(me)) {
      const loc = (v || before).loc;
      if (!manages(me, loc) || (before && !manages(me, before.loc))) deny();
      if (v === null) { doc.checklists = doc.checklists.filter(c => c.id !== cid); return; }
      const clean = { id: cid, name: str(v.name, 80), loc: v.loc, assign: { type: v.assign?.type === 'location' ? 'location' : 'shift', label: str(v.assign?.label, 80) },
        items: (v.items || []).slice(0, 100).map(i => ({ t: str(i.t, 200), done: Boolean(i.done) })), day: before?.day };
      if (before) Object.assign(before, clean); else doc.checklists.push(clean);
      return;
    }
    if (!before || v === null || !(me.locs || []).includes(before.loc) || v.items?.length !== before.items.length) deny();
    before.items.forEach((it, i) => { if (v.items[i].t !== it.t) deny(); it.done = Boolean(v.items[i].done); });
  }

  // ---------------- to-dos
  function relevantTo(t, pid) {
    const p = doc.people[pid], a = t.assign || {};
    if (a.type === 'person') return a.ref === pid;
    if (a.type === 'shift') { const s = byId(doc.shifts, a.ref); return Boolean(s && s.emp === pid); }
    if (a.type === 'location') return (p.locs || []).includes(a.ref);
    return false;
  }
  function taskLocs(t) {
    const a = t.assign || {};
    if (a.type === 'location') return [a.ref];
    if (a.type === 'shift') { const s = byId(doc.shifts, a.ref); return s ? [s.loc] : []; }
    return doc.people[a.ref]?.locs || [];
  }
  function task(tid, v) {
    const before = byId(doc.tasks, tid);
    const leads = settings.tasks?.whoCreates === 'everyone' || (settings.tasks?.whoCreates === 'leads' && (me.roles || []).some(r => /lead/i.test(doc.roles[r] || '')));
    if (isMgr(me) || (!before && leads)) {
      if (before && !isOwner(me) && !taskLocs(before).some(l => manages(me, l)) && !isMgr(me)) deny();
      if (v === null) { if (!isMgr(me)) deny(); doc.tasks = doc.tasks.filter(t => t.id !== tid); return; }
      const clean = { id: tid, title: str(v.title, 200), assign: { type: ['person', 'shift', 'location'].includes(v.assign?.type) ? v.assign.type : 'person', ref: str(v.assign?.ref, 40) },
        due: v.due && v.due.wk ? { wk: str(v.due.wk, 10), d: Number(v.due.d) || 0 } : null, status: ['todo', 'doing', 'done'].includes(v.status) ? v.status : 'todo',
        items: (v.items || []).slice(0, 50).map(i => ({ t: str(i.t, 200), done: Boolean(i.done) })) };
      if (!isOwner(me) && isMgr(me) && !taskLocs(clean).some(l => manages(me, l))) deny('You can only assign to-dos within your locations.');
      if (before) Object.assign(before, clean); else doc.tasks.unshift(clean);
      return;
    }
    if (!before || v === null || !relevantTo(before, actor.id)) deny();
    if (['todo', 'doing', 'done'].includes(v.status)) before.status = v.status;
    if (Array.isArray(v.items) && v.items.length === (before.items || []).length) before.items.forEach((it, i) => { it.done = Boolean(v.items[i].done); });
  }

  // ---------------- announcements
  function announcement(aid, v) {
    const before = byId(doc.announcements, aid);
    if (!before) {
      if (!isMgr(me) || v === null) deny('Only managers can post announcements.');
      const loc = v.loc && doc.locs[v.loc] ? v.loc : null;
      if (loc ? !manages(me, loc) : !(isOwner(me) || Object.keys(doc.locs).every(l => manages(me, l)))) deny('You can only post to locations you manage.');
      doc.announcements.unshift({ id: aid, title: str(v.title, 120), text: str(v.text, 4000), from: actor.id, loc, at: ts, pinned: Boolean(v.pinned), seen: [] });
      return;
    }
    if (v === null) { if (!isMgr(me) || (before.loc ? !manages(me, before.loc) : !isOwner(me))) deny(); doc.announcements = doc.announcements.filter(a => a.id !== aid); return; }
    if (Array.isArray(v.seen) && v.seen.includes(actor.id) && !before.seen.includes(actor.id)) before.seen.push(actor.id);
    if (isMgr(me) && before.from === actor.id) { before.pinned = Boolean(v.pinned); }
  }

  // ---------------- messages
  function message(ch, items) {
    if (!canUseChannel(doc, actor, ch)) deny('You can’t post in that conversation.');
    if (!Array.isArray(items) || items.length > 20) throw new HttpError(400, 'Bad message.');
    doc.messages[ch] ||= [];
    for (const m of items) {
      const text = str(m.text, 2000).trim();
      if (text) doc.messages[ch].push({ from: actor.id, text, at: ts });
    }
  }

  // ---------------- publishing
  function published(wk, v) {
    if (!isMgr(me)) deny();
    doc.published[wk] ||= {};
    for (const loc of Object.keys(v || {})) {
      if (!manages(me, loc)) deny(`You don’t manage ${locName(loc)}.`);
      doc.published[wk][loc] = { by: actor.id, at: ts }; // the browser only sends locations it just published
    }
  }
}

function sanitizeSettings(v, prev) {
  const s = structuredClone(prev || {});
  const pick = (obj, keys) => Object.fromEntries(keys.filter(k => obj && obj[k] !== undefined).map(k => [k, obj[k]]));
  s.business = { ...s.business, ...pick(v.business, ['name', 'type', 'timezone']) };
  s.business.name = str(s.business.name, 80) || 'My business';
  s.sched = { ...s.sched, ...pick(v.sched, ['weekStart', 'otHours', 'notifyChangedOnly']) };
  s.requests = { ...s.requests, ...pick(v.requests, ['autoApprove', 'namedSwaps', 'partialDay', 'multiDay', 'noticeDays']) };
  s.messages = { ...s.messages, ...pick(v.messages, ['teamChat', 'birthdays', 'phoneSharing', 'quietHours']), defaults: { ...s.messages?.defaults, ...pick(v.messages?.defaults, ['push', 'email', 'sms']) } };
  s.tasks = { ...s.tasks, ...pick(v.tasks, ['progress', 'resetAt', 'whoCreates']) };
  return s;
}

// ---------------------------------------------------------------- new business
export function defaultSettings(name, type) {
  return {
    business: { name, type, timezone: 'America/Chicago' },
    sched: { weekStart: 'Monday', otHours: 40, notifyChangedOnly: true },
    requests: { autoApprove: false, namedSwaps: true, partialDay: true, multiDay: true, noticeDays: 7 },
    messages: { teamChat: true, birthdays: true, phoneSharing: false, quietHours: true, defaults: { push: true, email: true, sms: false } },
    tasks: { progress: 'today', resetAt: '04:00', whoCreates: 'leads' },
  };
}
export function blankPerson(o) {
  return Object.assign({
    access: 'employee', manages: [], status: 'active', role: '', roles: [], locs: [], phone: '', email: '', photo: '',
    avail: Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map(d => [d, { t: 'any', s: '06:00', e: '18:00' }])), prefHours: [0, 40], prefShifts: [],
    notif: { channels: { push: true, email: true, sms: false }, events: { schedule: true, openShifts: true, requests: true, messages: true, announcements: true } },
    birthday: null, bdayOptIn: false, sharePhone: false, theme: 'system', verified: { email: false, phone: false },
  }, o);
}

export { isMgr, isOwner, manages };
