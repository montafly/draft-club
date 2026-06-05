// Детерминированные проверки подсчёта: очки тренера, срабатывание замены, тай-брейки.
import { scoreManager, standings } from './scoring.js';

let failed = 0;
const eq = (got, exp, msg) => {
  const ok = JSON.stringify(got) === JSON.stringify(exp);
  console.log((ok ? 'OK  ' : 'FAIL') + ' ' + msg + (ok ? '' : ` | got ${JSON.stringify(got)} exp ${JSON.stringify(exp)}`));
  if (!ok) failed++;
};

// helper: собрать валидный состав 1GK+3DEF+5MID+2FWD+1COACH (=12) и замену
function squad(idBase, club = 'X') {
  const u = (pos, i) => ({ id: idBase + i, name: `${pos}${idBase + i}`, club, position: pos });
  let i = 0;
  const roster = [
    u('GK', i++), u('DEF', i++), u('DEF', i++), u('DEF', i++),
    u('MID', i++), u('MID', i++), u('MID', i++), u('MID', i++), u('MID', i++),
    u('FWD', i++), u('FWD', i++), u('COACH', i++),
  ];
  return { roster, nextId: idBase + i };
}

// Сценарий 1: тренер приносит очки вышедших на замену; все сыграли; замена не срабатывает.
{
  const { roster, nextId } = squad(100);
  const sub = { id: nextId, name: 'SUBdef', club: 'X', position: 'DEF' };
  const m = { id: 1, name: 'M1', roster, substitute: sub, finishOrder: 1 };
  const results = {};
  for (const u of roster) results[u.id] = { points: 1, played: true };
  results[roster[11].id] = { points: 7, played: true };   // тренер: сумма вышедших на замену = 7
  results[sub.id] = { points: 5, played: true };
  const s = scoreManager(m, results);
  // base = 11 игроков по 1 + тренер 7 = 18; замена не срабатывает (нет DNP)
  eq([s.total, s.subActivated], [18, false], 'тренер даёт очки; замена без DNP не срабатывает');
}

// Сценарий 2: один защитник не сыграл (DNP) + защитник на замене → срабатывает.
{
  const { roster, nextId } = squad(200);
  const sub = { id: nextId, name: 'SUBdef', club: 'X', position: 'DEF' };
  const m = { id: 2, name: 'M2', roster, substitute: sub, finishOrder: 1 };
  const results = {};
  for (const u of roster) results[u.id] = { points: 2, played: true };
  results[roster[1].id] = { points: 0, played: false };   // DEF не сыграл
  results[sub.id] = { points: 6, played: true };
  const s = scoreManager(m, results);
  // 12 юнитов по 2, но DNP-защитник даёт 0 → 11*2 = 22; +замена 6 = 28
  eq([s.total, s.subActivated], [28, true], 'DNP-защитник + защитник на замене → срабатывает (+6)');
}

// Сценарий 3: DNP-защитник, но на замене ВРАТАРЬ → не срабатывает.
{
  const { roster, nextId } = squad(300);
  const sub = { id: nextId, name: 'SUBgk', club: 'X', position: 'GK' };
  const m = { id: 3, name: 'M3', roster, substitute: sub, finishOrder: 1 };
  const results = {};
  for (const u of roster) results[u.id] = { points: 2, played: true };
  results[roster[1].id] = { points: 0, played: false };   // DEF не сыграл
  results[sub.id] = { points: 9, played: true };
  const s = scoreManager(m, results);
  eq([s.subActivated], [false], 'вратарь-замена не меняет полевого DNP');
}

// Сценарий 4: 5 защитников, DNP-нападающий, защитник на замене → НЕ срабатывает (DEF стало бы 6).
{
  // состав 1GK+5DEF+3MID+2FWD+1COACH = 12
  const u = (pos, i, club = 'X') => ({ id: 400 + i, name: `${pos}${i}`, club, position: pos });
  let i = 0;
  const roster = [u('GK', i++), u('DEF', i++), u('DEF', i++), u('DEF', i++), u('DEF', i++), u('DEF', i++),
                  u('MID', i++), u('MID', i++), u('MID', i++), u('FWD', i++), u('FWD', i++), u('COACH', i++)];
  const sub = { id: 499, name: 'SUBdef', club: 'X', position: 'DEF' };
  const m = { id: 4, name: 'M4', roster, substitute: sub, finishOrder: 1 };
  const results = {};
  for (const x of roster) results[x.id] = { points: 1, played: true };
  results[roster[9].id] = { points: 0, played: false };   // FWD не сыграл
  results[sub.id] = { points: 8, played: true };
  const s = scoreManager(m, results);
  eq([s.subActivated], [false], 'защитник не заменяет нападающего при 5 защитниках (лимит)');
}

// Сценарий 5: тай-брейк — равные очки → выше тот, у кого замена набрала больше; затем finishOrder.
{
  const mk = (id, sub, finishOrder) => {
    const { roster, nextId } = squad(1000 + id * 100, 'X' + id);
    const s = { id: nextId, name: `sub${id}`, club: 'X' + id, position: 'DEF' };
    return { id, name: `T${id}`, roster, substitute: s, finishOrder, _subPts: sub };
  };
  const a = mk(1, 4, 3);   // равные total, замена 4
  const b = mk(2, 9, 5);   // равные total, замена 9 → выше
  const c = mk(3, 9, 1);   // замена 9, но finishOrder раньше → выше b и a... сравним
  const results = {};
  for (const m of [a, b, c]) {
    for (const u of m.roster) results[u.id] = { points: 1, played: true };
    results[m.substitute.id] = { points: m._subPts, played: true }; // замена не срабатывает (нет DNP)
  }
  const table = standings([a, b, c], results);
  // total у всех равный; subPoints: c=9(fo1), b=9(fo5), a=4 → порядок c, b, a
  eq(table.map((x) => x.name), ['T3', 'T2', 'T1'], 'тай-брейк: subPoints ↓, затем finishOrder ↑');
}

console.log(failed === 0 ? '\nВСЕ ТЕСТЫ ПРОШЛИ' : `\nПРОВАЛЕНО: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
