// Talks to the database through Supabase's REST API (PostgREST) with the service role.
// The tables are locked to everyone else (see supabase/migrations).
import { config } from './config.js';
import { HttpError } from './errors.js';

const headers = extra => {
  const k = config.serviceKey;
  // legacy service_role keys are JWTs; newer "sb_secret_" keys go in the apikey header only
  return { apikey: k, ...(k.startsWith('eyJ') ? { Authorization: `Bearer ${k}` } : {}), 'Content-Type': 'application/json', ...extra };
};
async function call(method, path, body, prefer) {
  const r = await fetch(`${config.supabaseUrl}/rest/v1/${path}`, { method, headers: headers(prefer ? { Prefer: prefer } : {}), body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  const data = text ? JSON.parse(text) : null;
  if (!r.ok) { const e = new HttpError(r.status >= 500 ? 502 : 500, 'The database couldn’t complete that request.'); e.db = data; console.error('[db]', method, path, r.status, text.slice(0, 300)); throw e; }
  return data;
}
const enc = encodeURIComponent;
export const db = {
  one: async (table, filter) => (await call('GET', `${table}?${filter}&limit=1`))[0] || null,
  all: (table, filter) => call('GET', `${table}?${filter}`),
  insert: (table, row, prefer = 'return=minimal') => call('POST', table, row, prefer),
  update: (table, filter, patch) => call('PATCH', `${table}?${filter}`, patch, 'return=representation'),
  remove: (table, filter) => call('DELETE', `${table}?${filter}`, undefined, 'return=minimal'),
  rpc: async (fn, args) => {
    const r = await fetch(`${config.supabaseUrl}/rest/v1/rpc/${fn}`, { method: 'POST', headers: headers(), body: JSON.stringify(args) });
    const text = await r.text(); const data = text ? JSON.parse(text) : null;
    if (!r.ok) { const e = new HttpError(500, 'The database couldn’t complete that request.'); e.db = data; e.dbMessage = data && data.message; if (!/invite_expired|version_conflict/.test(String(e.dbMessage))) console.error('[db rpc]', fn, r.status, text.slice(0, 300)); throw e; }
    return data;
  },
  eq: v => 'eq.' + enc(v),
};
