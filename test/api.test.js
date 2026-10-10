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
function client(ip = '1.2.3.4') {
  let token = '';
  return async (path, { method = 'GET', body } = {}) => {
    const res = await handle(
      new Request(`https://x.supabase.co/functions/v1/api${path}`, {
        method,
        headers: { 'content-type': 'application/json', 'x-forwarded-for': ip, ...(token && { [TOKEN_HEADER]: token }) },
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
  assert.deepEqual(dispatched.at(-2), { type: 'kill_declared', gameId: game.id, to: [first.target_id], data: {} });
  assert.equal(dispatched.at(-1).type, 'admin_kill_declared');
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
  assert.deepEqual(dispatched.slice(-2).map((e) => e.type), ['game_finished', 'admin_game_finished']);

  // Déconnexion : le jeton n'est plus valable
  await killer('/player/logout', { method: 'POST' });
  assert.equal((await killer('/player/me')).status, 401);
});

test('trop de tentatives de connexion → 429', async () => {
  const c = client('9.9.9.9');
  for (let i = 0; i < 10; i++) await c('/player/login', { method: 'POST', body: { code: 'NOPE' + i } });
  assert.equal((await c('/player/login', { method: 'POST', body: { code: 'NOPE' } })).status, 429);
});

test('pré-vol CORS et routes inconnues', async () => {
  const res = await handle(new Request('https://x.supabase.co/functions/v1/api/admin/login', { method: 'OPTIONS' }));
  assert.equal(res.status, 204);
  assert.match(res.headers.get('access-control-allow-headers'), new RegExp(TOKEN_HEADER));
  assert.equal((await client()('/inconnue')).status, 404);
});

test('messagerie : organisateur → groupes de joueurs, joueur → organisateur uniquement', async () => {
  const admin = client();
  await admin('/admin/login', { method: 'POST', body: { username: 'admin', password: 'secret-pass' } });
  const { data: game } = await admin('/admin/games', { method: 'POST', body: { name: 'Messages' } });
  await admin(`/admin/games/${game.id}/players`, { method: 'POST', body: { players: ['Ana', 'Ben', 'Cyd', 'Dan'].map((name) => ({ name })) } });
  await admin(`/admin/games/${game.id}/challenges`, { method: 'POST', body: { texts: ['a', 'b'] } });
  await admin(`/admin/games/${game.id}/plan/random`, { method: 'POST' });
  await admin(`/admin/games/${game.id}/launch`, { method: 'POST' });
  let { data: state } = await admin(`/admin/games/${game.id}`);
  const byName = Object.fromEntries(state.players.map((p) => [p.name, p]));
  const clients = {};
  for (const p of state.players) {
    clients[p.name] = client();
    await clients[p.name]('/player/login', { method: 'POST', body: { code: p.code } });
  }
  // Dan est retiré de la partie
  await admin(`/admin/players/${byName.Dan.id}/eliminate`, { method: 'POST' });

  const send = (body) => admin(`/admin/games/${game.id}/messages`, { method: 'POST', body });
  assert.equal((await send({ body: 'Bonjour à tous', audience: 'all' })).data.sent, 4);
  assert.equal((await send({ body: 'Courage les vivants', audience: 'alive' })).data.sent, 3);
  assert.equal((await send({ body: 'Merci les morts', audience: 'dead' })).data.sent, 1);
  assert.equal((await send({ body: 'Psst Ana', audience: 'players', player_ids: [byName.Ana.id] })).data.sent, 1);
  assert.equal((await send({ body: 'x', audience: 'players', player_ids: [] })).status, 400);
  assert.equal((await send({ body: '   ', audience: 'all' })).status, 400);
  assert.equal(dispatched.at(-1).type, 'message_received');
  assert.deepEqual(dispatched.at(-1).to, [byName.Ana.id]);

  // Ce que chacun reçoit
  assert.equal((await clients.Ana('/player/me')).data.unread_messages, 3);
  const ana = (await clients.Ana('/player/messages')).data.messages.map((m) => m.body);
  assert.deepEqual(ana, ['Bonjour à tous', 'Courage les vivants', 'Psst Ana']);
  assert.equal((await clients.Ana('/player/me')).data.unread_messages, 0); // lus à l'ouverture
  const dan = (await clients.Dan('/player/messages')).data.messages.map((m) => m.body);
  assert.deepEqual(dan, ['Bonjour à tous', 'Merci les morts']);
  const ben = (await clients.Ben('/player/messages')).data.messages;
  assert.ok(!ben.some((m) => m.body === 'Psst Ana'));

  // Un joueur n'écrit qu'à l'organisateur (aucun destinataire possible)
  assert.equal((await clients.Ben('/player/messages', { method: 'POST', body: { body: 'Question pour l’orga', to: byName.Ana.id } })).status, 201);
  assert.deepEqual(dispatched.at(-1), { type: 'admin_message', gameId: game.id, to: [], admins: true, data: { playerId: byName.Ben.id, body: 'Question pour l’orga' } });
  assert.ok(!(await clients.Ana('/player/messages')).data.messages.some((m) => m.body.includes('Question')));

  // Vue organisateur : fils par joueur, non-lus, envois groupés
  assert.equal((await admin('/admin/games')).data.unread[game.id], 1);
  const { data: box } = await admin(`/admin/games/${game.id}/messages`);
  assert.equal(box.threads[byName.Ben.id].at(-1).from, 'player');
  assert.equal(box.broadcasts.length, 3);
  await admin(`/admin/games/${game.id}/messages/read`, { method: 'POST', body: { player_id: byName.Ben.id } });
  assert.equal((await admin('/admin/games')).data.unread[game.id], undefined);

  // Un joueur ne peut pas lire la messagerie d'une partie
  assert.equal((await clients.Ben(`/admin/games/${game.id}/messages`)).status, 401);
});

test("préférences de notification de l'organisateur", async () => {
  const admin = client();
  await admin('/admin/login', { method: 'POST', body: { username: 'admin', password: 'secret-pass' } });
  assert.equal((await admin('/admin/email', { method: 'PUT', body: { email: 'faux' } })).status, 400);
  await admin('/admin/email', { method: 'PUT', body: { email: 'orga@ex.fr' } });
  await admin('/admin/push/subscribe', { method: 'POST', body: { subscription: { endpoint: 'https://push.example/orga', keys: { p256dh: 'k', auth: 'a' } } } });
  const { data } = await admin('/admin/notifications');
  assert.equal(data.email, 'orga@ex.fr');
  assert.equal(data.push_devices, 1);
  await admin('/admin/push/unsubscribe', { method: 'POST', body: { endpoint: 'https://push.example/orga' } });
  assert.equal((await admin('/admin/notifications')).data.push_devices, 0);
});

test('les rappels sont déclenchables sans connexion', async () => {
  const res = await client()('/cron/reminders', { method: 'POST' });
  assert.equal(res.status, 200);
  assert.equal(typeof res.data.reminders, 'number');
});
