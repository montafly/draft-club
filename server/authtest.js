// Проверка цепочки авторизации: admin-create пользователя → signin → authUser → profile.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
  if (m) process.env[m[1]] = m[2].trim();
}
const { authUser, getProfile } = await import('./auth.js');
const URL = process.env.SUPABASE_URL, ANON = process.env.SUPABASE_ANON_KEY, SVC = process.env.SUPABASE_SERVICE_KEY;

async function adminCreate(email, password) {
  const r = await fetch(`${URL}/auth/v1/admin/users`, { method: 'POST',
    headers: { apikey: SVC, authorization: `Bearer ${SVC}`, 'content-type': 'application/json' },
    body: JSON.stringify({ email, password, email_confirm: true }) });
  return { status: r.status, body: await r.json() };
}
async function signin(email, password) {
  const r = await fetch(`${URL}/auth/v1/token?grant_type=password`, { method: 'POST',
    headers: { apikey: ANON, 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }) });
  return r.json();
}

const email = 'dctest1@example.com', pw = 'Test123456!';
const cr = await adminCreate(email, pw);
console.log('admin create:', cr.status, cr.body.id ? 'id=' + cr.body.id : JSON.stringify(cr.body).slice(0, 160));
const s = await signin(email, pw);
console.log('signin: access_token?', !!s.access_token, s.error_description || s.msg || '');
if (s.access_token) {
  const au = await authUser(s.access_token);
  console.log('authUser ->', au);
  const p = await getProfile(au.id);
  console.log('profile ->', p);
}
