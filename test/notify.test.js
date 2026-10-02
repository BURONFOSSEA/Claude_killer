import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createNotifier, messageFor } from '../src/notify.js';
import { savePlan, launchGame, declareKill, confirmKill, contestKill, eliminatePlayer, updateContractChallenge } from '../src/game.js';

function setup(n = 3) {
  const db = openDb(':memory:');
  const gameId = Number(db.prepare("INSERT INTO games (name) VALUES ('Soirée')").run().lastInsertRowid);
  const ids = [];
  for (let i = 0; i < n; i++) {
    ids.push(
      Number(
        db.prepare('INSERT INTO players (game_id, name, code, email) VALUES (?, ?, ?, ?)').run(gameId, `P${i}`, `C${i}`, i === 0 ? '' : `p${i}@ex.fr`)
          .lastInsertRowid,
      ),
    );
  }
  savePlan(db, gameId, ids.map((id, i) => ({ killer_id: id, target_id: ids[(i + 1) % n], challenge_text: `défi secret ${i}` })));
  return { db, gameId, ids };
}

function fakes() {
  const mails = [];
  const pushes = [];
  return {
    mails,
    pushes,
    mailer: { send: async (m) => mails.push(m) },
    push: {
      publicKey: 'test-key',
      send: async (sub, payload) => {
        if (sub.endpoint.includes('expired')) throw Object.assign(new Error('gone'), { statusCode: 410 });
        pushes.push({ endpoint: sub.endpoint, ...JSON.parse(payload) });
      },
    },
  };
}

const openContract = (db, killerId) =>
  db.prepare("SELECT * FROM contracts WHERE killer_id = ? AND status IN ('active','pending')").get(killerId);
const types = (result) => result.events.map((e) => `${e.type}:${e.to.join(',')}`);

test('chaque action du jeu produit les bons événements', () => {
  const { db, gameId, ids } = setup(4);
  const [a, b, c, d] = ids;
  assert.deepEqual(types(launchGame(db, gameId)), [`game_started:${ids.join(',')}`]);
  assert.deepEqual(types(declareKill(db, a)), [`kill_declared:${b}`]);
  assert.deepEqual(types(contestKill(db, openContract(db, a).id)), [`kill_contested:${a}`]);
  declareKill(db, a);
  assert.deepEqual(types(contestKill(db, openContract(db, a).id, 'admin')), [`kill_rejected:${a}`]);
  assert.deepEqual(types(confirmKill(db, openContract(db, a).id, 'admin')), [`you_were_killed:${b}`, `kill_confirmed:${a}`]);
  assert.deepEqual(types(updateContractChallenge(db, openContract(db, a).id, 'nouveau défi')), [`challenge_changed:${a}`]);
  assert.deepEqual(types(updateContractChallenge(db, openContract(db, a).id, 'nouveau défi')), []); // pas de changement
  assert.deepEqual(types(eliminatePlayer(db, c)), [`you_were_removed:${c}`, `target_removed:${a}`]);
  const end = confirmKill(db, openContract(db, a).id, 'admin'); // a tue d → victoire
  assert.deepEqual(types(end), [`you_were_killed:${d}`, `game_finished:${ids.join(',')}`]);
  assert.equal(end.events[1].data.winnerId, a);
});

test('le notifier envoie push + e-mail sans jamais révéler la cible ni le défi', async () => {
  const { db, gameId, ids } = setup(3);
  const f = fakes();
  db.prepare('INSERT INTO push_subscriptions (player_id, endpoint, keys_json) VALUES (?, ?, ?)').run(ids[0], 'https://push/a', '{"p256dh":"x","auth":"y"}');
  db.prepare('INSERT INTO push_subscriptions (player_id, endpoint, keys_json) VALUES (?, ?, ?)').run(ids[1], 'https://push/expired', '{"p256dh":"x","auth":"y"}');
  const notifier = createNotifier({ db, mailer: f.mailer, push: f.push, logger: { error() {} } });

  await notifier.dispatch(launchGame(db, gameId).events, { baseUrl: 'https://killer.test' });

  assert.equal(f.pushes.length, 1); // P0 abonné ; l'abonnement expiré de P1 échoue
  assert.equal(f.pushes[0].url, 'https://killer.test/jouer');
  assert.equal(f.mails.length, 2); // P1 et P2 ont un e-mail, pas P0
  assert.deepEqual(f.mails.map((m) => m.to).sort(), ['p1@ex.fr', 'p2@ex.fr']);
  assert.match(f.mails[0].subject, /Soirée/);
  const everything = JSON.stringify([f.pushes, f.mails]);
  assert.ok(!everything.includes('défi secret'), 'le défi ne doit pas apparaître');
  for (const m of f.mails) {
    const other = ['P0', 'P1', 'P2'].filter((n) => !m.text.includes(`Salut ${n}`));
    for (const n of other) assert.ok(!m.text.includes(n), `nom ${n} révélé`);
  }
  // l'abonnement expiré (410) a été supprimé
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get().n, 1);
});

test('fin de partie : message personnalisé pour le vainqueur', () => {
  const evt = { type: 'game_finished', data: { winnerId: 1 } };
  assert.match(messageFor(evt, { game: 'G', winner: 'Alice', isWinner: true }).title, /gagné/);
  assert.match(messageFor(evt, { game: 'G', winner: 'Alice', isWinner: false }).body, /Alice/);
});

test("le noms et e-mails sont échappés dans l'e-mail HTML", async () => {
  const db = openDb(':memory:');
  const gameId = Number(db.prepare("INSERT INTO games (name) VALUES ('<b>G</b>')").run().lastInsertRowid);
  const pid = Number(db.prepare("INSERT INTO players (game_id, name, code, email) VALUES (?, '<script>x</script>', 'Z1', 'a@b.fr')").run(gameId).lastInsertRowid);
  const f = fakes();
  await createNotifier({ db, mailer: f.mailer }).dispatch([{ type: 'game_started', gameId, to: [pid], data: {} }], { baseUrl: '' });
  assert.ok(!f.mails[0].html.includes('<script>'));
  assert.ok(!f.mails[0].html.includes('<b>G</b>'));
});
