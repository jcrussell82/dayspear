// TEST ONLY — stands in for Supabase's front door when testing locally without Docker.
//   /auth/v1/*          → Supabase Auth (GoTrue)
//   /rest/v1/*          → PostgREST
//   /functions/v1/api/* → the `api` Edge Function running in Deno
//   /realtime/v1/*      → not used
// It also runs a tiny SMTP server that catches the sign-in code emails Supabase Auth
// sends, and a fake Stripe API, so tests can read codes and check Stripe requests.
//   GET /_mail          → captured emails (newest first)
//   GET /_stripe        → captured Stripe requests
//   GET /_tpl/<name>    → email templates from supabase/templates
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = Number(process.env.GATEWAY_PORT || 54321);
const UP = { auth: Number(process.env.AUTH_PORT || 9999), rest: Number(process.env.REST_PORT || 54330), fn: Number(process.env.FN_PORT || 54340) };
const SMTP_PORT = Number(process.env.SMTP_PORT || 2525);
const STRIPE_PORT = Number(process.env.STRIPE_PORT || 54350);
const mail = [], stripeCalls = [], customers = new Set();

function proxy(req, res, port, newPath) {
  const p = http.request({ host: '127.0.0.1', port, path: newPath, method: req.method, headers: { ...req.headers, host: `127.0.0.1:${port}`, 'x-forwarded-for': req.socket.remoteAddress } }, r => {
    const h = { ...r.headers }; if (res.getHeader('Access-Control-Allow-Origin')) { delete h['access-control-allow-origin']; } res.writeHead(r.statusCode, h); r.pipe(res);
  });
  p.on('error', e => { res.writeHead(502); res.end(JSON.stringify({ error: 'gateway: ' + e.message })); });
  req.pipe(p);
}

http.createServer((req, res) => {
  const u = req.url;
  if (u === '/_mail') { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify(mail)); }
  if (u === '/_stripe') { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify(stripeCalls)); }
  if (u.startsWith('/_tpl/')) { const f = path.join(ROOT, 'supabase', 'templates', path.basename(u)); res.setHeader('Content-Type', 'text/html'); return res.end(fs.existsSync(f) ? fs.readFileSync(f) : ''); }
  if (u.startsWith('/auth/v1/') || u.startsWith('/rest/v1/')) { // hosted Supabase answers browsers from any site on these
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') { res.writeHead(200, { 'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info', 'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS' }); return res.end(); }
  }
  if (u.startsWith('/auth/v1/')) return proxy(req, res, UP.auth, u.slice('/auth/v1'.length));
  if (u.startsWith('/rest/v1/')) return proxy(req, res, UP.rest, u.slice('/rest/v1'.length));
  if (u.startsWith('/functions/v1/')) return proxy(req, res, UP.fn, u.slice('/functions/v1'.length));
  res.writeHead(404); res.end('not found');
}).listen(PORT, '127.0.0.1');

// --- minimal SMTP sink
net.createServer(sock => {
  let data = false, buf = '', msg = { to: [], body: '' };
  const say = s => sock.write(s + '\r\n');
  say('220 sink ESMTP');
  sock.on('data', chunk => {
    buf += chunk.toString('utf8');
    let i;
    while ((i = buf.indexOf('\r\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 2);
      if (data) {
        if (line === '.') { data = false; mail.unshift({ to: msg.to, body: decode(msg.body), at: Date.now() }); msg = { to: [], body: '' }; say('250 OK'); }
        else msg.body += (line.startsWith('..') ? line.slice(1) : line) + '\n';
        continue;
      }
      const cmd = line.slice(0, 4).toUpperCase();
      if (cmd === 'EHLO') { sock.write('250-sink\r\n250 AUTH PLAIN LOGIN\r\n'); }
      else if (cmd === 'HELO') say('250 sink');
      else if (cmd === 'AUTH') say('235 OK');
      else if (cmd === 'MAIL') say('250 OK');
      else if (cmd === 'RCPT') { msg.to.push((line.match(/<([^>]+)>/) || [])[1]); say('250 OK'); }
      else if (cmd === 'DATA') { data = true; say('354 go'); }
      else if (cmd === 'QUIT') { say('221 bye'); sock.end(); }
      else say('250 OK');
    }
  });
  sock.on('error', () => {});
}).listen(SMTP_PORT, '127.0.0.1');
// decode quoted-printable / base64 parts enough to find the code
function decode(b) {
  let out = b.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/g, (m, h) => String.fromCharCode(parseInt(h, 16)));
  const b64 = [...b.matchAll(/\n\n([A-Za-z0-9+/=\n]{40,})\n/g)].map(m => { try { return Buffer.from(m[1].replace(/\n/g, ''), 'base64').toString('utf8'); } catch { return ''; } }).join('\n');
  return out + '\n' + b64;
}

// --- fake Stripe API
http.createServer((req, res) => {
  let body = ''; req.on('data', c => body += c); req.on('end', () => {
    stripeCalls.unshift({ method: req.method, url: req.url, auth: req.headers.authorization, body: Object.fromEntries(new URLSearchParams(body)) });
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/v1/customers') { const id = 'cus_fake_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); customers.add(id); return res.end(JSON.stringify({ id })); }
    if (req.method === 'GET' && req.url.startsWith('/v1/customers/')) { const id = req.url.slice('/v1/customers/'.length); if (customers.has(id)) return res.end(JSON.stringify({ id })); res.statusCode = 404; return res.end(JSON.stringify({ error: { code: 'resource_missing' } })); }
    if (req.url === '/v1/checkout/sessions') return res.end(JSON.stringify({ id: 'cs_fake', url: 'https://checkout.stripe.test/c/cs_fake' }));
    if (req.url === '/v1/billing_portal/sessions') return res.end(JSON.stringify({ url: 'https://billing.stripe.test/p/1' }));
    res.statusCode = 404; res.end('{}');
  });
}).listen(STRIPE_PORT, '127.0.0.1');

console.log(`gateway on ${PORT} (smtp ${SMTP_PORT}, fake stripe ${STRIPE_PORT})`);
