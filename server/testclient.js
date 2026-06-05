// Headless-тест мультирума: хост создаёт комнату, 4 клиента входят по коду, играют драфт.
import { WebSocket } from 'ws';

const URL = process.env.URL || 'ws://localhost:4000';
const NAMES = ['Alice', 'Bob', 'Carol', 'Dave', 'Erin'];
const rnd = (n) => Math.floor(Math.random() * n);
const pick = (a) => a[rnd(a.length)];

let ROOMCODE = null, spawned = false, done = false;

function spawnJoiners() {
  if (spawned) return;
  spawned = true;
  NAMES.slice(1).forEach((n) => makeClient(n, 'join', ROOMCODE));
}

function makeClient(name, mode, code) {
  const ws = new WebSocket(URL);
  const isHost = mode === 'create';
  let myId = null, lastKey = '', startSent = false;
  ws.on('open', () => ws.send(JSON.stringify(isHost ? { type: 'createRoom', name } : { type: 'joinRoom', code, name })));
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    if (msg.type === 'room') { if (isHost) { ROOMCODE = msg.code; spawnJoiners(); } return; }
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
  ws.on('error', (e) => console.error('ws error', name, e.message));
  return ws;
}

function finish(d) {
  const errs = [];
  for (const m of d.managers) {
    if (m.size !== 12) errs.push(`${m.name}: состав ${m.size}`);
    if (!m.substitute) errs.push(`${m.name}: нет замены`);
  }
  console.log('Комната:', ROOMCODE);
  for (const m of d.managers) console.log(`  ${m.name}: 1-${m.counts.DEF}-${m.counts.MID}-${m.counts.FWD} +тренер, $${m.budget}, замена ${m.substitute?.name}`);
  console.log(errs.length ? 'ОШИБКИ: ' + errs.join('; ') : 'OK — мультирум: создание комнаты + вход по коду + полный драфт прошли.');
  process.exit(errs.length ? 1 : 0);
}

makeClient(NAMES[0], 'create');
setTimeout(() => { if (!done) { console.error('таймаут'); process.exit(2); } }, 20000);
