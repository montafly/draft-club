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
    "/stop — отписаться, /status — статус подписки."
)
BIND_HINT = ("\n\nЧтобы получать ПЕРСОНАЛЬНЫЕ уведомления по своим драфтам, привяжи аккаунт: "
             "сайт → Профиль → «Подключить Telegram».")


def my_profile(chat_id: int) -> str | None:
    rows = db.select("dc_bot_subscribers", f"select=user_id&chat_id=eq.{chat_id}&limit=1")
    uid = rows[0].get("user_id") if rows else None
    if not uid:
        return None
    pf = db.select("dc_profiles", f"select=display_name&id=eq.{uid}")
    return pf[0]["display_name"] if pf else uid[:8]


def handle_command(token: str, msg: dict) -> None:
    text = (msg.get("text") or "").strip()
    low = text.lower()
    chat = msg["chat"]
    if low.startswith("/start"):
        upsert_subscriber(chat, active=True)
        parts = text.split(maxsplit=1)          # /start <code> — payload из deep-link
        payload = parts[1].strip() if len(parts) > 1 else ""
        if payload:
            name = bind_code(chat["id"], payload)
            if name:
                tg.send_message(token, chat["id"], f"Аккаунт привязан: {name}.\n\n" + WELCOME)
            else:
                tg.send_message(token, chat["id"],
                                "Код привязки неверный или истёк. Сгенерируй новый: "
                                "сайт → Профиль → «Подключить Telegram».\n\n" + WELCOME)
        else:
            tg.send_message(token, chat["id"], WELCOME + BIND_HINT)
    elif low.startswith("/stop"):
        upsert_subscriber(chat, active=False)
        tg.send_message(token, chat["id"], "Отписал. Вернуться — /start.")
    elif low.startswith("/status"):
        name = my_profile(chat["id"])
        if name:
            tg.send_message(token, chat["id"], f"Подписка активна, привязана к профилю: {name}.")
        else:
            tg.send_message(token, chat["id"], "Подписка есть, но аккаунт не привязан." + BIND_HINT)
    else:
        tg.send_message(token, chat["id"], "Команды: /start, /stop, /status.")


def poll_commands(token: str) -> None:
    offset = read_offset()
    updates = tg.get_updates(token, offset, timeout=0)
    if not updates:
        return
    max_id = offset - 1
    for upd in updates:
        max_id = max(max_id, upd["update_id"])
        msg = upd.get("message") or upd.get("edited_message")
        if msg and msg.get("chat"):
            try:
                handle_command(token, msg)
            except Exception as e:  # noqa: BLE001
                print(f"[cmd] ошибка на update {upd['update_id']}: {e}")
    save_offset(max_id + 1)


# --------------------------------------------------------------------------- #
# детектор «составы вышли»
# --------------------------------------------------------------------------- #
def already_sent(chat_id: int, match_id: int, kind: str) -> bool:
    rows = db.select("dc_bot_sent",
                     f"select=match_id&chat_id=eq.{chat_id}&match_id=eq.{match_id}"
                     f"&kind=eq.{kind}&limit=1")
    return bool(rows)


def mark_sent(chat_id: int, match_id: int, kind: str) -> None:
    db.upsert("dc_bot_sent", [{
        "chat_id": chat_id, "match_id": match_id, "kind": kind,
        "sent_at": now_utc().isoformat(),
    }], on_conflict="chat_id,match_id,kind")


def lineup_ready(match_id: int) -> bool:
    """В dc_player_match по матчу уже проставлен lineup (составы вышли)."""
    rows = db.select("dc_player_match",
                     f"select=player_id&match_id=eq.{match_id}&lineup=not.is.null&limit=1")
    return bool(rows)


def candidate_matches() -> list[dict]:
    """Матчи в окне: pending около старта / live (для составов) и confirmed (для итогов)."""
    # quote: в ISO есть '+00:00', иначе '+' в URL станет пробелом → 400 (22007).
    hi = quote((now_utc() + timedelta(minutes=LOOKAHEAD_MIN)).isoformat(), safe="")
    lo = quote((now_utc() - timedelta(hours=8)).isoformat(), safe="")  # confirmed приходит спустя часы
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
            if not lineup_ready(mid):                       # составы ещё не вышли
                continue
        elif stx == "confirmed":
            kind = "results"
        else:
            continue
        for s in subs:
            chat_id = s["chat_id"]
            if already_sent(chat_id, mid, kind):
                continue
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
# цикл
# --------------------------------------------------------------------------- #
def main() -> None:
    token = bot_token()
    once = "--once" in sys.argv[1:]
    if once:
        poll_commands(token)
        detect_and_notify(token)
        return
    print(f"Draft Club bot запущен. Шаг {POLL_SECONDS}с, окно вперёд {LOOKAHEAD_MIN}мин.")
    while True:
        try:
            poll_commands(token)
            detect_and_notify(token)
        except Exception as e:  # noqa: BLE001 — цикл не должен падать
            print(f"[loop] ошибка: {e}")
        time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    main()
