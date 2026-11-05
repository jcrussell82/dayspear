// SQLite storage using Node's built-in driver (no external dependencies).
// Relational tables hold everything security-sensitive (accounts, sessions,
// codes, invites, billing). Each business's scheduling data lives in one
// JSON document in `workspaces`, always loaded by business_id — so one
// business can never read or write another's data.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
export const db = new DatabaseSync(config.dbPath);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

const MIGRATIONS = [
  `CREATE TABLE businesses (
     id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL,
     plan_id TEXT NOT NULL DEFAULT 'free',
     stripe_customer_id TEXT, stripe_subscription_id TEXT, subscription_status TEXT,
     current_period_end TEXT, grace_until TEXT
   );
   CREATE TABLE workspaces (
     business_id TEXT PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
     doc TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL
   );
   CREATE TABLE users ( id TEXT PRIMARY KEY, created_at TEXT NOT NULL );
   CREATE TABLE identities (
     id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     kind TEXT NOT NULL CHECK (kind IN ('email','phone')), value TEXT NOT NULL,
     verified INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
     UNIQUE (kind, value)
   );
   CREATE TABLE memberships (
     business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
     person_id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     created_at TEXT NOT NULL, PRIMARY KEY (business_id, person_id)
   );
   CREATE INDEX memberships_user ON memberships(user_id);
   CREATE TABLE sessions (
     id_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     business_id TEXT, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, last_seen TEXT NOT NULL
   );
   CREATE TABLE codes (
     id TEXT PRIMARY KEY, purpose TEXT NOT NULL, kind TEXT NOT NULL, value TEXT NOT NULL,
     code_hash TEXT NOT NULL, user_id TEXT, meta TEXT, attempts INTEGER NOT NULL DEFAULT 0,
     expires_at TEXT NOT NULL, used_at TEXT, created_at TEXT NOT NULL
   );
   CREATE INDEX codes_lookup ON codes(purpose, kind, value);
   CREATE TABLE invites (
     token_hash TEXT PRIMARY KEY, business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
     person_id TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT, revoked INTEGER NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL
   );
   CREATE TABLE stripe_events ( id TEXT PRIMARY KEY, type TEXT, received_at TEXT NOT NULL );
   CREATE TABLE outbox (
     id TEXT PRIMARY KEY, channel TEXT NOT NULL, recipient TEXT NOT NULL, subject TEXT,
     body TEXT NOT NULL, status TEXT NOT NULL, error TEXT, created_at TEXT NOT NULL
   );`,
];

db.exec('CREATE TABLE IF NOT EXISTS schema_version (v INTEGER NOT NULL)');
const cur = db.prepare('SELECT v FROM schema_version').get();
let v = cur ? cur.v : 0;
if (!cur) db.prepare('INSERT INTO schema_version (v) VALUES (0)').run();
while (v < MIGRATIONS.length) {
  db.exec('BEGIN');
  try { db.exec(MIGRATIONS[v]); v++; db.prepare('UPDATE schema_version SET v = ?').run(v); db.exec('COMMIT'); }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

export const now = () => new Date().toISOString();
// letters and digits only — ids are joined with '-' in channel names (dm-a-b)
export const newId = (p = '') => p + crypto.randomBytes(8).toString('hex');
export const hmac = s => crypto.createHmac('sha256', config.secret).update(String(s)).digest('base64url');

export function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

export const q = {
  one: (sql, ...a) => db.prepare(sql).get(...a),
  all: (sql, ...a) => db.prepare(sql).all(...a),
  run: (sql, ...a) => db.prepare(sql).run(...a),
};
