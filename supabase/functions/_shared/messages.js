// Messagerie : l'organisateur écrit à tous / aux vivants / aux éliminés / à des joueurs choisis ;
// un joueur ne peut écrire qu'à l'organisateur.
import { GameError, adminEvent, getGame } from './game.js';
import { nowIso } from './db.js';

export const MAX_LENGTH = 1000;
const PLAYER_HOURLY_LIMIT = 30;
const AUDIENCES = { all: 'tous les joueurs', alive: 'les joueurs en vie', dead: 'les joueurs éliminés', players: 'joueurs choisis' };

function cleanBody(body) {
  const text = String(body ?? '').trim();
  if (!text) throw new GameError('Le message est vide.');
  if (text.length > MAX_LENGTH) throw new GameError(`Message trop long (${MAX_LENGTH} caractères maximum).`);
  return text;
}

export const preview = (text, max = 140) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

// Organisateur → joueurs
export async function sendAdminMessage(db, gameId, { body, audience = 'all', playerIds = [] }) {
  const text = cleanBody(body);
  if (!AUDIENCES[audience]) throw new GameError('Destinataires invalides.');
  await getGame(db, gameId);
  let recipients;
  if (audience === 'players') {
    const ids = [...new Set(playerIds.map(Number).filter(Number.isInteger))];
    if (!ids.length) throw new GameError('Choisissez au moins un joueur.');
    recipients = await db.query('SELECT id FROM players WHERE game_id = $1 AND id = ANY($2::int[])', [gameId, ids]);
  } else {
    const filter = audience === 'alive' ? " AND status = 'alive'" : audience === 'dead' ? " AND status = 'dead'" : '';
    recipients = await db.query(`SELECT id FROM players WHERE game_id = $1${filter}`, [gameId]);
  }
  if (!recipients.length) throw new GameError('Aucun joueur ne correspond à ces destinataires.');
  // Envoi groupé (historique côté organisateur) : tout envoi à un groupe, ou à plusieurs joueurs choisis.
  const key = audience !== 'players' || recipients.length > 1 ? crypto.randomUUID() : null;
  const now = nowIso();
  await db.tx(async (t) => {
    for (const r of recipients) {
      await t.query(
        "INSERT INTO messages (game_id, player_id, direction, body, broadcast_key, audience, created_at) VALUES ($1, $2, 'to_player', $3, $4, $5, $6)",
        [gameId, r.id, text, key, audience, now],
      );
    }
  });
  const ids = recipients.map((r) => r.id);
  return { sent: ids.length, events: [{ type: 'message_received', gameId, to: ids, data: { body: text } }] };
}

// Joueur → organisateur
export async function sendPlayerMessage(db, playerId, body) {
  const text = cleanBody(body);
  const player = await db.one('SELECT * FROM players WHERE id = $1', [playerId]);
  if (!player) throw new GameError('Joueur introuvable.', 404);
  const since = new Date(Date.now() - 3600_000).toISOString();
  const recent = await db.one("SELECT COUNT(*)::int AS n FROM messages WHERE player_id = $1 AND direction = 'to_admin' AND created_at > $2", [playerId, since]);
  if (recent.n >= PLAYER_HOURLY_LIMIT) throw new GameError("Trop de messages envoyés : réessaie dans un moment.", 429);
  await db.query("INSERT INTO messages (game_id, player_id, direction, body, created_at) VALUES ($1, $2, 'to_admin', $3, $4)", [
    player.game_id,
    playerId,
    text,
    nowIso(),
  ]);
  return { events: [adminEvent('admin_message', player.game_id, { playerId, body: text })] };
}

// Fil du joueur (ses messages + ceux de l'organisateur). Les messages reçus sont marqués comme lus.
export async function playerThread(db, playerId) {
  const rows = await db.query('SELECT id, direction, body, broadcast_key, audience, created_at, read_at FROM messages WHERE player_id = $1 ORDER BY id', [playerId]);
  await db.query("UPDATE messages SET read_at = $1 WHERE player_id = $2 AND direction = 'to_player' AND read_at IS NULL", [nowIso(), playerId]);
  return rows.map((m) => ({
    id: m.id,
    from: m.direction === 'to_player' ? 'admin' : 'me',
    body: m.body,
    at: m.created_at,
    group: m.direction === 'to_player' && m.audience !== 'players' ? AUDIENCES[m.audience] : null,
    unread: m.direction === 'to_player' && !m.read_at,
  }));
}

export async function playerUnread(db, playerId) {
  return (await db.one("SELECT COUNT(*)::int AS n FROM messages WHERE player_id = $1 AND direction = 'to_player' AND read_at IS NULL", [playerId])).n;
}

// Vue organisateur : un fil par joueur + historique des envois groupés.
export async function adminMessages(db, gameId) {
  const rows = await db.query('SELECT * FROM messages WHERE game_id = $1 ORDER BY id', [gameId]);
  const threads = {};
  const broadcasts = new Map();
  for (const m of rows) {
    (threads[m.player_id] ||= []).push({
      id: m.id,
      from: m.direction === 'to_admin' ? 'player' : 'admin',
      body: m.body,
      at: m.created_at,
      read: Boolean(m.read_at),
      group: m.direction === 'to_player' && m.broadcast_key ? AUDIENCES[m.audience] : null,
    });
    if (m.broadcast_key) {
      const b = broadcasts.get(m.broadcast_key) || { body: m.body, at: m.created_at, audience: AUDIENCES[m.audience], recipients: 0, read: 0 };
      b.recipients++;
      if (m.read_at) b.read++;
      broadcasts.set(m.broadcast_key, b);
    }
  }
  return { threads, broadcasts: [...broadcasts.values()].reverse() };
}

export async function markThreadRead(db, gameId, playerId) {
  await db.query("UPDATE messages SET read_at = $1 WHERE game_id = $2 AND player_id = $3 AND direction = 'to_admin' AND read_at IS NULL", [
    nowIso(),
    gameId,
    playerId,
  ]);
}

export async function adminUnreadByGame(db) {
  const rows = await db.query("SELECT game_id, COUNT(*)::int AS n FROM messages WHERE direction = 'to_admin' AND read_at IS NULL GROUP BY game_id");
  return Object.fromEntries(rows.map((r) => [r.game_id, r.n]));
}
