// Logique du jeu : attribution circulaire des cibles, déclaration/validation des kills, statistiques.
import { nowIso } from './db.js';

export class GameError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const OPEN = "('active', 'pending')";

// Les actions du jeu renvoient des événements { type, to: [ids joueurs], gameId, data } :
// le serveur les transmet ensuite au module de notifications (push + e-mail).
const event = (type, gameId, to, data = {}) => ({ type, gameId, to: [to].flat().filter(Boolean), data });
// Événement destiné à l'organisateur (tous les comptes admin) : il peut, lui, contenir des noms.
export const adminEvent = (type, gameId, data = {}) => ({ type, gameId, to: [], admins: true, data });
const allPlayers = async (db, gameId) => (await db.query('SELECT id FROM players WHERE game_id = $1 ORDER BY id', [gameId])).map((p) => p.id);

// ---------- Fonctions pures (tirage, validation) ----------

export function shuffle(array) {
  const a = [...array];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Distribue des défis en évitant les doublons tant que la liste le permet.
export function pickChallenges(challengeTexts, count) {
  if (challengeTexts.length === 0) return Array(count).fill('');
  const out = [];
  let pool = [];
  while (out.length < count) {
    if (pool.length === 0) pool = shuffle(challengeTexts);
    out.push(pool.pop());
  }
  return out;
}

// Construit une boucle aléatoire unique : chaque joueur chasse le suivant, le dernier chasse le premier.
export function buildRandomPlan(playerIds, challengeTexts) {
  const order = shuffle(playerIds);
  return planFromOrder(order, pickChallenges(challengeTexts, order.length));
}

export function planFromOrder(order, challengeTexts) {
  return order.map((killerId, i) => ({
    killer_id: killerId,
    target_id: order[(i + 1) % order.length],
    challenge_text: challengeTexts[i] || '',
  }));
}

// Vérifie qu'un plan forme UNE seule boucle passant par tous les joueurs.
export function validatePlan(plan, playerIds) {
  const errors = [];
  const ids = new Set(playerIds);
  if (!Array.isArray(plan) || plan.length !== ids.size) {
    errors.push(`Le plan doit contenir exactement ${ids.size} lignes (une par joueur).`);
    return errors;
  }
  const killers = new Map();
  const targets = new Set();
  for (const row of plan) {
    if (!ids.has(row.killer_id) || !ids.has(row.target_id)) {
      errors.push('Le plan référence un joueur inconnu.');
      return errors;
    }
    if (row.killer_id === row.target_id) errors.push('Un joueur ne peut pas être sa propre cible.');
    if (killers.has(row.killer_id)) errors.push('Un joueur apparaît deux fois comme tueur.');
    if (targets.has(row.target_id)) errors.push('Un joueur est la cible de deux tueurs.');
    if (!String(row.challenge_text || '').trim()) errors.push('Chaque ligne doit avoir un défi.');
    killers.set(row.killer_id, row.target_id);
    targets.add(row.target_id);
  }
  if (errors.length) return [...new Set(errors)];
  // Parcours de la boucle depuis le premier joueur : on doit revenir au départ après N pas.
  const start = plan[0].killer_id;
  let current = start;
  let steps = 0;
  do {
    current = killers.get(current);
    steps++;
  } while (current !== start && steps <= ids.size);
  if (steps !== ids.size) {
    errors.push('Les cibles forment plusieurs petites boucles : il faut une seule boucle qui passe par tout le monde.');
  }
  return errors;
}

// ---------- Accès aux données ----------

export async function getGame(db, gameId, { lock = false } = {}) {
  const game = await db.one(`SELECT * FROM games WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [gameId]);
  if (!game) throw new GameError('Partie introuvable.', 404);
  return game;
}

export function getPlan(game) {
  try {
    return game.plan_json ? JSON.parse(game.plan_json) : null;
  } catch {
    return null;
  }
}

export async function savePlan(db, gameId, plan) {
  const game = await getGame(db, gameId);
  if (game.status !== 'draft') throw new GameError('La partie est déjà lancée : modifiez les contrats depuis le suivi.');
  const clean = plan.map((r) => ({
    killer_id: Number(r.killer_id),
    target_id: Number(r.target_id),
    challenge_text: String(r.challenge_text || '').trim(),
    ...(r.reason ? { reason: String(r.reason) } : {}),
  }));
  await db.query('UPDATE games SET plan_json = $1 WHERE id = $2', [JSON.stringify(clean), gameId]);
  return clean;
}

export function launchGame(db, gameId) {
  return db.tx(async (t) => {
    const game = await getGame(t, gameId, { lock: true });
    if (game.status !== 'draft') throw new GameError('Cette partie a déjà été lancée.');
    const ids = await allPlayers(t, gameId);
    if (ids.length < 3) throw new GameError('Il faut au moins 3 joueurs pour lancer une partie.');
    const plan = getPlan(game);
    if (!plan) throw new GameError("Générez d'abord l'attribution des cibles.");
    const errors = validatePlan(plan, ids);
    if (errors.length) throw new GameError(errors.join(' '));
    const now = nowIso();
    for (const row of plan) {
      await t.query('INSERT INTO contracts (game_id, killer_id, target_id, challenge_text, created_at) VALUES ($1, $2, $3, $4, $5)', [
        gameId,
        row.killer_id,
        row.target_id,
        row.challenge_text,
        now,
      ]);
    }
    await t.query("UPDATE players SET status = 'alive', eliminated_at = NULL, eliminated_by = NULL WHERE game_id = $1", [gameId]);
    await t.query("UPDATE games SET status = 'running', started_at = $1 WHERE id = $2", [now, gameId]);
    return { events: [event('game_started', gameId, ids)] };
  });
}

async function requireRunning(db, gameId) {
  const game = await getGame(db, gameId, { lock: true });
  if (game.status !== 'running') throw new GameError("La partie n'est pas en cours.");
  return game;
}

const openContractOf = (db, killerId) => db.one(`SELECT * FROM contracts WHERE killer_id = $1 AND status IN ${OPEN}`, [killerId]);
const openContractOn = (db, targetId) => db.one(`SELECT * FROM contracts WHERE target_id = $1 AND status IN ${OPEN}`, [targetId]);
const playerById = (db, id) => db.one('SELECT * FROM players WHERE id = $1', [id]);
const contractById = (db, id) => db.one('SELECT * FROM contracts WHERE id = $1', [id]);

async function closeGame(db, gameId, winnerId) {
  const now = nowIso();
  await db.query(`UPDATE contracts SET status = 'void', closed_at = $1 WHERE game_id = $2 AND status IN ${OPEN}`, [now, gameId]);
  await db.query("UPDATE games SET status = 'finished', finished_at = $1, winner_id = $2 WHERE id = $3", [now, winnerId, gameId]);
  const events = [event('game_finished', gameId, await allPlayers(db, gameId), { winnerId })];
  // Victoire automatique (dernier survivant) : l'organisateur est prévenu. S'il arrête lui-même la partie, inutile.
  if (winnerId) events.push(adminEvent('admin_game_finished', gameId, { winnerId }));
  return { events };
}

// Fin de partie décidée par l'organisateur.
export function finishGame(db, gameId) {
  return db.tx(async (t) => {
    await requireRunning(t, gameId);
    return closeGame(t, gameId, null);
  });
}

// Retire un joueur de la boucle : son chasseur hérite de sa cible et de son défi.
async function removeFromChain(db, gameId, victimId, { killerId = null, how, confirmedBy = 'elimination' }) {
  const now = nowIso();
  const inbound = await openContractOn(db, victimId);
  const outbound = await openContractOf(db, victimId);
  await db.query("UPDATE players SET status = 'dead', eliminated_at = $1, eliminated_by = $2 WHERE id = $3", [now, killerId, victimId]);
  if (inbound) {
    await db.query('UPDATE contracts SET status = $1, closed_at = $2 WHERE id = $3', [how === 'kill' ? 'done' : 'void', now, inbound.id]);
  }
  if (outbound) await db.query("UPDATE contracts SET status = 'void', closed_at = $1 WHERE id = $2", [now, outbound.id]);
  await db.query(
    'INSERT INTO kills (game_id, killer_id, victim_id, challenge_text, contract_started_at, confirmed_by, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)',
    [gameId, killerId, victimId, inbound?.challenge_text ?? null, inbound?.created_at ?? null, confirmedBy, now],
  );

  const events = [event(how === 'kill' ? 'you_were_killed' : 'you_were_removed', gameId, victimId)];
  // Kill confirmé par la victime : l'organisateur ne l'a pas vu passer, on le prévient.
  if (confirmedBy === 'target') events.push(adminEvent('admin_kill_confirmed', gameId, { killerId, victimId }));
  if (!inbound || !outbound) return { finished: false, events };
  const hunter = inbound.killer_id;
  const next = outbound.target_id;
  if (next === hunter) {
    const finished = await closeGame(db, gameId, hunter);
    return { finished: true, winnerId: hunter, events: [...events, ...finished.events] };
  }
  await db.query('INSERT INTO contracts (game_id, killer_id, target_id, challenge_text, created_at) VALUES ($1, $2, $3, $4, $5)', [
    gameId,
    hunter,
    next,
    outbound.challenge_text,
    now,
  ]);
  events.push(event(how === 'kill' ? 'kill_confirmed' : 'target_removed', gameId, hunter));
  return { finished: false, events };
}

// Le tueur déclare avoir réalisé son défi : le kill passe "en attente" de confirmation par la cible.
export function declareKill(db, playerId) {
  return db.tx(async (t) => {
    const player = await playerById(t, playerId);
    await requireRunning(t, player.game_id);
    if (player.status !== 'alive') throw new GameError('Vous êtes éliminé.');
    const contract = await openContractOf(t, playerId);
    if (!contract) throw new GameError("Vous n'avez pas de cible actuellement.");
    if (contract.status === 'pending') throw new GameError('Kill déjà déclaré, en attente de confirmation.');
    await t.query("UPDATE contracts SET status = 'pending', declared_at = $1, reminded_at = NULL WHERE id = $2", [nowIso(), contract.id]);
    return {
      events: [
        event('kill_declared', player.game_id, contract.target_id),
        adminEvent('admin_kill_declared', player.game_id, { killerId: playerId, victimId: contract.target_id }),
      ],
    };
  });
}

export async function cancelDeclaration(db, playerId) {
  const contract = await openContractOf(db, playerId);
  if (!contract || contract.status !== 'pending') throw new GameError('Aucun kill en attente à annuler.');
  await db.query("UPDATE contracts SET status = 'active', declared_at = NULL WHERE id = $1", [contract.id]);
}

// Validation d'un kill (par la victime elle-même ou par l'admin).
export function confirmKill(db, contractId, by) {
  return db.tx(async (t) => {
    const found = await contractById(t, contractId);
    if (!found) throw new GameError('Contrat introuvable.', 404);
    await requireRunning(t, found.game_id);
    const contract = await contractById(t, contractId); // relu après verrouillage de la partie
    if (by === 'target' && contract.status !== 'pending') throw new GameError("Ce kill n'est plus en attente.");
    if (!['active', 'pending'].includes(contract.status)) throw new GameError('Ce contrat est déjà clos.');
    return removeFromChain(t, contract.game_id, contract.target_id, { killerId: contract.killer_id, how: 'kill', confirmedBy: by });
  });
}

// La victime (ou l'admin) conteste : le contrat redevient actif.
export async function contestKill(db, contractId, by = 'target') {
  const contract = await contractById(db, contractId);
  if (!contract || contract.status !== 'pending') throw new GameError("Ce kill n'est plus en attente.");
  await db.query("UPDATE contracts SET status = 'active', declared_at = NULL, contested = contested + 1 WHERE id = $1", [contractId]);
  const events = [event(by === 'admin' ? 'kill_rejected' : 'kill_contested', contract.game_id, contract.killer_id)];
  // Contestation par la cible : c'est à l'organisateur de trancher.
  if (by !== 'admin') events.push(adminEvent('admin_kill_contested', contract.game_id, { killerId: contract.killer_id, victimId: contract.target_id }));
  return { events };
}

// Élimination administrative (abandon, triche...) : le chasseur hérite de la cible du joueur retiré.
export function eliminatePlayer(db, playerId) {
  return db.tx(async (t) => {
    const found = await playerById(t, playerId);
    if (!found) throw new GameError('Joueur introuvable.', 404);
    await requireRunning(t, found.game_id);
    const player = await playerById(t, playerId);
    if (player.status !== 'alive') throw new GameError('Ce joueur est déjà éliminé.');
    return removeFromChain(t, player.game_id, playerId, { how: 'elimination' });
  });
}

export async function updateContractChallenge(db, contractId, text) {
  const clean = String(text || '').trim();
  if (!clean) throw new GameError('Le défi ne peut pas être vide.');
  const contract = await db.one(`SELECT * FROM contracts WHERE id = $1 AND status IN ${OPEN}`, [contractId]);
  if (!contract) throw new GameError('Contrat introuvable ou déjà clos.');
  if (contract.challenge_text === clean) return { events: [] };
  await db.query('UPDATE contracts SET challenge_text = $1 WHERE id = $2', [clean, contractId]);
  return { events: [event('challenge_changed', contract.game_id, contract.killer_id)] };
}

// Rappel pour les kills déclarés depuis trop longtemps sans réponse (appelé régulièrement).
// Chaque kill en attente ne donne lieu qu'à un seul rappel.
export async function pendingKillReminders(db, { olderThanMs = 2 * 3600_000 } = {}) {
  const limit = new Date(Date.now() - olderThanMs).toISOString();
  const due = await db.query(
    `UPDATE contracts c SET reminded_at = $1
     FROM games g
     WHERE g.id = c.game_id AND g.status = 'running' AND c.status = 'pending'
       AND c.reminded_at IS NULL AND c.declared_at < $2
     RETURNING c.*`,
    [nowIso(), limit],
  );
  const events = [];
  for (const c of due) {
    events.push(event('kill_declared_reminder', c.game_id, c.target_id));
    events.push(adminEvent('admin_kill_pending', c.game_id, { killerId: c.killer_id, victimId: c.target_id, since: c.declared_at }));
  }
  return { events };
}

// ---------- Vues ----------

function durationMs(from, to) {
  return from && to ? new Date(to) - new Date(from) : null;
}

// Ce que voit un joueur : uniquement SA cible, SON défi, SES stats.
// Aucune information permettant de déduire le nombre de joueurs restants.
export async function playerView(db, playerId) {
  const me = await playerById(db, playerId);
  if (!me) throw new GameError('Joueur introuvable.', 404);
  const game = await getGame(db, me.game_id);
  const name = async (id) => (await db.one('SELECT name FROM players WHERE id = $1', [id]))?.name ?? '?';

  const myKills = [];
  for (const k of await db.query('SELECT * FROM kills WHERE killer_id = $1 ORDER BY created_at', [playerId])) {
    myKills.push({
      victim: await name(k.victim_id),
      challenge: k.challenge_text,
      at: k.created_at,
      duration_ms: durationMs(k.contract_started_at, k.created_at),
    });
  }
  const durations = myKills.map((k) => k.duration_ms).filter((d) => d != null);

  const view = {
    me: { name: me.name, status: me.status, eliminated_at: me.eliminated_at },
    game: { name: game.name, status: game.status, started_at: game.started_at, ends_at: game.ends_at, finished_at: game.finished_at },
    target: null,
    incoming: null,
    death: null,
    stats: {
      kills: myKills.length,
      fastest_kill_ms: durations.length ? Math.min(...durations) : null,
      average_kill_ms: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null,
      last_game_kill_at: (await db.one('SELECT MAX(created_at) AS t FROM kills WHERE game_id = $1', [game.id])).t,
    },
    kills: myKills,
    final: null,
  };

  if (game.status === 'running' && me.status === 'alive') {
    const contract = await openContractOf(db, playerId);
    if (contract) {
      view.target = {
        name: await name(contract.target_id),
        challenge: contract.challenge_text,
        since: contract.created_at,
        pending: contract.status === 'pending',
      };
    }
    const incoming = await db.one("SELECT * FROM contracts WHERE target_id = $1 AND status = 'pending'", [playerId]);
    if (incoming) view.incoming = { contract_id: incoming.id, killer: await name(incoming.killer_id), challenge: incoming.challenge_text };
  }

  if (me.status === 'dead') {
    const k = await db.one('SELECT * FROM kills WHERE victim_id = $1 ORDER BY id DESC LIMIT 1', [playerId]);
    view.death = {
      at: me.eliminated_at,
      by: k?.killer_id ? await name(k.killer_id) : null,
      challenge: k?.killer_id ? k.challenge_text : null,
    };
  }

  // Une fois la partie terminée, on révèle tout : vainqueur et classement.
  if (game.status === 'finished') view.final = await finalRanking(db, game);
  return view;
}

export async function finalRanking(db, game) {
  const rows = await db.query(
    `SELECT p.id, p.name, p.status, p.eliminated_at,
            (SELECT COUNT(*)::int FROM kills k WHERE k.killer_id = p.id) AS kills
     FROM players p WHERE p.game_id = $1`,
    [game.id],
  );
  rows.sort((a, b) => {
    if (a.id === game.winner_id) return -1;
    if (b.id === game.winner_id) return 1;
    if (a.status !== b.status) return a.status === 'alive' ? -1 : 1;
    return (b.eliminated_at || '').localeCompare(a.eliminated_at || '') || b.kills - a.kills;
  });
  const winner = rows.find((r) => r.id === game.winner_id);
  return {
    winner: winner?.name ?? null,
    ranking: rows.map((r) => ({ name: r.name, kills: r.kills, status: r.status })),
  };
}

// Vue complète pour l'admin.
export async function adminGameState(db, gameId) {
  const game = await getGame(db, gameId);
  const players = await db.query('SELECT * FROM players WHERE game_id = $1 ORDER BY lower(name), id', [gameId]);
  const challenges = await db.query('SELECT * FROM challenges WHERE game_id = $1 ORDER BY id', [gameId]);
  const contracts = await db.query(`SELECT * FROM contracts WHERE game_id = $1 AND status IN ${OPEN} ORDER BY id`, [gameId]);
  const kills = await db.query('SELECT * FROM kills WHERE game_id = $1 ORDER BY created_at DESC, id DESC', [gameId]);
  const killCount = new Map();
  for (const k of kills) if (k.killer_id) killCount.set(k.killer_id, (killCount.get(k.killer_id) || 0) + 1);
  const { plan_json, ...gameFields } = game;
  return {
    game: gameFields,
    plan: getPlan(game),
    players: players.map((p) => ({ ...p, kills: killCount.get(p.id) || 0 })),
    challenges,
    contracts,
    kills,
    alive: players.filter((p) => p.status === 'alive').length,
  };
}
