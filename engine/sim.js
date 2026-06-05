// Симулятор: гоняет много случайных драфтов с ботами и проверяет инварианты.
import { Draft } from './draft.js';
import { DEFAULT_CONFIG } from './config.js';
import { makePool } from './data.js';

const rnd = (n) => Math.floor(Math.random() * n);
const pick = (arr) => arr[rnd(arr.length)];

function botDriveOneDraft() {
  const cfg = DEFAULT_CONFIG;
  const pool = makePool();
  const players = Array.from({ length: cfg.managersCount }, (_, i) => ({ id: i + 1, name: `P${i + 1}` }));
  const order = players.map((p) => p.id).sort(() => Math.random() - 0.5); // жеребьёвка
  const d = new Draft(pool, players, order, cfg);
  d.start();

  let guard = 0;
  while (d.phase !== 'done') {
    if (++guard > 100000) throw new Error('движок не сходится (возможен дедлок)');
    const a = d.actor;
    if (d.phase === 'nominating') {
      const opts = d.eligibleNominations(a);
      if (opts.length === 0) throw new Error('номинатор без опций (не должно быть на полном пуле)');
      // иногда открываем выше 1, чтобы прогонять стратегию «отсечь по бюджету»
      const u = pick(opts);
      const open = Math.random() < 0.1 ? Math.min(d.managerMaxBid(a), 1 + rnd(4)) : 1;
      d.nominate(a, u.id, Math.max(1, open));
    } else if (d.phase === 'bidding') {
      const lot = d.lot;
      const need = lot.highBid + cfg.minIncrement;
      const canAfford = d.managerMaxBid(a) >= need && d.canManagerAdd(a, lot.unit);
      // бот перебивает с вероятностью 0.55, если может; иначе пас
      if (canAfford && Math.random() < 0.55) d.bid(a, need);
      else d.pass(a);
    } else if (d.phase === 'substitutes') {
      const opts = d.eligibleSubstitutes(a);
      if (opts.length === 0) throw new Error('нет доступной замены');
      d.pickSubstitute(a, pick(opts).id);
    }
  }
  return d;
}

function checkInvariants(d, cfg) {
  const errs = [];
  const seen = new Set();
  const clubTally = {};
  for (const m of d.managers.values()) {
    if (m.roster.length !== cfg.squadSize) errs.push(`${m.name}: состав ${m.roster.length} != ${cfg.squadSize}`);
    const c = { GK: 0, DEF: 0, MID: 0, FWD: 0, COACH: 0 };
    for (const u of m.roster) {
      c[u.position]++;
      if (seen.has(u.id)) errs.push(`юнит ${u.name} взят дважды`);
      seen.add(u.id);
      clubTally[u.club] = (clubTally[u.club] || 0) + 1;
    }
    for (const p of Object.keys(cfg.positions)) {
      const { min, max } = cfg.positions[p];
      if (c[p] < min || c[p] > max) errs.push(`${m.name}: ${p}=${c[p]} вне [${min},${max}]`);
    }
    if (m.budget < 0) errs.push(`${m.name}: бюджет ${m.budget} < 0`);
    const spent = cfg.budget - m.budget;
    if (spent < 0) errs.push(`${m.name}: потрачено ${spent} < 0`);
    if (!m.substitute) errs.push(`${m.name}: нет замены`);
    else {
      if (m.substitute.position === 'COACH') errs.push(`${m.name}: замена — тренер`);
      if (seen.has(m.substitute.id)) errs.push(`замена ${m.substitute.name} пересекается`);
      seen.add(m.substitute.id);
      clubTally[m.substitute.club] = (clubTally[m.substitute.club] || 0) + 1;
    }
    if (m.finishOrder == null) errs.push(`${m.name}: нет finishOrder`);
  }
  for (const [club, n] of Object.entries(clubTally)) {
    if (n > cfg.teamLimit) errs.push(`клуб ${club}: ${n} > лимит ${cfg.teamLimit}`);
  }
  return errs;
}

function run(N = 300) {
  let ok = 0;
  const allErrs = [];
  for (let i = 0; i < N; i++) {
    let d;
    try { d = botDriveOneDraft(); }
    catch (e) { allErrs.push(`драфт #${i}: краш — ${e.message}`); continue; }
    const errs = checkInvariants(d, DEFAULT_CONFIG);
    if (errs.length === 0) ok++;
    else allErrs.push(`драфт #${i}: ${errs.join('; ')}`);
  }
  console.log(`Прогнали ${N} драфтов. Валидных: ${ok}/${N}`);
  if (allErrs.length) {
    console.log(`Проблемы (${allErrs.length}):`);
    for (const e of allErrs.slice(0, 12)) console.log('  -', e);
  } else {
    console.log('Все инварианты соблюдены: составы 12, GK=1/COACH=1, позиции в рамках, бюджет>=0, лимит клуба<=5, нет дублей, у всех замена.');
  }
}

run(Number(process.argv[2]) || 300);
