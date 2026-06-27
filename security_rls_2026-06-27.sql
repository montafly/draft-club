-- Draft Club — фиксы безопасности RLS/грантов (2026-06-27)
-- Запускать в Supabase SQL Editor. Идемпотентно (можно повторно).
-- Контекст: anon-роль уже закрыта; дыры — в роли authenticated (залогиненный юзер с anon-ключом + JWT).
-- ПОСЛЕ применения: залогинься в приложении и проверь — профиль/аватар/таймзона меняются,
-- история баланса (ledger) показывает ТОЛЬКО свои строки, лобби/драфты грузятся, драфт-просмотрщик работает.

-- ============================================================
-- 0) ДИАГНОСТИКА (выполни ОТДЕЛЬНО до изменений, чтобы видеть текущее состояние)
-- ============================================================
-- RLS включён? (relrowsecurity = true)
--   select relname, relrowsecurity from pg_class
--   where relname in ('dc_profiles','dc_applications','dc_ledger','dc_draft_rosters','dc_pronunciations')
--   order by relname;
-- Какие гранты у anon/authenticated?
--   select table_name, grantee, privilege_type from information_schema.role_table_grants
--   where table_schema='public' and grantee in ('anon','authenticated')
--     and table_name in ('dc_profiles','dc_applications','dc_ledger','dc_draft_rosters','dc_pronunciations')
--   order by table_name, grantee, privilege_type;

-- ============================================================
-- 1) [CRITICAL] dc_profiles: запретить юзеру менять свои role и dcc_balance
--    Причина: табличный GRANT UPDATE + политика "обновляй свою строку" позволяли
--    sb.from('dc_profiles').update({role:'admin', dcc_balance: ...}) с анон-ключом.
--    RLS не умеет ограничивать колонки — ограничиваем колоночным грантом.
-- ============================================================
revoke update on public.dc_profiles from authenticated;
grant  update (display_name, avatar_url, timezone) on public.dc_profiles to authenticated;
-- insert — тоже только безопасные колонки (профиль и так автосоздаётся триггером dc_handle_new_user,
-- он SECURITY DEFINER и не зависит от этого гранта; здесь — оборона от ручного insert с role/balance)
revoke insert on public.dc_profiles from authenticated;
grant  insert (id, display_name, avatar_url, timezone) on public.dc_profiles to authenticated;
-- политики оставляем как есть: select using(true) (см. примечание ниже), update/insert — только своя строка.

-- ============================================================
-- 2) [HIGH] dc_applications: запретить вставлять заявку сразу со status='accepted'
--    Причина: with check проверял только user_id, не status → самопринятие в драфт мимо админа.
-- ============================================================
drop policy if exists "apps insert own" on public.dc_applications;
create policy "apps insert own" on public.dc_applications
  for insert to authenticated
  with check (user_id = auth.uid() and status = 'pending');

-- ============================================================
-- 3) [CRITICAL-проверка] dc_ledger: включить RLS, читать только свои строки, писать — только сервер
--    Клиент делает select('*') без фильтра (index.html:1190) и полагается на RLS.
-- ============================================================
alter table public.dc_ledger enable row level security;
revoke insert, update, delete on public.dc_ledger from authenticated, anon;
drop policy if exists "ledger read own" on public.dc_ledger;
create policy "ledger read own" on public.dc_ledger
  for select to authenticated using (user_id = auth.uid());
grant select on public.dc_ledger to authenticated;   -- нужен, иначе Postgres режет ДО проверки RLS
grant select, insert, update, delete on public.dc_ledger to service_role;

-- ============================================================
-- 4) [CRITICAL-проверка] dc_draft_rosters: серверная таблица, клиент НЕ читает её напрямую
--    (составы идут через /api/draft/score). Закрываем для anon/authenticated полностью.
-- ============================================================
alter table public.dc_draft_rosters enable row level security;
revoke select, insert, update, delete on public.dc_draft_rosters from authenticated, anon;
grant  select, insert, update, delete on public.dc_draft_rosters to service_role;

-- ============================================================
-- 5) [LOW] dc_pronunciations: серверная таблица (TTS читает сервер, пишет админ через /api).
--    Клиент не читает напрямую. Закрываем для anon/authenticated.
-- ============================================================
alter table public.dc_pronunciations enable row level security;
revoke select, insert, update, delete on public.dc_pronunciations from authenticated, anon;
grant  select, insert, update, delete on public.dc_pronunciations to service_role;

-- ============================================================
-- ПРИМЕЧАНИЕ (не фикс, на будущее): dc_profiles select using(true) даёт любому залогиненному
-- читать чужие dcc_balance/role/статистику (email там нет — он в auth.users). Чтобы скрыть,
-- нужна вьюха dc_profiles_public(id, display_name, avatar_url) + правка клиентских select на неё.
-- Это отдельная задача (требует изменения index.html). Severity MEDIUM, оставлено осознанно.
-- ============================================================
