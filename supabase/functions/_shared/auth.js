// Authentification : hachage des mots de passe (PBKDF2), jetons de session, limitation des tentatives.
// N'utilise que l'API Web Crypto : fonctionne à l'identique sous Node et dans les Edge Functions (Deno).

const SESSION_DAYS = { admin: 7, player: 60 };
const ITERATIONS = 100_000;
// Alphabet sans caractères ambigus (0/O, 1/I/L) : facile à taper sur un téléphone.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

const enc = new TextEncoder();
const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (hex) => Uint8Array.from(hex.match(/../g), (h) => parseInt(h, 16));

async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
}

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${ITERATIONS}$${toHex(salt)}$${toHex(await pbkdf2(password, salt, ITERATIONS))}`;
}

export async function verifyPassword(password, stored) {
  const [scheme, iter, saltHex, hashHex] = String(stored).split('$');
  if (scheme !== 'pbkdf2' || !saltHex || !hashHex) return false;
  const actual = toHex(await pbkdf2(password, fromHex(saltHex), Number(iter)));
  // comparaison en temps constant
  if (actual.length !== hashHex.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual.charCodeAt(i) ^ hashHex.charCodeAt(i);
  return diff === 0;
}

export function randomCode(length = 6) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

export function normalizeCode(code) {
  return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

const sha256 = async (s) => toHex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
const randomToken = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/[+/=]/g, '');

export async function createSession(db, kind, subjectId) {
  const token = randomToken();
  const expires = new Date(Date.now() + SESSION_DAYS[kind] * 86400_000).toISOString();
  await db.query('INSERT INTO sessions (token_hash, kind, subject_id, expires_at) VALUES ($1, $2, $3, $4)', [
    await sha256(token),
    kind,
    subjectId,
    expires,
  ]);
  return token;
}

export async function readSession(db, kind, token) {
  if (!token) return null;
  const row = await db.one('SELECT * FROM sessions WHERE token_hash = $1 AND kind = $2', [await sha256(token), kind]);
  if (!row) return null;
  if (row.expires_at < new Date().toISOString()) {
    await db.query('DELETE FROM sessions WHERE token_hash = $1', [row.token_hash]);
    return null;
  }
  return row;
}

export async function destroySession(db, token) {
  if (token) await db.query('DELETE FROM sessions WHERE token_hash = $1', [await sha256(token)]);
}

export async function destroySubjectSessions(db, kind, subjectId) {
  await db.query('DELETE FROM sessions WHERE kind = $1 AND subject_id = $2', [kind, subjectId]);
}

// Limitation stockée en base (les instances serveur sont éphémères) : N échecs max par IP sur la fenêtre.
const MAX_FAILURES = 10;
const WINDOW = '15 minutes';

export async function loginBlocked(db, ip) {
  const row = await db.one(`SELECT COUNT(*)::int AS n FROM login_attempts WHERE ip = $1 AND at > now() - interval '${WINDOW}'`, [ip]);
  return row.n >= MAX_FAILURES;
}

export async function loginFailed(db, ip) {
  await db.query('INSERT INTO login_attempts (ip) VALUES ($1)', [ip]);
  await db.query(`DELETE FROM login_attempts WHERE at < now() - interval '1 day'`);
}

export async function loginSucceeded(db, ip) {
  await db.query('DELETE FROM login_attempts WHERE ip = $1', [ip]);
}

// Crée le compte admin s'il n'existe pas encore (identifiants fournis par la configuration).
export async function ensureAdmin(db, { username, password }) {
  if (await db.one('SELECT id FROM admins LIMIT 1')) return null;
  const generated = !password;
  const pwd = password || randomCode(12);
  await db.query('INSERT INTO admins (username, password_hash) VALUES ($1, $2) ON CONFLICT DO NOTHING', [username, await hashPassword(pwd)]);
  return { username, password: generated ? pwd : null };
}
