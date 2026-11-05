// Passwordless sign-in: one-time 6-digit codes sent to a verified email or
// mobile number. Codes and session tokens are stored only as HMAC hashes.
import crypto from 'node:crypto';
import { config } from './config.js';
import { q, newId, now, hmac } from './db.js';

export class HttpError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
}

// ---------- identifiers ----------
export function normIdent(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  if (s.includes('@')) {
    const v = s.toLowerCase();
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) && v.length <= 254 ? { kind: 'email', value: v } : null;
  }
  let d = s.replace(/\D/g, '');
  if (s.startsWith('+')) return d.length >= 10 && d.length <= 15 ? { kind: 'phone', value: '+' + d } : null;
  if (d.length === 10) return { kind: 'phone', value: '+1' + d };           // default: US/Canada
  if (d.length === 11 && d.startsWith('1')) return { kind: 'phone', value: '+' + d };
  return null;
}
export const mask = (kind, v) => {
  if (kind === 'email') { const [u, d] = v.split('@'); return `${u[0]}${'•'.repeat(Math.max(2, u.length - 1))}@${d}`; }
  return `(•••) •••-${v.slice(-4)}`;
};
export const findIdentity = (kind, value) => q.one('SELECT * FROM identities WHERE kind = ? AND value = ?', kind, value);
export const userIdentities = userId => q.all('SELECT * FROM identities WHERE user_id = ?', userId);

// ---------- rate limiting (in memory; fine for a single server instance) ----------
const buckets = new Map();
export function rateLimit(key, max, windowMs) {
  const t = Date.now(); const b = buckets.get(key);
  if (!b || b.reset < t) { buckets.set(key, { n: 1, reset: t + windowMs }); return; }
  if (++b.n > max) throw new HttpError(429, 'Too many attempts. Please wait a few minutes and try again.');
}
setInterval(() => { const t = Date.now(); for (const [k, b] of buckets) if (b.reset < t) buckets.delete(k); }, 60_000).unref();

// ---------- one-time codes ----------
const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;

export function createCode(purpose, kind, value, { userId = null, meta = null } = {}) {
  q.run("UPDATE codes SET used_at = ? WHERE purpose = ? AND kind = ? AND value = ? AND used_at IS NULL", now(), purpose, kind, value);
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  const id = newId('c_');
  q.run('INSERT INTO codes (id, purpose, kind, value, code_hash, user_id, meta, expires_at, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
    id, purpose, kind, value, hmac(`${id}:${code}`), userId, meta ? JSON.stringify(meta) : null,
    new Date(Date.now() + CODE_TTL_MS).toISOString(), now());
  return code;
}

export function consumeCode(purpose, kind, value, code) {
  const row = q.one("SELECT * FROM codes WHERE purpose = ? AND kind = ? AND value = ? AND used_at IS NULL ORDER BY created_at DESC LIMIT 1", purpose, kind, value);
  if (!row || row.expires_at < now()) throw new HttpError(400, 'That code has expired. Request a new one.');
  if (row.attempts >= MAX_ATTEMPTS) throw new HttpError(429, 'Too many wrong codes. Request a new one.');
  const ok = crypto.timingSafeEqual(Buffer.from(hmac(`${row.id}:${String(code).replace(/\D/g, '')}`)), Buffer.from(row.code_hash));
  if (!ok) { q.run('UPDATE codes SET attempts = attempts + 1 WHERE id = ?', row.id); throw new HttpError(400, 'That code isn’t right. Check it and try again.'); }
  q.run('UPDATE codes SET used_at = ? WHERE id = ?', now(), row.id);
  return { ...row, meta: row.meta ? JSON.parse(row.meta) : null };
}

// ---------- sessions ----------
const COOKIE = 'ds_session';
const LONG = 30 * 24 * 3600 * 1000, SHORT = 12 * 3600 * 1000;

export function createSession(res, userId, businessId, keep = true) {
  const token = crypto.randomBytes(32).toString('base64url');
  const ttl = keep ? LONG : SHORT;
  q.run('INSERT INTO sessions (id_hash, user_id, business_id, created_at, expires_at, last_seen) VALUES (?,?,?,?,?,?)',
    hmac(token), userId, businessId, now(), new Date(Date.now() + ttl).toISOString(), now());
  const parts = [`${COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (config.secureCookies) parts.push('Secure');
  if (keep) parts.push(`Max-Age=${Math.floor(ttl / 1000)}`);
  res.setHeader('Set-Cookie', parts.join('; '));
}

export function readCookie(req, name) {
  const h = req.headers.cookie || '';
  for (const part of h.split(';')) { const [k, ...v] = part.trim().split('='); if (k === name) return v.join('='); }
  return null;
}

export function getSession(req) {
  const token = readCookie(req, COOKIE);
  if (!token) return null;
  const s = q.one('SELECT * FROM sessions WHERE id_hash = ?', hmac(token));
  if (!s || s.expires_at < now()) return null;
  if (Date.now() - Date.parse(s.last_seen) > 5 * 60 * 1000) q.run('UPDATE sessions SET last_seen = ? WHERE id_hash = ?', now(), s.id_hash);
  return { ...s, token };
}

export function destroySession(req, res) {
  const token = readCookie(req, COOKIE);
  if (token) q.run('DELETE FROM sessions WHERE id_hash = ?', hmac(token));
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${config.secureCookies ? '; Secure' : ''}`);
}

export const setSessionBusiness = (s, businessId) => q.run('UPDATE sessions SET business_id = ? WHERE id_hash = ?', businessId, s.id_hash);
