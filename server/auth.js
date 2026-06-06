// Авторизация через Supabase: валидация access-токена + профили.
// Токен проверяем обращением к Supabase /auth/v1/user (не нужен JWT secret).
// Env (читаются лениво, после загрузки .env в server.js):
//   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_KEY

const U = () => process.env.SUPABASE_URL;
const ANON = () => process.env.SUPABASE_ANON_KEY;
const SERVICE = () => process.env.SUPABASE_SERVICE_KEY;

export function clientConfig() {
  return { supabaseUrl: U(), supabaseAnonKey: ANON() };
}

/** Проверить токен пользователя → {id, email}. Бросает, если невалиден. */
export async function authUser(token) {
  if (!token) throw new Error('нет токена');
  const r = await fetch(`${U()}/auth/v1/user`, {
    headers: { apikey: ANON(), authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error('не авторизован');
  const u = await r.json();
  if (!u || !u.id) throw new Error('не авторизован');
  return { id: u.id, email: u.email };
}

/** Профиль игрока (display_name создаётся триггером при регистрации). */
export async function getProfile(userId) {
  const r = await fetch(
    `${U()}/rest/v1/dc_profiles?id=eq.${userId}&select=display_name,role,dcc_balance,games_played,wins,podiums`,
    { headers: { apikey: SERVICE(), authorization: `Bearer ${SERVICE()}` } });
  if (!r.ok) return null;
  const rows = await r.json();
  return rows[0] || null;
}
