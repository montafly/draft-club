"""Telegram Bot API — голый HTTP, только stdlib (как боты в PyCharmMiscProject).

Зависимостей нет. Все вызовы — POST с urlencoded-телом.
"""
from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request


def api(token: str, method: str, params: dict | None = None) -> dict:
    """Вызов метода Bot API. Возвращает разобранный JSON.
    Сетевые/HTTP-ошибки не бросает наружу, а отдаёт {ok: False, ...},
    чтобы один сбойный чат не ронял весь цикл."""
    url = f"https://api.telegram.org/bot{token}/{method}"
    data = urllib.parse.urlencode(params).encode() if params else None
    try:
        with urllib.request.urlopen(urllib.request.Request(url, data=data), timeout=60) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")
        return {"ok": False, "error_code": e.code, "description": body}
    except Exception as e:  # noqa: BLE001 — таймаут/сеть: не валим цикл
        return {"ok": False, "error_code": 0, "description": str(e)}


def _chunks(text: str, limit: int = 4000) -> list[str]:
    """Режет по границам блоков ('\\n\\n'), чтобы не разрывать HTML-теги/<pre>.
    Сверхдлинный блок (редко) режется жёстко."""
    if len(text) <= limit:
        return [text]
    parts, cur = [], ""
    for para in text.split("\n\n"):
        piece = ("\n\n" if cur else "") + para
        if len(cur) + len(piece) <= limit:
            cur += piece
        else:
            if cur:
                parts.append(cur)
            if len(para) <= limit:
                cur = para
            else:
                for i in range(0, len(para), limit):
                    parts.append(para[i:i + limit])
                cur = ""
    if cur:
        parts.append(cur)
    return parts


def send_message(token: str, chat_id: int | str, text: str, parse_mode: str | None = None) -> dict:
    """Отправка текста в чат. Длинный текст бьётся по границам блоков (см. _chunks).
    parse_mode='HTML' — для уведомлений с <pre> (моноширинный standing)."""
    out: dict = {"ok": True}
    for chunk in _chunks(text or " "):
        params = {"chat_id": chat_id, "text": chunk}
        if parse_mode:
            params["parse_mode"] = parse_mode
        out = api(token, "sendMessage", params)
        if not out.get("ok"):
            break
    return out


def get_updates(token: str, offset: int, timeout: int = 0) -> list[dict]:
    """Забирает накопленные апдейты начиная с offset (long-poll при timeout>0)."""
    resp = api(token, "getUpdates", {"offset": offset, "timeout": timeout})
    return resp.get("result", []) if resp.get("ok") else []
