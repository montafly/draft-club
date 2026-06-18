// Реалтайм-сервер драфта: HTTP (клиент) + WebSocket (комнаты по коду) + Supabase-авторизация.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import { Room } from './room.js';
import { authUser, getProfile, clientConfig } from './auth.js';
import { sstatsClubOdds } from './sstats.js';   // вторичный источник кэфов (sstats.net), доливка дырок FanTeam

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 4000;

// --- .env (SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_KEY) ---
try {
  const t = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
  for (const line of t.split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
} catch {}

// --- FanTeam (ScoutGG) прокси: список матчей тура для создания драфта ---
const FT_API = 'https://fanteam-game.api.scoutgg.net';
const FT_HEADERS = {
  accept: 'application/json',
  authorization: 'Bearer fanteam undefined', // dummy-токен, реальный логин не нужен
  origin: 'https://fanteam.com', referer: 'https://fanteam.com/',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
};
async function ftMatches(season, round) {
  const r = await fetch(`${FT_API}/real_matches?season_id=${encodeURIComponent(season)}&round=${encodeURIComponent(round)}`, { headers: FT_HEADERS });
  if (!r.ok) throw new Error('FanTeam ' + r.status);
  const d = await r.json();
  const teams = {};
  for (const t of d.realTeams || []) teams[t.id] = { name: t.name || String(t.id), abbr: t.abbr || '' };
  return (d.realMatches || []).map(m => {
    const [a, b] = (m.realTeamIds || []).slice(0, 2);
    return {
      matchId: m.id,
      home: teams[a]?.name || a, away: teams[b]?.name || b,
      homeCode: teams[a]?.abbr || '', awayCode: teams[b]?.abbr || '',
      startTime: m.startTime || null, status: m.status || null,
    };
  });
}

async function ftGet(path) {
  const r = await fetch(`${FT_API}/${path}`, { headers: FT_HEADERS });
  if (!r.ok) throw new Error('FanTeam ' + r.status + ' ' + path);
  return r.json();
}
// деталь матча с кэшем 60с (для скоринга/просмотра — не дёргать FanTeam на каждый клик)
const ftCache = new Map();
async function ftDetail(matchId) {
  const c = ftCache.get(matchId), now = Date.now();
  if (c && now - c.t < 60000) return c.data;
  const d = await ftGet(`real_matches/${matchId}`);
  ftCache.set(matchId, { t: now, data: d });
  return d;
}
// разбивка очков игрока на составляющие (ЕДИНЫЙ источник весов; cp = сумма). Веса FanTeam — валидированы, порт collect.py.
// Возвращает строки {label, n (сырой счётчик), pts (вклад в очки)}; только ненулевой вклад.
function cpBreak(s, pos) {
  const g = (k) => (+s[k] || 0);
  const out = [];
  const add = (label, n, pts) => { if (pts) out.push({ label, n, pts }); };
  add('Выход на поле', g('playtime1'), g('playtime1') * 1);
  add('60+ минут', g('playtime60'), g('playtime60') * 1);
  add('Пас (ассист)', g('assist'), g('assist') * 3);
  add('Привёз пенальти/штрафной', g('penaltyCaused'), g('penaltyCaused') * -2);
  add('Незабитый пенальти', g('penaltyMiss'), g('penaltyMiss') * -2);
  add('Автогол', g('ownGoal'), g('ownGoal') * -2);
  add('Жёлтая карточка', g('yellowCard'), g('yellowCard') * -1);
  add('Красная карточка', g('redCard'), g('redCard') * -3);
  add('Импакт', g('impact'), g('impact') * 0.3);
  if (pos === 'goalkeeper') {
    add('Гол', g('goal'), g('goal') * 8);
    add('Сухой матч', g('cleanSheet'), g('cleanSheet') * 4);
    add('Удары в створ', g('shotOnTarget'), g('shotOnTarget') * 1);
    add('Сейвы', g('keeperSave'), g('keeperSave') * 0.5);
    add('Сейв пенальти', g('penaltySave'), g('penaltySave') * 5);
    add('Пропущенные голы', g('concededGoal'), Math.floor(g('concededGoal') / 2) * -1);
  } else if (pos === 'defender') {
    add('Гол', g('goal'), g('goal') * 6);
    add('Сухой матч', g('cleanSheet'), g('cleanSheet') * 4);
    add('Удары в створ', g('shotOnTarget'), g('shotOnTarget') * 0.6);
    add('Пропущенные голы', g('concededGoal'), Math.floor(g('concededGoal') / 2) * -1);
  } else if (pos === 'midfielder') {
    add('Гол', g('goal'), g('goal') * 5);
    add('Сухой матч', g('cleanSheet'), g('cleanSheet') * 1);
    add('Полный матч', g('fullGame'), g('fullGame') * 1);
    add('Удары в створ', g('shotOnTarget'), g('shotOnTarget') * 0.4);
  } else if (pos === 'forward') {
    add('Гол', g('goal'), g('goal') * 4);
    add('Полный матч', g('fullGame'), g('fullGame') * 1);
    add('Удары в створ', g('shotOnTarget'), g('shotOnTarget') * 0.4);
  }
  return out;
}
// очки игрока = сумма разбивки (округление как раньше — поведение totals неизменно)
function cp(s, pos) { return Math.round(cpBreak(s, pos).reduce((a, b) => a + b.pts, 0) * 100) / 100; }
// слить строки разбивки по нескольким матчам игрока (floor пропущенных считается per-match, потому суммируем готовые строки)
function mergeBreak(lines) {
  const m = new Map();
  for (const l of lines) { const e = m.get(l.label); if (e) { e.n += l.n; e.pts += l.pts; } else m.set(l.label, { label: l.label, n: l.n, pts: l.pts }); }
  return [...m.values()].map((e) => ({ label: e.label, n: e.n, pts: Math.round(e.pts * 100) / 100 }));
}
const POSMAP = { goalkeeper: 'GK', defender: 'DEF', midfielder: 'MID', forward: 'FWD' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Собрать пул движка по выбранным матчам драфта: игроки + тренеры + коэф/xG/CS по клубам
async function buildDraftPool(seasonId, round, matchIds) {
  const idset = new Set((matchIds || []).map(Number));
  const listing = await ftGet(`real_matches?season_id=${seasonId}&round=${round}`);
  const teams = {}, abbr = {};
  for (const t of listing.realTeams || []) { teams[t.id] = t.name || String(t.id); abbr[t.id] = t.abbr || String(t.name || '').slice(0, 3).toUpperCase(); }
  const sel = (listing.realMatches || []).filter((m) => idset.has(Number(m.id)));
  const clubOdds = [];
  for (const m of sel) {
    const det = m.details || {}, od = det.odds || {}, xg = (det.expectedGoals || [null, null]).slice(0, 2);
    const ids = (m.realTeamIds || [null, null]).slice(0, 2);
    let wh = null, wa = null;
    try { const inv = [1 / +od.home, 1 / +od.draw, 1 / +od.away]; const s = inv[0] + inv[1] + inv[2]; wh = Math.round(inv[0] / s * 100); wa = Math.round(inv[2] / s * 100); } catch {}
    const nxg = (v) => (v == null || v === 0 || Number.isNaN(v)) ? null : v;   // xG=0 — плейсхолдер FanTeam «ещё не опубликовано» (реальный xG никогда не ровно 0)
    const xh = nxg(xg[0]), xa = nxg(xg[1]);
    if (Number.isNaN(wh)) wh = null; if (Number.isNaN(wa)) wa = null;          // нет кэфов → win=NaN → null (иначе считается «опубликованным»)
    clubOdds.push({ club: teams[ids[0]], win: wh, xg: xh, cs: xa != null ? Math.round(Math.exp(-xa) * 100) : null });
    clubOdds.push({ club: teams[ids[1]], win: wa, xg: xa, cs: xh != null ? Math.round(Math.exp(-xh) * 100) : null });
  }
  const units = [], seen = new Set(), involved = new Set();
  for (const m of sel) {
    const det = await ftGet(`real_matches/${m.id}`);
    for (const mem of det.realTeamMemberships || []) {
      const pid = mem.realPlayerId; if (seen.has(pid)) continue;
      const pos = POSMAP[mem.position]; if (!pos) continue;
      seen.add(pid);
      const p = mem.realPlayer || {}; const tid = mem.realTeamId; involved.add(tid);
      units.push({ id: pid, name: p.lastName || p.firstName || String(pid), first: (p.lastName && p.firstName) ? p.firstName : '', club: teams[tid] || String(tid), code: abbr[tid] || '', position: pos });
    }
    await sleep(250); // вежливый троттлинг FanTeam
  }
  for (const tid of involved) units.push({ id: -Number(tid), name: 'Coach ' + (abbr[tid] || teams[tid] || tid), club: teams[tid] || String(tid), code: abbr[tid] || '', position: 'COACH' });
  // дизамбигуация: если в одном клубе 2+ игрока с одинаковой фамилией → показываем инициал имени (J. David); если инициалы тоже совпали — полное имя
  const _g = {};
  for (const u of units) { if (u.position === 'COACH' || !u.name) continue; const k = u.club + '|' + u.name.toLowerCase(); (_g[k] = _g[k] || []).push(u); }
  for (const u of units) { if (u.position !== 'COACH') u.disp = u.name; }
  for (const k in _g) {
    const g = _g[k]; if (g.length < 2) continue;
    const inits = g.map((u) => (u.first || '').charAt(0).toUpperCase());
    const initOk = inits.every(Boolean) && new Set(inits).size === inits.length;   // у всех есть имя и инициалы различны
    for (const u of g) u.disp = u.first ? ((initOk ? u.first.charAt(0).toUpperCase() + '.' : u.first) + ' ' + u.name) : u.name;
  }
  const matches = sel.map((m) => { const ids = (m.realTeamIds || [null, null]).slice(0, 2); return { home: teams[ids[0]] || '', away: teams[ids[1]] || '', startTime: m.startTime || null }; });
  return { units, clubOdds, matches };
}

// лёгкая сводка тура для страницы результатов: котировки клубов + расписание (один запрос листинга, без сбора пула игроков)
async function tourInfo(seasonId, round, matchIds) {
  const idset = new Set((matchIds || []).map(Number));
  const listing = await ftGet(`real_matches?season_id=${seasonId}&round=${round}`);
  const teams = {}, abbr = {};
  for (const t of listing.realTeams || []) { teams[t.id] = t.name || String(t.id); abbr[t.id] = t.abbr || String(t.name || '').slice(0, 3).toUpperCase(); }
  const sel = (listing.realMatches || []).filter((m) => idset.has(Number(m.id)));
  const clubOdds = [], fixtures = [];
  for (const m of sel) {
    const det = m.details || {}, od = det.odds || {}, xg = (det.expectedGoals || [null, null]).slice(0, 2);
    const ids = (m.realTeamIds || [null, null]).slice(0, 2);
    let wh = null, wa = null;
    try { const inv = [1 / +od.home, 1 / +od.draw, 1 / +od.away]; const s = inv[0] + inv[1] + inv[2]; wh = Math.round(inv[0] / s * 100); wa = Math.round(inv[2] / s * 100); } catch {}
    const nxg = (v) => (v == null || v === 0 || Number.isNaN(v)) ? null : v;   // xG=0 — плейсхолдер FanTeam «ещё не опубликовано» (реальный xG никогда не ровно 0)
    const xh = nxg(xg[0]), xa = nxg(xg[1]);
    if (Number.isNaN(wh)) wh = null; if (Number.isNaN(wa)) wa = null;          // нет кэфов → win=NaN → null (иначе считается «опубликованным»)
    clubOdds.push({ club: teams[ids[0]], win: wh, xg: xh, cs: xa != null ? Math.round(Math.exp(-xa) * 100) : null });
    clubOdds.push({ club: teams[ids[1]], win: wa, xg: xa, cs: xh != null ? Math.round(Math.exp(-xh) * 100) : null });
    fixtures.push({ matchId: m.id, home: teams[ids[0]] || '', away: teams[ids[1]] || '', homeCode: abbr[ids[0]] || '', awayCode: abbr[ids[1]] || '', startTime: m.startTime || null, status: m.status || null });
  }
  return { clubOdds, fixtures };
}

// REST-хелперы (service key) для launchDraft
async function svcGet(path) {
  const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${path}`, { headers: { apikey: process.env.SUPABASE_SERVICE_KEY, authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_KEY } });
  if (!r.ok) throw new Error('db ' + r.status); return r.json();
}
async function svcPatch(path, body) {
  const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${path}`, { method: 'PATCH', headers: { apikey: process.env.SUPABASE_SERVICE_KEY, authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_KEY, 'content-type': 'application/json', prefer: 'return=minimal' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error('db patch ' + r.status);
}
async function svcPost(path, body) {
  const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${path}`, { method: 'POST', headers: { apikey: process.env.SUPABASE_SERVICE_KEY, authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_KEY, 'content-type': 'application/json', prefer: 'return=minimal' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error('db post ' + r.status + ' ' + (await r.text()));
}
async function svcDelete(path) {
  const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${path}`, { method: 'DELETE', headers: { apikey: process.env.SUPABASE_SERVICE_KEY, authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_KEY, prefer: 'return=minimal' } });
  if (!r.ok) throw new Error('db del ' + r.status);
}
// upsert по первичному ключу (kind,ref) — для произношений
async function svcUpsert(path, rows) {
  const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${path}`, { method: 'POST', headers: { apikey: process.env.SUPABASE_SERVICE_KEY, authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_KEY, 'content-type': 'application/json', prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(rows) });
  if (!r.ok) throw new Error('db upsert ' + r.status + ' ' + (await r.text()));
}
// --- Озвучка покупок (Yandex SpeakKit): синтез mp3 + кэш в памяти процесса ---
const _ttsCache = new Map();                              // hash(text) -> Buffer
function _hash(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return String(h); }
function mlnWord(n) { n = Math.abs(Math.round(+n || 0)); const t = n % 100, o = n % 10; if (t >= 11 && t <= 14) return 'миллионов'; if (o === 1) return 'миллион'; if (o >= 2 && o <= 4) return 'миллиона'; return 'миллионов'; }
// грубый транслит латиницы в кириллицу — базовая «заглушка» произношения (точные правит админ вручную)
function translitRu(s) {
  s = String(s || ''); if (!s) return '';
  const di = { shch: 'щ', sh: 'ш', ch: 'ч', zh: 'ж', kh: 'х', ph: 'ф', th: 'т', ts: 'ц', ya: 'я', yu: 'ю', yo: 'ё', ck: 'к', qu: 'ку' };
  const si = { a: 'а', b: 'б', c: 'к', d: 'д', e: 'е', f: 'ф', g: 'г', h: 'х', i: 'и', j: 'дж', k: 'к', l: 'л', m: 'м', n: 'н', o: 'о', p: 'п', q: 'к', r: 'р', s: 'с', t: 'т', u: 'у', v: 'в', w: 'в', x: 'кс', y: 'й', z: 'з' };
  return s.split(/(\s+|[-'’.])/).map((tok) => {
    if (!tok || /^(\s+|[-'’.])$/.test(tok)) return tok;
    const low = tok.toLowerCase(); let out = '', i = 0;
    while (i < low.length) {
      let m = null;
      for (const L of [4, 3, 2]) { const sub = low.slice(i, i + L); if (di[sub]) { m = di[sub]; i += L; break; } }
      if (m === null) { const c = low[i]; m = (si[c] !== undefined) ? si[c] : (/[a-z]/.test(c) ? '' : c); i++; }
      out += m;
    }
    if (tok[0] === tok[0].toUpperCase()) out = out.charAt(0).toUpperCase() + out.slice(1);
    return out;
  }).join('');
}
async function ttsSynth(text) {
  const key = _hash(text); if (_ttsCache.has(key)) return _ttsCache.get(key);
  const body = new URLSearchParams({ text, lang: 'ru-RU', voice: 'alena', emotion: 'good', format: 'mp3', folderId: process.env.YANDEX_FOLDER_ID || '' });
  const r = await fetch('https://tts.api.cloud.yandex.net/speech/v1/tts:synthesize', { method: 'POST', headers: { authorization: 'Api-Key ' + (process.env.YANDEX_TTS_API_KEY || ''), 'content-type': 'application/x-www-form-urlencoded' }, body });
  if (!r.ok) throw new Error('tts ' + r.status + ' ' + (await r.text()).slice(0, 150));
  const buf = Buffer.from(await r.arrayBuffer());
  if (_ttsCache.size > 500) _ttsCache.clear();             // простой бэкстоп от роста памяти
  _ttsCache.set(key, buf); return buf;
}
async function launchDraft(draftId) {
  const rows = await svcGet(`dc_drafts?id=eq.${draftId}&select=*`); const d = rows[0];
  if (!d) throw new Error('драфт не найден');
  if (d.room_code && rooms.has(d.room_code)) return d.room_code; // уже запущен
  const acc = await svcGet(`dc_applications?draft_id=eq.${draftId}&status=eq.accepted&select=user_id`);
  if (!acc.length) throw new Error('нет принятых участников');
  const pool = await buildDraftPool(d.season_id, d.round, d.match_ids);
  if (!pool.units.length) throw new Error('не собрался пул игроков по матчам');
  const code = (d.room_code && !rooms.has(d.room_code)) ? d.room_code : makeCode();
  const room = new Room(undefined, d.slots, pool.units, pool.clubOdds, pool.matches);
  room.draftMeta = { seasonId: d.season_id, round: d.round, matchIds: d.match_ids }; // для refreshOdds: коэф снапшотятся на launch, обновляем при старте аукциона
  room.allowedUserIds = new Set(acc.map((a) => a.user_id));
  room.draftId = draftId;
  room.persistedStatus = 'live';
  rooms.set(code, { room, clients: new Set() });
  await svcPatch(`dc_drafts?id=eq.${draftId}`, { status: 'live', room_code: code });
  return code;
}
// держим dc_drafts.status в синхроне с фазой движка + сохраняем составы на финише
function syncStatus(e) {
  if (!e || !e.room || !e.room.draftId || !e.room.draft) return;
  const desired = e.room.draft.phase === 'done' ? 'done' : 'live';
  if (e.room.persistedStatus !== desired) {
    e.room.persistedStatus = desired;
    svcPatch(`dc_drafts?id=eq.${e.room.draftId}`, { status: desired }).catch(() => {});
  }
  if (e.room.draft.phase === 'done' && !e.room.rostersSaved) {
    e.room.rostersSaved = true;
    persistRosters(e).catch((err) => { e.room.rostersSaved = false; console.error('persistRosters', err); });
  }
}
// сохранить составы участников (для скоринга) при завершении аукциона
async function persistRosters(e) {
  const r = e.room, d = r.draft; if (!d || !r.draftId) return;
  const seatUser = {}; for (const s of r.seats) seatUser[s.id] = s.userId;
  const rows = [];
  for (const m of d.managers.values()) {
    const uid = seatUser[m.id]; if (!uid) continue;
    const fo = m.finishOrder != null ? m.finishOrder : null;
    for (const u of m.roster) rows.push({ draft_id: r.draftId, user_id: uid, seat: m.id, player_id: u.id, name: u.name, disp: u.disp || u.name, club: u.club, position: u.position, price: u.price, is_sub: false, finish_order: fo });
    if (m.substitute) rows.push({ draft_id: r.draftId, user_id: uid, seat: m.id, player_id: m.substitute.id, name: m.substitute.name, disp: m.substitute.disp || m.substitute.name, club: m.substitute.club, position: m.substitute.position, price: 0, is_sub: true, finish_order: fo });
  }
  if (!rows.length) return;
  await svcDelete(`dc_draft_rosters?draft_id=eq.${r.draftId}`);
  try { await svcPost('dc_draft_rosters', rows); }
  catch (err) {
    try { await svcPost('dc_draft_rosters', rows.map(({ disp, ...x }) => x)); }                     // колонки disp ещё нет — без неё (finish_order сохраняем)
    catch (e2) { await svcPost('dc_draft_rosters', rows.map(({ disp, finish_order, ...x }) => x)); } // нет ни disp, ни finish_order
  }
  // полный лог пиков (с числом ставок и таймингом торгов) → dc_drafts.picks (jsonb); не критично — не валим сохранение составов
  try { await svcPatch(`dc_drafts?id=eq.${r.draftId}`, { picks: d.picks || [] }); } catch (err) { console.error('persist picks', err.message); }
  try { await svcPatch(`dc_drafts?id=eq.${r.draftId}`, { events: (r.events || []).slice(-5000) }); } catch (err) { console.error('persist events', err.message); } // полный лог действий для истории в просмотрщике
  try { await svcPatch(`dc_drafts?id=eq.${r.draftId}`, { seat_ms: r.seatMs || {}, chat: (r.chat || []).slice(-200) }); } catch (err) { console.error('persist seat_ms/chat', err.message); } // личные таймеры (по seat) + чат для просмотрщика итогов
  // DCC: списываем бай-ины с сыгравших участников (идемпотентно через dc_drafts.charged_at)
  try { await chargeBuyins(r.draftId, rows.map((x) => x.user_id)); } catch (err) { console.error('chargeBuyins', err.message); }
}
// --- DCC: операции (леджер) + движение баланса (read-modify-write; один сервер) ---
// PATCH с возвратом изменённых строк — для атомарного «застолбления» (только один запрос флипнет null→now)
async function svcPatchReturn(path, body) {
  const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${path}`, { method: 'PATCH', headers: { apikey: process.env.SUPABASE_SERVICE_KEY, authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_KEY, 'content-type': 'application/json', prefer: 'return=representation' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error('db patch ' + r.status);
  return r.json();
}
async function ledger(userId, draftId, type, amount, note) {
  await svcPost('dc_ledger', [{ user_id: userId, draft_id: draftId, type, amount, note: note || null }]);
  const pf = await svcGet(`dc_profiles?id=eq.${userId}&select=dcc_balance`);
  const bal = (pf[0] && pf[0].dcc_balance != null) ? pf[0].dcc_balance : 0;
  await svcPatch(`dc_profiles?id=eq.${userId}`, { dcc_balance: bal + amount });
}
async function chargeBuyins(draftId, userIds) {
  const dr = await svcGet(`dc_drafts?id=eq.${draftId}&select=buyin`); const d = dr[0]; if (!d) return;
  const claimed = await svcPatchReturn(`dc_drafts?id=eq.${draftId}&charged_at=is.null`, { charged_at: new Date().toISOString() });
  if (!claimed.length) return;                          // уже списано (атомарно через charged_at)
  const buyin = d.buyin || 0;
  if (buyin > 0) for (const uid of [...new Set(userIds)]) await ledger(uid, draftId, 'buyin', -buyin, 'бай-ин');
}
async function payPrizes(draftId, standings, d) {
  const claimed = await svcPatchReturn(`dc_drafts?id=eq.${draftId}&paid_at=is.null`, { paid_at: new Date().toISOString() });
  if (!claimed.length) return;                          // уже выплачено (атомарно через paid_at)
  const prizes = [d.prize1 || 0, d.prize2 || 0];
  for (let i = 0; i < 2; i++) { const s = standings[i]; if (s && prizes[i] > 0) await ledger(s.user_id, draftId, 'prize', prizes[i], `приз за ${i + 1} место`); }
}
// очки игроков+тренеров по матчам драфта из live-данных FanTeam (lineup, минуты, статы)
async function draftPoints(ids) {
  const playerPts = {}, playerMin = {}, coachPts = {}, matchInfo = {}; let confirmed = 0;
  const playerBreak = {}, playerEvents = {}, coachBreak = {}, nameOf = {};   // разбивка/события для тултипов просмотрщика (#5/#6)
  for (const mid of ids) {
    let det; try { det = await ftDetail(mid); } catch { continue; }
    const rm = det.realMatch || {};
    matchInfo[mid] = { status: rm.status || null, score: Array.isArray(rm.score) ? rm.score.slice(0, 2) : null };
    if (rm.status === 'confirmed') confirmed++;
    for (const m of det.realTeamMemberships || []) { const rp = m.realPlayer || {}; nameOf[m.realPlayerId] = [rp.firstName, rp.lastName].filter(Boolean).join(' ') || String(m.realPlayerId); }
    for (const r of det.realPlayerMatchStats || []) {
      const pid = r.realPlayerId, pos = r.position || '', br = cpBreak(r.stats || {}, pos), pts = Math.round(br.reduce((a, b) => a + b.pts, 0) * 100) / 100, min = r.minutesPlayed || 0;
      playerPts[pid] = (playerPts[pid] || 0) + pts; playerMin[pid] = (playerMin[pid] || 0) + min;
      if (br.length) (playerBreak[pid] || (playerBreak[pid] = [])).push(...br);
      if (r.lineup === 'bench' && min > 0) { const ck = -Number(r.realTeamId); coachPts[ck] = (coachPts[ck] || 0) + pts; if (pts) (coachBreak[ck] || (coachBreak[ck] = [])).push({ label: nameOf[pid] || String(pid), n: 1, pts }); } // тренер = очки вышедших на замену
    }
    // таймлайн событий игрока (минута есть только здесь; удары в створ — счётчик без минуты, идут в разбивку)
    for (const ev of det.realMatchEvents || []) {
      const pid = ev.realPlayerId; if (pid == null) continue;
      if (!['goal', 'assist', 'substitution', 'yellow_card', 'red_card'].includes(ev.mainType)) continue;
      (playerEvents[pid] || (playerEvents[pid] = [])).push({ t: ev.mainType, minute: ev.minute != null ? ev.minute : null });
    }
  }
  return { playerPts, playerMin, coachPts, matchInfo, allConfirmed: ids.length > 0 && confirmed === ids.length, playerBreak, playerEvents, coachBreak };
}
// накопленные за турнир очки/минуты по игроку (подсказка в номинации) — сумма по СЫГРАННЫМ матчам сезона до тура uptoRound. Статы сыгранных матчей неизменны → кэш 10 мин.
const _seasonStatsCache = new Map();                       // `${season}|${upto}` -> {t, map}
async function seasonStats(seasonId, uptoRound) {
  const key = seasonId + '|' + uptoRound, now = Date.now();
  const c = _seasonStatsCache.get(key); if (c && now - c.t < 600000) return c.map;
  const map = {};                                          // pid -> {pts, min}
  for (let k = 1; k <= uptoRound; k++) {
    let listing; try { listing = await ftGet(`real_matches?season_id=${seasonId}&round=${k}`); } catch (e) { continue; }
    for (const m of (listing.realMatches || [])) {
      if (m.status !== 'confirmed') continue;              // только сыгранные
      let det; try { det = await ftDetail(m.id); } catch (e) { continue; }
      for (const r of (det.realPlayerMatchStats || [])) {
        const pid = r.realPlayerId, br = cpBreak(r.stats || {}, r.position || '');
        const e = map[pid] || (map[pid] = { pts: 0, min: 0 });
        e.pts += br.reduce((a, b) => a + b.pts, 0); e.min += (r.minutesPlayed || 0);
      }
      await sleep(100);                                    // вежливый троттлинг FanTeam
    }
  }
  for (const k in map) map[k].pts = Math.round(map[k].pts * 10) / 10;
  _seasonStatsCache.set(key, { t: now, map });
  return map;
}
// standings драфта; статус settled когда все матчи confirmed
async function scoreDraft(draftId) {
  const drows = await svcGet(`dc_drafts?id=eq.${draftId}&select=*`); const d = drows[0];
  if (!d) throw new Error('нет драфта');
  const ids = d.match_ids || [];
  const rosters = await svcGet(`dc_draft_rosters?draft_id=eq.${draftId}&select=*`);
  const { playerPts, playerMin, coachPts, matchInfo, allConfirmed, playerBreak, playerEvents, coachBreak } = await draftPoints(ids);
  const brk = (r) => r.position === 'COACH' ? (coachBreak[r.player_id] || []) : mergeBreak(playerBreak[r.player_id] || []);   // разбивка очков игрока/тренера для тултипа (#6)
  const evs = (r) => r.position === 'COACH' ? [] : (playerEvents[r.player_id] || []).slice().sort((a, b) => (a.minute == null ? 1e9 : a.minute) - (b.minute == null ? 1e9 : b.minute));   // таймлайн (#5)
  let clubOdds = [], matches = [];
  try { const ti = await tourInfo(d.season_id, d.round, ids); clubOdds = ti.clubOdds; matches = ti.fixtures.map((f) => ({ ...f, score: (matchInfo[f.matchId] || {}).score || null, status: (matchInfo[f.matchId] || {}).status || f.status })); } catch (e) { console.error('tourInfo', e.message); }
  const clubStatus = {}, clubCode = {};
  for (const f of matches) { clubStatus[f.home] = f.status; clubStatus[f.away] = f.status; clubCode[f.home] = f.homeCode; clubCode[f.away] = f.awayCode; }
  // статус игрока: сыграл / не вышел (0 минут при завершённом матче) / идёт / ждёт матч; тренер — по статусу матча
  const pstat = (club, min, isCoach) => { const st = clubStatus[club] || 'pending'; if (isCoach) return st === 'confirmed' ? 'final' : st; if (st === 'confirmed') return min > 0 ? 'played' : 'dnp'; return st; };
  const uids = [...new Set(rosters.map((r) => r.user_id))]; const names = {};
  if (uids.length) { const pf = await svcGet(`dc_profiles?id=in.(${uids.map((u) => '"' + u + '"').join(',')})&select=id,display_name`); for (const p of pf) names[p.id] = p.display_name; }
  const rnd1 = (x) => Math.round(x * 10) / 10;
  const PMIN = { GK: 1, DEF: 3, MID: 2, FWD: 1, COACH: 1 }, PMAX = { GK: 1, DEF: 5, MID: 5, FWD: 3, COACH: 1 };
  const byUser = {}; for (const r of rosters) (byUser[r.user_id] || (byUser[r.user_id] = [])).push(r);
  const standings = [], teams = [];
  // порядок приобретения игрока на драфте (индекс в логе пиков; winnerId=seat, unitName=name) — для переключателя сортировки в просмотрщике
  const pickIdx = {}; (d.picks || []).forEach((p, idx) => { const k = `${p.winnerId}|${p.unitName}|${p.position}`; if (!(k in pickIdx)) pickIdx[k] = idx; });
  const dOrd = (r) => (pickIdx[`${r.seat}|${r.name}|${r.position}`] ?? 1e9);
  for (const uid of Object.keys(byUser)) {
    const rs = byUser[uid], starters = rs.filter((r) => !r.is_sub), sub = rs.find((r) => r.is_sub);
    let total = 0; const players = [];
    for (const r of starters) {
      const pp = r.position === 'COACH' ? (coachPts[r.player_id] || 0) : (playerPts[r.player_id] || 0);
      total += pp;
      players.push({ name: r.disp || r.name, club: r.club, code: clubCode[r.club] || '', position: r.position, points: rnd1(pp), minutes: playerMin[r.player_id] || 0, cost: r.price != null ? r.price : null, mstatus: pstat(r.club, playerMin[r.player_id] || 0, r.position === 'COACH'), isCoach: r.position === 'COACH', isSub: false, counted: true, draftOrder: dOrd(r), breakdown: brk(r), events: evs(r) });
    }
    // Замена срабатывает, если есть несыгравший стартовый (матч завершён, 0 минут — pending/live НЕ считаем «не вышел», иначе замена
    // зелёная по умолчанию, #15), которого она может закрыть. Проверяем КАЖДОГО несыгравшего отдельно: замена позиции P может закрыть
    // несыгравшего позиции Q, если ввод не превышает максимум P (сыгравшие[P]+1 ≤ max) И не роняет минимум освобождаемой Q (сыгравшие[Q] ≥ min;
    // для своей позиции — сыгравшие[Q]+1). Уже нарушенный минимум ДРУГОЙ линии не блокирует (напр. защита просела до 2, но форвард-замена
    // закрывает несыгравшего ПЗ — срабатывает). Вратаря меняет только вратарь; тренера — никто. ЗАЩ/ПЗ/НАП взаимозаменяемы (ограничение — лимиты).
    const isDnp = (r) => pstat(r.club, playerMin[r.player_id] || 0, false) === 'dnp';
    let subUsed = false;
    if (sub) {
      const P = sub.position;
      if (P === 'GK') {
        subUsed = starters.some((r) => r.position === 'GK' && isDnp(r));                            // вратаря заменяет только вратарь, и только если стартовый не вышел
      } else {
        const played = { DEF: 0, MID: 0, FWD: 0 };
        for (const r of starters) if (['DEF', 'MID', 'FWD'].includes(r.position) && !isDnp(r)) played[r.position]++;
        const dnpPos = new Set(starters.filter((r) => ['DEF', 'MID', 'FWD'].includes(r.position) && isDnp(r)).map((r) => r.position));
        for (const Q of dnpPos) {
          const newP = played[P] + 1;                                                              // замена выходит на свою позицию
          const newQ = (P === Q) ? played[Q] + 1 : played[Q];                                      // освобождаем слот несыгравшего Q
          if (newP <= PMAX[P] && newQ >= PMIN[Q]) { subUsed = true; break; }                       // не превышаем max своей позиции и не роняем min освобождаемой
        }
      }
      const sp = playerPts[sub.player_id] || 0; if (subUsed) total += sp;
      players.push({ name: sub.disp || sub.name, club: sub.club, code: clubCode[sub.club] || '', position: sub.position, points: rnd1(sp), minutes: playerMin[sub.player_id] || 0, cost: sub.price != null ? sub.price : null, mstatus: pstat(sub.club, playerMin[sub.player_id] || 0, false), isCoach: false, isSub: true, counted: subUsed, draftOrder: dOrd(sub), breakdown: brk(sub), events: evs(sub) });
    }
    total = rnd1(total);
    standings.push({ user_id: uid, name: names[uid] || uid.slice(0, 8), total, subUsed });
    // «осталось сыграть»: стартовые (их 12, с тренером) всегда; замену добавляем ТОЛЬКО когда она сработала (стартовый не вышел) и сама ещё ждёт свой матч (#15)
    const subP = players.find((p) => p.isSub);
    const toPlay = players.filter((p) => !p.isSub && (p.mstatus === 'pending' || p.mstatus === 'live')).length
      + (subUsed && subP && (subP.mstatus === 'pending' || subP.mstatus === 'live') ? 1 : 0);
    const finishOrder = rs.length && rs[0].finish_order != null ? rs[0].finish_order : null;
    const seat = rs.length ? rs[0].seat : null;
    teams.push({ user_id: uid, name: names[uid] || uid.slice(0, 8), total, toPlay, finishOrder, seat, activeMs: (d.seat_ms && d.seat_ms[seat]) || 0, players });
  }
  standings.sort((a, b) => b.total - a.total);
  standings.forEach((s, i) => { s.place = i + 1; });                                  // место по очкам — для медалей/контура в просмотрщике
  const placeByUser = {}; for (const s of standings) placeByUser[s.user_id] = s.place;
  for (const t of teams) t.place = placeByUser[t.user_id] || null;
  // Порядок блоков команд = порядок жеребьёвки (как колонки шли в кокпите, ф-я ordered() по d.order). d.order в БД не сохраняется →
  // восстанавливаем по логу: аукцион пошаговый, ход идёт по жеребьёвке, поэтому порядок ПЕРВОГО действия участника (выставил/ставка/пас)
  // на первом лоте = порядок жеребьёвки. Берём имена в порядке первого появления среди действий торгов. Fallback на seat, если лога нет.
  const drawSeq = [];
  const pushName = (nm) => { if (nm && !drawSeq.includes(nm)) drawSeq.push(nm); };
  for (const ev of (d.events || [])) {
    const kind = (ev && typeof ev === 'object') ? ev.kind : null;
    if (kind && !['nominate', 'bid', 'pass'].includes(kind)) continue;                 // только действия торгов (не join/leave/chat/done/sub)
    const tx = typeof ev === 'string' ? ev : (ev && ev.text) || '';
    const m = tx.match(/^#\d+\s+(.+?)\s+выставил\s/) || tx.match(/^(.+?)\s+[—–-]\s+(?:ставка|пас|авто-пас)/);   // без \b — в JS он не работает на границе кириллица/пробел; тире любого типа
    if (m) pushName(m[1]);
  }
  const drawPos = new Map(); drawSeq.forEach((nm, i) => drawPos.set(nm, i));
  const ordKey = (t) => drawPos.has(t.name) ? drawPos.get(t.name) : (1000 + (t.seat || 0));
  teams.sort((a, b) => ordKey(a) - ordKey(b));
  let status = d.status;
  if (allConfirmed && d.status === 'done') {
    await svcPatch(`dc_drafts?id=eq.${draftId}`, { status: 'settled' }); status = 'settled';
    try { await payPrizes(draftId, standings, d); } catch (err) { console.error('payPrizes', err.message); }
  }
  return { status, allConfirmed, standings, teams, matches, clubOdds, picks: d.picks || null, events: d.events || null, chat: d.chat || null, hasRosters: rosters.length > 0 };
}

// Кэш результатов scoreDraft: один пересчёт на драфт раз в SCORE_TTL, всем клиентам — из кэша.
// Снимает зависимость частоты запросов к FanTeam от числа открытых просмотрщиков (риск бана не растёт),
// даёт «обновлено X назад» (updatedAt = время реального пересчёта) и делает кнопку «обновить» безопасной.
const SCORE_TTL = 30000;
const scoreCache = new Map(); // draftId -> { at, data }
async function scoreDraftCached(draftId, force) {
  const c = scoreCache.get(draftId);
  const now = Date.now();
  if (!force && c && (now - c.at) < SCORE_TTL) return { ...c.data, updatedAt: c.at };
  const data = await scoreDraft(draftId);
  const at = Date.now();
  scoreCache.set(draftId, { at, data });
  return { ...data, updatedAt: at };
}

// Сводка тура для предпросмотра драфта в лобби (матчи + котировки клубов), кэш 60с — один запрос к FanTeam на драфт.
const tourCache = new Map(); // draftId -> { t, data }
async function tourForDraftCached(draftId) {
  const c = tourCache.get(draftId), now = Date.now();
  if (c && now - c.t < 60000) return c.data;
  const rows = await svcGet(`dc_drafts?id=eq.${draftId}&select=season_id,round,match_ids,league,tournament`); const d = rows[0];
  if (!d) throw new Error('драфт не найден');
  const { clubOdds, fixtures } = await tourInfo(d.season_id, d.round, d.match_ids);
  const data = { league: d.league, tournament: d.tournament, round: d.round, clubOdds, fixtures };
  tourCache.set(draftId, { t: now, data });
  return data;
}

// Пул игроков драфта для предпросмотра в лобби (как пул аукциона). Тяжёлый (per-match membership) → кэш 10 мин: предматчевые составы стабильны.
const poolCache = new Map(); // draftId -> { t, data }
async function poolForDraftCached(draftId) {
  const c = poolCache.get(draftId), now = Date.now();
  if (c && now - c.t < 600000) return c.data;
  const rows = await svcGet(`dc_drafts?id=eq.${draftId}&select=season_id,round,match_ids`); const d = rows[0];
  if (!d) throw new Error('драфт не найден');
  const { units, clubOdds, matches } = await buildDraftPool(d.season_id, d.round, d.match_ids);
  const data = { units, clubOdds, matches };
  poolCache.set(draftId, { t: now, data });
  return data;
}

const rooms = new Map(); // code -> { room, clients:Set<ws> }
let autoplayEnabled = false; // тумблер авто-доигрывания (для теста), по умолчанию выкл — в проде остаётся off
function makeCode() {
  const a = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c;
  do { c = Array.from({ length: 4 }, () => a[Math.floor(Math.random() * a.length)]).join(''); }
  while (rooms.has(c));
  return c;
}

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/config.json') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(clientConfig()));
  }
  if (url === '/api/ft/matches') {
    const q = new URLSearchParams((req.url.split('?')[1] || ''));
    const season = q.get('season'), round = q.get('round');
    if (!season || !round) { res.writeHead(400, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: 'нужны season и round' })); }
    ftMatches(season, round)
      .then(matches => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ matches })); })
      .catch(e => { res.writeHead(502, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: String(e.message || e) })); });
    return;
  }
  if (url === '/api/flags') {
    res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ autoplay: autoplayEnabled }));
  }
  if (url === '/api/admin/autoplay' && req.method === 'POST') {
    let body = ''; req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      try {
        const { on } = JSON.parse(body || '{}');
        const token = (req.headers.authorization || '').replace(/^Bearer /, '');
        const user = await authUser(token); const prof = await getProfile(user.id);
        if (!prof || prof.role !== 'admin') throw new Error('только админ');
        autoplayEnabled = !!on;
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ autoplay: autoplayEnabled }));
      } catch (e) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: String(e.message || e) })); }
    });
    return;
  }
  if (url === '/api/ft/matchstats') {
    const q = new URLSearchParams((req.url.split('?')[1] || ''));
    const matchId = q.get('matchId');
    if (!matchId) { res.writeHead(400, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: 'нужен matchId' })); }
    ftDetail(matchId).then((det) => {
      const names = {}; for (const m of det.realTeamMemberships || []) { const rp = m.realPlayer || {}; names[m.realPlayerId] = [rp.firstName, rp.lastName].filter(Boolean).join(' ') || m.realPlayerId; }  // полное имя+фамилия — снять разночтения у Lee/Kim (#14)
      const teams = {}, abbr = {}; for (const t of det.realTeams || []) { teams[t.id] = t.name || String(t.id); abbr[t.id] = t.abbr || String(t.name || '').slice(0, 3).toUpperCase(); }
      const rm = det.realMatch || {}; const tids = (rm.realTeamIds || []).slice(0, 2);
      const players = (det.realPlayerMatchStats || []).map((r) => ({ name: names[r.realPlayerId] || r.realPlayerId, club: teams[r.realTeamId] || r.realTeamId, position: r.position, lineup: r.lineup, minutes: r.minutesPlayed || 0, total: cp(r.stats || {}, r.position), stats: r.stats || {} }));
      // лог событий матча (#5): timed из realMatchEvents (голы/ассисты/карточки/замены), untimed из счётчиков (удары/сухой/сейвы/пенальти/автогол). НЕ детализируем: минуты на поле, импакт, пропущенные.
      const onePts = (key, pos, n) => Math.round(cpBreak({ [key]: n }, pos).reduce((a, b) => a + b.pts, 0) * 100) / 100;
      // kind — для иконок/курсива на клиенте. Clean Sheet в лог НЕ кладём (по тз). Минуты на поле/импакт/пропущенные тоже не детализируем.
      const TIMED = { goal: ['goal', 'Goal', 'goal'], assist: ['assist', 'Assist', 'assist'], yellow_card: ['yellowCard', 'Yellow Card', 'yc'], red_card: ['redCard', 'Red Card', 'rc'] };
      const log = [];
      for (const e of det.realMatchEvents || []) {
        const pid = e.realPlayerId; if (pid == null) continue; const pos = e.position || '';
        if (e.mainType === 'substitution') { const on = e.subType === 0; log.push({ minute: e.minute != null ? e.minute : null, name: names[pid] || String(pid), teamId: e.realTeamId, action: on ? 'Subbed ON' : 'Subbed OFF', kind: on ? 'sub_on' : 'sub_off', pts: null }); continue; }
        const t = TIMED[e.mainType]; if (!t) continue;
        log.push({ minute: e.minute != null ? e.minute : null, name: names[pid] || String(pid), teamId: e.realTeamId, action: t[1], kind: t[2], pts: onePts(t[0], pos, 1) });
      }
      const UNTIMED = [['shotOnTarget', 'Shot on Target', 'shot'], ['keeperSave', 'Save', 'save'], ['penaltySave', 'Penalty Save', 'pensave'], ['penaltyMiss', 'Penalty Miss', 'penmiss'], ['penaltyCaused', 'Blunder', 'blunder'], ['ownGoal', 'Own Goal', 'owngoal']];
      for (const r of det.realPlayerMatchStats || []) {
        const pos = r.position || '', s = r.stats || {}, pid = r.realPlayerId;
        for (const [key, lbl, kind] of UNTIMED) {
          const n = +s[key] || 0; if (!n) continue; const pts = onePts(key, pos, n); if (!pts) continue;   // 0 очков за категорию для этой позиции — пропускаем
          log.push({ minute: null, name: names[pid] || String(pid), teamId: r.realTeamId, action: n > 1 ? lbl + ' ×' + n : lbl, kind, pts });
        }
      }
      log.sort((a, b) => (a.minute == null ? 1e9 : a.minute) - (b.minute == null ? 1e9 : b.minute));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ home: teams[tids[0]] || '', away: teams[tids[1]] || '', homeId: tids[0] || null, awayId: tids[1] || null, homeCode: abbr[tids[0]] || '', awayCode: abbr[tids[1]] || '', status: rm.status || null, players, log }));
    }).catch((e) => { res.writeHead(502, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: String(e.message || e) })); });
    return;
  }
  if (url === '/api/draft/score') {
    const q = new URLSearchParams((req.url.split('?')[1] || ''));
    const draftId = q.get('draftId');
    if (!draftId) { res.writeHead(400, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: 'нужен draftId' })); }
    scoreDraftCached(draftId, q.get('force') === '1')
      .then((r) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(r)); })
      .catch((e) => { res.writeHead(502, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: String(e.message || e) })); });
    return;
  }
  if (url === '/api/draft/tour') {
    const q = new URLSearchParams((req.url.split('?')[1] || ''));
    const draftId = q.get('draftId');
    if (!draftId) { res.writeHead(400, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: 'нужен draftId' })); }
    tourForDraftCached(draftId)
      .then((r) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(r)); })
      .catch((e) => { res.writeHead(502, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: String(e.message || e) })); });
    return;
  }
  if (url === '/api/draft/pool') {
    const q = new URLSearchParams((req.url.split('?')[1] || ''));
    const draftId = q.get('draftId');
    if (!draftId) { res.writeHead(400, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: 'нужен draftId' })); }
    poolForDraftCached(draftId)
      .then((r) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(r)); })
      .catch((e) => { res.writeHead(502, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: String(e.message || e) })); });
    return;
  }
  if (url === '/api/draft/seasonstats') {                                // накопленные очки/минуты по игрокам сезона (для подсказки в номинации)
    const q = new URLSearchParams((req.url.split('?')[1] || ''));
    (async () => {
      try {
        let sid = q.get('season'), rnd = q.get('round'); const draftId = q.get('draftId');
        if ((!sid || !rnd) && draftId) { const d = (await svcGet(`dc_drafts?id=eq.${draftId}&select=season_id,round`))[0]; if (d) { sid = d.season_id; rnd = d.round; } }
        if (!sid || !rnd) throw new Error('нужны season+round или draftId');
        const map = await seasonStats(+sid, +rnd);
        const out = {}; for (const k in map) out[k] = [map[k].pts, map[k].min];   // компактно: [pts, min]
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'public, max-age=120' }); res.end(JSON.stringify({ stats: out }));
      } catch (e) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: String(e.message || e) })); }
    })();
    return;
  }
  if (url === '/api/draft/launch' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e5) req.destroy(); });
    req.on('end', async () => {
      try {
        const { draftId } = JSON.parse(body || '{}');
        const token = (req.headers.authorization || '').replace(/^Bearer /, '');
        const user = await authUser(token);
        const prof = await getProfile(user.id);
        if (!prof || prof.role !== 'admin') throw new Error('только админ может запускать драфт');
        const code = await launchDraft(draftId);
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ code }));
      } catch (e) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: String(e.message || e) })); }
    });
    return;
  }
  if (url === '/api/draft/unapply' && req.method === 'POST') {           // участник сам отзывает свою заявку (только пока идёт набор)
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e5) req.destroy(); });
    req.on('end', async () => {
      try {
        const { draftId } = JSON.parse(body || '{}');
        const token = (req.headers.authorization || '').replace(/^Bearer /, '');
        const user = await authUser(token);
        const drows = await svcGet(`dc_drafts?id=eq.${draftId}&select=status`); const d = drows[0];
        if (!d) throw new Error('драфт не найден');
        if (d.status !== 'recruiting') throw new Error('заявку можно отозвать только пока идёт набор');
        await svcDelete(`dc_applications?draft_id=eq.${draftId}&user_id=eq.${user.id}`);   // только свою (по user_id из токена)
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true }));
      } catch (e) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: String(e.message || e) })); }
    });
    return;
  }
  if (url === '/api/draft/refresh-odds' && req.method === 'POST') {       // админ: спарсить кэфы (Win%/xG/CS) из FanTeam сейчас; для live-комнаты применить сразу
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e5) req.destroy(); });
    req.on('end', async () => {
      try {
        const { draftId } = JSON.parse(body || '{}');
        const token = (req.headers.authorization || '').replace(/^Bearer /, '');
        const user = await authUser(token);
        const prof = await getProfile(user.id);
        if (!prof || prof.role !== 'admin') throw new Error('только админ');
        const drows = await svcGet(`dc_drafts?id=eq.${draftId}&select=season_id,round,match_ids`); const d = drows[0];
        if (!d) throw new Error('драфт не найден');
        const { clubOdds } = await tourInfo(d.season_id, d.round, d.match_ids);   // прямой запрос (без 60с-кэша) → свежие данные
        const total = clubOdds.length;
        const withOdds = clubOdds.filter((o) => o.win != null || o.xg != null || o.cs != null).length;
        const gaps = total - withOdds;                                            // клубы, по которым FanTeam ещё молчит → пробуем sstats
        let applied = false;
        for (const [, ent] of rooms) {
          if (ent.room && String(ent.room.draftId) === String(draftId)) {         // живая комната → FanTeam применяем сразу, sstats-доливку запускаем в фоне (медленно, прилетит через broadcastPool)
            applied = true;
            refreshOdds(ent, { sstats: gaps > 0 }).catch((err) => console.error('refresh-odds bg', err.message));
            break;
          }
        }
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ total, withOdds, applied, sstatsRunning: applied && gaps > 0 }));
      } catch (e) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: String(e.message || e) })); }
    });
    return;
  }
  if (url === '/api/draft/reconnect' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e5) req.destroy(); });
    req.on('end', async () => {
      try {
        const { draftId } = JSON.parse(body || '{}');
        const token = (req.headers.authorization || '').replace(/^Bearer /, '');
        const user = await authUser(token);
        const prof = await getProfile(user.id);
        if (!prof || prof.role !== 'admin') throw new Error('только админ');
        let target = null;
        for (const [, ent] of rooms) { if (ent.room && String(ent.room.draftId) === String(draftId)) { target = ent; break; } }
        if (!target) throw new Error('живая комната не найдена (сначала «Воскресить комнату»)');
        let n = 0; const m = JSON.stringify({ type: 'reconnect' });
        for (const c of target.clients) { if (c.readyState === 1) { c.send(m); n++; } }
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ reconnected: n }));
      } catch (e) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: String(e.message || e) })); }
    });
    return;
  }
  if (url === '/api/tts/pick' && req.method === 'POST') {                 // озвучка покупки: {playerId,playerName,buyerUserId,buyerName,price} → mp3
    let body = ''; req.on('data', (c) => { body += c; if (body.length > 1e5) req.destroy(); });
    req.on('end', async () => {
      try {
        const { playerId, playerName, buyerUserId, buyerName, price } = JSON.parse(body || '{}');
        const pron = {};
        try {
          const refs = [playerId, buyerUserId].filter((x) => x != null).map((x) => '"' + x + '"').join(',');
          if (refs) { const rows = await svcGet(`dc_pronunciations?ref=in.(${refs})&select=kind,ref,say`); for (const r of rows) pron[r.kind + ':' + r.ref] = r.say; }
        } catch (e) { /* нет таблицы/оверрайдов — берём фолбэк-имена */ }
        const psay = pron['player:' + playerId] || translitRu(playerName) || 'игрок';
        const nsay = pron['nick:' + buyerUserId] || translitRu(buyerName) || 'участник';
        const p = Math.round(+price || 0);
        const text = `${psay} был куплен игроком ${nsay} за ${p} ${mlnWord(p)}.`;
        const audio = await ttsSynth(text);
        res.writeHead(200, { 'content-type': 'audio/mpeg', 'cache-control': 'no-store' }); res.end(audio);
      } catch (e) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: String(e.message || e) })); }
    });
    return;
  }
  if (url === '/api/tts/nominate' && req.method === 'POST') {             // озвучка номинации: «В торгах {игрок}»
    let body = ''; req.on('data', (c) => { body += c; if (body.length > 1e5) req.destroy(); });
    req.on('end', async () => {
      try {
        const { playerId, playerName } = JSON.parse(body || '{}');
        let say = null;
        try { const rows = await svcGet(`dc_pronunciations?kind=eq.player&ref=eq.${encodeURIComponent(String(playerId))}&select=say`); if (rows[0]) say = rows[0].say; } catch (e) {}
        const psay = say || translitRu(playerName) || 'игрок';
        const audio = await ttsSynth(`В торгах ${psay}.`);
        res.writeHead(200, { 'content-type': 'audio/mpeg', 'cache-control': 'no-store' }); res.end(audio);
      } catch (e) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: String(e.message || e) })); }
    });
    return;
  }
  if (url === '/api/tts/say' && req.method === 'POST') {                  // админ: прослушать произвольный текст (превью произношения)
    let body = ''; req.on('data', (c) => { body += c; if (body.length > 1e5) req.destroy(); });
    req.on('end', async () => {
      try {
        const token = (req.headers.authorization || '').replace(/^Bearer /, '');
        const user = await authUser(token); const prof = await getProfile(user.id);
        if (!prof || prof.role !== 'admin') throw new Error('только админ');
        const { text } = JSON.parse(body || '{}');
        const t = String(text || '').trim().slice(0, 300); if (!t) throw new Error('пустой текст');
        const audio = await ttsSynth(t);
        res.writeHead(200, { 'content-type': 'audio/mpeg', 'cache-control': 'no-store' }); res.end(audio);
      } catch (e) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: String(e.message || e) })); }
    });
    return;
  }
  if (url === '/api/admin/pron') {                                        // админ: текущие произношения + каталоги (ники + сыгранные игроки)
    (async () => {
      try {
        const token = (req.headers.authorization || '').replace(/^Bearer /, '');
        const user = await authUser(token); const prof = await getProfile(user.id);
        if (!prof || prof.role !== 'admin') throw new Error('только админ');
        const pron = await svcGet('dc_pronunciations?select=kind,ref,say').catch(() => []);
        const nrows = await svcGet('dc_profiles?select=id,display_name&order=display_name.asc');
        const nicks = nrows.map((u) => ({ id: u.id, display_name: u.display_name, suggest: translitRu(u.display_name) }));
        const seen = new Set(); const players = [];
        const addP = (pid, name, club) => { const ref = String(pid); if (!pid || seen.has(ref)) return; seen.add(ref); players.push({ player_id: ref, name, club, suggest: translitRu(name) }); };
        const rrows = await svcGet('dc_draft_rosters?select=player_id,name,club,position');
        for (const r of rrows) if (r.position !== 'COACH') addP(r.player_id, r.name, r.club);   // сыгранные
        try {                                                                                    // + весь пул активных драфтов (recruiting/finalized/live) — готовить произношение заранее
          const active = await svcGet('dc_drafts?status=in.(recruiting,finalized,live)&select=id,match_ids');
          const doneKeys = new Set();
          for (const d of active) { const key = (d.match_ids || []).join(','); if (doneKeys.has(key)) continue; doneKeys.add(key); try { const pool = await poolForDraftCached(d.id); for (const u of (pool.units || [])) if (u.position !== 'COACH') addP(u.id, u.name, u.club); } catch (e) {} }
        } catch (e) {}
        players.sort((a, b) => String(a.club).localeCompare(String(b.club)) || String(a.name).localeCompare(String(b.name)));
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ pron, nicks, players }));
      } catch (e) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: String(e.message || e) })); }
    })();
    return;
  }
  if (url === '/api/admin/pron-set' && req.method === 'POST') {           // админ: задать/очистить произношение
    let body = ''; req.on('data', (c) => { body += c; if (body.length > 1e5) req.destroy(); });
    req.on('end', async () => {
      try {
        const token = (req.headers.authorization || '').replace(/^Bearer /, '');
        const user = await authUser(token); const prof = await getProfile(user.id);
        if (!prof || prof.role !== 'admin') throw new Error('только админ');
        const { kind, ref, say } = JSON.parse(body || '{}');
        if (!['player', 'nick'].includes(kind) || ref == null) throw new Error('bad kind/ref');
        const s = (say || '').trim();
        if (!s) await svcDelete(`dc_pronunciations?kind=eq.${kind}&ref=eq.${encodeURIComponent(String(ref))}`);
        else await svcUpsert('dc_pronunciations', [{ kind, ref: String(ref), say: s }]);
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true }));
      } catch (e) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: String(e.message || e) })); }
    });
    return;
  }
  if (url === '/api/admin/users') {
    (async () => {
      try {
        const token = (req.headers.authorization || '').replace(/^Bearer /, '');
        const user = await authUser(token); const prof = await getProfile(user.id);
        if (!prof || prof.role !== 'admin') throw new Error('только админ');
        const users = await svcGet('dc_profiles?select=id,display_name,dcc_balance,role,games_played,wins&order=display_name.asc');
        const emailById = {};                                   // email живёт в auth.users → Admin Auth API (service key)
        try {
          const ar = await fetch(`${process.env.SUPABASE_URL}/auth/v1/admin/users?page=1&per_page=1000`, { headers: { apikey: process.env.SUPABASE_SERVICE_KEY, authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_KEY } });
          if (ar.ok) { const aj = await ar.json(); for (const u of (aj.users || [])) emailById[u.id] = u.email; }
        } catch (e) { console.error('admin users email', e.message); }
        for (const u of users) u.email = emailById[u.id] || null;
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ users }));
      } catch (e) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: String(e.message || e) })); }
    })();
    return;
  }
  if (url === '/api/admin/credit' && req.method === 'POST') {
    let body = ''; req.on('data', (c) => { body += c; if (body.length > 1e5) req.destroy(); });
    req.on('end', async () => {
      try {
        const { userId, amount, note } = JSON.parse(body || '{}');
        const token = (req.headers.authorization || '').replace(/^Bearer /, '');
        const user = await authUser(token); const prof = await getProfile(user.id);
        if (!prof || prof.role !== 'admin') throw new Error('только админ');
        const amt = Math.round(Number(amount) || 0);
        if (!userId || !amt) throw new Error('нужен userId и ненулевая сумма');
        await ledger(userId, null, 'admin_credit', amt, note || 'начисление админом');
        const pf = await svcGet(`dc_profiles?id=eq.${userId}&select=dcc_balance`);
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ balance: pf[0] ? pf[0].dcc_balance : null }));
      } catch (e) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: String(e.message || e) })); }
    });
    return;
  }
  if (url === '/api/ice') {
    const secret = process.env.TURN_SECRET;
    const turnUrl = process.env.TURN_URL || ('turn:' + (req.headers.host || '147.45.158.66').split(':')[0] + ':3478');
    const stunUrl = turnUrl.replace(/^turns?:/, 'stun:').split('?')[0];
    const iceServers = [{ urls: stunUrl }];
    if (secret) {
      const username = String(Math.floor(Date.now() / 1000) + 12 * 3600); // эфемерный логин = срок жизни (12ч)
      const credential = crypto.createHmac('sha1', secret).update(username).digest('base64');
      iceServers.push({ urls: turnUrl, username, credential });
      iceServers.push({ urls: turnUrl + '?transport=tcp', username, credential });
    }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ iceServers }));
    return;
  }
  let file = url === '/' ? '/index.html' : url;
  if (file.endsWith('/')) file += 'index.html';
  const full = path.join(__dirname, 'public', file);
  if (!full.startsWith(path.join(__dirname, 'public'))) { res.writeHead(403); return res.end(); }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    const ext = path.extname(full);
    const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.wav': 'audio/wav' }[ext] || 'text/plain';
    const headers = { 'content-type': mime + '; charset=utf-8' };
    if (ext === '.html') headers['cache-control'] = 'no-cache, no-store, must-revalidate';
    res.writeHead(200, headers);
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });
let rtcSeq = 0;                                          // уникальный id соединения для WebRTC-mesh (игроки и зрители)

// WS keepalive: пингуем клиентов; мёртвый (half-open) сокет не ответит pong → terminate → честный 'close' → presence чистится (dupLive прикрывает гонку реконнекта)
const WS_PING_MS = 30000;
const wsHeartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { try { ws.terminate(); } catch {} continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, WS_PING_MS);
wss.on('close', () => clearInterval(wsHeartbeat));

const DRAW_SPIN_MS = 6500, DRAW_REVEAL_MS = 2000; // жеребьёвка: (n-1) спинов + показ финального порядка; последний выбирается автоматом (синхронно с клиентом)
function broadcast(code) {
  const e = rooms.get(code);
  if (!e) return;
  const state = e.room.serialize();
  if (state.lobby) state.lobby.rtc = [...e.clients]    // все в комнате для mesh: {id(rtcId), name, seat|null}
    .filter((c) => c.user && c.rtcId)
    .map((c) => ({ id: c.rtcId, name: c.name || 'Player', seat: c.seatId == null ? null : c.seatId, uid: c.user.id, listen: c.voiceListen === true }));
  const msg = JSON.stringify({ type: 'state', state });
  for (const c of e.clients) if (c.readyState === 1) c.send(msg);
}
function sendErr(ws, message) { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'error', message })); }

function attach(ws, code) {
  ws.roomCode = code;
  const e = rooms.get(code);
  e.clients.add(ws);
  ws.send(JSON.stringify({ type: 'room', code }));
  ws.send(JSON.stringify({ type: 'pool', units: e.room.pool, clubOdds: e.room.clubOdds, matches: e.room.matches }));
}
function broadcastPool(e) {
  const msg = JSON.stringify({ type: 'pool', units: e.room.pool, clubOdds: e.room.clubOdds, matches: e.room.matches });
  for (const c of e.clients) if (c.readyState === 1) c.send(msg);
}
// Коэф/xG/CS снапшотятся в комнату на launchDraft — часто задолго до матчей, когда FanTeam их ещё не опубликовал (→ нули у части клубов).
// На старте аукциона (ближе к матчам) подтягиваем свежие через лёгкий tourInfo (один запрос) и доливаем недостающие поля, не затирая уже валидные.
async function refreshOdds(e, opts = {}) {
  const meta = e.room && e.room.draftMeta;
  if (!meta) return { ft: 0, ss: 0 };
  const hasGaps = () => (e.room.clubOdds || []).some((o) => o.win == null || o.xg == null || o.cs == null);
  // долить недостающие поля из map by[club], не затирая уже валидные значения; вернуть число изменённых клубов
  const apply = (by) => {
    let n = 0;
    e.room.clubOdds = (e.room.clubOdds || []).map((o) => {
      const f = by[o.club]; if (!f) return o;
      const merged = { club: o.club, win: o.win ?? f.win, xg: o.xg ?? f.xg, cs: o.cs ?? f.cs };
      if (merged.win !== o.win || merged.xg !== o.xg || merged.cs !== o.cs) n++;
      return merged;
    });
    return n;
  };
  // 1) основной источник — свежий FanTeam (один лёгкий tourInfo)
  let ftFilled = 0;
  try {
    const { clubOdds: fresh } = await tourInfo(meta.seasonId, meta.round, meta.matchIds);
    if (fresh && fresh.some((o) => o.win != null || o.xg != null || o.cs != null)) {
      const by = {}; for (const o of fresh) by[o.club] = o;
      ftFilled = apply(by);
    }
  } catch (err) { console.error('refreshOdds ft', err.message); }
  if (ftFilled) broadcastPool(e);   // отдаём FanTeam-доливку сразу, не дожидаясь медленного sstats
  // 2) вторичный — sstats.net, ТОЛЬКО по явному запросу (медленный, троттлится ~2с/матч): закрывает то, что FanTeam ещё не опубликовал
  let ssFilled = 0;
  if (opts.sstats && hasGaps()) {
    try {
      const fixtures = (e.room.matches || []).filter((m) => m.home && m.away).map((m) => ({ home: m.home, away: m.away, startTime: m.startTime }));
      const { clubOdds: ss } = await sstatsClubOdds(fixtures);
      if (ss && ss.length) { const by = {}; for (const o of ss) by[o.club] = o; ssFilled = apply(by); if (ssFilled) broadcastPool(e); }
    } catch (err) { console.error('refreshOdds sstats', err.message); }
  }
  return { ft: ftFilled, ss: ssFilled };
}
async function joinAuthed(ws, msg) {
  const user = await authUser(msg.token);              // валидация токена → {id,email}
  const prof = await getProfile(user.id);
  const name = (prof && prof.display_name) || (user.email || 'Player').split('@')[0];
  ws.user = user;
  if (msg.voice) {                                     // голосовой компаньон: тот же аккаунт со второго устройства ТОЛЬКО для голоса
    ws.voice = true;                                   // НЕ занимаем/не реюзаем место → seatId=null → действия запрещены, presence места на ПК не трогаем
    ws.name = name + ' (голос)';                       // в mesh виден как отдельный голосовой пир
    ws.seatId = null;
    ws.send(JSON.stringify({ type: 'joined', you: null, name: ws.name, rtc: ws.rtcId, uid: user.id, voice: true }));
    broadcast(ws.roomCode);
    return;
  }
  ws.name = name;                                      // имя для списка rtc-пиров в стейте
  const e = ws.roomCode ? rooms.get(ws.roomCode) : null;
  const id = e ? e.room.join(user.id, name) : null;
  ws.seatId = id;                                      // null = зритель (не принят / мест нет)
  if (id === null && e) e.room.addSpectator(user.id, name);
  ws.send(JSON.stringify({ type: 'joined', you: id, name, rtc: ws.rtcId, uid: user.id }));
  broadcast(ws.roomCode);
}

wss.on('connection', (ws) => {
  ws.roomCode = null; ws.seatId = null; ws.user = null; ws.rtcId = ++rtcSeq; ws.name = null;
  ws.isAlive = true; ws.on('pong', () => { ws.isAlive = true; });   // ответ на протокольный ping heartbeat'а
  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    try {
      if (msg.type === 'ping') { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'pong' })); return; }   // app-watchdog клиента: эхо-pong
      if (msg.type === 'createRoom') {
        const code = makeCode();
        rooms.set(code, { room: new Room(), clients: new Set() });
        attach(ws, code);
        await joinAuthed(ws, msg);
      } else if (msg.type === 'joinRoom') {
        const code = String(msg.code || '').toUpperCase();
        if (!rooms.has(code)) return sendErr(ws, 'Комната не найдена');
        attach(ws, code);
        await joinAuthed(ws, msg);
      } else {
        const e = rooms.get(ws.roomCode);
        if (!e) return sendErr(ws, 'Сначала создай или войди в комнату');
        if (msg.type === 'rtc') { // сигналинг WebRTC: точечно пересылаем целевому пиру по rtcId (игроки и зрители), без рассылки стейта
          const target = [...e.clients].find((c) => c.rtcId === msg.to);
          if (target && target.readyState === 1) target.send(JSON.stringify({ type: 'rtc', from: ws.rtcId, data: msg.data }));
          return;
        }
        if (msg.type === 'voiceListen') { ws.voiceListen = !!msg.on; broadcast(ws.roomCode); return; } // голосовой компаньон слушает у себя → ПК того же аккаунта приглушит свой звук
        if (msg.type === 'leaveRoom') { // явный выход: помечаем место отключённым / убираем зрителя, отвязываем сокет от комнаты (close его уже не тронет)
          if (ws.seatId) e.room.disconnect(ws.seatId);
          else if (ws.user && !ws.voice) e.room.removeSpectator(ws.user.id);
          e.clients.delete(ws);
          const code = ws.roomCode; ws.roomCode = null; ws.seatId = null;
          broadcast(code);
          return;
        }
        if (msg.type === 'ready') { if (ws.seatId) e.room.setReady(ws.seatId, msg.ready !== false); }
        else if (msg.type === 'start') { e.room.start(); refreshOdds(e).catch(() => {}); }
        else if (msg.type === 'draw') {
          if (!ws.seatId) throw new Error('вы зритель');
          const code = ws.roomCode;
          if (e.room.draw()) {                                    // только что запустили жеребьёвку → стартуем драфт после анимации
            const drawMs = Math.max(0, e.room.seats.length - 1) * DRAW_SPIN_MS + DRAW_REVEAL_MS;
            setTimeout(() => {
              const e2 = rooms.get(code);
              if (e2 && e2.room.drawOrder && !e2.room.draft) {
                try { e2.room.start(); refreshOdds(e2).catch(() => {}); } catch (err) { console.error('draw start', err.message); }
                broadcast(code); syncStatus(e2);
              }
            }, drawMs);
          }
        }
        else if (msg.type === 'undo') { if (!ws.seatId) throw new Error('вы зритель'); e.room.undo(ws.seatId); }
        else if (msg.type === 'delegateTurn') { if (!ws.seatId) throw new Error('вы зритель'); e.room.delegateTurn(ws.seatId, msg.toSeatId); }
        else if (msg.type === 'reclaimTurn') { if (!ws.seatId) throw new Error('вы зритель'); e.room.reclaimTurn(ws.seatId); }
        else if (msg.type === 'preFold') { if (!ws.seatId) throw new Error('вы зритель'); e.room.setPreFold(ws.seatId, msg.on !== false); }
        else if (msg.type === 'autoplay') {
          let ok = !e.room.allowedUserIds;                       // тестовая комната — всегда можно
          if (!ok && ws.user) { const prof = await getProfile(ws.user.id); ok = autoplayEnabled && prof && prof.role === 'admin'; }
          if (!ok) throw new Error('авто-доигрывание выключено (включается в Админке)');
          e.room.autoplay();
        }
        else if (msg.type === 'chat') { if (!ws.user) throw new Error('войдите в комнату'); if (!e.room.addChat(ws.name, msg.text)) return; } // зрителям тоже можно; пустое — без рассылки
        else { if (!ws.seatId) throw new Error('вы зритель'); e.room.action(e.room.actingSeatFor(ws.seatId), msg); }   // делегат (#8) исполняет действие от имени владельца, чей сейчас ход
        broadcast(ws.roomCode);
        syncStatus(e);
      }
    } catch (err) { sendErr(ws, err.message); }
  });
  ws.on('close', () => {
    const e = rooms.get(ws.roomCode);
    if (!e) return;
    e.clients.delete(ws);
    // другой живой сокет того же аккаунта ещё в комнате (F5/реконнект гонкой, второе устройство) → присутствие НЕ гасим:
    // иначе close старого сокета затирает connected, хотя человек уже сидит на новом (корень хаоса со статусами)
    const dupLive = ws.user && [...e.clients].some((c) => c.user && c.user.id === ws.user.id && !c.voice);
    if (ws.seatId) { if (!dupLive) e.room.disconnect(ws.seatId); }
    else if (ws.user && !ws.voice && !dupLive) e.room.removeSpectator(ws.user.id); // voice-компаньон зрителем не числится — присутствие места на ПК не трогаем
    broadcast(ws.roomCode);
  });
});

server.listen(PORT, () => console.log(`Draft Club сервер: http://localhost:${PORT}`));
