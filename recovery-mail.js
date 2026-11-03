// Brief 041: recovery email sender. The app wires Resend (a plain HTTPS
// POST, no SDK — this codebase is Node stdlib only). Firebase
// Authentication email-link was considered first per the brief, but it
// needs Firebase/Identity Platform enabled in the console, a client SDK
// in a no-build page, and server-side credential verification via the
// Admin SDK — disproportionate here, and its token would still need the
// app's own single-use token layered on top. Resend carries the app's
// own token instead.
//
// Transports, in order:
//  1. PARENTLOOP_TEST_MAIL_FILE — test-only capture file (JSON lines).
//  2. RECOVERY_MAIL_ENDPOINT — generic JSON webhook (local stubs).
//  3. Resend — needs RESEND_API_KEY and RESEND_FROM (a from-address on a
//     domain verified in Resend). RESEND_API_URL overrides the endpoint.
// When none is configured the sender reports not_configured and the UI
// hides the recovery entry point, so no live button can fail to send.
// The recovery link/token is never logged.

const fs = require('fs');

function isRecoveryMailConfigured() {
  if (process.env.PARENTLOOP_TEST_MAIL_FILE) return true;
  if (process.env.RECOVERY_MAIL_ENDPOINT) return true;
  return Boolean(process.env.RESEND_API_KEY && process.env.RESEND_FROM);
}

async function sendRecoveryEmail({ to, link }) {
  const subject = 'Your ParentLoop recovery link';
  const text = [
    'Hello,',
    '',
    'You asked to get back into your ParentLoop family. Use this link within 60 minutes:',
    '',
    link,
    '',
    'The link works once. If you did not ask for it, you can ignore this email.',
    '',
    '— ParentLoop',
  ].join('\n');

  return sendEmail({ to, subject, text });
}

// One transport for every ParentLoop email (recovery links, the evening
// email). html and headers (e.g. List-Unsubscribe) are optional and only
// reach Resend; the test capture and the generic endpoint get the same
// fields as JSON.
async function sendEmail({ to, subject, text, html, headers }) {
  const testFile = process.env.PARENTLOOP_TEST_MAIL_FILE || '';
  if (testFile) {
    fs.appendFileSync(testFile, JSON.stringify({ to, subject, text, html: html || '', headers: headers || {} }) + '\n');
    return { sent: true, via: 'test-capture' };
  }

  const endpoint = process.env.RECOVERY_MAIL_ENDPOINT || '';
  if (endpoint) {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to, subject, text, html: html || '' }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error('mail endpoint HTTP ' + res.status);
    return { sent: true, via: 'endpoint' };
  }

  const apiKey = process.env.RESEND_API_KEY || '';
  const from = process.env.RESEND_FROM || '';
  if (!apiKey || !from) return { sent: false, reason: 'not_configured' };
  const apiUrl = process.env.RESEND_API_URL || 'https://api.resend.com/emails';
  const payload = { from, to: [to], subject, text };
  if (html) payload.html = html;
  if (headers && Object.keys(headers).length) payload.headers = headers;
  const res = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error('Resend HTTP ' + res.status);
  return { sent: true, via: 'resend' };
}

module.exports = { sendRecoveryEmail, sendEmail, isRecoveryMailConfigured, isMailConfigured: isRecoveryMailConfigured };
