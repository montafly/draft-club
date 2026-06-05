// Синтетический пул юнитов для тестов движка (20 клубов) с сгенерированными фамилиями.
// В проде заменится реальными игроками FanTeam + справочником тренеров (шаг 2b.3).

const SURNAMES = [
  'Walker', 'Silva', 'Saka', 'Rice', 'Foden', 'Palmer', 'Watkins', 'Mount', 'Toney', 'Maddison',
  'Gordon', 'Bowen', 'Eze', 'Gibbs', 'Mings', 'Dunk', 'Coady', 'Stones', 'Trippier', 'Botman',
  'Guimaraes', 'Isak', 'Wilson', 'Almiron', 'Schar', 'Burn', 'Hall', 'Gakpo', 'Nunez', 'Diaz',
  'Mac Allister', 'Szoboszlai', 'Robertson', 'Konate', 'Bradley', 'Tsimikas', 'Elliott', 'Jota', 'Salah', 'Nelson',
  'Odegaard', 'Havertz', 'Jesus', 'Martinelli', 'White', 'Gabriel', 'Zinchenko', 'Tomiyasu', 'Jorginho', 'Trossard',
  'Doku', 'Grealish', 'Alvarez', 'Kovacic', 'Akanji', 'Dias', 'Ake', 'Gvardiol', 'Ortega', 'Lewis',
  'Garnacho', 'Rashford', 'Hojlund', 'Fernandes', 'Casemiro', 'Mainoo', 'Dalot', 'Martinez', 'Shaw', 'Onana',
  'Mudryk', 'Sterling', 'Jackson', 'Caicedo', 'Fernandez', 'Gallagher', 'Colwill', 'Chilwell', 'James', 'Cucurella',
  'Solanke', 'Johnson', 'Kulusevski', 'Bissouma', 'Romero', 'Van de Ven', 'Udogie', 'Porro', 'Vicario', 'Richarlison',
  'Mbeumo', 'Wissa', 'Norgaard', 'Jensen', 'Hickey', 'Collins', 'Pinnock', 'Janelt', 'Schade', 'Lewis-Potter',
];
const INITIALS = 'ABCDEFGHIJKLMNOPRSTVWZ'.split('');

function nameFor(i) {
  const sur = SURNAMES[i % SURNAMES.length];
  const ini = INITIALS[Math.floor(i / SURNAMES.length) % INITIALS.length];
  return `${ini}. ${sur}`;
}

export function makePool() {
  const clubs = ['ARS', 'AVL', 'BHA', 'BOU', 'BRE', 'BUR', 'CHE', 'CRY', 'EVE', 'FUL',
                 'LIV', 'LEE', 'MCI', 'MUN', 'NEW', 'NFO', 'SUN', 'TOT', 'WHU', 'WOL'];
  const perPos = { GK: 3, DEF: 8, MID: 8, FWD: 5 };
  const units = [];
  let id = 1;
  let n = 0;
  for (const club of clubs) {
    for (const [pos, cnt] of Object.entries(perPos)) {
      for (let i = 1; i <= cnt; i++) units.push({ id: id++, name: nameFor(n++), club, position: pos });
    }
    units.push({ id: id++, name: `Coach ${club}`, club, position: 'COACH' });
  }
  return units;
}
