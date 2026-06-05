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
  constructor(config = DEFAULT_CONFIG, maxSeats = 5) {
    this.config = config;
    this.maxSeats = maxSeats;
    // реальный пул FanTeam из pool.json (collect.py pool); фолбэк — синтетический
    this.pool = (POOLFILE && POOLFILE.units && POOLFILE.units.length) ? POOLFILE.units : makePool();
    this.clubOdds = (POOLFILE && POOLFILE.clubOdds) || [];
    this.seats = [];                     // {id,name,ready,connected}
    this.draft = null;
  }

  join(name) {
    // переподключение по имени
    const existing = this.seats.find((s) => s.name === name);
    if (existing) { existing.connected = true; return existing.id; }
    if (this.seats.length >= this.maxSeats) return null; // спектатор
    const id = this.seats.length + 1;
    this.seats.push({ id, name, ready: false, connected: true });
    return id;
  }

  setReady(seatId, ready = true) {
    const s = this.seats.find((x) => x.id === seatId);
    if (s) s.ready = ready;
  }

  disconnect(seatId) {
    const s = this.seats.find((x) => x.id === seatId);
    if (s) s.connected = false;
  }

  startable() {
    return !this.draft && this.seats.length >= 2 && this.seats.every((s) => s.ready);
  }

  start() {
    if (!this.startable()) throw new Error('start: не все готовы / мало игроков');
    const players = this.seats.map((s) => ({ id: s.id, name: s.name }));
    const order = players.map((p) => p.id).sort(() => Math.random() - 0.5); // жеребьёвка
    this.draft = new Draft(this.pool, players, order, this.config, { now: Date.now });
    this.draft.start();
  }

  action(seatId, msg) {
    if (!this.draft) throw new Error('драфт не начат');
    switch (msg.type) {
      case 'nominate': return this.draft.nominate(seatId, msg.unitId, msg.openingBid ?? 1);
      case 'bid':      return this.draft.bid(seatId, msg.amount);
      case 'pass':     return this.draft.pass(seatId);
      case 'pickSubstitute': return this.draft.pickSubstitute(seatId, msg.unitId);
      default: throw new Error('неизвестное действие: ' + msg.type);
    }
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
      seats: this.seats.map((s) => ({ id: s.id, name: s.name, ready: s.ready, connected: s.connected })),
      startable: this.startable(),
    };
    if (!this.draft) return { started: false, lobby, draft: null };
    const d = this.draft;
    return {
      started: true,
      lobby,
      draft: {
        phase: d.phase,
        actor: d.actor,
        order: d.order,
        lot: d.lot && { unit: d.lot.unit, highBid: d.lot.highBid, highBidder: d.lot.highBidder, passed: [...d.lot.passed], bidsBy: d.lot.bidsBy },
        clubCounts: d.clubCounts,
        taken: [...d.taken],
        picks: d.picks,
        actorOptions: this._actorOptions(),
        managers: [...d.managers.values()].map((m) => ({
          id: m.id, name: m.name, budget: m.budget, maxBid: d.managerMaxBid(m.id),
          finished: m.finished, finishOrder: m.finishOrder, size: m.roster.length,
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
