-- Draft Club — схема для очков FanTeam.
-- Префикс dc_ чтобы не пересекаться с таблицами FPL в той же базе Supabase.
-- Запустить один раз в Supabase SQL Editor.

create table if not exists dc_matches (
    match_id      bigint primary key,
    season_id     integer not null,
    round         integer,
    home_team_id  integer,
    away_team_id  integer,
    home_team     text,
    away_team     text,
    start_time    timestamptz,
    status        text,                 -- pending / (live) / (ended) / confirmed
    score_home    integer,
    score_away    integer,
    is_final      boolean generated always as (status = 'confirmed') stored,
    updated_at    timestamptz default now()
);

create table if not exists dc_player_match (
    match_id      bigint references dc_matches(match_id) on delete cascade,
    player_id     bigint not null,
    player_name   text,
    team_id       integer,
    position      text,
    minutes       integer,
    points        numeric(6,2),         -- посчитанные очки по весам FanTeam
    stats         jsonb,                -- сырьё realPlayerMatchStats.stats
    status        text,                 -- статус матча на момент записи (provisional/final)
    updated_at    timestamptz default now(),
    primary key (match_id, player_id)
);

create index if not exists idx_dc_matches_season_round on dc_matches (season_id, round);
create index if not exists idx_dc_player_match_player on dc_player_match (player_id);

-- Права для сборщика (пишет под service_role). Без этого PostgREST даёт 403.
grant select, insert, update, delete on public.dc_matches to service_role;
grant select, insert, update, delete on public.dc_player_match to service_role;
