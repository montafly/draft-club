// Подсчёт итогов драфта по результатам матчей.
// Вход: участники (состав 12 + замена) и results: unitId -> { points, played }.
//  - футболисты: points/played из данных FanTeam (dc_player_match).
//  - тренер: points = сумма очков игроков клуба, вышедших на замену; played = true.
import { DEFAULT_CONFIG } from './config.js';

function withinLimits(counts, config) {
  for (const p of Object.keys(config.positions)) {
    if (p === 'COACH') continue;
    const have = counts[p] || 0;
    const { min, max } = config.positions[p];
    if (have < min || have > max) return false;
  }
  return true;
}

/** Срабатывает ли замена: есть несыгравший стартер (0 мин) И замена валидна по позициям. */
function substitutionActivates(sub, dnpStarters, counts, config) {
  if (!sub || dnpStarters.length === 0) return false;
  for (const st of dnpStarters) {
    if (sub.position === 'GK') {
      if (st.position === 'GK') return true;          // вратарь меняет только вратаря
      continue;
    }
    if (st.position === 'GK') continue;                // полевой не меняет вратаря
    const nc = { ...counts };
    nc[st.position]--;
    nc[sub.position]++;
    if (withinLimits(nc, config)) return true;
  }
  return false;
}

export function scoreManager(m, results, config = DEFAULT_CONFIG) {
  const get = (u) => (u && results[u.id]) || { points: 0, played: false };
  let base = 0;
  const counts = { GK: 0, DEF: 0, MID: 0, FWD: 0 };
  const dnp = [];
  for (const u of m.roster) {
    base += get(u).points || 0;
    if (u.position === 'COACH') continue;
    counts[u.position] = (counts[u.position] || 0) + 1;
    if (!get(u).played) dnp.push(u);
  }
  const subPts = get(m.substitute).points || 0;
  const activated = substitutionActivates(m.substitute, dnp, counts, config);
  return {
    id: m.id, name: m.name,
    total: round2(base + (activated ? subPts : 0)),
    base: round2(base),
    subPoints: round2(subPts),
    subActivated: activated,
    finishOrder: m.finishOrder,
  };
}

/** Итоговая таблица с местами. Тай-брейк: total ↓, subPoints ↓, finishOrder ↑. */
export function standings(managers, results, config = DEFAULT_CONFIG) {
  const scored = [...managers].map((m) => scoreManager(m, results, config));
  scored.sort((a, b) =>
    b.total - a.total
    || b.subPoints - a.subPoints
    || a.finishOrder - b.finishOrder);
  scored.forEach((s, i) => { s.place = i + 1; });
  return scored;
}

function round2(x) { return Math.round(x * 100) / 100; }
