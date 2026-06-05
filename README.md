# Draft Club — считалка очков

Тянет данные FanTeam (ScoutGG API), считает очки игроков по позиционным весам FanTeam
(1 в 1) и складывает в Supabase. Источник и веса описаны в vault:
`Personal/Draft Club/{draft-club} {spec} FanTeam ScoutGG API – 2026-06-05.md`.

## Статус
- `collect.py` — считалка. Скоринг **валидирован** на матче Brentford 3:0 Sunderland
  (15/15 игроков совпали с тоталами FanTeam).
- `schema.sql` — таблицы Supabase (`dc_matches`, `dc_player_match`).
- TODO: запись в Supabase (`db.py`), оркестратор тура, GitHub Actions cron.

## Запуск (Python 3.13, только stdlib)
```
python collect.py validate            # сверка с известными тоталами
python collect.py match 3877589       # очки одного матча
python collect.py round 1900 21       # PL 2025/26, тур 21
python collect.py round 1995 1        # World Cup 2026, игровой день 1
```
На этой машине Python: `C:\Users\Montafly\anaconda3\python.exe`.

## Ключевые ID
- PL 2025/26: `season_id 1900`, round 1–38.
- World Cup 2026: `season_id 1995`, round = игровой день (старт 11.06.2026) — для обкатки live.

## Финальность очков
Очки финальны при `status = confirmed`. До этого — provisional (live/ended).

## Доступ к данным
Эндпоинты FanTeam требуют заголовок `authorization: Bearer fanteam undefined`
(реальный логин не нужен). Поллинг — вежливый (раз в 5–10 мин, только активные матчи).
