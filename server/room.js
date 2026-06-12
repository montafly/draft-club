// Комната драфта (transport-agnostic): места + одна партия Draft + сериализация состояния.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Draft } from '../engine/draft.js';
import { DEFAULT_CONFIG } from '../engine/config.js';
import { makePool } from '../engine/data.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let POOLFILE = null;
try { POOLFILE = JSON.parse(fs.readFileSync(path.join(__dirname, 'pool.json'), 'utf8')); } catch {}

export class Room {
  constructor(config = DEFAULT_CONFIG, maxSeats = 5, pool = null, clubOdds = null, matches = null) {
    this.config = config;
    this.maxSeats = maxSeats;
    // пул конкретного драфта (по match_ids) если передан; иначе pool.json; иначе синтетика
    this.pool = (pool && pool.length) ? pool
      : ((POOLFILE && POOLFILE.units && POOLFILE.units.length) ? POOLFILE.units : makePool());
    this.clubOdds = clubOdds || (POOLFILE && POOLFILE.clubOdds) || [];
    this.matches = matches || (POOLFILE && POOLFILE.matches) || []; // [{home,away,startTime}]
    this.allowedUserIds = null;          // null = открыто (тест); Set = место только принятым, остальные зрители
    this.draftId = null;                 // связь с dc_drafts
    this.history = [];                   // стек снапшотов для отмены: {seatId, snap}
    this.seats = [];                     // {id,name,ready,connected}
    this.spectators = new Map();         // userId -> name (зрители без места)
    this.events = [];                    // единый лог комнаты (вход/выход + действия аукциона)
    this.chat = [];                      // эфемерный чат комнаты (в памяти процесса): {t,name,text}
    this.draft = null;
    // --- хронометраж ---
    this.draftStartAt = null;            // момент старта аукциона (таймер драфта; не плавает, в отличие от окна событий)
    this.draftEndAt = null;              // момент финиша (последняя замена) — таймер замирает
    this.seatMs = {};                    // «время на часах» по местам: сумма ≈ таймеру драфта
    this.onClock = null;                 // чьё место сейчас «на часах» (ждём его ход)
    this.clockSince = null;              // с какого момента тикает текущему onClock
    this.drawOrder = null;               // жеребьёвка: предрассчитанный порядок выбора (до старта)
    this.drawAt = null;                  // момент запуска жеребьёвки (для синхронной анимации у всех)
  }

  // жеребьёвка: фиксируем порядок выбора заранее, клиент анимирует «колесо» к нему. true = только что запущена
  draw() {
    if (this.draft) throw new Error('драфт уже идёт');
    if (!this.startable()) throw new Error('не все готовы / мало игроков');
    if (this.drawOrder) return false;    // уже крутится
    this.drawOrder = this.seats.map((s) => s.id).sort(() => Math.random() - 0.5);
    this.drawAt = Date.now();
    this.logEvent('info', '— Жеребьёвка —');
    return true;
  }

  // отнести прошедшее время тому, кого ждали (onClock), и сдвинуть точку отсчёта на now
  _tickClock(now) {
    if (this.onClock != null && this.clockSince != null) {
      this.seatMs[this.onClock] = (this.seatMs[this.onClock] || 0) + (now - this.clockSince);
    }
    this.clockSince = now;
  }

  join(userId, name) {
    // переподключение по аккаунту (userId)
    const existing = this.seats.find((s) => s.userId === userId);
    if (existing) { existing.connected = true; existing.name = name; this.logEvent('join', `${name} — переподключился`); return existing.id; }
    if (this.allowedUserIds && !this.allowedUserIds.has(userId)) return null; // не принят → зритель
    if (this.seats.length >= this.maxSeats) return null; // мест нет → зритель
    const id = this.seats.length + 1;
    this.seats.push({ id, userId, name, ready: false, connected: true });
    this.logEvent('join', `${name} — вошёл (участник)`);
    return id;
  }
  logEvent(kind, text) { this.events.push({ t: Date.now(), kind, text }); if (this.events.length > 5000) this.events.shift(); }
  // чат: нормализуем (один абзац, без управляющих переносов), режем до 500 символов; пустое не пишем. Экранирование — на клиенте при рендере.
  addChat(name, text) { const t = String(text == null ? '' : text).replace(/\s+/g, ' ').trim().slice(0, 500); if (!t) return false; this.chat.push({ t: Date.now(), name: name || 'Player', text: t }); if (this.chat.length > 200) this.chat.shift(); return true; }

  setReady(seatId, ready = true) {
    const s = this.seats.find((x) => x.id === seatId);
    if (s) s.ready = ready;
  }

  disconnect(seatId) {
    const s = this.seats.find((x) => x.id === seatId);
    if (s) { s.connected = false; this.logEvent('leave', `${s.name} — отключился`); }
  }

  addSpectator(userId, name) { if (userId && !this.seats.find((s) => s.userId === userId) && !this.spectators.has(userId)) { this.spectators.set(userId, name); this.logEvent('join', `${name} — смотрит (зритель)`); } }
  removeSpectator(userId) { const n = this.spectators.get(userId); if (n) { this.spectators.delete(userId); this.logEvent('leave', `${n} (зритель) — вышел`); } }

  startable() {
    if (this.draft || !this.seats.length || !this.seats.every((s) => s.ready)) return false;
    const need = this.allowedUserIds ? Math.max(2, this.allowedUserIds.size) : 1; // реальный драфт: все принятые на месте (мин. 2); тест-комната (allowedUserIds=null): 1
    return this.seats.length >= need;
  }

  start() {
    if (!this.startable()) throw new Error('start: не все готовы / мало игроков');
    const players = this.seats.map((s) => ({ id: s.id, name: s.name }));
    const order = this.drawOrder ? this.drawOrder.slice() : players.map((p) => p.id).sort(() => Math.random() - 0.5); // порядок из жеребьёвки, иначе случайный (тест/инстант-старт)
    this.logEvent('info', '— Аукцион начался —');
    this.draft = new Draft(this.pool, players, order, this.config, { now: Date.now, log: this.events });
    this.draft.start();
    const now = Date.now();
    this.draftStartAt = now;             // полный хронометраж аукциона — от старта
    this.onClock = this.draft.actor;     // первый номинатор «на часах»
    this.clockSince = now;
  }

  action(seatId, msg) {
    if (!this.draft) throw new Error('драфт не начат');
    const now = Date.now();
    this._tickClock(now);                         // время ожидания → тому, кто сейчас ходит (его и ждали)
    const snap = snapDraft(this.draft);          // снимок ДО действия
    let res;
    switch (msg.type) {
      case 'nominate': res = this.draft.nominate(seatId, msg.unitId, msg.openingBid ?? 1); break;
      case 'bid':      res = this.draft.bid(seatId, msg.amount); break;
      case 'pass':     res = this.draft.pass(seatId); break;
      case 'pickSubstitute': res = this.draft.pickSubstitute(seatId, msg.unitId); break;
      default: throw new Error('неизвестное действие: ' + msg.type);
    }
    this.history.push({ seatId, snap });          // действие прошло → фиксируем для отмены
    if (this.history.length > 50) this.history.shift();
    this.onClock = this.draft.phase === 'done' ? null : this.draft.actor; // следующий на часах
    this.clockSince = now;
    if (this.draft.phase === 'done' && this.draftEndAt == null) this.draftEndAt = now; // таймер драфта замирает на последней замене
    return res;
  }

  // отмена: вернуть состояние до последнего действия, но только если оно принадлежит этому игроку
  // (нельзя отменить через чужой ход → накопительно откатываешь только свои последние действия)
  undo(seatId) {
    if (!this.draft) throw new Error('драфт не начат');
    if (this.draft.phase === 'done') throw new Error('драфт завершён — отмена недоступна'); // завершённый драфт неизменяем: иначе откат последней замены после финиша
    const top = this.history[this.history.length - 1];
    if (!top || top.seatId !== seatId) throw new Error('нечего отменять (сверху не ваше действие)');
    restoreDraft(this.draft, top.snap);
    this.history.pop();
    const now = Date.now();
    this._tickClock(now);                         // зафиксировать набежавшее, дальше ждём вернувшегося ходящего
    this.onClock = this.draft.actor;
    this.clockSince = now;
    const s = this.seats.find((x) => x.id === seatId);
    this.logEvent('info', `${s ? s.name : 'игрок'} — отменил последнее действие`);
  }

  // ТОЛЬКО ДЛЯ ТЕСТА: авто-доиграть драфт (каждый номинирует дешёвого, остальные пасуют → забор за старт)
  autoplay() {
    if (!this.draft) {
      if (!this.seats.length) throw new Error('нет игроков');
      for (const s of this.seats) s.ready = true;
      this.start();
    }
    if (this.draftStartAt == null) this.draftStartAt = Date.now();
    const d = this.draft; let guard = 0;
    while (d.phase !== 'done' && guard++ < 5000) {
      if (d.phase === 'nominating') {
        const elig = d.eligibleNominations(d.actor);
        if (!elig.length) break;
        d.nominate(d.actor, elig[0].id, 1);
      } else if (d.phase === 'bidding') {
        d.pass(d.actor);
      } else if (d.phase === 'substitutes') {
        const elig = d.eligibleSubstitutes(d.actor);
        if (!elig.length) break;
        d.pickSubstitute(d.actor, elig[0].id);
      } else break;
    }
    this.history = []; // снапшоты отмены после автодоигрывания не нужны
    if (this.draft.phase === 'done' && this.draftEndAt == null) this.draftEndAt = Date.now();
  }

  _actorOptions() {
    const d = this.draft;
    if (!d || d.actor == null) return null;
    if (d.phase === 'nominating') {
      return { kind: 'nominate', maxOpen: d.managerMaxBid(d.actor), units: d.eligibleNominations(d.actor) };
    }
    if (d.phase === 'bidding') {
      const min = d.lot.highBid + this.config.minIncrement;
      const mx = d.managerMaxBid(d.actor);
      const canBid = d.canManagerAdd(d.actor, d.lot.unit) && mx >= min;
      return { kind: 'bid', minAmount: min, maxAmount: mx, canBid };
    }
    if (d.phase === 'substitutes') {
      return { kind: 'sub', units: d.eligibleSubstitutes(d.actor) };
    }
    return null;
  }

  serialize() {
    const lobby = {
      seats: this.seats.map((s) => ({ id: s.id, userId: s.userId, name: s.name, ready: s.ready, connected: s.connected })),
      startable: this.startable(),
      need: this.allowedUserIds ? this.allowedUserIds.size : null,
      spectators: [...this.spectators.values()],
      events: this.events.slice(-400), // живое окно: только недавнее (payload не растёт с размером лога); полный лог — в dc_drafts.events на финише
      chat: this.chat.slice(-100),     // последние сообщения чата (эфемерные, в памяти комнаты)
      draw: (this.drawOrder && !this.draft) ? { order: this.drawOrder, at: this.drawAt } : null, // идёт жеребьёвка
    };
    if (!this.draft) return { started: false, isTest: !this.allowedUserIds, lobby, draft: null };
    const d = this.draft;
    return {
      started: true,
      isTest: !this.allowedUserIds,
      lobby,
      draft: {
        phase: d.phase,
        actor: d.actor,
        startAt: this.draftStartAt,                 // хронометраж: фикс. старт/финиш + чьё место на часах
        endAt: this.draftEndAt,
        onClock: this.onClock,
        asOf: Date.now(),
        lotNo: d.lotNo,
        canUndoSeat: this.history.length ? this.history[this.history.length - 1].seatId : null,
        order: d.order,
        lot: d.lot && { unit: d.lot.unit, highBid: d.lot.highBid, highBidder: d.lot.highBidder, passed: [...d.lot.passed], bidsBy: d.lot.bidsBy, no: d.lot.no, nominator: d.lot.nominatorId },
        clubCounts: d.clubCounts,
        teamLimit: this.config.teamLimit,
        taken: [...d.taken],
        picks: d.picks,
        actorOptions: this._actorOptions(),
        managers: [...d.managers.values()].map((m) => ({
          id: m.id, name: m.name, budget: m.budget, maxBid: d.managerMaxBid(m.id),
          finished: m.finished, finishOrder: m.finishOrder, size: m.roster.length,
          activeMs: this.seatMs[m.id] || 0,

          counts: countPos(m.roster),
          roster: m.roster.map((u) => ({ id: u.id, name: u.name, club: u.club, code: u.code, position: u.position, price: u.price })),
          substitute: m.substitute && { name: m.substitute.name, club: m.substitute.club, code: m.substitute.code, position: m.substitute.position },
        })),
      },
    };
  }
}

function countPos(roster) {
  const c = { GK: 0, DEF: 0, MID: 0, FWD: 0, COACH: 0 };
  for (const u of roster) c[u.position]++;
  return c;
}

// снапшот/восстановление состояния движка для отмены (units/config/now не меняются — не клонируем)
const SNAP_FIELDS = ['taken', 'clubCounts', 'managers', 'order', 'orderIdx', 'phase', 'nominatorPtr', 'lot', 'actor', '_finishCounter', 'subOrder', 'subPtr', 'picks', 'lotNo']; // 'log' исключён — общий лог комнаты не откатывается отменой
function snapDraft(d) { const o = {}; for (const k of SNAP_FIELDS) o[k] = structuredClone(d[k]); return o; }
function restoreDraft(d, s) { for (const k of SNAP_FIELDS) d[k] = structuredClone(s[k]); }
