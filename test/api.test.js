// Parcours complet via l'API HTTP : admin crée une partie, joueurs se connectent, kills, victoire.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newDb } from './helpers.js';
import { ensureAdmin } from '../supabase/functions/_shared/auth.js';
import { configureAi } from '../supabase/functions/_shared/ai.js';
import { createHandler, TOKEN_HEADER } from '../supabase/functions/_shared/app.js';

configureAi({}); // mode hors-ligne
const db = await newDb();
await ensureAdmin(db, { username: 'admin', password: 'secret-pass' });
const dispatched = [];
const fakeNotifier = { pushPublicKey: 'cle-test', mailEnabled: true, dispatch: async (events) => dispatched.push(...events) };
const handle = createHandler({ db, notifier: fakeNotifier, allowedOrigin: 'https://moi.github.io' });

// Mini-client gardant son jeton de session, comme le navigateur.
function client() {
  let token = '';
  return async (path, { method = 'GET', body } = {}) => {
    const res = await handle(
      new Request(`https://x.supabase.co/functions/v1/api${path}`, {
        method,
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '1.2.3.4', ...(token && { [TOKEN_HEADER]: token }) },
        body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
      }),
    );
    const data = await res.json().catch(() => null);
    if (data?.token) token = data.token;
    return { status: res.status, data, headers: res.headers };
  };
}

test('parcours complet d’une partie', async () => {
  const admin = client();
  assert.equal((await admin('/admin/games')).status, 401);
  assert.equal((await admin('/admin/login', { method: 'POST', body: { username: 'admin', password: 'nope' } })).status, 401);
  const login = await admin('/admin/login', { method: 'POST', body: { username: 'admin', password: 'secret-pass' } });
  assert.equal(login.status, 200);
  assert.equal(login.headers.get('access-control-allow-origin'), 'https://moi.github.io');

  const { data: game, status } = await admin('/admin/games', { method: 'POST', body: { name: 'Soirée test', theme: 'anniversaire' } });
  assert.equal(status, 201);
  await admin(`/admin/games/${game.id}/players`, {
    method: 'POST',
    body: { players: [{ name: 'Alice', notes: 'aime le café', email: 'alice@ex.fr' }, { name: 'Bob' }, { name: 'Chloé' }] },
  });
  assert.equal((await admin(`/admin/games/${game.id}/players`, { method: 'POST', body: { name: 'X', email: 'pas-un-mail' } })).status, 400);

  const { data: sugg } = await admin(`/admin/games/${game.id}/ai/challenges`, { method: 'POST', body: { count: 5 } });
  assert.equal(sugg.source, 'library');
  assert.equal(sugg.challenges.length, 5);
  await admin(`/admin/games/${game.id}/challenges`, { method: 'POST', body: { texts: sugg.challenges, source: 'library' } });

  assert.equal((await admin(`/admin/games/${game.id}/launch`, { method: 'POST' })).status, 400);

  const { data: plan } = await admin(`/admin/games/${game.id}/plan/ai`, { method: 'POST', body: {} });
  assert.equal(plan.source, 'random');
  assert.deepEqual(plan.errors, []);
  const bad = plan.plan.map((r) => ({ ...r, target_id: r.killer_id }));
  assert.ok((await admin(`/admin/games/${game.id}/plan`, { method: 'PUT', body: { plan: bad } })).data.errors.length > 0);
  await admin(`/admin/games/${game.id}/plan`, { method: 'PUT', body: { plan: plan.plan } });

  assert.equal((await admin(`/admin/games/${game.id}/launch`, { method: 'POST' })).status, 200);
  assert.equal(dispatched.at(-1).type, 'game_started');
  assert.equal(dispatched.at(-1).to.length, 3);
  const { data: state } = await admin(`/admin/games/${game.id}`);
  assert.equal(state.contracts.length, 3);

  const players = new Map();
  for (const p of state.players) {
    const c = client();
    assert.equal((await c('/player/login', { method: 'POST', body: { code: p.code.toLowerCase() } })).status, 200);
    players.set(p.id, c);
  }
  assert.equal((await client()('/player/login', { method: 'POST', body: { code: 'ZZZZZZ' } })).status, 401);
  const anyPlayer = players.values().next().value;
  assert.equal((await anyPlayer('/admin/games')).status, 401);

  const first = state.contracts[0];
  const killer = players.get(first.killer_id);
  const victim = players.get(first.target_id);
  const { data: kView } = await killer('/player/me');
  assert.equal(kView.target.name, state.players.find((p) => p.id === first.target_id).name);
  assert.ok(!JSON.stringify(kView).includes('code'));

  // Préférences de notification
  assert.equal((await killer('/player/notifications')).data.push_key, 'cle-test');
  assert.equal((await killer('/player/email', { method: 'PUT', body: { email: 'faux' } })).status, 400);
  assert.equal((await killer('/player/email', { method: 'PUT', body: { email: 'moi@ex.fr' } })).status, 200);
  assert.equal((await killer('/player/notifications')).data.email, 'moi@ex.fr');
  const subscription = { endpoint: 'https://push.example/abc', keys: { p256dh: 'k', auth: 'a' } };
  assert.equal((await killer('/player/push/subscribe', { method: 'POST', body: { subscription } })).status, 200);
  assert.equal((await killer('/player/notifications')).data.push_devices, 1);
  assert.equal((await killer('/player/push/subscribe', { method: 'POST', body: { subscription: { endpoint: 'http://x' } } })).status, 400);

  await killer('/player/kill', { method: 'POST' });
  assert.deepEqual(dispatched.at(-1), { type: 'kill_declared', gameId: game.id, to: [first.target_id], data: {} });
  assert.ok((await victim('/player/me')).data.incoming);
  assert.equal((await victim('/player/incoming/confirm', { method: 'POST' })).status, 200);
  assert.equal((await victim('/player/me')).data.me.status, 'dead');

  const { data: s2 } = await admin(`/admin/games/${game.id}`);
  assert.equal(s2.contracts.length, 2);
  const last = s2.contracts.find((c) => c.killer_id === first.killer_id);
  await admin(`/admin/contracts/${last.id}/confirm`, { method: 'POST' });
  const { data: final } = await killer('/player/me');
  assert.equal(final.game.status, 'finished');
  assert.equal(final.final.winner, kView.me.name);
  assert.equal(dispatched.at(-1).type, 'game_finished');

  // Déconnexion : le jeton n'est plus valable
  await killer('/player/logout', { method: 'POST' });
  assert.equal((await killer('/player/me')).status, 401);
});

test('trop de tentatives de connexion → 429', async () => {
  const c = client();
  for (let i = 0; i < 10; i++) await c('/player/login', { method: 'POST', body: { code: 'NOPE' + i } });
  assert.equal((await c('/player/login', { method: 'POST', body: { code: 'NOPE' } })).status, 429);
});

test('pré-vol CORS et routes inconnues', async () => {
  const res = await handle(new Request('https://x.supabase.co/functions/v1/api/admin/login', { method: 'OPTIONS' }));
  assert.equal(res.status, 204);
  assert.match(res.headers.get('access-control-allow-headers'), new RegExp(TOKEN_HEADER));
  assert.equal((await client()('/inconnue')).status, 404);
});
