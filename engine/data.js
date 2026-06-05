// Синтетический пул юнитов для тестов движка (20 клубов).
// В проде заменится реальными игроками FanTeam + справочником тренеров.

export function makePool() {
  const clubs = ['ARS', 'AVL', 'BHA', 'BOU', 'BRE', 'BUR', 'CHE', 'CRY', 'EVE', 'FUL',
                 'LIV', 'LEE', 'MCI', 'MUN', 'NEW', 'NFO', 'SUN', 'TOT', 'WHU', 'WOL'];
  const perPos = { GK: 3, DEF: 8, MID: 8, FWD: 5 };
  const units = [];
  let id = 1;
  for (const club of clubs) {
    for (const [pos, n] of Object.entries(perPos)) {
      for (let i = 1; i <= n; i++) units.push({ id: id++, name: `${club}-${pos}${i}`, club, position: pos });
    }
    units.push({ id: id++, name: `${club}-Coach`, club, position: 'COACH' });
  }
  return units;
}
