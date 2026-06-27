// Альтернативный источник кэфов: sstats.net (бесплатно, без ключа — 30 req/min с IP).
// Зачем: FanTeam публикует odds/xG лениво (за неск. дней до матчей у части туров пусто).
// sstats отдаёт кэфы букмекеров заранее → выводим те же метрики, что и FanTeam:
//   win%  ← рынок 1 "Match Winner" (де-виг 1X2)
//   xG    ← рынок 16/17 "Total - Home/Away", линия Over 0.5 → P(команда забьёт), затем xG = -ln(1-P)
//           (Пуассон: P(забьёт ≥1)=1-e^(-λ); fallback — рынок 43/44 "Team Score a Goal")
//   cs    ← cs_клуба = exp(-xG_соперника)*100 (как в server.js — clean sheet = P(соперник не забьёт))
// Имена клубов в выдаче = имена FanTeam, чтобы слияние в refreshOdds (по o.club) совпало.
// ВАЖНО: source read-only, ничего не пишет; xG здесь — РЫНОЧНЫЙ implied, не модельный.

const SS_API = 'https://api.sstats.net';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';

// --- утилиты ---
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
function median(arr) {
  const a = arr.filter((x) => x != null && !Number.isNaN(x)).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
const devig2 = (yes, no) => { const iy = 1 / +yes, ino = 1 / +no; const s = iy + ino; return s > 0 ? iy / s : null; };
const devig3 = (h, d, a) => { const ih = 1 / +h, id = 1 / +d, ia = 1 / +a, s = ih + id + ia; return s > 0 ? [ih / s, id / s, ia / s] : null; };

// Опциональный ключ из .env (SSTATS_API_KEY): без него 30 req/min (shared pool, ловит 429),
// с ключом 120/min + 300k/день. Ключ → заголовок apikey.
const SS_KEY = (typeof process !== 'undefined' && process.env && process.env.SSTATS_API_KEY) || null;
async function ssGet(p, { retries = 3 } = {}) {
  const headers = { accept: 'application/json', 'user-agent': UA };
  if (SS_KEY) headers.apikey = SS_KEY;
  for (let i = 0; ; i++) {
    const r = await fetch(`${SS_API}/${p}`, { headers });
    if (r.ok) return r.json();
    if ((r.status === 429 || r.status >= 500) && i < retries) { await sleep(3000 + i * 3000); continue; } // backoff на лимит/5xx: 3с,6с,9с
    throw new Error('sstats ' + r.status + ' ' + p);
  }
}

// --- нормализация имён команд (сборные: много вариантов написания) ---
const ALIAS = {
  'united states': 'usa', us: 'usa', usa: 'usa',
  'south korea': 'korea', 'korea republic': 'korea', 'republic of korea': 'korea',
  'north korea': 'koreadpr', 'korea dpr': 'koreadpr', 'dpr korea': 'koreadpr',
  czechia: 'czech', 'czech republic': 'czech',
  bosnia: 'bosnia', 'bosnia herzegovina': 'bosnia', 'bosnia and herzegovina': 'bosnia',
  'ivory coast': 'cotedivoire', 'cote divoire': 'cotedivoire',
  iran: 'iran', 'ir iran': 'iran',
  china: 'china', 'china pr': 'china',
  'cape verde': 'caboverde', 'cabo verde': 'caboverde',
  uae: 'uae', 'united arab emirates': 'uae',
  turkey: 'turkiye', turkiye: 'turkiye',
};
const DROP = new Set(['fc', 'sc', 'afc', 'cf', 'national', 'team', 'nationalteam', 'the', 'of', 'and']);
function normTeam(name) {
  let s = String(name || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  s = s.replace(/&/g, ' ').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (ALIAS[s]) return ALIAS[s];
  const toks = s.split(' ').filter((t) => t && !DROP.has(t));
  const joined = toks.join(' ');
  if (ALIAS[joined]) return ALIAS[joined];
  return toks.join('');
}
// Dice-коэффициент по биграммам (fuzzy fallback, если алиас не сработал)
function bigrams(s) { const out = []; for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2)); return out; }
function sim(a, b) {
  const na = normTeam(a), nb = normTeam(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const ga = bigrams(na), gb = bigrams(nb);
  if (!ga.length || !gb.length) return na === nb ? 1 : 0;
  const mb = new Map(); for (const g of gb) mb.set(g, (mb.get(g) || 0) + 1);
  let hit = 0; for (const g of ga) { const c = mb.get(g); if (c) { hit++; mb.set(g, c - 1); } }
  return (2 * hit) / (ga.length + gb.length);
}

// --- список игр sstats за набор дат (UTC) ---
async function ssGamesForDates(dates, { throttle = 700 } = {}) {
  const out = [];
  const seen = new Set();
  for (const date of dates) {
    let d;
    // без &timezone=0: sstats.net регрессанул и отдаёт на timezone=0 HTTP 500; дефолтный бакет по дате
    // нам подходит — matchFixture фильтрует по dateUtc (unix, tz-независимо) в окне ±36ч (тянем Date-1/Date/Date+1)
    try { d = await ssGet(`Games/list?Date=${date}`); } catch (e) { continue; }
    for (const g of d.data || []) {
      if (seen.has(g.id)) continue; seen.add(g.id);
      const lg = ((g.season || {}).league || {}).name || '';
      out.push({
        gid: g.id, league: lg,
        home: (g.homeTeam || {}).name || '', away: (g.awayTeam || {}).name || '',
        dateUtc: g.dateUtc || null,
      });
    }
    await sleep(throttle);
  }
  return out;
}

// сопоставить одну фикстуру FanTeam (home/away/время) лучшей игре sstats
function matchFixture(fix, ssGames, { minScore = 0.6, minSide = 0.34 } = {}) {
  const ftHome = fix.home, ftAway = fix.away;
  const tFt = fix.startTime ? Date.parse(fix.startTime) / 1000 : null;
  let best = null;
  for (const g of ssGames) {
    if (tFt && g.dateUtc && Math.abs(g.dateUtc - tFt) > 36 * 3600) continue; // окно ±36ч
    const sh = sim(ftHome, g.home), sa = sim(ftAway, g.away);
    const score = 0.5 * sh + 0.5 * sa;
    if (sh < minSide || sa < minSide) continue;
    if (!best || score > best.score) best = { ...g, score, sh, sa };
  }
  return best && best.score >= minScore ? best : null;
}

// --- из одной выдачи /Odds/{gid} (массив по букмекерам) вытащить метрики ---
function oddsToMetrics(books) {
  const winH = [], winA = [], pH = [], pA = [];
  for (const bk of books || []) {
    const byId = {}; for (const m of bk.odds || []) byId[m.marketId] = m.odds || [];
    // win% из 1X2
    if (byId[1]) {
      const mp = {}; for (const o of byId[1]) mp[o.name] = o.value;
      const w = devig3(mp.Home, mp.Draw, mp.Away);
      if (w) { winH.push(w[0]); winA.push(w[2]); }
    }
    // P(команда забьёт): сначала Total команды Over/Under 0.5, иначе Team Score a Goal Yes/No
    const pScore = (totalMarket, yesNoMarket) => {
      const t = byId[totalMarket];
      if (t) { const mp = {}; for (const o of t) mp[o.name] = o.value; if (mp['Over 0.5'] && mp['Under 0.5']) return devig2(mp['Over 0.5'], mp['Under 0.5']); }
      const yn = byId[yesNoMarket];
      if (yn) { const mp = {}; for (const o of yn) mp[o.name] = o.value; if (mp.Yes && mp.No) return devig2(mp.Yes, mp.No); }
      return null;
    };
    const ph = pScore(16, 43), pa = pScore(17, 44);
    if (ph != null) pH.push(ph);
    if (pa != null) pA.push(pa);
  }
  const wh = median(winH), wa = median(winA), mph = median(pH), mpa = median(pA);
  const toXg = (p) => (p == null ? null : -Math.log(1 - clamp(p, 0, 0.97)));
  const xh = toXg(mph), xa = toXg(mpa);
  return {
    win_home: wh == null ? null : Math.round(wh * 100),
    win_away: wa == null ? null : Math.round(wa * 100),
    xg_home: xh == null ? null : Math.round(xh * 100) / 100,
    xg_away: xa == null ? null : Math.round(xa * 100) / 100,
    // clean sheet клуба = P(соперник не забьёт) = exp(-xG_соперника) (формула как в server.js)
    cs_home: xa == null ? null : Math.round(Math.exp(-xa) * 100),
    cs_away: xh == null ? null : Math.round(Math.exp(-xh) * 100),
    nBooksWin: winH.length, nBooksScore: Math.max(pH.length, pA.length),
  };
}

// --- ПУБЛИЧНОЕ: clubOdds в формате FanTeam ({club, win, xg, cs}) + отчёт о матчинге ---
// fixtures: [{home, away, startTime}] — имена и время от FanTeam
export async function sstatsClubOdds(fixtures, { throttle = SS_KEY ? 700 : 2100 } = {}) {
  const dates = [...new Set(fixtures.flatMap((f) => {
    if (!f.startTime) return [];
    const d = new Date(f.startTime);
    const day = (x) => x.toISOString().slice(0, 10);
    // дата матча по UTC + соседние сутки (часовые сдвиги/поздние матчи)
    return [day(new Date(d.getTime() - 864e5)), day(d), day(new Date(d.getTime() + 864e5))];
  }))];
  const ssGames = await ssGamesForDates(dates, { throttle: SS_KEY ? 300 : 700 });
  const clubOdds = [], report = [];
  for (const fix of fixtures) {
    const mt = matchFixture(fix, ssGames);
    if (!mt) { report.push({ fix: `${fix.home} vs ${fix.away}`, matched: null }); continue; }
    let metrics = null;
    try { const od = await ssGet(`Odds/${mt.gid}`); metrics = oddsToMetrics(od.data); } catch (e) { metrics = null; }
    await sleep(throttle);
    if (!metrics) { report.push({ fix: `${fix.home} vs ${fix.away}`, matched: mt, metrics: null }); continue; }
    clubOdds.push({ club: fix.home, win: metrics.win_home, xg: metrics.xg_home, cs: metrics.cs_home });
    clubOdds.push({ club: fix.away, win: metrics.win_away, xg: metrics.xg_away, cs: metrics.cs_away });
    report.push({ fix: `${fix.home} vs ${fix.away}`, matched: { gid: mt.gid, ss: `${mt.home} vs ${mt.away}`, score: +mt.score.toFixed(2) }, metrics });
  }
  return { clubOdds, report };
}

// =================== CLI-демо (node sstats.js <season> <round>) ===================
// Тянет фикстуры FanTeam, прогоняет sstats, печатает сравнение FanTeam vs sstats.
import { pathToFileURL } from 'node:url';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const season = process.argv[2] || '1995';
  const round = process.argv[3] || '3';
  const FT = 'https://fanteam-game.api.scoutgg.net';
  const FTH = { accept: 'application/json', authorization: 'Bearer fanteam undefined', origin: 'https://fanteam.com', referer: 'https://fanteam.com/', 'user-agent': UA };
  const ftGet = async (p) => { const r = await fetch(`${FT}/${p}`, { headers: FTH }); if (!r.ok) throw new Error('FT ' + r.status); return r.json(); };
  const nxg = (v) => (v == null || v === 0 || Number.isNaN(+v) || typeof v === 'object') ? null : +v;

  (async () => {
    const d = await ftGet(`real_matches?season_id=${season}&round=${round}`);
    const teams = {}; for (const t of d.realTeams || []) teams[t.id] = t.name || String(t.id);
    const fixtures = [], ftOdds = {};
    for (const m of d.realMatches || []) {
      const [a, b] = (m.realTeamIds || []).slice(0, 2);
      const home = teams[a], away = teams[b];
      if (!home || !away) continue;
      fixtures.push({ home, away, startTime: m.startTime });
      const od = (m.details || {}).odds || {}, xg = (m.details || {}).expectedGoals || [null, null];
      let wh = null, wa = null;
      const w = devig3(od.home, od.draw, od.away); if (w) { wh = Math.round(w[0] * 100); wa = Math.round(w[2] * 100); }
      const xh = nxg(xg[0]), xa = nxg(xg[1]);
      ftOdds[home] = { win: wh, xg: xh, cs: xa == null ? null : Math.round(Math.exp(-xa) * 100) };
      ftOdds[away] = { win: wa, xg: xa, cs: xh == null ? null : Math.round(Math.exp(-xh) * 100) };
    }
    console.log(`\nFanTeam season=${season} round=${round}: ${fixtures.length} матчей. Тяну sstats...\n`);
    const { clubOdds, report } = await sstatsClubOdds(fixtures);
    const ssBy = {}; for (const o of clubOdds) ssBy[o.club] = o;

    const f = (v, w = 4) => (v == null ? '·' : String(v)).padStart(w);
    console.log('МАТЧ / клуб'.padEnd(26) + ' | FT  win  xg   cs | SS  win  xg   cs | matched(score)');
    console.log('-'.repeat(92));
    let matched = 0, ftEmpty = 0, ssFilled = 0;
    for (const r of report) {
      const m = r.matched;
      if (m) matched++;
      console.log(r.fix.padEnd(26) + ` | ` + (m ? `ss:${m.ss} (${m.score})` : 'НЕТ СОВПАДЕНИЯ'));
      for (const club of r.fix.split(' vs ')) {
        const ft = ftOdds[club] || {}, ss = ssBy[club] || {};
        const ftHas = ft.win != null || ft.xg != null;
        const ssHas = ss.win != null || ss.xg != null;
        if (!ftHas) ftEmpty++;
        if (!ftHas && ssHas) ssFilled++;
        console.log('  ' + club.padEnd(22) + ` |    ${f(ft.win)} ${f(ft.xg, 4)} ${f(ft.cs)} |    ${f(ss.win)} ${f(ss.xg, 4)} ${f(ss.cs)} |`);
      }
    }
    console.log('-'.repeat(92));
    console.log(`Матчей сопоставлено: ${matched}/${report.length}. Клубов без кэфов FanTeam: ${ftEmpty}, из них закрыто sstats: ${ssFilled}.`);
  })().catch((e) => { console.error('ОШИБКА:', e.message); process.exit(1); });
}
