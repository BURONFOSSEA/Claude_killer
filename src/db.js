// Accès à la base SQLite (module natif node:sqlite, aucune dépendance native à compiler).
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS admins (
  id            INTEGER PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('admin', 'player')),
  subject_id INTEGER NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS games (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  theme       TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'running', 'finished')),
  ends_at     TEXT,              -- fin prévue (optionnelle), ISO 8601
  started_at  TEXT,
  finished_at TEXT,
  winner_id   INTEGER,
  plan_json   TEXT,              -- proposition d'attribution (brouillon) avant lancement
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS players (
  id             INTEGER PRIMARY KEY,
  game_id        INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  notes          TEXT NOT NULL DEFAULT '',   -- infos visibles uniquement par l'admin (et l'IA)
  code           TEXT NOT NULL UNIQUE,       -- code d'accès personnel du joueur
  status         TEXT NOT NULL DEFAULT 'alive' CHECK (status IN ('alive', 'dead')),
  eliminated_at  TEXT,
  eliminated_by  INTEGER,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS challenges (
  id         INTEGER PRIMARY KEY,
  game_id    INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  text       TEXT NOT NULL,
  source     TEXT NOT NULL DEFAULT 'admin' CHECK (source IN ('admin', 'ai', 'library')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Un contrat = "killer doit éliminer target avec ce défi".
-- active : en cours ; pending : kill déclaré, en attente de confirmation ;
-- done : kill validé ; void : annulé (cible éliminée autrement, réattribution...).
CREATE TABLE IF NOT EXISTS contracts (
  id             INTEGER PRIMARY KEY,
  game_id        INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  killer_id      INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  target_id      INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  challenge_text TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'pending', 'done', 'void')),
  contested      INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL,
  declared_at    TEXT,
  closed_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_contracts_game ON contracts(game_id, status);

CREATE TABLE IF NOT EXISTS kills (
  id             INTEGER PRIMARY KEY,
  game_id        INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  killer_id      INTEGER REFERENCES players(id) ON DELETE CASCADE,
  victim_id      INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  challenge_text TEXT,
  contract_started_at TEXT,
  confirmed_by   TEXT NOT NULL CHECK (confirmed_by IN ('target', 'admin', 'elimination')),
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_kills_game ON kills(game_id);

-- Abonnements aux notifications push (un joueur peut en avoir plusieurs : téléphone, ordinateur...).
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id         INTEGER PRIMARY KEY,
  player_id  INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  endpoint   TEXT NOT NULL UNIQUE,
  keys_json  TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

// Colonnes ajoutées après la première version : ajoutées aux bases existantes au démarrage.
const MIGRATIONS = [['players', 'email', "TEXT NOT NULL DEFAULT ''"]];

function migrate(db) {
  for (const [table, column, definition] of MIGRATIONS) {
    const exists = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
    if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

export function getSetting(db, key) {
  return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null;
}

export function setSetting(db, key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

// Exécute fn dans une transaction (rollback en cas d'erreur).
export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function nowIso() {
  return new Date().toISOString();
}
