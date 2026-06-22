# Draft Club — бот-уведомлятор (Telegram)

Шлёт участникам уведомления по матчам. Первый тип — **«составы вышли»** (FanTeam
проставляет стартовый состав/банк ещё на pending, за ~60 мин до старта).

## Как устроено
- Данные пишет `collect.py` (cron `auto`) в Supabase: `dc_matches`, `dc_player_match`
  (включая колонку `lineup` = confirmed/bench). Бот в FanTeam **не ходит**.
- `bot/run.py` — постоянный цикл:
  - команды `/start` `/stop` `/status` → таблица `dc_bot_subscribers`;
  - детектор: матч pending/live + в `dc_player_match` появился `lineup` + ещё не
    слали → рассылка подписчикам; антидубль через `dc_bot_sent`.
- `bot/tg.py` — голый Bot API (stdlib), `db.py` (корень репо) — Supabase.

## Шов под формат (ещё не финализирован)
Текст и адресация уведомления заданы в `build_lineup_message()` (`bot/run.py`) —
сейчас нейтральный широковещательный текст-заглушка. Финальный формат и таргетинг
(всем подписчикам / персонально по ростеру драфта) утверждаются отдельно и
заменяют только эту функцию + список получателей в `detect_and_notify()`.

## Первый запуск
1. Создать бота у @BotFather, получить токен.
2. В `.env` (корень репо) добавить: `BOT_TOKEN=...`
3. Применить DDL: `dc_bot.sql` в Supabase SQL Editor.
4. Прогон детектора разово: `python bot/run.py --once`
5. Постоянно (локально): `python bot/run.py`

## Деплой на VPS (systemd)
collect.py должен идти по cron в окнах матчей (пишет lineup), бот — отдельный сервис.

`/etc/systemd/system/dc-bot.service`:
```ini
[Unit]
Description=Draft Club notify bot
After=network-online.target

[Service]
WorkingDirectory=/opt/draft-club        # корень репо на сервере
ExecStart=/usr/bin/python3 bot/run.py
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

cron для сбора данных (пример — каждые 2 минуты, фильтрацию активных делает auto):
```
*/2 * * * * cd /opt/draft-club && SEASON_IDS=1995 /usr/bin/python3 collect.py auto >> /var/log/dc-collect.log 2>&1
```

`SEASON_IDS` — какие сезоны мониторить (1995 = ЧМ-2026, 1900 = PL 2025/26).
`PREMATCH_MINUTES` (env, по умолч. 100) — за сколько минут до старта поллить pending.
