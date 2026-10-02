// Adaptateurs de base de données (voir db.js pour l'interface).

// Production : postgres.js (connexion directe fournie par Supabase via SUPABASE_DB_URL).
export function postgresAdapter(sql) {
  const wrap = (s) => ({
    query: (text, params = []) => s.unsafe(text, params),
    one: async (text, params = []) => (await s.unsafe(text, params))[0],
  });
  return {
    ...wrap(sql),
    exec: (text) => sql.unsafe(text),
    tx: (fn) => sql.begin((t) => fn(wrap(t))),
  };
}

// Local / tests : PGlite (Postgres compilé en WebAssembly, sans installation).
export function pgliteAdapter(pg) {
  const wrap = (c) => ({
    query: async (text, params = []) => (await c.query(text, params)).rows,
    one: async (text, params = []) => (await c.query(text, params)).rows[0],
  });
  return {
    ...wrap(pg),
    exec: (text) => pg.exec(text),
    tx: (fn) => pg.transaction((t) => fn(wrap(t))),
  };
}
