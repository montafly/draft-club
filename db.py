"""
Запись/чтение в Supabase через PostgREST. Только stdlib.
Креды берутся из .env (SUPABASE_URL, SUPABASE_KEY).
"""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.request


def _open(req):
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.read()
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")
        raise RuntimeError(f"HTTP {e.code} {e.reason} | {body}") from None


def load_env(path: str = ".env") -> None:
    if not os.path.exists(path):
        return
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip())


def _creds() -> tuple[str, str]:
    load_env()
    url = os.environ.get("SUPABASE_URL", "").rstrip("/")
    key = os.environ.get("SUPABASE_KEY", "")
    if not url or not key:
        raise RuntimeError("Нет SUPABASE_URL/SUPABASE_KEY в .env")
    return url, key


def upsert(table: str, rows: list[dict], on_conflict: str | None = None) -> int:
    """Upsert (merge по primary key / on_conflict). Возвращает число отправленных строк."""
    if not rows:
        return 0
    url, key = _creds()
    endpoint = f"{url}/rest/v1/{table}"
    if on_conflict:
        endpoint += f"?on_conflict={on_conflict}"
    body = json.dumps(rows).encode("utf-8")
    req = urllib.request.Request(endpoint, data=body, method="POST", headers={
        "apikey": key,
        "authorization": f"Bearer {key}",
        "content-type": "application/json",
        "prefer": "resolution=merge-duplicates,return=minimal",
    })
    _open(req)
    return len(rows)


def select(table: str, query: str = "") -> list[dict]:
    url, key = _creds()
    endpoint = f"{url}/rest/v1/{table}"
    if query:
        endpoint += f"?{query}"
    req = urllib.request.Request(endpoint, headers={
        "apikey": key,
        "authorization": f"Bearer {key}",
        "accept": "application/json",
    })
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode("utf-8"))
