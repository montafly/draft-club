// Чистые функции-правила: подсчёт позиций, макс. ставка, можно ли добрать юнит.
import { POSITIONS } from './config.js';

export function positionCounts(roster) {
  const c = { GK: 0, DEF: 0, MID: 0, FWD: 0, COACH: 0 };
  for (const u of roster) c[u.position]++;
  return c;
}

/**
 * Макс. ставка участника: оставляем по 1 млн на каждый незакрытый слот
 * (после покупки текущего юнита). max = budget − (нужно_ещё_юнитов − 1).
 */
export function maxBid(manager, config) {
  if (manager.finished) return 0;
  const needed = config.squadSize - manager.roster.length; // включая текущий
  return manager.budget - (needed - 1);
}

/**
 * Можно ли участнику добавить unit, не нарушив правила:
 * - не превышен максимум по позиции;
 * - не превышен лимит клуба (глобальный, clubCounts);
 * - после добавления остаётся возможность добрать валидный состав из 12
 *   (физибилити — покрывает и кейс «≥7 атакующих не оставляют слотов»).
 * Бюджет здесь НЕ проверяется (это ось ставки, см. maxBid).
 */
export function canAdd(manager, unit, clubCounts, config) {
  if (manager.finished) return false;
  if (manager.roster.length >= config.squadSize) return false;

  const pos = config.positions;
  const c = positionCounts(manager.roster);

  if (c[unit.position] + 1 > pos[unit.position].max) return false;
  if ((clubCounts[unit.club] || 0) >= config.teamLimit) return false;

  // физибилити после добавления
  const cc = { ...c };
  cc[unit.position]++;
  const total = manager.roster.length + 1;
  const remaining = config.squadSize - total;
  let needMin = 0;
  let cap = 0;
  for (const p of POSITIONS) {
    needMin += Math.max(0, pos[p].min - cc[p]);
    cap += pos[p].max - cc[p];
  }
  return remaining >= needMin && remaining <= cap;
}
