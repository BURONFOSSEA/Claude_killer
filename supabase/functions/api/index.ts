// Edge Function Supabase : toute l'API du jeu.
// Déployée avec --no-verify-jwt : l'authentification est gérée par le jeu lui-même (jetons de session).
import postgres from 'postgres';
import { postgresAdapter } from '../_shared/adapters.js';
import { boot } from '../_shared/boot.js';

// SUPABASE_DB_URL est fourni automatiquement par Supabase à chaque Edge Function.
const sql = postgres(Deno.env.get('SUPABASE_DB_URL')!, { prepare: false, max: Number(Deno.env.get('DB_POOL_MAX')) || 3 });

const ready = boot({
  db: postgresAdapter(sql),
  env: Deno.env.toObject(),
  // Laisse le temps aux notifications de partir après l'envoi de la réponse.
  // deno-lint-ignore no-explicit-any
  waitUntil: (p: Promise<unknown>) => (globalThis as any).EdgeRuntime?.waitUntil(p) ?? p,
});

Deno.serve(async (req) => (await ready)(req));
