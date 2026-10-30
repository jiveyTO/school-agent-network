// Throwaway probe: can a school-managed student Google account authorize
// this project's OAuth client to read Google Classroom data, read-only?
// Test spike only — not wired into the app. Tokens live in memory only.
// Run: node probe/classroom-auth-test.js

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3001;
const REDIRECT_URI = `http://127.0.0.1:${PORT}/classroom-probe/callback`;
const SCOPES = [
  'https://www.googleapis.com/auth/classroom.courses.readonly',
  'https://www.googleapis.com/auth/classroom.coursework.me.readonly',
  'https://www.googleapis.com/auth/classroom.announcements.readonly',
];

function loadEnvFile() {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadEnvFile();

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';

function fail(error) {
  console.log(`VERDICT: ERROR — ${error && error.message ? error.message : String(error)}`);
  process.exit(1);
}

function buildAuthUrl() {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: SCOPES.join(' '),
    prompt: 'consent',
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

async function exchangeCode(code) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
      grant_type: 'authorization_code',
    }).toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    const detail = data.error_description || data.error || `HTTP ${res.status}`;
    throw new Error(`Token exchange failed: ${detail}`);
  }
  return data.access_token;
}

async function classroomGet(accessToken, resource) {
  const res = await fetch(`https://classroom.googleapis.com/v1/${resource}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail =
      (data.error && (data.error.message || data.error.status)) || `HTTP ${res.status}`;
    throw new Error(`Classroom API failed: ${detail}`);
  }
  return data;
}

function formatDue(courseWork) {
  const due = courseWork.dueDate;
  if (!due) return 'no due date';
  const date = `${due.year}-${String(due.month).padStart(2, '0')}-${String(due.day).padStart(2, '0')}`;
  const time = courseWork.dueTime
    ? ` ${String(courseWork.dueTime.hours || 0).padStart(2, '0')}:${String(courseWork.dueTime.minutes || 0).padStart(2, '0')} UTC`
    : '';
  return `${date}${time}`;
}

async function runProbe(accessToken, res) {
  const coursesData = await classroomGet(
    accessToken,
    `courses?studentId=me&pageSize=100`
  );
  const courses = coursesData.courses || [];
  const active = courses.filter((c) => !c.courseState || c.courseState === 'ACTIVE');
  const first = active[0] || courses[0];

  console.log(`Courses: ${courses.length}`);
  for (const course of courses) console.log(`- ${course.name}`);

  if (first) {
    const workData = await classroomGet(
      accessToken,
      `courses/${encodeURIComponent(first.id)}/courseWork?pageSize=100`
    );
    const announcementsData = await classroomGet(
      accessToken,
      `courses/${encodeURIComponent(first.id)}/announcements?pageSize=100`
    );
    const work = workData.courseWork || [];
    const announcements = announcementsData.announcements || [];
    console.log(`First course: ${first.name}`);
    console.log(`Coursework: ${work.length}`);
    console.log(`Announcements: ${announcements.length}`);
    for (const item of work.slice(0, 3)) {
      console.log(`- ${item.title} — due ${formatDue(item)}`);
    }
  }

  console.log('VERDICT: WORKS');
  respondAndExit(res, 'Probe complete. You can close this tab and return to the terminal.');
}

function respondAndExit(res, text) {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
  setTimeout(() => process.exit(0), 100);
}

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.log(
    'VERDICT: ERROR — GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set in .env first.'
  );
  process.exit(1);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (req.method !== 'GET' || url.pathname !== '/classroom-probe/callback') {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found.');
    return;
  }

  const googleError = url.searchParams.get('error');
  if (googleError) {
    console.log(googleError);
    console.log(`VERDICT: BLOCKED — ${googleError}`);
    respondAndExit(res, `Google returned: ${googleError}`);
    return;
  }

  const code = url.searchParams.get('code');
  if (!code) {
    const message = 'No authorization code returned.';
    console.log(`VERDICT: ERROR — ${message}`);
    respondAndExit(res, message);
    return;
  }

  try {
    const accessToken = await exchangeCode(code);
    await runProbe(accessToken, res);
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    if (/access|admin|permission|forbidden|unauthori[sz]ed|403/i.test(message)) {
      console.log(`VERDICT: BLOCKED — ${message}`);
    } else {
      console.log(`VERDICT: ERROR — ${message}`);
    }
    respondAndExit(res, 'Probe finished. Return to the terminal for the verdict.');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('Open this Google sign-in URL in your browser:');
  console.log(buildAuthUrl());
  console.log(
    "Sign in with the STUDENT's school account (the account that actually has the classes)."
  );
  console.log(`Waiting for Google on ${REDIRECT_URI} ...`);
});
