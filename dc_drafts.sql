-- Draft Club Фаза C (часть 1): драфты + заявки. Идемпотентно.

create table if not exists dc_drafts (
  id          bigint generated always as identity primary key,
  created_by  uuid references auth.users(id),
  tournament  text not null,
  season_id   int  not null,
  round       int  not null,
  match_ids   bigint[] not null,
  league      text not null check (league in ('BRONZE','SILVER','GOLDEN')),
  buyin       int  not null,
  prize1      int  not null,
  prize2      int  not null,
  slots       int  not null default 5,
  club_limit  int  not null default 5,
  starts_at   timestamptz,
  status      text not null default 'recruiting'
              check (status in ('recruiting','finalized','live','done','cancelled','settled')),
  created_at  timestamptz default now()
);

create table if not exists dc_applications (
  id         bigint generated always as identity primary key,
  draft_id   bigint references dc_drafts(id) on delete cascade,
  user_id    uuid references auth.users(id),
  status     text not null default 'pending' check (status in ('pending','accepted','rejected')),
  created_at timestamptz default now(),
  unique (draft_id, user_id)
);

alter table dc_drafts enable row level security;
alter table dc_applications enable row level security;

-- текущий юзер админ? (security definer — читает dc_profiles в обход RLS, без рекурсии)
create or replace function dc_is_admin() returns boolean language sql stable security definer as $$
  select exists (select 1 from dc_profiles where id = auth.uid() and role = 'admin');
$$;
grant execute on function dc_is_admin() to authenticated, anon, service_role;

-- dc_drafts: читают все залогиненные; создаёт/меняет только админ
drop policy if exists "drafts read" on dc_drafts;
create policy "drafts read" on dc_drafts for select to authenticated using (true);
drop policy if exists "drafts admin insert" on dc_drafts;
create policy "drafts admin insert" on dc_drafts for insert to authenticated with check (dc_is_admin());
drop policy if exists "drafts admin update" on dc_drafts;
create policy "drafts admin update" on dc_drafts for update to authenticated using (dc_is_admin()) with check (dc_is_admin());

-- dc_applications: юзер видит/создаёт/снимает свою; админ видит все и меняет статус
-- заявки видны всем залогиненным (никнеймы заявителей/принятых в лобби)
drop policy if exists "apps read own or admin" on dc_applications;
drop policy if exists "apps read all" on dc_applications;
create policy "apps read all" on dc_applications for select to authenticated using (true);
drop policy if exists "apps insert own" on dc_applications;
create policy "apps insert own" on dc_applications for insert to authenticated with check (user_id = auth.uid());
drop policy if exists "apps admin update" on dc_applications;
create policy "apps admin update" on dc_applications for update to authenticated using (dc_is_admin()) with check (dc_is_admin());
drop policy if exists "apps withdraw own" on dc_applications;
create policy "apps withdraw own" on dc_applications for delete to authenticated using (user_id = auth.uid());

grant select, insert, update, delete on dc_drafts to authenticated, service_role;
grant select, insert, update, delete on dc_applications to authenticated, service_role;

notify pgrst, 'reload schema';
