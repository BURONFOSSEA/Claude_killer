import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newDb, setupGame, openContract } from './helpers.js';
import { createBrevoMailer, createNotifier, messageFor } from '../supabase/functions/_shared/notify.js';
import {
  launchGame,
  declareKill,
  confirmKill,
  contestKill,
  eliminatePlayer,
  updateContractChallenge,
  pendingKillReminders,
} from '../supabase/functions/_shared/game.js';

const db = await newDb();

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
const types = (result) => result.events.map((e) => `${e.type}:${e.to.join(',')}`);

test('chaque action du jeu produit les bons événements', async () => {
  const { gameId, ids } = await setupGame(db, 4);
  const [a, b, c, d] = ids;
  assert.deepEqual(types(await launchGame(db, gameId)), [`game_started:${ids.join(',')}`]);
  assert.deepEqual(types(await declareKill(db, a)), [`kill_declared:${b}`, 'admin_kill_declared:']);
  assert.deepEqual(types(await contestKill(db, (await openContract(db, a)).id)), [`kill_contested:${a}`, 'admin_kill_contested:']);
  await declareKill(db, a);
  assert.deepEqual(types(await contestKill(db, (await openContract(db, a)).id, 'admin')), [`kill_rejected:${a}`]);
  assert.deepEqual(types(await confirmKill(db, (await openContract(db, a)).id, 'admin')), [`you_were_killed:${b}`, `kill_confirmed:${a}`]);
  assert.deepEqual(types(await updateContractChallenge(db, (await openContract(db, a)).id, 'nouveau défi')), [`challenge_changed:${a}`]);
  assert.deepEqual(types(await updateContractChallenge(db, (await openContract(db, a)).id, 'nouveau défi')), []);
  assert.deepEqual(types(await eliminatePlayer(db, c)), [`you_were_removed:${c}`, `target_removed:${a}`]);
  const end = await confirmKill(db, (await openContract(db, a)).id, 'admin');
  assert.deepEqual(types(end), [`you_were_killed:${d}`, `game_finished:${ids.join(',')}`, 'admin_game_finished:']);
  assert.equal(end.events[1].data.winnerId, a);
});

test('le notifier envoie push + e-mail sans jamais révéler la cible ni le défi', async () => {
  const { gameId, ids } = await setupGame(db, 3, { name: 'Soirée', emails: (i) => (i === 0 ? '' : `p${i}@ex.fr`) });
  const f = fakes();
  const keys = '{"p256dh":"x","auth":"y"}';
  await db.query('INSERT INTO push_subscriptions (player_id, endpoint, keys_json) VALUES ($1, $2, $3)', [ids[0], 'https://push/a', keys]);
  await db.query('INSERT INTO push_subscriptions (player_id, endpoint, keys_json) VALUES ($1, $2, $3)', [ids[1], 'https://push/expired', keys]);
  const notifier = createNotifier({ db, mailer: f.mailer, push: f.push, logger: { error() {} } });

  await notifier.dispatch((await launchGame(db, gameId)).events, { siteUrl: 'https://moi.github.io/Claude_killer/' });

  assert.equal(f.pushes.length, 1);
  assert.equal(f.pushes[0].url, 'https://moi.github.io/Claude_killer/player.html');
  assert.deepEqual(f.mails.map((m) => m.to).sort(), ['p1@ex.fr', 'p2@ex.fr']);
  assert.match(f.mails[0].subject, /Soirée/);
  assert.doesNotMatch(JSON.stringify([f.pushes, f.mails]), /défi \d/, 'le défi ne doit pas apparaître');
  for (const m of f.mails) {
    for (const n of ['P0', 'P1', 'P2'].filter((n) => m.toName !== n)) assert.ok(!m.text.includes(n), `nom ${n} révélé`);
  }
  // l'abonnement expiré (410) a été supprimé
  assert.equal((await db.one('SELECT COUNT(*)::int AS n FROM push_subscriptions WHERE endpoint LIKE $1', ['%expired'])).n, 0);
});

test('fin de partie : message personnalisé pour le vainqueur', () => {
  const evt = { type: 'game_finished', data: { winnerId: 1 } };
  assert.match(messageFor(evt, { game: 'G', winner: 'Alice', isWinner: true }).title, /gagné/);
  assert.match(messageFor(evt, { game: 'G', winner: 'Alice', isWinner: false }).body, /Alice/);
});

test("les noms sont échappés dans l'e-mail HTML", async () => {
  const gameId = (await db.one("INSERT INTO games (name) VALUES ('<b>G</b>') RETURNING id")).id;
  const pid = (await db.one("INSERT INTO players (game_id, name, code, email) VALUES ($1, '<script>x</script>', 'ZZ1', 'a@b.fr') RETURNING id", [gameId])).id;
  const f = fakes();
  await createNotifier({ db, mailer: f.mailer }).dispatch([{ type: 'game_started', gameId, to: [pid], data: {} }]);
  assert.ok(!f.mails[0].html.includes('<script>'));
  assert.ok(!f.mails[0].html.includes('<b>G</b>'));
});

test("le mailer Brevo appelle l'API avec le bon format", async () => {
  const calls = [];
  const fakeFetch = async (url, init) => (calls.push({ url, init }), new Response('{}', { status: 201 }));
  const mailer = createBrevoMailer({ BREVO_API_KEY: 'xkey', MAIL_FROM: 'Killer <killer@ex.fr>' }, fakeFetch);
  await mailer.send({ to: 'a@b.fr', toName: 'Alice', subject: 'S', text: 'T', html: '<p>H</p>' });
  assert.equal(calls[0].url, 'https://api.brevo.com/v3/smtp/email');
  assert.equal(calls[0].init.headers['api-key'], 'xkey');
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body.sender, { email: 'killer@ex.fr', name: 'Killer' });
  assert.deepEqual(body.to, [{ email: 'a@b.fr', name: 'Alice' }]);
  assert.equal(createBrevoMailer({}), null);
  const failing = createBrevoMailer({ BREVO_API_KEY: 'k', MAIL_FROM: 'a@b.fr' }, async () => new Response('nope', { status: 401 }));
  await assert.rejects(failing.send({ to: 'x@y.fr', subject: 's', text: 't', html: 'h' }), /Brevo 401/);
});

test("kill confirmé par la victime : l'organisateur est prévenu avec les noms", async () => {
  const { gameId, ids } = await setupGame(db, 3, { name: 'Gîte' });
  await launchGame(db, gameId);
  await declareKill(db, ids[0]);
  const result = await confirmKill(db, (await openContract(db, ids[0])).id, 'target');
  const evt = result.events.find((e) => e.type === 'admin_kill_confirmed');
  assert.deepEqual(evt.data, { killerId: ids[0], victimId: ids[1] });
  // envoi réel à l'organisateur (push + e-mail)
  const admin = await db.one("INSERT INTO admins (username, password_hash, email) VALUES ('orga', 'x', 'orga@ex.fr') RETURNING id");
  await db.query('INSERT INTO admin_push_subscriptions (admin_id, endpoint, keys_json) VALUES ($1, $2, $3)', [admin.id, 'https://push/admin', '{"p256dh":"x","auth":"y"}']);
  const f = fakes();
  await createNotifier({ db, mailer: f.mailer, push: f.push }).dispatch([evt], { siteUrl: 'https://site' });
  assert.equal(f.pushes[0].title, '💀 P0 a éliminé P1');
  assert.equal(f.pushes[0].url, `https://site/admin.html#/game/${gameId}/live`);
  assert.equal(f.mails[0].to, 'orga@ex.fr');
  await db.query('DELETE FROM admins WHERE id = $1', [admin.id]);
});

test('rappel unique pour un kill en attente depuis plus de 2 heures', async () => {
  const { gameId, ids } = await setupGame(db, 3);
  await launchGame(db, gameId);
  await declareKill(db, ids[0]);
  assert.equal((await pendingKillReminders(db)).events.filter((e) => e.gameId === gameId).length, 0); // trop récent
  const old = new Date(Date.now() - 3 * 3600_000).toISOString();
  await db.query("UPDATE contracts SET declared_at = $1 WHERE killer_id = $2 AND status = 'pending'", [old, ids[0]]);
  const first = (await pendingKillReminders(db)).events.filter((e) => e.gameId === gameId);
  assert.deepEqual(first.map((e) => e.type), ['kill_declared_reminder', 'admin_kill_pending']);
  assert.deepEqual(first[0].to, [ids[1]]);
  assert.equal((await pendingKillReminders(db)).events.filter((e) => e.gameId === gameId).length, 0); // déjà rappelé
});
