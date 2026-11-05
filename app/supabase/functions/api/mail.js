// Sends invite and contact-form emails through Resend. (Sign-in codes are sent by Supabase Auth.)
// Without RESEND_API_KEY nothing is sent: the API hands the invite link back to the manager instead.
import { config, emailEnabled } from './config.js';

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const html = (text, link, label) => `<div style="font-family:Inter,Arial,sans-serif;font-size:15px;line-height:1.5;color:#0e210e;max-width:520px">
  <p style="font-weight:700;font-size:18px;color:#2f8a2d;margin:0 0 16px">DaySpear</p>
  ${text.split('\n\n').map(p => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('')}
  ${link ? `<p><a href="${esc(link)}" style="display:inline-block;background:#0e210e;color:#fff;padding:12px 20px;border-radius:999px;text-decoration:none;font-weight:600">${esc(label || 'Open DaySpear')}</a></p>` : ''}
  <p style="color:#6b7a6c;font-size:12px">If you didn't expect this message, you can ignore it.</p></div>`;

export async function sendEmail(to, subject, text, link, label) {
  if (!emailEnabled()) return false;
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST', headers: { Authorization: `Bearer ${config.email.resendKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: config.email.from, to: [to], subject, text: text + (link ? `\n\n${link}` : ''), html: html(text, link, label) }),
  });
  if (!r.ok) { console.error('[email] Resend', r.status, (await r.text()).slice(0, 200)); return false; }
  return true;
}
