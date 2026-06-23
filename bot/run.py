"""Draft Club — бот-уведомлятор (Telegram).

Постоянный цикл:
  1) приём команд участников (/start /stop /status) → подписчики в Supabase;
  2) детектор «составы вышли»: матч pending/live, в dc_player_match появился
     lineup, ещё не уведомляли → отправка подписчикам, антидубль через dc_bot_sent.

Бот НЕ ходит в FanTeam. Данные пишет collect.py (cron auto), бот только читает
Supabase и шлёт в Telegram. Только stdlib.

Креды — из .env в корне репо (как у collect.py/db.py):
  SUPABASE_URL, SUPABASE_KEY (service_role), BOT_TOKEN.

Запуск (из корня репо):  python bot/run.py
Разовый прогон детектора без цикла:  python bot/run.py --once
"""
from __future__ import annotations

import os
import sys
import time
from datetime import datetime, timedelta, timezone
from urllib.parse import quote

# корень репо в path, чтобы импортировать db.py и tg.py
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import db       # noqa: E402  (обёртка Supabase из корня репо)
import tg       # noqa: E402
import notify   # noqa: E402  (сборка персонального сообщения)

POLL_SECONDS = int(os.environ.get("BOT_POLL_SECONDS", "15"))   # шаг цикла
LOOKAHEAD_MIN = int(os.environ.get("BOT_LOOKAHEAD_MIN", "150"))  # как далеко вперёд смотрим pending
LOOKBACK_HOURS = int(os.environ.get("BOT_LOOKBACK_HOURS", "36"))  # назад: storm/простой не теряем results
STATE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "state")


# --------------------------------------------------------------------------- #
# креды / утилиты
# --------------------------------------------------------------------------- #
def bot_token() -> str:
    db.load_env(os.path.join(ROOT, ".env"))
    tok = os.environ.get("BOT_TOKEN", "")
    if not tok:
        raise SystemExit("Нет BOT_TOKEN в .env")
    return tok


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def read_offset() -> int:
    path = os.path.join(STATE_DIR, "offset.txt")
    if os.path.exists(path):
        return int(open(path, encoding="utf-8").read().strip() or 0)
    return 0


def save_offset(offset: int) -> None:
    os.makedirs(STATE_DIR, exist_ok=True)
    open(os.path.join(STATE_DIR, "offset.txt"), "w", encoding="utf-8").write(str(offset))


# --------------------------------------------------------------------------- #
# подписчики (Supabase: dc_bot_subscribers)
# --------------------------------------------------------------------------- #
def upsert_subscriber(chat: dict, active: bool) -> None:
    db.upsert("dc_bot_subscribers", [{
        "chat_id": chat["id"],
        "username": chat.get("username"),
        "first_name": chat.get("first_name"),
        "active": active,
        "updated_at": now_utc().isoformat(),
    }], on_conflict="chat_id")


def bound_subscribers() -> list[dict]:
    """Активные подписчики, привязанные к профилю (user_id не пуст) — только им шлём
    персональные уведомления."""
    return db.select("dc_bot_subscribers",
                     "select=chat_id,user_id&active=is.true&user_id=not.is.null&limit=10000")


def bind_code(chat_id: int, code: str) -> str | None:
    """Привязка chat_id к профилю по одноразовому коду с сайта.
    Возвращает display_name профиля или None (код неверный/истёк/использован)."""
    rows = db.select("dc_bot_links",
                     f"select=user_id,expires_at,used&code=eq.{quote(code, safe='')}&limit=1")
    if not rows:
        return None
    link = rows[0]
    if link.get("used"):
        return None
    exp = link.get("expires_at")
    if exp and exp < now_utc().isoformat():
        return None
    uid = link["user_id"]
    db.upsert("dc_bot_subscribers", [{
        "chat_id": chat_id, "user_id": uid, "active": True,
        "updated_at": now_utc().isoformat(),
    }], on_conflict="chat_id")
    db.upsert("dc_bot_links", [{"code": code, "user_id": uid, "used": True}],
              on_conflict="code")  # гасим код (одноразовый)
    pf = db.select("dc_profiles", f"select=display_name&id=eq.{uid}")
    return pf[0]["display_name"] if pf else uid[:8]


# --------------------------------------------------------------------------- #
# приём команд
# --------------------------------------------------------------------------- #
WELCOME = (
    "Подписка на уведомления Draft Club включена.\n"
    "Будут приходить апдейты по матчам (например, выход стартовых составов).\n\n"
    "/lobby — драфты в наборе и подача заявки, /stop — отписаться, /status — статус."
)
BIND_HINT = ("\n\nЧтобы получать ПЕРСОНАЛЬНЫЕ уведомления по своим драфтам, привяжи аккаунт: "
             "сайт → Профиль → «Подключить Telegram».")


def bound_uid(chat_id: int) -> str | None:
    rows = db.select("dc_bot_subscribers", f"select=user_id&chat_id=eq.{chat_id}&limit=1")
    return rows[0].get("user_id") if rows else None


def send_welcome(token: str, chat_id: int, uid: str, prefix: str | None = None) -> None:
    """Шлёт привязанному игроку приветствие (драфты + ближайшие матчи). При сбое сборки
    — короткий fallback."""
    w = notify.build_welcome(uid) or WELCOME
    tg.send_message(token, chat_id, (prefix + "\n\n" + w) if prefix else w, parse_mode="HTML")


def handle_command(token: str, msg: dict) -> None:
    text = (msg.get("text") or "").strip()
    low = text.lower()
    chat = msg["chat"]
    cid = chat["id"]
    if low.startswith("/start"):
        upsert_subscriber(chat, active=True)
        parts = text.split(maxsplit=1)          # /start <code> — payload из deep-link
        payload = parts[1].strip() if len(parts) > 1 else ""
        if payload:
            name = bind_code(cid, payload)
            if name:
                send_welcome(token, cid, bound_uid(cid), prefix=f"Аккаунт привязан: {name}.")
            else:
                tg.send_message(token, cid,
                                "Код привязки неверный или истёк. Сгенерируй новый: "
                                "сайт → Профиль → «Подключить Telegram».\n\n" + WELCOME)
        else:
            uid = bound_uid(cid)
            if uid:
                send_welcome(token, cid, uid)
            else:
                tg.send_message(token, cid, WELCOME + BIND_HINT)
    elif low.startswith("/stop"):
        upsert_subscriber(chat, active=False)
        tg.send_message(token, cid, "Отписал. Вернуться — /start.")
    elif low.startswith("/status"):
        uid = bound_uid(cid)
        if uid:
            send_welcome(token, cid, uid)
        else:
            tg.send_message(token, cid, "Подписка есть, но аккаунт не привязан." + BIND_HINT)
    elif low.startswith("/lobby"):
        tg.send_message(token, cid, notify.build_lobby(bound_uid(cid)),
                        parse_mode="HTML", reply_markup=lobby_buttons())
    else:
        tg.send_message(token, cid, "Команды: /start, /lobby, /stop, /status.")


# --------------------------------------------------------------------------- #
# лобби: кнопки подачи заявки + обработка нажатий
# --------------------------------------------------------------------------- #
def lobby_buttons() -> dict | None:
    """Инлайн-кнопки «Оставить заявку» по каждому recruiting-драфту (callback apply:<id>)."""
    rows = [[{"text": f"Оставить заявку: {d['league']} #{d['seq']}",
              "callback_data": f"apply:{d['id']}"}] for d in notify.recruiting_drafts()]
    return {"inline_keyboard": rows} if rows else None


def create_application(user_id: str, draft_id: int) -> str:
    """Подать заявку участника на драфт (как сайт: insert в dc_applications, status=pending).
    Возвращает: 'ok' / 'exists' / 'closed'."""
    d = db.select("dc_drafts", f"select=status&id=eq.{draft_id}&limit=1")
    if not d or d[0].get("status") != "recruiting":
        return "closed"
    ex = db.select("dc_applications",
                   f"select=id&draft_id=eq.{draft_id}&user_id=eq.{user_id}&limit=1")
    if ex:
        return "exists"
    db.upsert("dc_applications", [{"draft_id": draft_id, "user_id": user_id}])  # status=pending по дефолту
    return "ok"


def handle_callback(token: str, cq: dict) -> None:
    data = cq.get("data") or ""
    cqid = cq["id"]
    msg = cq.get("message") or {}
    cid = (msg.get("chat") or {}).get("id")
    if cid is None:
        tg.answer_callback(token, cqid)
        return
    uid = bound_uid(cid)
    if data.startswith("apply:"):
        did = int(data.split(":", 1)[1])
        if not uid:
            tg.answer_callback(token, cqid)
            tg.send_message(token, cid, "Сначала привяжи аккаунт: сайт → Профиль → "
                            "«Подключить Telegram»." )
            return
        head = notify._draft_head(did)
        seq, _ = notify.draft_seq()
        label = f"{head['league']} #{seq.get(did, did)}" if head else f"#{did}"
        tg.answer_callback(token, cqid)
        tg.send_message(token, cid, f"Подать заявку на <b>{label}</b>?", parse_mode="HTML",
                        reply_markup={"inline_keyboard": [[
                            {"text": "Подтвердить", "callback_data": f"applyok:{did}"},
                            {"text": "Отмена", "callback_data": "cancel"}]]})
    elif data.startswith("applyok:"):
        did = int(data.split(":", 1)[1])
        if not uid:
            tg.answer_callback(token, cqid, "Аккаунт не привязан")
            return
        r = create_application(uid, did)
        toast = {"ok": "Заявка отправлена", "exists": "Заявка уже была подана",
                 "closed": "Набор на драфт закрыт"}[r]
        tg.answer_callback(token, cqid, toast)
        tg.send_message(token, cid, toast + ("." if r != "ok" else
                        ". Статус — в /lobby и в профиле на сайте."))
    elif data == "cancel":
        tg.answer_callback(token, cqid, "Отменено")
    else:
        tg.answer_callback(token, cqid)


def poll_commands(token: str) -> None:
    offset = read_offset()
    updates = tg.get_updates(token, offset, timeout=25)   # long-poll: команды ловятся почти мгновенно
    if not updates:
        return
    max_id = offset - 1
    for upd in updates:
        max_id = max(max_id, upd["update_id"])
        try:
            if upd.get("callback_query"):
                handle_callback(token, upd["callback_query"])
            else:
                msg = upd.get("message") or upd.get("edited_message")
                if msg and msg.get("chat"):
                    handle_command(token, msg)
        except Exception as e:  # noqa: BLE001
            print(f"[cmd] ошибка на update {upd['update_id']}: {e}")
    save_offset(max_id + 1)


# --------------------------------------------------------------------------- #
# детектор «составы вышли»
# --------------------------------------------------------------------------- #
def sent_chats(match_id: int, kind: str) -> set:
    """chat_id, которым уже ушло уведомление (match, kind) — одним запросом на матч.
    Нужно при широком окне назад: матч, разосланный всем, пропускаем целиком."""
    rows = db.select("dc_bot_sent",
                     f"select=chat_id&match_id=eq.{match_id}&kind=eq.{kind}&limit=10000")
    return {r["chat_id"] for r in rows}


def mark_sent(chat_id: int, match_id: int, kind: str) -> None:
    db.upsert("dc_bot_sent", [{
        "chat_id": chat_id, "match_id": match_id, "kind": kind,
        "sent_at": now_utc().isoformat(),
    }], on_conflict="chat_id,match_id,kind")


def lineup_ready(match_id: int, status: str) -> bool:
    """Готов ли состав к отправке LINE-UPS.

    Условие — обе команды выложили стартовый XI (>=11 confirmed на каждый team_id):
    тогда нотификация уходит ~за час до матча с верными статусами, а не на первой же
    проставленной строке (из-за чего раньше игроки уходили все как 'вне заявки' 🔴).
    Фолбэк: матч уже начался (live) — шлём что есть, даже если FanTeam не выкатил полный XI
    (недостающий слот = игрок не из базы FanTeam, такого и в наших драфтах нет)."""
    rows = db.select("dc_player_match",
                     f"select=team_id&match_id=eq.{match_id}&lineup=eq.confirmed&limit=300")
    by_team: dict = {}
    for r in rows:
        by_team[r["team_id"]] = by_team.get(r["team_id"], 0) + 1
    if len(by_team) >= 2 and all(c >= 11 for c in by_team.values()):
        return True
    return status == "live"


def candidate_matches() -> list[dict]:
    """Матчи в окне: pending около старта / live (для составов) и confirmed (для итогов)."""
    # quote: в ISO есть '+00:00', иначе '+' в URL станет пробелом → 400 (22007).
    hi = quote((now_utc() + timedelta(minutes=LOOKAHEAD_MIN)).isoformat(), safe="")
    # назад смотрим широко: матч мог затянуться (гроза/пауза) или бот — простоять, тогда
    # confirmed приходит сильно позже старта; узкое 8ч-окно такие матчи теряло (France-Iraq).
    lo = quote((now_utc() - timedelta(hours=LOOKBACK_HOURS)).isoformat(), safe="")
    q = ("select=match_id,home_team,away_team,start_time,status"
         f"&status=in.(pending,live,confirmed)&start_time=gte.{lo}&start_time=lte.{hi}&limit=200")
    return db.select("dc_matches", q)


def detect_and_notify(token: str) -> int:
    """Персональная рассылка. На каждого привязанного подписчика — одно сообщение по матчу
    (внутри блоки по его драфтам). Два типа: 'lineup' (pending/live, составы вышли) и
    'results' (confirmed, очки за матч). Антидубль per (chat, match, kind)."""
    sent_now = 0
    subs = bound_subscribers()
    if not subs:
        return 0
    for m in candidate_matches():
        mid, stx = m["match_id"], m["status"]
        if stx in ("pending", "live"):
            kind = "lineup"
            if not lineup_ready(mid, stx):                  # состав ещё не готов (см. lineup_ready)
                continue
        elif stx == "confirmed":
            kind = "results"
        else:
            continue
        done = sent_chats(mid, kind)
        targets = [s for s in subs if s["chat_id"] not in done]
        if not targets:                                    # все привязанные уже получили — пропускаем матч
            continue
        for s in targets:
            chat_id = s["chat_id"]
            text = notify.build_user_message(mid, s["user_id"], kind=kind)
            if not text:                                   # нет игроков/ростеров в матче
                continue
            res = tg.send_message(token, chat_id, text, parse_mode="HTML")
            if res.get("ok"):
                mark_sent(chat_id, mid, kind)
                sent_now += 1
                print(f"[{kind}] матч {mid} -> chat {chat_id} ({s['user_id'][:8]})")
            elif res.get("error_code") in (403, 400):      # заблокировал бота / чат недоступен
                upsert_subscriber({"id": chat_id}, active=False)
    return sent_now


# --------------------------------------------------------------------------- #
# детектор драфт-уведомлений (финализация / открытие комнаты)
# --------------------------------------------------------------------------- #
def draft_sent_chats(draft_id: int, kind: str) -> set:
    rows = db.select("dc_bot_draft_sent",
                     f"select=chat_id&draft_id=eq.{draft_id}&kind=eq.{kind}&limit=10000")
    return {r["chat_id"] for r in rows}


def mark_draft_sent(chat_id: int, draft_id: int, kind: str) -> None:
    db.upsert("dc_bot_draft_sent", [{
        "chat_id": chat_id, "draft_id": draft_id, "kind": kind,
        "sent_at": now_utc().isoformat(),
    }], on_conflict="chat_id,draft_id,kind")


def _push_draft(token: str, chat_id: int, draft_id: int, kind: str, text: str | None) -> bool:
    if not text:
        return False
    res = tg.send_message(token, chat_id, text, parse_mode="HTML")
    if res.get("ok"):
        mark_draft_sent(chat_id, draft_id, kind)
        print(f"[{kind}] драфт {draft_id} -> chat {chat_id}")
        return True
    if res.get("error_code") in (403, 400):
        upsert_subscriber({"id": chat_id}, active=False)
    return False


def detect_drafts(token: str) -> int:
    """Драфт-уведомления принятым (accepted) привязанным участникам:
    'finalized' — драфт финализирован (дата/время старта); 'room_open' — комната открыта (link).
    Антидубль per (chat, draft, kind) в dc_bot_draft_sent."""
    subs = bound_subscribers()
    if not subs:
        return 0
    by_uid = {s["user_id"]: s["chat_id"] for s in subs}
    sent = 0
    drafts = db.select("dc_drafts",
                       "select=id,status,room_code&status=in.(finalized,live)&order=id.desc&limit=50")
    for d in drafts:
        did, stx = d["id"], d["status"]
        apps = db.select("dc_applications",
                         f"select=user_id&draft_id=eq.{did}&status=eq.accepted&limit=200")
        uids = [a["user_id"] for a in apps if a.get("user_id") in by_uid]
        if not uids:
            continue
        # финализация (для live тоже — добивает пропущенное, если бот стоял на момент finalize)
        fin_done = draft_sent_chats(did, "finalized")
        for uid in uids:
            chat = by_uid[uid]
            if chat in fin_done:
                continue
            sent += _push_draft(token, chat, did, "finalized", notify.build_finalized(did, uid))
        # открытие комнаты — только когда live и есть код
        if stx == "live" and d.get("room_code"):
            room_done = draft_sent_chats(did, "room_open")
            for uid in uids:
                chat = by_uid[uid]
                if chat in room_done:
                    continue
                sent += _push_draft(token, chat, did, "room_open", notify.build_room_open(did, uid))
    return sent


# --------------------------------------------------------------------------- #
# цикл
# --------------------------------------------------------------------------- #
def main() -> None:
    token = bot_token()
    once = "--once" in sys.argv[1:]
    if once:
        poll_commands(token)
        detect_and_notify(token)
        detect_drafts(token)
        return
    print(f"Draft Club bot запущен. Long-poll 25с, окно вперёд {LOOKAHEAD_MIN}мин.")
    while True:
        try:
            poll_commands(token)            # блокируется до 25с (long-poll) → команды почти мгновенно
            detect_and_notify(token)
            detect_drafts(token)
        except Exception as e:  # noqa: BLE001 — цикл не должен падать
            print(f"[loop] ошибка: {e}")
        time.sleep(2)


if __name__ == "__main__":
    main()
