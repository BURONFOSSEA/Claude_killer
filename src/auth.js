// Authentification : hachage des mots de passe, sessions par cookie, limitation des tentatives.
import crypto from 'node:crypto';

const SESSION_DAYS = { admin: 7, player: 60 };
export const COOKIE = { admin: 'kg_admin', player: 'kg_player' };

// Alphabet sans caractères ambigus (0/O, 1/I/L) : facile à taper sur un téléphone.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

export function randomCode(length = 6) {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return out;
}

export function normalizeCode(code) {
  return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

export function createSession(db, kind, subjectId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_DAYS[kind] * 86400_000).toISOString();
  db.prepare('INSERT INTO sessions (token_hash, kind, subject_id, expires_at) VALUES (?, ?, ?, ?)')
    .run(sha256(token), kind, subjectId, expires);
  return { token, maxAge: SESSION_DAYS[kind] * 86400_000 };
}

export function readSession(db, kind, token) {
  if (!token) return null;
  const row = db.prepare('SELECT * FROM sessions WHERE token_hash = ? AND kind = ?').get(sha256(token), kind);
  if (!row) return null;
  if (row.expires_at < new Date().toISOString()) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(row.token_hash);
    return null;
  }
  return row;
}

export function destroySession(db, token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

export function destroySubjectSessions(db, kind, subjectId) {
  db.prepare('DELETE FROM sessions WHERE kind = ? AND subject_id = ?').run(kind, subjectId);
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// Limiteur simple en mémoire : N échecs max par fenêtre et par clé (IP).
export function createRateLimiter({ max = 10, windowMs = 15 * 60_000 } = {}) {
  const hits = new Map();
  return {
    blocked(key) {
      const entry = hits.get(key);
      if (!entry) return false;
      if (Date.now() - entry.start > windowMs) {
        hits.delete(key);
        return false;
      }
      return entry.count >= max;
    },
    fail(key) {
      const entry = hits.get(key);
      if (!entry || Date.now() - entry.start > windowMs) hits.set(key, { start: Date.now(), count: 1 });
      else entry.count++;
    },
    reset(key) {
      hits.delete(key);
    },
  };
}

// Crée le compte admin au premier démarrage s'il n'existe pas encore.
export function ensureAdmin(db, { username, password }) {
  const existing = db.prepare('SELECT id FROM admins LIMIT 1').get();
  if (existing) return null;
  const generated = !password;
  const pwd = password || randomCode(12);
  db.prepare('INSERT INTO admins (username, password_hash) VALUES (?, ?)').run(username, hashPassword(pwd));
  return { username, password: generated ? pwd : null };
}
