// State-machine драфта: лобби → номинации/торги → замены → завершение.
// Авторитарный движок: валидирует все ходы, сам считает автопасс, ведёт очередь.
import { DEFAULT_CONFIG } from './config.js';
import { canAdd, maxBid, positionCounts } from './rules.js';

export class Draft {
  /**
   * @param {Array} units  пул юнитов [{id,name,club,position}]
   * @param {Array} players [{id,name}] участники
   * @param {Array<number>} order  порядок (массив id участников) — жеребьёвка снаружи
   * @param {object} config
   */
  constructor(units, players, order, config = DEFAULT_CONFIG, opts = {}) {
    this.config = config;
    this.now = opts.now || (() => 0);   // инъекция времени (сервер: Date.now; тесты: 0)
    this.units = new Map(units.map((u) => [u.id, u]));
    this.taken = new Set();
    this.clubCounts = {};
    this.managers = new Map();
    for (const p of players) {
      this.managers.set(p.id, {
        id: p.id, name: p.name, budget: config.budget,
        roster: [], substitute: null, finished: false, finishOrder: null,
      });
    }
    this.order = order.slice();
    this.orderIdx = new Map(this.order.map((id, i) => [id, i]));
    this.phase = 'lobby';      // lobby | nominating | bidding | substitutes | done
    this.nominatorPtr = 0;     // индекс в order
    this.lot = null;           // {unit, highBid, highBidder, passed:Set, lastIdx}
    this.actor = null;         // чей ход сейчас
    this._finishCounter = 0;
    this.subOrder = [];
    this.subPtr = 0;
    this.log = opts.log || [];   // общий лог комнаты (если передан) — иначе свой
    this.picks = [];   // хронология: {no, unitName, club, position, price, winnerId, winnerName, sub?}
    this.lotNo = 0;
  }

  m(id) { return this.managers.get(id); }
  managerMaxBid(id) { return maxBid(this.m(id), this.config); }
  canManagerAdd(id, unit) { return canAdd(this.m(id), unit, this.clubCounts, this.config); }
  available() { return [...this.units.values()].filter((u) => !this.taken.has(u.id)); }
  eligibleNominations(id) {
    const m = this.m(id);
    return this.available().filter((u) => canAdd(m, u, this.clubCounts, this.config)
      && maxBid(m, this.config) >= 1);
  }

  // ---- старт ----
  start() {
    if (this.phase !== 'lobby') throw new Error('start: не lobby');
    this.phase = 'nominating';
    this._setNominator();
    return this.state();
  }

  _activeManagers() { return this.order.filter((id) => !this.m(id).finished); }

  _setNominator() {
    // следующий незакончивший номинатор; если все закончили → замены
    const n = this.order.length;
    for (let step = 0; step < n; step++) {
      const idx = (this.nominatorPtr + step) % n;
      const id = this.order[idx];
      if (this.m(id).finished) continue;
      // пропускаем номинатора, которому некого выставить (на полном пуле не случается)
      if (this.eligibleNominations(id).length === 0) continue;
      this.nominatorPtr = idx;
      this.actor = id;
      this.phase = 'nominating';
      return;
    }
    this._startSubstitutes();
  }

  // ---- номинация ----
  nominate(managerId, unitId, openingBid = 1) {
    this._expect('nominating', managerId);
    const unit = this.units.get(unitId);
    if (!unit || this.taken.has(unitId)) throw new Error('nominate: юнит недоступен');
    const m = this.m(managerId);
    if (!canAdd(m, unit, this.clubCounts, this.config)) throw new Error('nominate: нельзя взять этот юнит');
    openingBid = Math.trunc(openingBid);
    if (openingBid < 1) throw new Error('nominate: ставка < 1');
    if (openingBid > maxBid(m, this.config)) throw new Error('nominate: ставка > макс. бида');

    this.lot = { unit, highBid: openingBid, highBidder: managerId, passed: new Set(),
                 lastIdx: this.orderIdx.get(managerId), no: ++this.lotNo,
                 startAt: this.now(), bids: 1, bidsBy: { [managerId]: openingBid } };
    this.phase = 'bidding';
    this.log.push(`${m.name} выставил ${unit.name} (${unit.club}) — старт $${openingBid}`);
    this._advance();
    return this.state();
  }

  // ---- ставка ----
  bid(managerId, amount) {
    this._expect('bidding', managerId);
    const lot = this.lot;
    amount = Math.trunc(amount);
    const m = this.m(managerId);
    if (amount < lot.highBid + this.config.minIncrement) throw new Error('bid: ставка слишком мала');
    if (amount > maxBid(m, this.config)) throw new Error('bid: ставка > макс. бида');
    if (!canAdd(m, lot.unit, this.clubCounts, this.config)) throw new Error('bid: нельзя взять этот юнит');
    lot.highBid = amount;
    lot.highBidder = managerId;
    lot.lastIdx = this.orderIdx.get(managerId);
    lot.bids++;
    lot.bidsBy[managerId] = amount;
    this.log.push(`${m.name} — ставка $${amount}`);
    this._advance();
    return this.state();
  }

  // ---- пас ----
  pass(managerId) {
    this._expect('bidding', managerId);
    this.lot.passed.add(managerId);
    this.log.push(`${this.m(managerId).name} — пас`);
    this._advance();
    return this.state();
  }

  // следующий, кто может перебить; авто-пас неспособных; null → закрыть лот
  _nextBidder() {
    const lot = this.lot;
    const n = this.order.length;
    for (let step = 1; step <= n; step++) {
      const idx = (lot.lastIdx + step) % n;
      const id = this.order[idx];
      if (id === lot.highBidder) continue;
      if (lot.passed.has(id)) continue;
      const m = this.m(id);
      if (m.finished) continue;
      if (!canAdd(m, lot.unit, this.clubCounts, this.config)
          || maxBid(m, this.config) < lot.highBid + this.config.minIncrement) {
        lot.passed.add(id); // авто-пас
        continue;
      }
      return id;
    }
    return null;
  }

  _advance() {
    const next = this._nextBidder();
    if (next === null) { this._resolveLot(); return; }
    this.actor = next;
  }

  _resolveLot() {
    const lot = this.lot;
    const w = this.m(lot.highBidder);
    w.budget -= lot.highBid;
    w.roster.push({ ...lot.unit, price: lot.highBid });
    this.picks.push({ no: lot.no, unitName: lot.unit.name, club: lot.unit.club, code: lot.unit.code,
                      position: lot.unit.position, price: lot.highBid,
                      winnerId: w.id, winnerName: w.name,
                      bids: lot.bids, durationMs: this.now() - lot.startAt });
    this.taken.add(lot.unit.id);
    this.clubCounts[lot.unit.club] = (this.clubCounts[lot.unit.club] || 0) + 1;
    this.log.push(`${w.name} забрал ${lot.unit.name} за $${lot.highBid} (бюджет $${w.budget})`);
    if (w.roster.length >= this.config.squadSize) {
      w.finished = true;
      w.finishOrder = ++this._finishCounter;
      this.log.push(`${w.name} собрал состав (#${w.finishOrder})`);
    }
    this.lot = null;
    // очередь номинаций фиксированная по кругу, независимо от победителя
    this.nominatorPtr = (this.nominatorPtr + 1) % this.order.length;
    if (this._activeManagers().length === 0) this._startSubstitutes();
    else this._setNominator();
  }

  // ---- замены ----
  _startSubstitutes() {
    this.phase = 'substitutes';
    this.subOrder = [...this.managers.values()]
      .sort((a, b) => a.finishOrder - b.finishOrder).map((x) => x.id);
    this.subPtr = 0;
    this.actor = this.subOrder[0];
  }

  eligibleSubstitutes(id) {
    return this.available().filter((u) => u.position !== 'COACH'
      && (this.clubCounts[u.club] || 0) < this.config.teamLimit);
  }

  pickSubstitute(managerId, unitId) {
    this._expect('substitutes', managerId);
    const unit = this.units.get(unitId);
    if (!unit || this.taken.has(unitId)) throw new Error('sub: юнит недоступен');
    if (unit.position === 'COACH') throw new Error('sub: тренера на замену нельзя');
    if ((this.clubCounts[unit.club] || 0) >= this.config.teamLimit) throw new Error('sub: клуб заблокирован');
    const m = this.m(managerId);
    m.substitute = { ...unit, price: 0 };
    this.taken.add(unit.id);
    this.clubCounts[unit.club] = (this.clubCounts[unit.club] || 0) + 1;
    this.picks.push({ no: null, sub: true, unitName: unit.name, club: unit.club, code: unit.code,
                      position: unit.position, price: 0, winnerId: m.id, winnerName: m.name });
    this.log.push(`${m.name} выбрал замену: ${unit.name}`);
    this.subPtr++;
    if (this.subPtr >= this.subOrder.length) { this.phase = 'done'; this.actor = null; }
    else this.actor = this.subOrder[this.subPtr];
    return this.state();
  }

  _expect(phase, managerId) {
    if (this.phase !== phase) throw new Error(`ожидается фаза ${phase}, сейчас ${this.phase}`);
    if (this.actor !== managerId) throw new Error(`сейчас ход ${this.actor}, не ${managerId}`);
  }

  state() {
    return {
      phase: this.phase,
      actor: this.actor,
      lot: this.lot && { unit: this.lot.unit, highBid: this.lot.highBid, highBidder: this.lot.highBidder },
      managers: [...this.managers.values()].map((m) => ({
        id: m.id, name: m.name, budget: m.budget, finished: m.finished,
        counts: positionCounts(m.roster), size: m.roster.length,
        substitute: m.substitute && m.substitute.name,
      })),
    };
  }
}
