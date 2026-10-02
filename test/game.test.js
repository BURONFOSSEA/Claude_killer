import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newDb, setupGame, openContract } from './helpers.js';
import {
  buildRandomPlan,
  validatePlan,
  launchGame,
  declareKill,
  confirmKill,
  contestKill,
  eliminatePlayer,
  playerView,
  adminGameState,
} from '../supabase/functions/_shared/game.js';

const db = await newDb();

test('le tirage aléatoire forme toujours une boucle unique valide', () => {
  for (let n = 2; n < 30; n++) {
    const ids = Array.from({ length: n }, (_, i) => i + 1);
    assert.deepEqual(validatePlan(buildRandomPlan(ids, ['a', 'b', 'c']), ids), []);
  }
});

test('validatePlan détecte les sous-boucles et les erreurs', () => {
  const ids = [1, 2, 3, 4];
  const chain = ids.map((id, i) => ({ killer_id: id, target_id: ids[(i + 1) % 4], challenge_text: 'x' }));
  const twoLoops = [
    { killer_id: 1, target_id: 2, challenge_text: 'x' },
    { killer_id: 2, target_id: 1, challenge_text: 'x' },
    { killer_id: 3, target_id: 4, challenge_text: 'x' },
    { killer_id: 4, target_id: 3, challenge_text: 'x' },
  ];
  assert.match(validatePlan(twoLoops, ids).join(' '), /plusieurs petites boucles/);
  assert.match(validatePlan([{ killer_id: 1, target_id: 1, challenge_text: 'x' }], [1]).join(' '), /propre cible/);
  assert.match(validatePlan(chain.slice(0, 3), ids).join(' '), /exactement 4/);
  assert.match(validatePlan(chain.map((r, i) => ({ ...r, challenge_text: i ? 'x' : ' ' })), ids).join(' '), /défi/);
});

test('un kill confirmé transmet la cible et le défi de la victime', async () => {
  const { gameId, ids } = await setupGame(db, 4);
  await launchGame(db, gameId);
  await declareKill(db, ids[0]);
  const c = await openContract(db, ids[0]);
  assert.equal(c.status, 'pending');
  await confirmKill(db, c.id, 'target');
  const next = await openContract(db, ids[0]);
  assert.equal(next.target_id, ids[2]);
  assert.equal(next.challenge_text, 'défi 1');
  assert.equal((await db.one('SELECT status FROM players WHERE id = $1', [ids[1]])).status, 'dead');
});

test('le dernier survivant gagne et la partie se termine', async () => {
  const { gameId, ids } = await setupGame(db, 3);
  await launchGame(db, gameId);
  await confirmKill(db, (await openContract(db, ids[0])).id, 'admin');
  const result = await confirmKill(db, (await openContract(db, ids[0])).id, 'admin');
  assert.equal(result.finished, true);
  assert.equal(result.winnerId, ids[0]);
  const game = await db.one('SELECT * FROM games WHERE id = $1', [gameId]);
  assert.equal(game.status, 'finished');
  const view = await playerView(db, ids[2]);
  assert.equal(view.final.winner, 'P0');
  assert.equal(view.final.ranking[0].name, 'P0');
});

test('une contestation remet le contrat en jeu', async () => {
  const { gameId, ids } = await setupGame(db, 3);
  await launchGame(db, gameId);
  await declareKill(db, ids[0]);
  const c = await openContract(db, ids[0]);
  await contestKill(db, c.id);
  const after = await openContract(db, ids[0]);
  assert.equal(after.status, 'active');
  assert.equal(after.contested, 1);
  await assert.rejects(confirmKill(db, c.id, 'target'), /plus en attente/);
});

test("l'élimination par l'admin raccorde la boucle", async () => {
  const { gameId, ids } = await setupGame(db, 4);
  await launchGame(db, gameId);
  await eliminatePlayer(db, ids[2]);
  const c = await openContract(db, ids[1]);
  assert.equal(c.target_id, ids[3]);
  assert.equal(c.challenge_text, 'défi 2');
  const state = await adminGameState(db, gameId);
  assert.equal(state.alive, 3);
  assert.equal(state.contracts.length, 3);
});

test('la vue joueur ne révèle que sa propre cible, jamais le nombre de joueurs', async () => {
  const { gameId, ids } = await setupGame(db, 5);
  await launchGame(db, gameId);
  const view = await playerView(db, ids[0]);
  assert.equal(view.target.name, 'P1');
  assert.equal(view.target.challenge, 'défi 0');
  const json = JSON.stringify(view);
  for (const other of ['P2', 'P3', 'P4', 'CODE']) assert.ok(!json.includes(other), `fuite de ${other}`);
});

test('la cible voit la déclaration de kill la concernant', async () => {
  const { gameId, ids } = await setupGame(db, 3);
  await launchGame(db, gameId);
  await declareKill(db, ids[0]);
  assert.equal((await playerView(db, ids[1])).incoming.killer, 'P0');
  assert.equal((await playerView(db, ids[0])).target.pending, true);
});

test('deux validations simultanées du même kill ne cassent pas la boucle', async () => {
  const { gameId, ids } = await setupGame(db, 4);
  await launchGame(db, gameId);
  const c = await openContract(db, ids[0]);
  const results = await Promise.allSettled([confirmKill(db, c.id, 'admin'), confirmKill(db, c.id, 'admin')]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  const state = await adminGameState(db, gameId);
  assert.equal(state.alive, 3);
  assert.equal(state.contracts.length, 3);
});
