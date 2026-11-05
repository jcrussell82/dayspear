// Email and SMS delivery boundary. Providers are chosen with environment
// variables. Nothing is sent unless a provider is configured — the default
// "console" provider only logs messages and records them in the outbox table
// (useful in development). Every attempt is recorded in `outbox`.
import { config, smsEnabled } from './config.js';
import { q, newId, now } from './db.js';

function record(channel, recipient, subject, body, status, error) {
  // Once real delivery is on, don't keep usable codes or invite links in the database.
  if (status !== 'logged') { body = body.replace(/\b\d{6}\b/g, '••••••').replace(/#invite\/[\w-]+/g, '#invite/•••'); subject = subject && subject.replace(/\b\d{6}\b/g, '••••••'); }
  q.run('INSERT INTO outbox (id, channel, recipient, subject, body, status, error, created_at) VALUES (?,?,?,?,?,?,?,?)',
    newId('m_'), channel, recipient, subject || null, body, status, error || null, now());
}

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const html = (text, link) => `<div style="font-family:Inter,Arial,sans-serif;font-size:15px;line-height:1.5;color:#0e210e;max-width:520px">
  <p style="font-weight:700;font-size:18px;color:#2f8a2d;margin:0 0 16px">DaySpear</p>
  ${text.split('\n\n').map(p => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('')}
  ${link ? `<p><a href="${esc(link)}" style="display:inline-block;background:#0e210e;color:#fff;padding:12px 20px;border-radius:999px;text-decoration:none;font-weight:600">${esc(link.includes('#invite') ? 'Set up my account' : 'Open DaySpear')}</a></p>` : ''}
  <p style="color:#6b7a6c;font-size:12px">If you didn't expect this message, you can ignore it.</p></div>`;

export async function sendEmail(to, subject, text, link) {
  const p = config.email.provider;
  try {
    if (p === 'resend') {
      if (!config.email.resendKey) throw new Error('RESEND_API_KEY is not set');
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST', headers: { Authorization: `Bearer ${config.email.resendKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: config.email.from, to: [to], subject, text: text + (link ? `\n\n${link}` : ''), html: html(text, link) }),
      });
      if (!r.ok) throw new Error(`Resend ${r.status}: ${(await r.text()).slice(0, 200)}`);
    } else if (p === 'postmark') {
      if (!config.email.postmarkToken) throw new Error('POSTMARK_SERVER_TOKEN is not set');
      const r = await fetch('https://api.postmarkapp.com/email', {
        method: 'POST', headers: { 'X-Postmark-Server-Token': config.email.postmarkToken, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ From: config.email.from, To: to, Subject: subject, TextBody: text + (link ? `\n\n${link}` : ''), HtmlBody: html(text, link), MessageStream: 'outbound' }),
      });
      if (!r.ok) throw new Error(`Postmark ${r.status}: ${(await r.text()).slice(0, 200)}`);
    } else {
      console.log(`\n[email:console] To: ${to}\nSubject: ${subject}\n${text}${link ? `\n${link}` : ''}\n`);
    }
    record('email', to, subject, text + (link ? `\n${link}` : ''), p === 'console' ? 'logged' : 'sent');
    return true;
  } catch (e) {
    console.error('[email] failed:', e.message);
    record('email', to, subject, text, 'failed', e.message);
    return false;
  }
}

export async function sendSms(to, text) {
  const p = config.sms.provider;
  try {
    if (!smsEnabled()) throw new Error('Text messages are not set up (SMS_PROVIDER).');
    if (p === 'twilio') {
      const { twilioSid: sid, twilioToken: tok, twilioFrom: from } = config.sms;
      const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
        method: 'POST',
        headers: { Authorization: 'Basic ' + Buffer.from(`${sid}:${tok}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ To: to, From: from, Body: text }),
      });
      if (!r.ok) throw new Error(`Twilio ${r.status}: ${(await r.text()).slice(0, 200)}`);
    } else {
      console.log(`\n[sms:console] To: ${to}\n${text}\n`);
    }
    record('sms', to, null, text, p === 'console' ? 'logged' : 'sent');
    return true;
  } catch (e) {
    console.error('[sms] failed:', e.message);
    record('sms', to, null, text, 'failed', e.message);
    return false;
  }
}

export const deliver = (kind, value, subject, text, link) =>
  kind === 'email' ? sendEmail(value, subject, text, link) : sendSms(value, text + (link ? ` ${link}` : ''));
