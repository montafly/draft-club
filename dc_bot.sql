-- Draft Club — бот-уведомлятор. Выполнять в Supabase SQL Editor (DDL — вручную).
-- Безопасно: ничего из игровых/settled-таблиц не трогает.

-- 1) lineup (confirmed/bench) в данных по игрокам — для детекта «составы вышли».
--    Для старых строк останется NULL — это ок (детектор смотрит только not-null).
alter table dc_player_match
  add column if not exists lineup text;

-- 2) Подписчики бота.
create table if not exists dc_bot_subscribers (
  chat_id     bigint primary key,
  username    text,
  first_name  text,
  active      boolean     not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- 3) Антидубль: по каждому матчу+типу уведомление шлём один раз.
create table if not exists dc_bot_sent (
  match_id    bigint      not null,
  kind        text        not null,   -- 'lineup' (дальше: 'goal', 'final', ...)
  recipients  int,
  sent_at     timestamptz not null default now(),
  primary key (match_id, kind)
);

-- 4) Права роли PostgREST: на таблицы из SQL Editor авто-грант не срабатывает,
--    без этого бот ловит 403 permission denied (42501).
grant select, insert, update, delete on public.dc_bot_subscribers to service_role;
grant select, insert, update, delete on public.dc_bot_sent to service_role;

-- ========================================================================= --
-- v2 (персональные уведомления): привязка профиля + per-user антидубль.
-- ========================================================================= --

-- 5) Привязка chat_id -> профиль игрока.
alter table dc_bot_subscribers
  add column if not exists user_id uuid;

-- 6) Одноразовые коды привязки (генерит сайт, гасит бот).
create table if not exists dc_bot_links (
  code        text        primary key,
  user_id     uuid        not null,
  used        boolean     not null default false,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz
);
grant select, insert, update, delete on public.dc_bot_links to service_role;

-- 7) Антидубль теперь per (подписчик, матч, тип) — одно сообщение на пару user×match.
--    Таблица v1 была per (match,kind); пересоздаём (данных там нет).
drop table if exists dc_bot_sent;
create table dc_bot_sent (
  chat_id   bigint      not null,
  match_id  bigint      not null,
  kind      text        not null,   -- 'lineup' (дальше: 'goal','final',...)
  sent_at   timestamptz not null default now(),
  primary key (chat_id, match_id, kind)
);
grant select, insert, update, delete on public.dc_bot_sent to service_role;

-- ========================================================================= --
-- v3 (драфт-уведомления): /lobby, заявка через бота, финализация/комната.
-- ========================================================================= --

-- 8) Антидубль драфт-уведомлений per (подписчик, драфт, тип).
--    Отдельно от dc_bot_sent (та — по матчам). kind: 'finalized', 'room_open'.
create table if not exists dc_bot_draft_sent (
  chat_id   bigint      not null,
  draft_id  bigint      not null,
  kind      text        not null,
  sent_at   timestamptz not null default now(),
  primary key (chat_id, draft_id, kind)
);
grant select, insert, update, delete on public.dc_bot_draft_sent to service_role;
