-- Draft Club — профили игроков (привязаны к Supabase Auth). Запустить в Supabase SQL Editor.

create table if not exists dc_profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  display_name text not null,
  role         text not null default 'user' check (role in ('user','admin')),
  dcc_balance  int  not null default 0,
  games_played int  not null default 0,
  wins         int  not null default 0,
  podiums      int  not null default 0,
  created_at   timestamptz default now()
);

-- для уже существующей таблицы (Фаза A): отдельная миграция в profiles_phaseA.sql

alter table dc_profiles enable row level security;

-- читать профили может любой залогиненный (чтобы показывать имена соперников)
drop policy if exists "profiles readable by authenticated" on dc_profiles;
create policy "profiles readable by authenticated"
  on dc_profiles for select to authenticated using (true);

-- менять/создавать только свой профиль
drop policy if exists "users update own profile" on dc_profiles;
create policy "users update own profile"
  on dc_profiles for update to authenticated using (auth.uid() = id);
drop policy if exists "users insert own profile" on dc_profiles;
create policy "users insert own profile"
  on dc_profiles for insert to authenticated with check (auth.uid() = id);

-- автосоздание профиля при регистрации (display_name = часть email до @)
create or replace function dc_handle_new_user()
returns trigger language plpgsql security definer as $$
begin
  insert into public.dc_profiles (id, display_name)
  values (new.id, split_part(new.email, '@', 1))
  on conflict (id) do nothing;
  return new;
end; $$;

drop trigger if exists dc_on_auth_user_created on auth.users;
create trigger dc_on_auth_user_created
  after insert on auth.users
  for each row execute function dc_handle_new_user();

grant select, insert, update on public.dc_profiles to service_role;
-- authenticated нужен табличный грант, иначе RLS-политики не срабатывают (Postgres режет до RLS)
grant select, insert, update on public.dc_profiles to authenticated;
