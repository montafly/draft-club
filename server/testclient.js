// Headless-тест сетевого цикла: 5 WS-клиентов проходят полный драфт через сервер.
import { WebSocket } from 'ws';

const URL = process.env.URL || 'ws://localhost:3000';
const NAMES = ['Alice', 'Bob', 'Carol', 'Dave', 'Erin'];
const rnd = (n) => Math.floor(Math.random() * n);
const pick = (a) => a[rnd(a.length)];

let done = false;

function makeClient(name, isHost) {
  const ws = new WebSocket(URL);
  let myId = null;
  let lastKey = '';
  let startSent = false;

  ws.on('open', () => ws.send(JSON.stringify({ type: 'join', name })));
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    if (msg.type === 'joined') { myId = msg.you; ws.send(JSON.stringify({ type: 'ready' })); return; }
    if (msg.type !== 'state') return;
    const st = msg.state;

    if (!st.started) {
      if (isHost && !startSent && st.lobby.startable) { startSent = true; ws.send(JSON.stringify({ type: 'start' })); }
      return;
    }
    const d = st.draft;
    if (d.phase === 'done') {
      if (!done) { done = true; finish(d); }
      return;
    }
    if (d.actor !== myId) return;
    const o = d.actorOptions;
    const key = d.phase + ':' + (d.lot ? d.lot.unit.id + '@' + d.lot.highBid : d.actor + ':' + (d.managers.find(m => m.id === myId)?.size));
    if (key === lastKey) return; // не дублируем ход
    lastKey = key;

    if (d.phase === 'nominating') {
      if (o.units.length) ws.send(JSON.stringify({ type: 'nominate', unitId: pick(o.units).id, openingBid: 1 }));
    } else if (d.phase === 'bidding') {
      if (o.canBid && Math.random() < 0.55) ws.send(JSON.stringify({ type: 'bid', amount: o.minAmount }));
      else ws.send(JSON.stringify({ type: 'pass' }));
    } else if (d.phase === 'substitutes') {
      if (o.units.length) ws.send(JSON.stringify({ type: 'pickSubstitute', unitId: pick(o.units).id }));
    }
  });
  ws.on('error', (e) => { console.error('ws error', name, e.message); });
  return ws;
}

function finish(d) {
  const errs = [];
  for (const m of d.managers) {
    if (m.size !== 12) errs.push(`${m.name}: состав ${m.size}`);
    const c = m.counts;
    if (c.GK !== 1) errs.push(`${m.name}: GK ${c.GK}`);
    if (c.COACH !== 1) errs.push(`${m.name}: COACH ${c.COACH}`);
    if (c.DEF < 3 || c.DEF > 5) errs.push(`${m.name}: DEF ${c.DEF}`);
    if (c.MID < 3 || c.MID > 5) errs.push(`${m.name}: MID ${c.MID}`);
    if (c.FWD < 1 || c.FWD > 3) errs.push(`${m.name}: FWD ${c.FWD}`);
    if (m.budget < 0) errs.push(`${m.name}: budget ${m.budget}`);
    if (!m.substitute) errs.push(`${m.name}: нет замены`);
  }
  console.log('Финальные составы:');
  for (const m of d.managers) {
    const c = m.counts;
    console.log(`  ${m.name}: 1-${c.DEF}-${c.MID}-${c.FWD} +тренер, бюджет ${m.budget}, замена ${m.substitute?.name}`);
  }
  console.log(errs.length ? 'ОШИБКИ: ' + errs.join('; ') : 'OK — сетевой драфт прошёл, все составы валидны.');
  process.exit(errs.length ? 1 : 0);
}

NAMES.forEach((n, i) => makeClient(n, i === 0));
setTimeout(() => { if (!done) { console.error('таймаут: драфт не завершился'); process.exit(2); } }, 20000);
