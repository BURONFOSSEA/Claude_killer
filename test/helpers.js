// Base Postgres jetable (PGlite en mémoire) pour les tests.
import { PGlite } from '@electric-sql/pglite';
import { pgliteAdapter } from '../supabase/functions/_shared/adapters.js';
import { migrate } from '../supabase/functions/_shared/db.js';

export async function newDb() {
  const db = pgliteAdapter(new PGlite());
  await migrate(db);
  return db;
}

// Crée une partie et n joueurs (P0, P1, ...), avec en option un plan en boucle P0 → P1 → ... → P0.
export async function setupGame(db, n, { name = 'Test', emails = () => '', plan = true } = {}) {
  const gameId = (await db.one('INSERT INTO games (name) VALUES ($1) RETURNING id', [name])).id;
  const ids = [];
  for (let i = 0; i < n; i++) {
    ids.push((await db.one('INSERT INTO players (game_id, name, code, email) VALUES ($1, $2, $3, $4) RETURNING id', [gameId, `P${i}`, `CODE${gameId}X${i}`, emails(i)])).id);
  }
  if (plan) {
    const rows = ids.map((id, i) => ({ killer_id: id, target_id: ids[(i + 1) % n], challenge_text: `défi ${i}` }));
    await db.query('UPDATE games SET plan_json = $1 WHERE id = $2', [JSON.stringify(rows), gameId]);
  }
  return { gameId, ids };
}

export const openContract = (db, killerId) => db.one("SELECT * FROM contracts WHERE killer_id = $1 AND status IN ('active','pending')", [killerId]);
