"""Draft Club — сборка персонального уведомления «составы вышли».

Источники:
  - dc_matches / dc_player_match (lineup) — Supabase, через db.py;
  - GET /api/draft/score?draftId= — серверный расчёт standings (не дублируем скоринг);
  - dc_drafts (match_ids, league, tournament, round).

Одно сообщение = на пару (участник × матч), внутри — блок на каждый его драфт,
где есть этот матч. Текст — как в спеке формата (vault: «Формат уведомлений для бота»).
"""
from __future__ import annotations

import html
import json
import os
import re
import urllib.request
from datetime import datetime, timedelta, timezone
try:
    from zoneinfo import ZoneInfo
except Exception:  # pragma: no cover
    ZoneInfo = None

import db

MSK = timezone(timedelta(hours=3))   # дефолт для профилей без выбранной зоны (auto/браузер)


def esc(s) -> str:
    """HTML-экранирование динамики (имена/ники/команды) для parse_mode=HTML."""
    return html.escape(str(s if s is not None else ""))


def _pre(lines: list[str]) -> str:
    """Моноширинный блок: экранируем строки + 2 концевых пробела (чтобы иконка </>
    в Telegram не налезала на текст на телефоне), оборачиваем в <pre>."""
    return "<pre>" + "\n".join(esc(x) + "  " for x in lines) + "</pre>"

SITE_URL = os.environ.get("SITE_URL", "https://draftclub.147.45.158.66.sslip.io").rstrip("/")

LEAGUE_EMOJI = {"BRONZE": "🟤", "SILVER": "⚪", "GOLDEN": "🟡"}
POS_SHORT = {"COACH": "COA"}                      # GK/DEF/MID/FWD оставляем как есть
POS_ORDER = {"GK": 0, "DEF": 1, "MID": 2, "FWD": 3, "COACH": 4}
STATUS = {"confirmed": ("в старте", "🔵"), "bench": ("в запасе", "🟠"), None: ("вне заявки", "🔴")}


# --------------------------------------------------------------------------- #
# чтение данных
# --------------------------------------------------------------------------- #
def match_meta(match_id: int) -> dict | None:
    rows = db.select("dc_matches",
                     f"select=match_id,home_team,away_team,status&match_id=eq.{match_id}")
    return rows[0] if rows else None


def lineup_map(match_id: int) -> dict:
    """player_id -> lineup ('confirmed'/'bench'). Игрок отсутствует = вне заявки."""
    rows = db.select("dc_player_match",
                     f"select=player_id,lineup&match_id=eq.{match_id}&limit=200")
    return {r["player_id"]: r["lineup"] for r in rows}


def points_map(match_id: int) -> dict:
    """player_id -> очки за ЭТОТ матч. Плюс ключи тренеров (-team_id):
    очки тренера = сумма очков игроков его команды, вышедших с банка (как на сервере)."""
    rows = db.select("dc_player_match",
                     f"select=player_id,points,lineup,minutes,team_id&match_id=eq.{match_id}&limit=200")
    pm: dict = {}
    coach: dict = {}
    for r in rows:
        pts = float(r.get("points") or 0)
        pm[r["player_id"]] = pts
        if r.get("lineup") == "bench" and (r.get("minutes") or 0) > 0 and r.get("team_id") is not None:
            ck = -int(r["team_id"])
            coach[ck] = coach.get(ck, 0.0) + pts
    pm.update(coach)
    return pm


def drafts_with_match(match_id: int) -> list[dict]:
    """Драфты, где есть этот матч и уже собраны ростеры (не recruiting/cancelled)."""
    q = ("select=id,league,tournament,round,status,match_ids"
         f"&match_ids=cs.{{{match_id}}}&status=in.(finalized,live,done,settled)&order=id.asc")
    return db.select("dc_drafts", q)


_TEST_RE = re.compile("dctest", re.I)


def _parse_ts(iso: str | None) -> float:
    try:
        return datetime.fromisoformat(iso).timestamp() if iso else float("inf")
    except ValueError:
        return float("inf")


def draft_seq() -> tuple[dict, set]:
    """Повторяет computeDraftSeq() с сайта: сквозной номер реального драфта по
    лиге+турниру (по starts_at ↑, тестовые с участником 'dctest' исключены).
    Возвращает ({draft_id: display_no}, {test_draft_ids})."""
    drafts = db.select("dc_drafts", "select=id,league,tournament,starts_at&limit=10000")
    apps = db.select("dc_applications", "select=draft_id,user_id&status=eq.accepted&limit=100000")
    uids = list({a["user_id"] for a in apps if a.get("user_id")})
    names: dict = {}
    for i in range(0, len(uids), 100):
        chunk = ",".join('"' + u + '"' for u in uids[i:i + 100])
        for p in db.select("dc_profiles", f"select=id,display_name&id=in.({chunk})"):
            names[p["id"]] = p["display_name"]
    parts: dict = {}
    for a in apps:
        parts.setdefault(a["draft_id"], []).append(names.get(a["user_id"], ""))
    is_test = lambda did: any(_TEST_RE.search(n or "") for n in parts.get(did, []))
    test_ids = {d["id"] for d in drafts if is_test(d["id"])}
    grp: dict = {}
    for d in drafts:
        if d["id"] in test_ids:
            continue
        grp.setdefault((d.get("league") or "") + "|" + (d.get("tournament") or ""), []).append(d)
    seq: dict = {}
    for lst in grp.values():
        lst.sort(key=lambda d: (_parse_ts(d.get("starts_at")), d["id"]))
        for i, d in enumerate(lst):
            seq[d["id"]] = i + 1
    return seq, test_ids


def draft_score(draft_id: int) -> dict | None:
    url = f"{SITE_URL}/api/draft/score?draftId={draft_id}"
    try:
        return json.load(urllib.request.urlopen(url, timeout=60))
    except Exception as e:  # noqa: BLE001
        print(f"[notify] score {draft_id}: {e}")
        return None


# --------------------------------------------------------------------------- #
# построение блока драфта
# --------------------------------------------------------------------------- #
def _user_stat(score: dict, user_id: str) -> dict:
    st = next((s for s in score.get("standings", []) if s["user_id"] == user_id), {})
    team = next((t for t in score.get("teams", []) if t["user_id"] == user_id), {})
    starters = [p for p in team.get("players", []) if not p.get("isSub")]
    played = sum(1 for p in starters if p.get("mstatus") not in ("pending", "live"))
    return {"total": st.get("total", 0), "place": st.get("place"),
            "played": played, "slots": len(starters)}


def _pos(p: dict) -> str:
    return POS_SHORT.get(p.get("position"), p.get("position") or "")


def _emo(p: dict, lineup: dict) -> str:
    """Статус игрока одним эмодзи: 🔵 старт / 🟠 запас / 🔴 вне заявки."""
    if p.get("isCoach"):
        return "🔵"                                  # тренер играет, если клуб в матче
    _, emo = STATUS.get(lineup.get(_pid(p)), STATUS[None])
    return emo


def _tot(v) -> str:
    """Тотал очков с одним знаком после запятой (19.0, 5.0, 33.3)."""
    try:
        return f"{float(v):.1f}"
    except (TypeError, ValueError):
        return "0.0"


def _pid(p: dict):
    # в score у игрока нет player_id; матчим по имени+клубу к ростеру отдельно (см. ниже)
    return p.get("_pid")


def _in_match(p: dict, home: str, away: str) -> bool:
    return p.get("club") in (home, away)


def build_draft_block(d: dict, score: dict, roster_pids: dict, lineup: dict,
                      user_id: str, home: str, away: str, display_no: int,
                      kind: str = "lineup", points: dict | None = None) -> str | None:
    points = points or {}
    """roster_pids: (user_id, name, club, position) -> player_id (для статуса по lineup)."""
    teams = score.get("teams", [])
    me = next((t for t in teams if t["user_id"] == user_id), None)
    if not me:
        return None

    def attach_pid(p, uid):
        p = dict(p)
        p["_pid"] = roster_pids.get((uid, p.get("name"), p.get("club"), p.get("position")))
        return p

    # мои игроки этого матча
    mine = sorted((attach_pid(p, user_id) for p in me.get("players", []) if _in_match(p, home, away)),
                  key=lambda p: POS_ORDER.get(p.get("position"), 9))
    # игроки матча у соперников
    opp = []
    for t in teams:
        if t["user_id"] == user_id:
            continue
        for p in t.get("players", []):
            if _in_match(p, home, away):
                opp.append((t, attach_pid(p, t["user_id"])))
    opp.sort(key=lambda tp: POS_ORDER.get(tp[1].get("position"), 9))

    emoji = LEAGUE_EMOJI.get(d["league"], "•")
    out = [f"{emoji} {d['league']} #{display_no} · {esc(d['tournament'])}, тур {d['round']}", ""]

    results = kind == "results"
    pstr = lambda p: _tot(points.get(_pid(p), 0))     # очки игрока за матч (для RESULTS)

    # Ваши игроки — LINE-UPS: имя + эмодзи; RESULTS: имя - очки
    out.append("<b>Ваши игроки:</b>")
    if mine:
        nw = max(len(p.get("name") or "") for p in mine)
        if results:
            pw = max(len(pstr(p)) for p in mine)
            lines = [f"{(p.get('name') or '').ljust(nw)} | {pstr(p).rjust(pw)}" for p in mine]
        else:
            lines = [f"{(p.get('name') or '').ljust(nw)} {_emo(p, lineup)}" for p in mine]
        out.append(_pre(lines))
    else:
        out.append("— нет игроков в этом матче")

    # Игроки соперников — LINE-UPS: имя | ник + эмодзи; RESULTS: имя - очки | ник
    if opp:
        nw = max(len(p.get("name") or "") for _, p in opp)
        ow = max(len(t["name"] or "") for t, _ in opp)
        if results:
            pw = max(len(pstr(p)) for _, p in opp)
            lines = [f"{(p.get('name') or '').ljust(nw)} | {pstr(p).rjust(pw)} | {t['name']}"
                     for t, p in opp]
        else:
            lines = [f"{(p.get('name') or '').ljust(nw)} | {(t['name'] or '').ljust(ow)} {_emo(p, lineup)}"
                     for t, p in opp]
        out.append("")
        out.append("<b>Игроки матча у соперников драфта:</b>")
        out.append(_pre(lines))

    # LIVE STANDING (моноширинно)
    st = sorted(score.get("standings", []), key=lambda s: s.get("place") or 99)
    nw = max((len(s["name"] or "") for s in st), default=0)
    tw = max((len(_tot(s["total"])) for s in st), default=0)
    lines = []
    for s in st:
        us = _user_stat(score, s["user_id"])
        lines.append(f"{s['place']}. {(s['name'] or '').ljust(nw)} | {_tot(s['total']).rjust(tw)} | "
                     f"({us['played']}/{us['slots']})")
    out.append("")
    out.append("LIVE STANDING")
    out.append(_pre(lines))

    out.append("")
    out.append(f"Ссылка на драфт: {SITE_URL}/?draft={d['id']}")
    return "\n".join(out)


def build_user_message(match_id: int, user_id: str, kind: str = "lineup") -> str | None:
    """Полное сообщение для одного участника по одному матчу (все его драфты с этим матчем).
    kind: 'lineup' (составы вышли) или 'results' (матч confirmed, очки за матч).
    None — если у участника нет игроков/ростеров в этом матче."""
    mm = match_meta(match_id)
    if not mm:
        return None
    home, away = mm["home_team"], mm["away_team"]
    lineup = lineup_map(match_id)
    points = points_map(match_id) if kind == "results" else {}
    seq, test_ids = draft_seq()
    drafts = [d for d in drafts_with_match(match_id) if d["id"] not in test_ids]  # тестовые не шлём
    drafts.sort(key=lambda d: seq.get(d["id"], 1e9))
    blocks = []
    for d in drafts:
        roster = db.select("dc_draft_rosters",
                           f"select=user_id,player_id,name,disp,club,position&draft_id=eq.{d['id']}")
        if not any(r["user_id"] == user_id for r in roster):
            continue
        # ключ (user, name, club, position) -> player_id; имя как в score (disp||name)
        rpids = {(r["user_id"], r.get("disp") or r["name"], r["club"], r["position"]): r["player_id"]
                 for r in roster}
        score = draft_score(d["id"])
        if not score:
            continue
        block = build_draft_block(d, score, rpids, lineup, user_id, home, away,
                                  display_no=seq.get(d["id"], d["id"]), kind=kind, points=points)
        if block:
            blocks.append(block)
    if not blocks:
        return None
    title = "RESULTS ✅" if kind == "results" else "LINE-UPS 🔥"
    header = f"<b>{esc(home)} — {esc(away)}. {title}</b>\n"
    sep = "\n\n" + "─" * 20 + "\n\n"          # разделитель между драфтами (если их несколько)
    return header + sep.join(blocks)


# --------------------------------------------------------------------------- #
# приветственное сообщение (/start, /status у привязанного)
# --------------------------------------------------------------------------- #
def _fmt_dt(iso: str | None, tz: str | None) -> str:
    """Дата/время старта матча в зоне игрока (tz из профиля; null → UTC+3)."""
    try:
        dt = datetime.fromisoformat(iso)
    except (TypeError, ValueError):
        return "—"
    target = None
    if tz and ZoneInfo is not None:
        try:
            target = ZoneInfo(tz)
        except Exception:  # noqa: BLE001 — нет такой зоны/нет tzdata → дефолт
            target = None
    return dt.astimezone(target or MSK).strftime("%d.%m %H:%M")


def build_welcome(user_id: str) -> str | None:
    """Приветствие привязанному игроку: его драфты в игре (с линками) + ближайшие
    матчи тура. Время — в зоне профиля (или UTC+3)."""
    pf = db.select("dc_profiles", f"select=display_name,timezone&id=eq.{user_id}")
    if not pf:
        return None
    name = pf[0].get("display_name") or "игрок"
    tz = pf[0].get("timezone")

    seq, test_ids = draft_seq()
    mine = db.select("dc_draft_rosters", f"select=draft_id&user_id=eq.{user_id}")
    dids = sorted({r["draft_id"] for r in mine})
    drafts = []
    if dids:
        idlist = ",".join(str(x) for x in dids)
        drafts = [d for d in db.select(
            "dc_drafts",
            f"select=id,league,tournament,round,season_id,match_ids&id=in.({idlist})&status=in.(finalized,live,done)")
            if d["id"] not in test_ids]
        drafts.sort(key=lambda d: seq.get(d["id"], 1e9))

    lobby = f'<a href="{SITE_URL}/?view=lobby">линк</a>'
    out = [f"<b>Привет, {esc(name)}!</b>", "",
           f"✍️ Запись на драфты: {lobby}", "",
           f"<b>Драфтов в игре: {len(drafts)}</b>"]
    if drafts:
        out.append("")
        for d in drafts:
            emoji = LEAGUE_EMOJI.get(d["league"], "•")
            no = seq.get(d["id"], d["id"])
            link = f'<a href="{SITE_URL}/?draft={d["id"]}">линк</a>'
            out.append(f"{emoji} {d['league']} #{no} · {esc(d['tournament'])}, тур {d['round']}: {link}")

    # все несыгранные матчи тура (live/pending) — по season+round драфтов в игре, не только match_ids
    pairs = {(d.get("season_id"), d.get("round")) for d in drafts}
    mmap = {}
    for sid, rnd in pairs:
        if sid is None or rnd is None:
            continue
        for m in db.select(
                "dc_matches",
                f"select=match_id,home_team,away_team,score_home,score_away,start_time,status"
                f"&season_id=eq.{sid}&round=eq.{rnd}&status=in.(live,pending)&limit=100"):
            mmap[m["match_id"]] = m
    matches = sorted(mmap.values(), key=lambda m: m.get("start_time") or "")
    if matches:
        nh = max(len(m["home_team"] or "") for m in matches)
        na = max(len(m["away_team"] or "") for m in matches)
        lines = []
        for m in matches:
            sh, sa = m.get("score_home"), m.get("score_away")
            sc = f"{sh}:{sa}" if sh is not None and sa is not None else "-"
            live = m["status"] == "live"
            stat, emo = ("LIVE", "🔥") if live else ("Upcoming", "⏰")
            lines.append(f"{_fmt_dt(m['start_time'], tz)} {(m['home_team'] or '').ljust(nh)} "
                         f"{sc:^5} {(m['away_team'] or '').ljust(na)} {stat:<8} {emo}")
        out.append("")
        out.append("<b>Ближайшие матчи этого тура:</b>")
        out.append(_pre(lines))
    return "\n".join(out)
