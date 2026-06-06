-- Draft Club Фаза A: роли + баланс DCC в профилях. Идемпотентно.
-- 1) колонки
alter table dc_profiles add column if not exists role text not null default 'user';
alter table dc_profiles add column if not exists dcc_balance integer not null default 0;

-- 2) ограничение роли (все существующие строки = 'user' по дефолту, проходит)
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'dc_profiles_role_chk') then
    alter table dc_profiles add constraint dc_profiles_role_chk check (role in ('user','admin'));
  end if;
end $$;

-- 3) Матвей (montafly4@gmail.com) -> админ
update dc_profiles set role = 'admin' where id = '56a7da2d-8f97-4c52-86a9-b10cc66564f4';

-- 4) грант для роли authenticated (без него RLS-политики не работают — Postgres режет до RLS)
grant select, insert, update on dc_profiles to authenticated;
