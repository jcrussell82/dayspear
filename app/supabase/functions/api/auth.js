// Who is calling? The browser signs in with Supabase Auth (one-time email or text codes)
// and sends its access token. We ask Supabase Auth to confirm it on every request.
import { config } from './config.js';

export async function getUser(req) {
  const h = req.headers.get('authorization') || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!token || token.split('.').length !== 3) return null; // not a user session (e.g. the public key)
  const r = await fetch(`${config.supabaseUrl}/auth/v1/user`, { headers: { apikey: config.serviceKey, Authorization: `Bearer ${token}` } });
  if (!r.ok) return null;
  const u = await r.json();
  return u && u.id ? u : null;
}

export async function sha256(s) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
}
export const randomToken = (bytes = 24) => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(bytes)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
// letters and digits only — ids are joined with '-' in channel names (dm-a-b)
export const newId = (p = '') => p + [...crypto.getRandomValues(new Uint8Array(8))].map(x => x.toString(16).padStart(2, '0')).join('');

export function normIdent(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  if (s.includes('@')) { const v = s.toLowerCase(); return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) && v.length <= 254 ? { kind: 'email', value: v } : null; }
  const d = s.replace(/\D/g, '');
  if (s.startsWith('+')) return d.length >= 10 && d.length <= 15 ? { kind: 'phone', value: '+' + d } : null;
  if (d.length === 10) return { kind: 'phone', value: '+1' + d };
  if (d.length === 11 && d.startsWith('1')) return { kind: 'phone', value: '+' + d };
  return null;
}
