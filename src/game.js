// Logique du jeu : attribution circulaire des cibles, déclaration/validation des kills, statistiques.
import { tx, nowIso } from './db.js';

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
const allPlayers = (db, gameId) => db.prepare('SELECT id FROM players WHERE game_id = ?').all(gameId).map((p) => p.id);

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
    errors.push("Les cibles forment plusieurs petites boucles : il faut une seule boucle qui passe par tout le monde.");
  }
  return errors;
}

export function getGame(db, gameId) {
  const game = db.prepare('SELECT * FROM games WHERE id = ?').get(gameId);
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

export function savePlan(db, gameId, plan) {
  const game = getGame(db, gameId);
  if (game.status !== 'draft') throw new GameError('La partie est déjà lancée : modifiez les contrats depuis le suivi.');
  const clean = plan.map((r) => ({
    killer_id: Number(r.killer_id),
    target_id: Number(r.target_id),
    challenge_text: String(r.challenge_text || '').trim(),
    ...(r.reason ? { reason: String(r.reason) } : {}),
  }));
  db.prepare('UPDATE games SET plan_json = ? WHERE id = ?').run(JSON.stringify(clean), gameId);
  return clean;
}

export function launchGame(db, gameId) {
  return tx(db, () => {
    const game = getGame(db, gameId);
    if (game.status !== 'draft') throw new GameError('Cette partie a déjà été lancée.');
    const players = db.prepare('SELECT id FROM players WHERE game_id = ?').all(gameId);
    if (players.length < 3) throw new GameError('Il faut au moins 3 joueurs pour lancer une partie.');
    const plan = getPlan(game);
    if (!plan) throw new GameError("Générez d'abord l'attribution des cibles.");
    const errors = validatePlan(plan, players.map((p) => p.id));
    if (errors.length) throw new GameError(errors.join(' '));
    const now = nowIso();
    const insert = db.prepare(
      'INSERT INTO contracts (game_id, killer_id, target_id, challenge_text, created_at) VALUES (?, ?, ?, ?, ?)',
    );
    for (const row of plan) insert.run(gameId, row.killer_id, row.target_id, row.challenge_text, now);
    db.prepare("UPDATE players SET status = 'alive', eliminated_at = NULL, eliminated_by = NULL WHERE game_id = ?").run(gameId);
    db.prepare("UPDATE games SET status = 'running', started_at = ? WHERE id = ?").run(now, gameId);
    return { events: [event('game_started', gameId, players.map((p) => p.id))] };
  });
}

function requireRunning(db, gameId) {
  const game = getGame(db, gameId);
  if (game.status !== 'running') throw new GameError("La partie n'est pas en cours.");
  return game;
}

function openContractOf(db, killerId) {
  return db.prepare(`SELECT * FROM contracts WHERE killer_id = ? AND status IN ${OPEN}`).get(killerId);
}

function openContractOn(db, targetId) {
  return db.prepare(`SELECT * FROM contracts WHERE target_id = ? AND status IN ${OPEN}`).get(targetId);
}

export function finishGame(db, gameId, winnerId = null) {
  const now = nowIso();
  db.prepare(`UPDATE contracts SET status = 'void', closed_at = ? WHERE game_id = ? AND status IN ${OPEN}`).run(now, gameId);
  db.prepare("UPDATE games SET status = 'finished', finished_at = ?, winner_id = ? WHERE id = ?").run(now, winnerId, gameId);
  return { events: [event('game_finished', gameId, allPlayers(db, gameId), { winnerId })] };
}

// Retire un joueur de la boucle : son chasseur hérite de sa cible et de son défi.
function removeFromChain(db, gameId, victimId, { killerId = null, how, confirmedBy = 'elimination' }) {
  const now = nowIso();
  const inbound = openContractOn(db, victimId);
  const outbound = openContractOf(db, victimId);
  db.prepare("UPDATE players SET status = 'dead', eliminated_at = ?, eliminated_by = ? WHERE id = ?").run(now, killerId, victimId);
  if (inbound) {
    db.prepare('UPDATE contracts SET status = ?, closed_at = ? WHERE id = ?').run(how === 'kill' ? 'done' : 'void', now, inbound.id);
  }
  if (outbound) db.prepare("UPDATE contracts SET status = 'void', closed_at = ? WHERE id = ?").run(now, outbound.id);
  db.prepare(
    'INSERT INTO kills (game_id, killer_id, victim_id, challenge_text, contract_started_at, confirmed_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(gameId, killerId, victimId, inbound?.challenge_text ?? null, inbound?.created_at ?? null, confirmedBy, now);

  const events = [event(how === 'kill' ? 'you_were_killed' : 'you_were_removed', gameId, victimId)];
  if (!inbound || !outbound) return { finished: false, events };
  const hunter = inbound.killer_id;
  const next = outbound.target_id;
  if (next === hunter) {
    const finished = finishGame(db, gameId, hunter);
    return { finished: true, winnerId: hunter, events: [...events, ...finished.events] };
  }
  db.prepare('INSERT INTO contracts (game_id, killer_id, target_id, challenge_text, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(gameId, hunter, next, outbound.challenge_text, now);
  events.push(event(how === 'kill' ? 'kill_confirmed' : 'target_removed', gameId, hunter));
  return { finished: false, events };
}

// Le tueur déclare avoir réalisé son défi : le kill passe "en attente" de confirmation par la cible.
export function declareKill(db, playerId) {
  return tx(db, () => {
    const player = db.prepare('SELECT * FROM players WHERE id = ?').get(playerId);
    requireRunning(db, player.game_id);
    if (player.status !== 'alive') throw new GameError('Vous êtes éliminé.');
    const contract = openContractOf(db, playerId);
    if (!contract) throw new GameError("Vous n'avez pas de cible actuellement.");
    if (contract.status === 'pending') throw new GameError('Kill déjà déclaré, en attente de confirmation.');
    db.prepare("UPDATE contracts SET status = 'pending', declared_at = ? WHERE id = ?").run(nowIso(), contract.id);
    return { events: [event('kill_declared', player.game_id, contract.target_id)] };
  });
}

export function cancelDeclaration(db, playerId) {
  const contract = openContractOf(db, playerId);
  if (!contract || contract.status !== 'pending') throw new GameError('Aucun kill en attente à annuler.');
  db.prepare("UPDATE contracts SET status = 'active', declared_at = NULL WHERE id = ?").run(contract.id);
}

// Validation d'un kill (par la victime elle-même ou par l'admin).
export function confirmKill(db, contractId, by) {
  return tx(db, () => {
    const contract = db.prepare('SELECT * FROM contracts WHERE id = ?').get(contractId);
    if (!contract) throw new GameError('Contrat introuvable.', 404);
    requireRunning(db, contract.game_id);
    if (by === 'target' && contract.status !== 'pending') throw new GameError("Ce kill n'est plus en attente.");
    if (!['active', 'pending'].includes(contract.status)) throw new GameError('Ce contrat est déjà clos.');
    return removeFromChain(db, contract.game_id, contract.target_id, {
      killerId: contract.killer_id,
      how: 'kill',
      confirmedBy: by,
    });
  });
}

// La victime (ou l'admin) conteste : le contrat redevient actif.
export function contestKill(db, contractId, by = 'target') {
  const contract = db.prepare('SELECT * FROM contracts WHERE id = ?').get(contractId);
  if (!contract || contract.status !== 'pending') throw new GameError("Ce kill n'est plus en attente.");
  db.prepare("UPDATE contracts SET status = 'active', declared_at = NULL, contested = contested + 1 WHERE id = ?").run(contractId);
  return { events: [event(by === 'admin' ? 'kill_rejected' : 'kill_contested', contract.game_id, contract.killer_id)] };
}

// Élimination administrative (abandon, triche...) : le chasseur hérite de la cible du joueur retiré.
export function eliminatePlayer(db, playerId) {
  return tx(db, () => {
    const player = db.prepare('SELECT * FROM players WHERE id = ?').get(playerId);
    if (!player) throw new GameError('Joueur introuvable.', 404);
    requireRunning(db, player.game_id);
    if (player.status !== 'alive') throw new GameError('Ce joueur est déjà éliminé.');
    return removeFromChain(db, player.game_id, playerId, { how: 'elimination' });
  });
}

export function updateContractChallenge(db, contractId, text) {
  const clean = String(text || '').trim();
  if (!clean) throw new GameError('Le défi ne peut pas être vide.');
  const contract = db.prepare(`SELECT * FROM contracts WHERE id = ? AND status IN ${OPEN}`).get(contractId);
  if (!contract) throw new GameError('Contrat introuvable ou déjà clos.');
  if (contract.challenge_text === clean) return { events: [] };
  db.prepare('UPDATE contracts SET challenge_text = ? WHERE id = ?').run(clean, contractId);
  return { events: [event('challenge_changed', contract.game_id, contract.killer_id)] };
}

// ---------- Vues ----------

function durationMs(from, to) {
  return from && to ? new Date(to) - new Date(from) : null;
}

// Ce que voit un joueur : uniquement SA cible, SON défi, SES stats.
// Aucune information permettant de déduire le nombre de joueurs restants.
export function playerView(db, playerId) {
  const me = db.prepare('SELECT * FROM players WHERE id = ?').get(playerId);
  if (!me) throw new GameError('Joueur introuvable.', 404);
  const game = getGame(db, me.game_id);
  const name = (id) => db.prepare('SELECT name FROM players WHERE id = ?').get(id)?.name ?? '?';

  const myKills = db
    .prepare('SELECT * FROM kills WHERE killer_id = ? ORDER BY created_at')
    .all(playerId)
    .map((k) => ({
      victim: name(k.victim_id),
      challenge: k.challenge_text,
      at: k.created_at,
      duration_ms: durationMs(k.contract_started_at, k.created_at),
    }));
  const durations = myKills.map((k) => k.duration_ms).filter((d) => d != null);

  const view = {
    me: { name: me.name, status: me.status, eliminated_at: me.eliminated_at },
    game: {
      name: game.name,
      status: game.status,
      started_at: game.started_at,
      ends_at: game.ends_at,
      finished_at: game.finished_at,
    },
    target: null,
    incoming: null,
    death: null,
    stats: {
      kills: myKills.length,
      fastest_kill_ms: durations.length ? Math.min(...durations) : null,
      average_kill_ms: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null,
      last_game_kill_at: db.prepare('SELECT MAX(created_at) AS t FROM kills WHERE game_id = ?').get(game.id).t,
    },
    kills: myKills,
    final: null,
  };

  if (game.status === 'running' && me.status === 'alive') {
    const contract = openContractOf(db, playerId);
    if (contract) {
      view.target = {
        name: name(contract.target_id),
        challenge: contract.challenge_text,
        since: contract.created_at,
        pending: contract.status === 'pending',
      };
    }
    const incoming = db.prepare("SELECT * FROM contracts WHERE target_id = ? AND status = 'pending'").get(playerId);
    if (incoming) view.incoming = { contract_id: incoming.id, killer: name(incoming.killer_id), challenge: incoming.challenge_text };
  }

  if (me.status === 'dead') {
    const k = db.prepare('SELECT * FROM kills WHERE victim_id = ? ORDER BY id DESC LIMIT 1').get(playerId);
    view.death = {
      at: me.eliminated_at,
      by: k?.killer_id ? name(k.killer_id) : null,
      challenge: k?.killer_id ? k.challenge_text : null,
    };
  }

  // Une fois la partie terminée, on révèle tout : vainqueur et classement.
  if (game.status === 'finished') view.final = finalRanking(db, game);
  return view;
}

export function finalRanking(db, game) {
  const rows = db
    .prepare(
      `SELECT p.id, p.name, p.status, p.eliminated_at,
              (SELECT COUNT(*) FROM kills k WHERE k.killer_id = p.id) AS kills
       FROM players p WHERE p.game_id = ?`,
    )
    .all(game.id);
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
export function adminGameState(db, gameId) {
  const game = getGame(db, gameId);
  const players = db.prepare('SELECT * FROM players WHERE game_id = ? ORDER BY name COLLATE NOCASE').all(gameId);
  const challenges = db.prepare('SELECT * FROM challenges WHERE game_id = ? ORDER BY id').all(gameId);
  const contracts = db
    .prepare(`SELECT * FROM contracts WHERE game_id = ? AND status IN ${OPEN} ORDER BY id`)
    .all(gameId);
  const kills = db.prepare('SELECT * FROM kills WHERE game_id = ? ORDER BY created_at DESC').all(gameId);
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
