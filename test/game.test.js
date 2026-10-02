import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import {
  buildRandomPlan,
  validatePlan,
  savePlan,
  launchGame,
  declareKill,
  confirmKill,
  contestKill,
  eliminatePlayer,
  playerView,
  adminGameState,
} from '../src/game.js';

function setup(n = 4) {
  const db = openDb(':memory:');
  const gameId = Number(db.prepare("INSERT INTO games (name) VALUES ('Test')").run().lastInsertRowid);
  const ids = [];
  for (let i = 0; i < n; i++) {
    ids.push(Number(db.prepare('INSERT INTO players (game_id, name, code) VALUES (?, ?, ?)').run(gameId, `P${i}`, `CODE${i}`).lastInsertRowid));
  }
  return { db, gameId, ids };
}

// Plan déterministe : P0 → P1 → P2 → ... → P0
function chainPlan(ids) {
  return ids.map((id, i) => ({ killer_id: id, target_id: ids[(i + 1) % ids.length], challenge_text: `défi ${i}` }));
}

const openContract = (db, killerId) =>
  db.prepare("SELECT * FROM contracts WHERE killer_id = ? AND status IN ('active','pending')").get(killerId);

test('le tirage aléatoire forme toujours une boucle unique valide', () => {
  for (let n = 2; n < 30; n++) {
    const ids = Array.from({ length: n }, (_, i) => i + 1);
    const plan = buildRandomPlan(ids, ['a', 'b', 'c']);
    assert.deepEqual(validatePlan(plan, ids), []);
  }
});

test('validatePlan détecte les sous-boucles et les erreurs', () => {
  const ids = [1, 2, 3, 4];
  const twoLoops = [
    { killer_id: 1, target_id: 2, challenge_text: 'x' },
    { killer_id: 2, target_id: 1, challenge_text: 'x' },
    { killer_id: 3, target_id: 4, challenge_text: 'x' },
    { killer_id: 4, target_id: 3, challenge_text: 'x' },
  ];
  assert.match(validatePlan(twoLoops, ids).join(' '), /plusieurs petites boucles/);
  assert.match(validatePlan([{ killer_id: 1, target_id: 1, challenge_text: 'x' }], [1]).join(' '), /propre cible/);
  assert.match(validatePlan(chainPlan(ids).slice(0, 3), ids).join(' '), /exactement 4/);
  const noChallenge = chainPlan(ids);
  noChallenge[0].challenge_text = ' ';
  assert.match(validatePlan(noChallenge, ids).join(' '), /défi/);
});

test('un kill confirmé transmet la cible et le défi de la victime', () => {
  const { db, gameId, ids } = setup(4);
  savePlan(db, gameId, chainPlan(ids));
  launchGame(db, gameId);

  declareKill(db, ids[0]);
  const c = openContract(db, ids[0]);
  assert.equal(c.status, 'pending');
  confirmKill(db, c.id, 'target');

  const next = openContract(db, ids[0]);
  assert.equal(next.target_id, ids[2]);
  assert.equal(next.challenge_text, 'défi 1'); // défi hérité de P1
  assert.equal(db.prepare('SELECT status FROM players WHERE id = ?').get(ids[1]).status, 'dead');
});

test('le dernier survivant gagne et la partie se termine', () => {
  const { db, gameId, ids } = setup(3);
  savePlan(db, gameId, chainPlan(ids));
  launchGame(db, gameId);
  confirmKill(db, openContract(db, ids[0]).id, 'admin'); // P0 tue P1, chasse P2
  const result = confirmKill(db, openContract(db, ids[0]).id, 'admin'); // P0 tue P2
  assert.equal(result.finished, true);
  assert.equal(result.winnerId, ids[0]);
  const game = db.prepare('SELECT * FROM games WHERE id = ?').get(gameId);
  assert.equal(game.status, 'finished');
  assert.equal(game.winner_id, ids[0]);
  const view = playerView(db, ids[2]);
  assert.equal(view.final.winner, 'P0');
  assert.equal(view.final.ranking[0].name, 'P0');
});

test('une contestation remet le contrat en jeu', () => {
  const { db, gameId, ids } = setup(3);
  savePlan(db, gameId, chainPlan(ids));
  launchGame(db, gameId);
  declareKill(db, ids[0]);
  const c = openContract(db, ids[0]);
  contestKill(db, c.id);
  const after = openContract(db, ids[0]);
  assert.equal(after.status, 'active');
  assert.equal(after.contested, 1);
  assert.throws(() => confirmKill(db, c.id, 'target'), /plus en attente/);
});

test("l'élimination par l'admin raccorde la boucle", () => {
  const { db, gameId, ids } = setup(4);
  savePlan(db, gameId, chainPlan(ids));
  launchGame(db, gameId);
  eliminatePlayer(db, ids[2]); // P1 chassait P2 → P1 chasse désormais P3 avec le défi de P2
  const c = openContract(db, ids[1]);
  assert.equal(c.target_id, ids[3]);
  assert.equal(c.challenge_text, 'défi 2');
  const state = adminGameState(db, gameId);
  assert.equal(state.alive, 3);
  assert.equal(state.contracts.length, 3);
});

test('la vue joueur ne révèle que sa propre cible, jamais le nombre de joueurs', () => {
  const { db, gameId, ids } = setup(5);
  savePlan(db, gameId, chainPlan(ids));
  launchGame(db, gameId);
  const view = playerView(db, ids[0]);
  assert.equal(view.target.name, 'P1');
  assert.equal(view.target.challenge, 'défi 0');
  const json = JSON.stringify(view);
  for (const other of ['P2', 'P3', 'P4', 'CODE']) assert.ok(!json.includes(other), `fuite de ${other}`);
  assert.ok(!('alive' in view.stats) && !('players' in view.game));
});

test('la cible voit la déclaration de kill la concernant', () => {
  const { db, gameId, ids } = setup(3);
  savePlan(db, gameId, chainPlan(ids));
  launchGame(db, gameId);
  declareKill(db, ids[0]);
  const victimView = playerView(db, ids[1]);
  assert.equal(victimView.incoming.killer, 'P0');
  assert.equal(playerView(db, ids[0]).target.pending, true);
});
