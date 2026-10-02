// Parcours complet via l'API HTTP : admin crée une partie, joueurs se connectent, kills, victoire.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { ensureAdmin } from '../src/auth.js';
import { createApp } from '../server.js';

delete process.env.ANTHROPIC_API_KEY; // mode hors-ligne pour les tests
delete process.env.ANTHROPIC_AUTH_TOKEN;

let server;
let base;
const dispatched = []; // événements transmis au module de notifications
const fakeNotifier = { pushPublicKey: 'cle-test', mailEnabled: true, dispatch: async (events) => dispatched.push(...events) };

before(async () => {
  const db = openDb(':memory:');
  ensureAdmin(db, { username: 'admin', password: 'secret-pass' });
  server = createApp({ db, notifier: fakeNotifier }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

// Mini-client gardant ses cookies.
function client() {
  let cookie = '';
  return async (path, { method = 'GET', body } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(cookie && { cookie }), ...(method !== 'GET' && { 'content-type': 'application/json' }) },
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, data: await res.json().catch(() => null) };
  };
}

test('parcours complet d’une partie', async () => {
  const admin = client();
  assert.equal((await admin('/api/admin/games')).status, 401);
  assert.equal((await admin('/api/admin/login', { method: 'POST', body: { username: 'admin', password: 'nope' } })).status, 401);
  assert.equal((await admin('/api/admin/login', { method: 'POST', body: { username: 'admin', password: 'secret-pass' } })).status, 200);

  const { data: game } = await admin('/api/admin/games', { method: 'POST', body: { name: 'Soirée test', theme: 'anniversaire' } });
  await admin(`/api/admin/games/${game.id}/players`, {
    method: 'POST',
    body: { players: [{ name: 'Alice', notes: 'aime le café', email: 'alice@ex.fr' }, { name: 'Bob' }, { name: 'Chloé' }] },
  });
  assert.equal(
    (await admin(`/api/admin/games/${game.id}/players`, { method: 'POST', body: { name: 'X', email: 'pas-un-mail' } })).status,
    400,
  );

  // Suggestions hors-ligne puis ajout
  const { data: sugg } = await admin(`/api/admin/games/${game.id}/ai/challenges`, { method: 'POST', body: { count: 5 } });
  assert.equal(sugg.source, 'library');
  assert.equal(sugg.challenges.length, 5);
  await admin(`/api/admin/games/${game.id}/challenges`, { method: 'POST', body: { texts: sugg.challenges, source: 'library' } });

  // Lancement impossible sans attribution
  assert.equal((await admin(`/api/admin/games/${game.id}/launch`, { method: 'POST' })).status, 400);

  // "IA" sans clé → repli sur le tirage aléatoire, toujours valide
  const { data: plan } = await admin(`/api/admin/games/${game.id}/plan/ai`, { method: 'POST', body: {} });
  assert.equal(plan.source, 'random');
  assert.deepEqual(plan.errors, []);

  // Un plan invalide (sous-boucle impossible à 3, mais auto-ciblage) est signalé
  const bad = plan.plan.map((r) => ({ ...r, target_id: r.killer_id }));
  const { data: badRes } = await admin(`/api/admin/games/${game.id}/plan`, { method: 'PUT', body: { plan: bad } });
  assert.ok(badRes.errors.length > 0);
  await admin(`/api/admin/games/${game.id}/plan`, { method: 'PUT', body: { plan: plan.plan } });

  assert.equal((await admin(`/api/admin/games/${game.id}/launch`, { method: 'POST' })).status, 200);
  assert.equal(dispatched.at(-1).type, 'game_started');
  assert.equal(dispatched.at(-1).to.length, 3);
  const { data: state } = await admin(`/api/admin/games/${game.id}`);
  assert.equal(state.contracts.length, 3);

  // Connexion des joueurs avec leur code (insensible à la casse)
  const players = new Map();
  for (const p of state.players) {
    const c = client();
    assert.equal((await c('/api/player/login', { method: 'POST', body: { code: p.code.toLowerCase() } })).status, 200);
    players.set(p.id, c);
  }
  assert.equal((await client()('/api/player/login', { method: 'POST', body: { code: 'ZZZZZZ' } })).status, 401);

  // Un joueur ne peut pas accéder à l'API admin
  const anyPlayer = players.values().next().value;
  assert.equal((await anyPlayer('/api/admin/games')).status, 401);

  // Le premier tueur déclare, la victime confirme
  const first = state.contracts[0];
  const killer = players.get(first.killer_id);
  const victim = players.get(first.target_id);
  const { data: kView } = await killer('/api/player/me');
  assert.equal(kView.target.name, state.players.find((p) => p.id === first.target_id).name);
  assert.ok(!JSON.stringify(kView).includes('code'));

  // Préférences de notification
  const { data: prefs } = await killer('/api/player/notifications');
  assert.equal(prefs.push_key, 'cle-test');
  assert.equal((await killer('/api/player/email', { method: 'PUT', body: { email: 'faux' } })).status, 400);
  assert.equal((await killer('/api/player/email', { method: 'PUT', body: { email: 'moi@ex.fr' } })).status, 200);
  assert.equal((await killer('/api/player/notifications')).data.email, 'moi@ex.fr');
  const subscription = { endpoint: 'https://push.example/abc', keys: { p256dh: 'k', auth: 'a' } };
  assert.equal((await killer('/api/player/push/subscribe', { method: 'POST', body: { subscription } })).status, 200);
  assert.equal((await killer('/api/player/notifications')).data.push_devices, 1);
  assert.equal(
    (await killer('/api/player/push/subscribe', { method: 'POST', body: { subscription: { endpoint: 'http://x' } } })).status,
    400,
  );

  await killer('/api/player/kill', { method: 'POST' });
  assert.deepEqual(dispatched.at(-1), { type: 'kill_declared', gameId: game.id, to: [first.target_id], data: {} });
  const { data: vView } = await victim('/api/player/me');
  assert.ok(vView.incoming);
  assert.equal((await victim('/api/player/incoming/confirm', { method: 'POST' })).status, 200);
  assert.equal((await victim('/api/player/me')).data.me.status, 'dead');

  // Le tueur hérite de la dernière cible ; l'admin valide → victoire
  const { data: s2 } = await admin(`/api/admin/games/${game.id}`);
  assert.equal(s2.contracts.length, 2);
  const last = s2.contracts.find((c) => c.killer_id === first.killer_id);
  await admin(`/api/admin/contracts/${last.id}/confirm`, { method: 'POST' });
  const { data: final } = await killer('/api/player/me');
  assert.equal(final.game.status, 'finished');
  assert.equal(final.final.winner, kView.me.name);
  assert.equal(dispatched.at(-1).type, 'game_finished');
});

test('les requêtes non-JSON sont refusées (anti-CSRF)', async () => {
  const res = await fetch(`${base}/api/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'username=admin&password=secret-pass',
  });
  assert.equal(res.status, 415);
});
