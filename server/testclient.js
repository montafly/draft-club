// Headless-тест с авторизацией: 5 тест-юзеров (Supabase) → комната по коду → драфт.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/); if (m) process.env[m[1]] = m[2].trim();
}
const SB = process.env.SUPABASE_URL, ANON = process.env.SUPABASE_ANON_KEY, SVC = process.env.SUPABASE_SERVICE_KEY;
const URL = process.env.URL || 'ws://localhost:4000';
const rnd = (n) => Math.floor(Math.random() * n);
const pick = (a) => a[rnd(a.length)];

async function tokenFor(i) {
  const email = `dctest${i}@example.com`, pw = 'Test123456!';
  await fetch(`${SB}/auth/v1/admin/users`, { method: 'POST',
    headers: { apikey: SVC, authorization: `Bearer ${SVC}`, 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: pw, email_confirm: true }) }); // если уже есть — ок
  const r = await fetch(`${SB}/auth/v1/token?grant_type=password`, { method: 'POST',
    headers: { apikey: ANON, 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: pw }) });
  return (await r.json()).access_token;
}

let ROOMCODE = null, spawned = false, done = false, TOKENS = [];

function spawnJoiners() {
  if (spawned) return; spawned = true;
  for (let i = 2; i <= 5; i++) makeClient('join', ROOMCODE, TOKENS[i - 1]);
}
function makeClient(mode, code, token) {
  const ws = new WebSocket(URL); const isHost = mode === 'create';
  let myId = null, lastKey = '', startSent = false;
  ws.on('open', () => ws.send(JSON.stringify(isHost ? { type: 'createRoom', token } : { type: 'joinRoom', code, token })));
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    if (msg.type === 'room') { if (isHost) { ROOMCODE = msg.code; spawnJoiners(); } return; }
    if (msg.type === 'error') { console.error('err:', msg.message); return; }
    if (msg.type === 'joined') { myId = msg.you; ws.send(JSON.stringify({ type: 'ready' })); return; }
    if (msg.type !== 'state') return;
    const st = msg.state;
    if (!st.started) { if (isHost && !startSent && st.lobby.startable) { startSent = true; ws.send(JSON.stringify({ type: 'start' })); } return; }
    const d = st.draft;
    if (d.phase === 'done') { if (!done) { done = true; finish(d); } return; }
    if (d.actor !== myId) return;
    const o = d.actorOptions;
    const key = d.phase + ':' + (d.lot ? d.lot.unit.id + '@' + d.lot.highBid : d.actor + ':' + (d.managers.find(m => m.id === myId)?.size));
    if (key === lastKey) return; lastKey = key;
    if (d.phase === 'nominating') { if (o.units.length) ws.send(JSON.stringify({ type: 'nominate', unitId: pick(o.units).id, openingBid: 1 })); }
    else if (d.phase === 'bidding') { if (o.canBid && Math.random() < 0.55) ws.send(JSON.stringify({ type: 'bid', amount: o.minAmount })); else ws.send(JSON.stringify({ type: 'pass' })); }
    else if (d.phase === 'substitutes') { if (o.units.length) ws.send(JSON.stringify({ type: 'pickSubstitute', unitId: pick(o.units).id })); }
  });
  ws.on('error', (e) => console.error('ws error', e.message));
  return ws;
}
function finish(d) {
  const errs = [];
  for (const m of d.managers) { if (m.size !== 12) errs.push(`${m.name}:${m.size}`); if (!m.substitute) errs.push(`${m.name}:нет замены`); }
  console.log('Комната:', ROOMCODE, '| игроки:', d.managers.map(m => m.name).join(', '));
  console.log(errs.length ? 'ОШИБКИ: ' + errs.join('; ') : 'OK — авторизация + мультирум + драфт прошли (имена из профилей).');
  process.exit(errs.length ? 1 : 0);
}

TOKENS = await Promise.all([1, 2, 3, 4, 5].map(tokenFor));
if (TOKENS.some(t => !t)) { console.error('не получил токены:', TOKENS.map(Boolean)); process.exit(2); }
makeClient('create', null, TOKENS[0]);
setTimeout(() => { if (!done) { console.error('таймаут'); process.exit(2); } }, 25000);
