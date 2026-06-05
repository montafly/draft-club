"""
Draft Club — считалка очков по данным FanTeam (ScoutGG API).

Тянет матчи тура / отдельный матч, считает очки игроков по позиционным весам
FanTeam (1 в 1, см. spec в vault) и печатает таблицу.

Зависимости: только стандартная библиотека (urllib, json).

Запуск:
    python collect.py match 3877589
    python collect.py round 1900 21        # PL 2025/26, тур 21
    python collect.py round 1995 1          # World Cup 2026, игровой день 1
"""
from __future__ import annotations

import json
import math
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

import db

REQUEST_DELAY = 0.5   # пауза между запросами к FanTeam (вежливый троттлинг)
MAX_RETRIES = 6       # ретраи на 429 с нарастающим бэкоффом

API = "https://fanteam-game.api.scoutgg.net"
HEADERS = {
    "accept": "application/json",
    # dummy-токен: без него detail отдаёт матч, но без realPlayerMatchStats,
    # а список матчей возвращает 401 no_client. Реальный логин не нужен.
    "authorization": "Bearer fanteam undefined",
    "origin": "https://fanteam.com",
    "referer": "https://fanteam.com/",
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
}


def fetch(path: str) -> dict:
    url = f"{API}/{path}"
    for attempt in range(MAX_RETRIES):
        try:
            req = urllib.request.Request(url, headers=HEADERS)
            with urllib.request.urlopen(req, timeout=30) as r:
                data = json.loads(r.read().decode("utf-8"))
            if REQUEST_DELAY:
                time.sleep(REQUEST_DELAY)
            return data
        except urllib.error.HTTPError as e:
            if e.code == 429 and attempt < MAX_RETRIES - 1:
                wait = 5 * (attempt + 1)  # 5,10,15,20,25с
                print(f"  429, жду {wait}с и повторяю...")
                time.sleep(wait)
                continue
            raise
    raise RuntimeError("unreachable")


def compute_points(s: dict, pos: str) -> float:
    """Очки игрока за матч по сырым счётчикам stats и позиции."""
    g = lambda k: s.get(k, 0) or 0
    pts = 0.0
    # --- общее для всех позиций ---
    pts += g("playtime1") * 1        # Appearance
    pts += g("playtime60") * 1       # 60+ минут
    pts += g("assist") * 3           # Assist / Fantasy Assist
    pts += g("penaltyCaused") * -2   # Blunder (привёз пенальти / голевой штрафной)
    pts += g("penaltyMiss") * -2
    pts += g("ownGoal") * -2
    pts += g("yellowCard") * -1
    pts += g("redCard") * -3
    pts += g("impact") * 0.3         # Positive/Negative impact (знак из значения)

    if pos == "goalkeeper":
        pts += g("goal") * 8
        pts += g("cleanSheet") * 4
        pts += g("shotOnTarget") * 1
        pts += g("keeperSave") * 0.5
        pts += g("penaltySave") * 5
        pts += math.floor(g("concededGoal") / 2) * -1
    elif pos == "defender":
        pts += g("goal") * 6
        pts += g("cleanSheet") * 4
        pts += g("shotOnTarget") * 0.6
        pts += math.floor(g("concededGoal") / 2) * -1
    elif pos == "midfielder":
        pts += g("goal") * 5
        pts += g("cleanSheet") * 1
        pts += g("fullGame") * 1     # Played full match
        pts += g("shotOnTarget") * 0.4
    elif pos == "forward":
        pts += g("goal") * 4
        pts += g("fullGame") * 1
        pts += g("shotOnTarget") * 0.4
    return round(pts, 2)


def _pname(p: dict):
    return p.get("lastName") or p.get("firstName") or p.get("name")


def score_match(match_id: int) -> dict:
    d = fetch(f"real_matches/{match_id}")
    names = {m["realPlayerId"]: _pname(m.get("realPlayer", {}))
             for m in d.get("realTeamMemberships", [])}
    teams = {t["id"]: t.get("name", t["id"]) for t in d.get("realTeams", [])}
    rm = d.get("realMatch", {})
    rows = []
    for r in d.get("realPlayerMatchStats", []):
        st = r.get("stats", {}) or {}
        rows.append({
            "team": teams.get(r["realTeamId"], r["realTeamId"]),
            "name": names.get(r["realPlayerId"], r["realPlayerId"]),
            "pos": (r.get("position") or "")[:3].upper(),
            "min": r.get("minutesPlayed", 0),
            "pts": compute_points(st, r.get("position") or ""),
        })
    return {"match": rm, "status": rm.get("status"), "rows": rows}


def print_match(match_id: int):
    res = score_match(match_id)
    print(f"\n=== match {match_id} | status: {res['status']} ===")
    rows = sorted(res["rows"], key=lambda x: (x["team"], -x["pts"]))
    cur = None
    for x in rows:
        if x["team"] != cur:
            cur = x["team"]
            print(f"\n-- {cur} --")
        print(f"  {x['name'][:18]:18} {x['pos']:3} {x['min']:>3}'  {x['pts']:>6.2f}")


def print_round(season_id: int, rnd: int):
    d = fetch(f"real_matches?season_id={season_id}&round={rnd}")
    teams = {t["id"]: t.get("name", t["id"]) for t in d.get("realTeams", [])}
    for m in d.get("realMatches", []):
        a, b = (m.get("realTeamIds") or [None, None])[:2]
        print(f"{m['id']} | {teams.get(a)} vs {teams.get(b)} | {m.get('status')}")


def validate():
    """Сверка с известными тоталами FanTeam (Brentford 3:0 Sunderland, matchId 3877589)."""
    res = score_match(3877589)
    by_name = {x["name"]: x["pts"] for x in res["rows"]}
    checks = {"Kelleher": 12.30, "Ajer": 4.30}
    print("=== ВАЛИДАЦИЯ (ожидаем = факт FanTeam) ===")
    ok = True
    for name, expected in checks.items():
        got = by_name.get(name)
        mark = "OK" if got == expected else "MISMATCH"
        if got != expected:
            ok = False
        print(f"  {name:10} ожидали {expected:>6.2f} | посчитали {got!s:>6} | {mark}")
    print("ИТОГ:", "все сходится" if ok else "есть расхождения")


def player_rows(match_id: int, status: str, detail: dict, now: str) -> list[dict]:
    names = {x["realPlayerId"]: _pname(x.get("realPlayer", {}))
             for x in detail.get("realTeamMemberships", [])}
    rows = []
    for r in detail.get("realPlayerMatchStats", []):
        st = r.get("stats", {}) or {}
        pos = r.get("position") or ""
        rows.append({
            "match_id": match_id,
            "player_id": r["realPlayerId"],
            "player_name": names.get(r["realPlayerId"]),
            "team_id": r["realTeamId"],
            "position": pos,
            "minutes": r.get("minutesPlayed", 0),
            "points": compute_points(st, pos),
            "stats": st,
            "status": status,
            "updated_at": now,
        })
    return rows


def collect_round(season_id: int, rnd: int, only_active: bool = False):
    """Собрать тур и записать в Supabase. only_active=True — только идущие/недавние матчи."""
    d = fetch(f"real_matches?season_id={season_id}&round={rnd}")
    teams = {t["id"]: t.get("name", t["id"]) for t in d.get("realTeams", [])}
    matches = d.get("realMatches", [])
    if only_active:
        matches = [m for m in matches if m.get("status") not in ("pending", "confirmed")]
    now = datetime.now(timezone.utc).isoformat()

    mrows = []
    for m in matches:
        ids = (m.get("realTeamIds") or [None, None])[:2]
        sc = (m.get("score") or [None, None])[:2]
        mrows.append({
            "match_id": m["id"], "season_id": season_id, "round": rnd,
            "home_team_id": ids[0], "away_team_id": ids[1],
            "home_team": teams.get(ids[0]), "away_team": teams.get(ids[1]),
            "start_time": m.get("startTime"), "status": m.get("status"),
            "score_home": sc[0], "score_away": sc[1], "updated_at": now,
        })
    db.upsert("dc_matches", mrows, on_conflict="match_id")

    total = 0
    for m in matches:
        detail = fetch(f"real_matches/{m['id']}")
        prows = player_rows(m["id"], m.get("status"), detail, now)
        db.upsert("dc_player_match", prows, on_conflict="match_id,player_id")
        total += len(prows)
    print(f"season {season_id} round {rnd}: матчей записано {len(mrows)}, строк игроков {total}")


def collect_auto(season_ids: list[int], window_hours: int = 6):
    """Авто-режим для cron: по каждому сезону берём матчи, начавшиеся за последние
    window_hours и ещё не завалидированные (status != confirmed), и пишем их.
    Будущие (pending, ещё не начались) и уже финальные (confirmed) пропускаем."""
    now = datetime.now(timezone.utc)
    lo, hi = now - timedelta(hours=window_hours), now + timedelta(minutes=5)
    iso = now.isoformat()
    for sid in season_ids:
        d = fetch(f"real_matches?season_id={sid}")
        teams = {t["id"]: t.get("name", t["id"]) for t in d.get("realTeams", [])}
        active = []
        for m in d.get("realMatches", []):
            if m.get("status") == "confirmed":
                continue
            st = m.get("startTime")
            try:
                stdt = datetime.fromisoformat(st) if st else None
            except ValueError:
                stdt = None
            if stdt and lo <= stdt <= hi:
                active.append(m)
        if not active:
            print(f"season {sid}: активных матчей нет")
            continue
        mrows = []
        for m in active:
            ids = (m.get("realTeamIds") or [None, None])[:2]
            sc = (m.get("score") or [None, None])[:2]
            mrows.append({
                "match_id": m["id"], "season_id": sid, "round": m.get("round"),
                "home_team_id": ids[0], "away_team_id": ids[1],
                "home_team": teams.get(ids[0]), "away_team": teams.get(ids[1]),
                "start_time": m.get("startTime"), "status": m.get("status"),
                "score_home": sc[0], "score_away": sc[1], "updated_at": iso,
            })
        db.upsert("dc_matches", mrows, on_conflict="match_id")
        total = 0
        for m in active:
            detail = fetch(f"real_matches/{m['id']}")
            prows = player_rows(m["id"], m.get("status"), detail, iso)
            db.upsert("dc_player_match", prows, on_conflict="match_id,player_id")
            total += len(prows)
        print(f"season {sid}: активных матчей {len(active)}, строк игроков {total}")


def collect_season(season_id: int, r1: int = 1, r2: int = 38):
    """Бэкфилл всего сезона: туры r1..r2 последовательно с троттлингом."""
    for rnd in range(r1, r2 + 1):
        try:
            collect_round(season_id, rnd)
        except Exception as e:
            print(f"round {rnd}: ОШИБКА {e}")


if __name__ == "__main__":
    args = sys.argv[1:]
    if not args:
        validate()
    elif args[0] == "season":
        sid = int(args[1])
        r1 = int(args[2]) if len(args) > 2 else 1
        r2 = int(args[3]) if len(args) > 3 else 38
        collect_season(sid, r1, r2)
    elif args[0] == "match":
        print_match(int(args[1]))
    elif args[0] == "round":
        print_round(int(args[1]), int(args[2]))
    elif args[0] == "collect":
        collect_round(int(args[1]), int(args[2]),
                      only_active=("--active" in args))
    elif args[0] == "auto":
        ids = [int(x) for x in os.environ.get("SEASON_IDS", "1900").split(",") if x.strip()]
        collect_auto(ids)
    elif args[0] == "validate":
        validate()
    else:
        print(__doc__)
