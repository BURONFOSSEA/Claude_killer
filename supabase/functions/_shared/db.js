// Schéma Postgres et petits utilitaires d'accès à la base.
// La base est fournie par un "adaptateur" exposant :
//   db.query(sql, params) -> lignes     db.one(sql, params) -> première ligne ou undefined
//   db.tx(async (t) => ...)             (t expose query/one dans une transaction)
// Adaptateurs : postgres.js en production (Supabase), PGlite en local et pour les tests.

const NOW = `to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS admins (
  id            serial PRIMARY KEY,
  username      text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  created_at    text NOT NULL DEFAULT ${NOW}
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash text PRIMARY KEY,
  kind       text NOT NULL CHECK (kind IN ('admin', 'player')),
  subject_id integer NOT NULL,
  expires_at text NOT NULL
);

CREATE TABLE IF NOT EXISTS login_attempts (
  id  serial PRIMARY KEY,
  ip  text NOT NULL,
  at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_login_attempts ON login_attempts(ip, at);

CREATE TABLE IF NOT EXISTS games (
  id          serial PRIMARY KEY,
  name        text NOT NULL,
  theme       text NOT NULL DEFAULT '',
  status      text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'running', 'finished')),
  ends_at     text,
  started_at  text,
  finished_at text,
  winner_id   integer,
  plan_json   text,
  created_at  text NOT NULL DEFAULT ${NOW}
);

CREATE TABLE IF NOT EXISTS players (
  id            serial PRIMARY KEY,
  game_id       integer NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  name          text NOT NULL,
  notes         text NOT NULL DEFAULT '',
  email         text NOT NULL DEFAULT '',
  code          text NOT NULL UNIQUE,
  status        text NOT NULL DEFAULT 'alive' CHECK (status IN ('alive', 'dead')),
  eliminated_at text,
  eliminated_by integer,
  created_at    text NOT NULL DEFAULT ${NOW}
);

CREATE TABLE IF NOT EXISTS challenges (
  id         serial PRIMARY KEY,
  game_id    integer NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  text       text NOT NULL,
  source     text NOT NULL DEFAULT 'admin' CHECK (source IN ('admin', 'ai', 'library')),
  created_at text NOT NULL DEFAULT ${NOW}
);

-- Un contrat = "killer doit éliminer target avec ce défi".
-- active : en cours ; pending : kill déclaré, en attente ; done : kill validé ; void : annulé.
CREATE TABLE IF NOT EXISTS contracts (
  id             serial PRIMARY KEY,
  game_id        integer NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  killer_id      integer NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  target_id      integer NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  challenge_text text NOT NULL,
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'pending', 'done', 'void')),
  contested      integer NOT NULL DEFAULT 0,
  created_at     text NOT NULL,
  declared_at    text,
  closed_at      text
);
CREATE INDEX IF NOT EXISTS idx_contracts_game ON contracts(game_id, status);

CREATE TABLE IF NOT EXISTS kills (
  id                  serial PRIMARY KEY,
  game_id             integer NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  killer_id           integer REFERENCES players(id) ON DELETE CASCADE,
  victim_id           integer NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  challenge_text      text,
  contract_started_at text,
  confirmed_by        text NOT NULL CHECK (confirmed_by IN ('target', 'admin', 'elimination')),
  created_at          text NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_kills_game ON kills(game_id);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id         serial PRIMARY KEY,
  player_id  integer NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  endpoint   text NOT NULL UNIQUE,
  keys_json  text NOT NULL,
  created_at text NOT NULL DEFAULT ${NOW}
);

-- Messagerie : chaque message appartient au fil d'un joueur (échanges joueur ↔ organisateur).
-- Un message de l'organisateur à plusieurs joueurs crée une ligne par destinataire (même broadcast_key).
CREATE TABLE IF NOT EXISTS messages (
  id            serial PRIMARY KEY,
  game_id       integer NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  player_id     integer NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  direction     text NOT NULL CHECK (direction IN ('to_player', 'to_admin')),
  body          text NOT NULL,
  broadcast_key text,
  audience      text,
  created_at    text NOT NULL DEFAULT ${NOW},
  read_at       text
);
CREATE INDEX IF NOT EXISTS idx_messages_player ON messages(player_id, id);
CREATE INDEX IF NOT EXISTS idx_messages_game ON messages(game_id, id);

-- Appareils de l'organisateur abonnés aux notifications push.
CREATE TABLE IF NOT EXISTS admin_push_subscriptions (
  id         serial PRIMARY KEY,
  admin_id   integer NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  endpoint   text NOT NULL UNIQUE,
  keys_json  text NOT NULL,
  created_at text NOT NULL DEFAULT ${NOW}
);

-- Colonnes ajoutées après la première version.
ALTER TABLE admins ADD COLUMN IF NOT EXISTS email text NOT NULL DEFAULT '';
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS reminded_at text;

CREATE TABLE IF NOT EXISTS settings (
  key   text PRIMARY KEY,
  value text NOT NULL
);

-- Toutes les données passent par la fonction serveur : on bloque l'accès direct
-- via l'API publique de Supabase (aucune policy = aucun accès pour anon/authenticated).
ALTER TABLE admins ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE login_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE games ENABLE ROW LEVEL SECURITY;
ALTER TABLE players ENABLE ROW LEVEL SECURITY;
ALTER TABLE challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE contracts ENABLE ROW LEVEL SECURITY;
ALTER TABLE kills ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_push_subscriptions ENABLE ROW LEVEL SECURITY;
`;

export async function migrate(db) {
  await db.exec(SCHEMA);
}

export function nowIso() {
  return new Date().toISOString();
}

export async function getSetting(db, key) {
  return (await db.one('SELECT value FROM settings WHERE key = $1', [key]))?.value ?? null;
}

export async function setSetting(db, key, value) {
  await db.query('INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = excluded.value', [key, value]);
}
