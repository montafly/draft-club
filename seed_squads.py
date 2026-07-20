"""
Draft Club — сид полных заявок клубов НОВОГО сезона в dc_player_match заранее.

Проблема: collect.py берёт составы из per-match realTeamMemberships/
realPlayerMatchStats, а FanTeam публикует их только за ~90 мин до конкретного
матча (см. PREMATCH_MINUTES). Для только что стартовавшего сезона там пока
пусто, и фолбэк buildDraftPool (dc_player_match по team_id) тоже пуст —
драфт создать не из чего.

Отдельный эндпоинт real_teams/{id}?season_id= отдаёт полную заявку клуба
ещё до начала сезона (без per-match контекста, только team_id/player_id/
position). Имя игрока тянем отдельным запросом real_players/{id}?season_id=.
Строки пишем в dc_player_match, привязывая к match_id первого найденного
в календаре матча команды (там FK на dc_matches — значит calendar backfill
уже должен быть сделан, см. collect.py season <id> 1 38).

Как только сезон стартует и FanTeam начнёт публиковать реальные lineup —
обычный collect.py (cron auto) перезапишет эти строки актуальными данными
(on_conflict=match_id,player_id — сиды на будущих турах не мешают).

Запуск:
    python seed_squads.py 2004          # season_id; якорь — тур 1 (upsert, дозаливка)
    python seed_squads.py 2004 3        # якорь на другой тур (если в 1-м не все клубы играют)
    python seed_squads.py 2004 --fresh  # чистый пере-сид: стереть снапшот сезона и залить заново
                                        #   (нужен при трансферах — upsert сам не удаляет ушедших)
"""
from __future__ import annotations

import sys
from datetime import datetime, timezone

import db
from collect import fetch, _pname, _pfirst


def seed_squads(season_id: int, anchor_round: int = 1, fresh: bool = False) -> None:
    listing = fetch(f"real_matches?season_id={season_id}&round={anchor_round}")
    teams = {t["id"]: t.get("name", t["id"]) for t in listing.get("realTeams", [])}
    match_for_team: dict[int, int] = {}
    for m in listing.get("realMatches", []):
        for tid in (m.get("realTeamIds") or [])[:2]:
            if tid is not None:
                match_for_team.setdefault(tid, m["id"])

    missing = set(teams) - set(match_for_team)
    if missing:
        print(f"ВНИМАНИЕ: нет матча-якоря в туре {anchor_round} для команд {[teams[t] for t in missing]} — пропущены")

    # Чистый пере-сид: стираем прошлый снапшот сезона (только сид-строки status=not_started,
    # привязанные к матчам-якорям тура) ДО заливки. Иначе upsert не удалит ушедших/перешедших
    # игроков (add/update по PK, не delete) → трансфер внутри АПЛ = игрок в двух клубах.
    # Реальные строки (collect: pending/live/confirmed) не трогаем — фильтр по not_started.
    if fresh:
        anchors = sorted(set(match_for_team.values()))
        if anchors:
            db.delete("dc_player_match", f"status=eq.not_started&match_id=in.({','.join(map(str, anchors))})")
            print(f"[fresh] стёрт прежний снапшот (not_started) по {len(anchors)} матчам-якорям")

    # Резюмируемость (при нестабильном инете): без --fresh пропускаем клубы, у которых
    # сид уже есть (upsert по клубу атомарен — команда либо залита целиком, либо нет).
    # Так повторный запуск добивает недостающие клубы, не перекачивая уже собранные.
    done_teams: set[int] = set()
    if not fresh:
        try:
            existing = db.select("dc_player_match", "status=eq.not_started&select=team_id")
            done_teams = {r["team_id"] for r in existing if r.get("team_id") is not None}
        except Exception as e:
            print(f"[resume] не смог прочитать текущий снапшот ({e}) — сею все клубы")
        if done_teams:
            print(f"[resume] уже засеяно клубов: {len(done_teams)} — пропускаю их, добиваю остальные")

    now = datetime.now(timezone.utc).isoformat()
    total = 0
    for tid, name in teams.items():
        match_id = match_for_team.get(tid)
        if match_id is None:
            continue
        if tid in done_teams:
            continue
        team_detail = fetch(f"real_teams/{tid}?season_id={season_id}")
        memberships = team_detail.get("realTeamMemberships", [])
        rows = []
        for mem in memberships:
            pid = mem.get("realPlayerId")
            pos = mem.get("position") or ""
            if pid is None or not pos:
                continue
            pdet = fetch(f"real_players/{pid}?season_id={season_id}")
            rp = pdet.get("realPlayer", {}) or {}
            rows.append({
                "match_id": match_id,
                "player_id": pid,
                "player_name": _pname(rp) or str(pid),
                "player_first": _pfirst(rp),
                "team_id": tid,
                "position": pos,
                "minutes": 0,
                "points": 0,
                "stats": {},
                "status": "not_started",
                "lineup": None,
                "updated_at": now,
            })
        if rows:
            db.upsert("dc_player_match", rows, on_conflict="match_id,player_id")
        total += len(rows)
        print(f"{name} ({tid}): заявка {len(rows)} игроков -> match_id {match_id}")

    print(f"ИТОГО: {total} строк засеяно в dc_player_match (season {season_id}, якорь тур {anchor_round})")


if __name__ == "__main__":
    argv = [a for a in sys.argv[1:] if a != "--fresh"]
    fresh = "--fresh" in sys.argv
    sid = int(argv[0])
    rnd = int(argv[1]) if len(argv) > 1 else 1
    seed_squads(sid, rnd, fresh=fresh)
