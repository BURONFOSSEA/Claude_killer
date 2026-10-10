// API HTTP du jeu, sous forme de gestionnaire "fetch" standard (Request -> Response).
// Le même code tourne dans l'Edge Function Supabase (Deno) et dans le serveur local (Node).
import {
  createSession,
  destroySession,
  destroySubjectSessions,
  hashPassword,
  loginBlocked,
  loginFailed,
  loginSucceeded,
  normalizeCode,
  randomCode,
  readSession,
  verifyPassword,
} from './auth.js';
import {
  GameError,
  adminGameState,
  buildRandomPlan,
  cancelDeclaration,
  confirmKill,
  contestKill,
  declareKill,
  eliminatePlayer,
  finishGame,
  getGame,
  launchGame,
  pendingKillReminders,
  playerView,
  savePlan,
  updateContractChallenge,
  validatePlan,
} from './game.js';
import { aiEnabled, generateChallenges, proposeAssignments } from './ai.js';
import {
  adminMessages,
  adminUnreadByGame,
  markThreadRead,
  playerThread,
  playerUnread,
  sendAdminMessage,
  sendPlayerMessage,
} from './messages.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Réponse "201 Created" : les autres routes renvoient simplement leur objet (200).
const CREATED = Symbol('created');
const created = (body) => ({ [CREATED]: body });
export const TOKEN_HEADER = 'x-killer-token';

// ---------- Validation des entrées ----------
const str = (v, max = 500) => String(v ?? '').trim().slice(0, max);
const id = (v) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new GameError('Identifiant invalide.');
  return n;
};
const optionalDate = (v) => {
  if (!v) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new GameError('Date invalide.');
  return d.toISOString();
};
const email = (v) => {
  const e = String(v ?? '').trim().slice(0, 200);
  if (e && !EMAIL_RE.test(e)) throw new GameError(`Adresse e-mail invalide : ${e}`);
  return e;
};

/**
 * @param {object} opts
 * @param {object} opts.db        adaptateur de base (voir db.js)
 * @param {object} opts.notifier  module de notifications (voir notify.js)
 * @param {string} opts.siteUrl   adresse publique du site (liens des notifications)
 * @param {string} opts.allowedOrigin  origine autorisée (CORS) ; '*' par défaut
 * @param {(p: Promise) => void} opts.waitUntil  prolonge l'exécution après la réponse (Edge Functions)
 */
export function createHandler({ db, notifier, siteUrl = '', allowedOrigin = '*', waitUntil = (p) => p }) {
  const routes = [];
  const route = (method, pattern, auth, handler) => {
    const keys = [];
    const regex = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)'))}$`);
    routes.push({ method, regex, keys, auth, handler });
  };

  // ---------- Utilitaires liés à la base ----------
  async function uniqueCode() {
    for (;;) {
      const code = randomCode(6);
      if (!(await db.one('SELECT 1 FROM players WHERE code = $1', [code]))) return code;
    }
  }
  async function playerOf(pid) {
    const p = await db.one('SELECT * FROM players WHERE id = $1', [pid]);
    if (!p) throw new GameError('Joueur introuvable.', 404);
    return p;
  }
  async function contractOf(cid) {
    const c = await db.one('SELECT * FROM contracts WHERE id = $1', [cid]);
    if (!c) throw new GameError('Contrat introuvable.', 404);
    return c;
  }
  async function requireDraft(gameId, what) {
    if ((await getGame(db, gameId)).status !== 'draft') throw new GameError(`Impossible ${what} une fois la partie lancée.`);
  }
  // Toute modification des joueurs invalide la proposition d'attribution.
  const resetPlan = (t, gameId) => t.query('UPDATE games SET plan_json = NULL WHERE id = $1', [gameId]);

  // Abonnement / désabonnement push d'un appareil (joueur ou organisateur).
  async function subscribePush(table, ownerColumn, ownerId, sub = {}) {
    const endpoint = str(sub.endpoint, 1000);
    if (!/^https:\/\//.test(endpoint) || !sub.keys?.p256dh || !sub.keys?.auth) throw new GameError('Abonnement push invalide.');
    const keys = JSON.stringify({ p256dh: str(sub.keys.p256dh, 200), auth: str(sub.keys.auth, 200) });
    await db.query(
      `INSERT INTO ${table} (${ownerColumn}, endpoint, keys_json) VALUES ($1, $2, $3)
       ON CONFLICT (endpoint) DO UPDATE SET ${ownerColumn} = excluded.${ownerColumn}, keys_json = excluded.keys_json`,
      [ownerId, endpoint, keys],
    );
    return { ok: true };
  }
  async function unsubscribePush(table, ownerColumn, ownerId, endpoint) {
    await db.query(`DELETE FROM ${table} WHERE ${ownerColumn} = $1 AND endpoint = $2`, [ownerId, str(endpoint, 1000)]);
    return { ok: true };
  }

  // Envoie les notifications sans retarder la réponse.
  function notify(result) {
    if (!result?.events?.length) return;
    waitUntil(notifier.dispatch(result.events, { siteUrl }).catch((err) => console.error('[notifications]', err)));
  }

  route('GET', '/health', null, async () => {
    await db.one('SELECT 1 AS ok'); // garde le projet Supabase actif
    return { ok: true };
  });

  // Rappels des kills restés sans réponse : appelé chaque heure par GitHub Actions.
  // Sans authentification : l'appel est sans effet hors des rappels dus, et chacun n'est envoyé qu'une fois.
  route('POST', '/cron/reminders', null, async () => {
    const result = await pendingKillReminders(db);
    notify(result);
    return { reminders: result.events.filter((e) => e.admins).length };
  });

  route('GET', '/config', null, async () => ({ ai: aiEnabled(), push_key: notifier.pushPublicKey, mail: notifier.mailEnabled }));

  // ---------------- Admin : session ----------------

  route('POST', '/admin/login', null, async ({ body, ip }) => {
    if (await loginBlocked(db, ip)) throw new GameError('Trop de tentatives, réessayez plus tard.', 429);
    const row = await db.one('SELECT * FROM admins WHERE username = $1', [str(body.username, 100)]);
    if (!row || !(await verifyPassword(String(body.password || ''), row.password_hash))) {
      await loginFailed(db, ip);
      throw new GameError('Identifiant ou mot de passe incorrect.', 401);
    }
    await loginSucceeded(db, ip);
    return { token: await createSession(db, 'admin', row.id), username: row.username };
  });

  route('POST', '/admin/logout', null, async ({ token }) => {
    await destroySession(db, token);
    return { ok: true };
  });

  route('GET', '/admin/me', 'admin', async ({ subjectId }) => {
    const row = await db.one('SELECT username FROM admins WHERE id = $1', [subjectId]);
    return { username: row?.username, ai: aiEnabled(), push: Boolean(notifier.pushPublicKey), mail: notifier.mailEnabled };
  });

  route('POST', '/admin/password', 'admin', async ({ body, subjectId }) => {
    const row = await db.one('SELECT * FROM admins WHERE id = $1', [subjectId]);
    if (!(await verifyPassword(String(body.current || ''), row.password_hash))) throw new GameError('Mot de passe actuel incorrect.', 403);
    const next = String(body.next || '');
    if (next.length < 8) throw new GameError('Le nouveau mot de passe doit faire au moins 8 caractères.');
    await db.query('UPDATE admins SET password_hash = $1 WHERE id = $2', [await hashPassword(next), row.id]);
    return { ok: true };
  });

  // Préférences de notification de l'organisateur.
  route('GET', '/admin/notifications', 'admin', async ({ subjectId }) => {
    const row = await db.one('SELECT email FROM admins WHERE id = $1', [subjectId]);
    const subs = await db.one('SELECT COUNT(*)::int AS n FROM admin_push_subscriptions WHERE admin_id = $1', [subjectId]);
    return { email: row.email, push_devices: subs.n, push_key: notifier.pushPublicKey, mail_enabled: notifier.mailEnabled };
  });
  route('PUT', '/admin/email', 'admin', async ({ body, subjectId }) => {
    await db.query('UPDATE admins SET email = $1 WHERE id = $2', [email(body.email), subjectId]);
    return { ok: true };
  });
  route('POST', '/admin/push/subscribe', 'admin', ({ body, subjectId }) =>
    subscribePush('admin_push_subscriptions', 'admin_id', subjectId, body.subscription),
  );
  route('POST', '/admin/push/unsubscribe', 'admin', ({ body, subjectId }) =>
    unsubscribePush('admin_push_subscriptions', 'admin_id', subjectId, body.endpoint),
  );

  // ---------------- Admin : parties ----------------

  route('GET', '/admin/games', 'admin', async () => ({
    unread: await adminUnreadByGame(db),
    games: await db.query(
      `SELECT g.id, g.name, g.status, g.started_at, g.ends_at, g.finished_at, g.created_at,
              (SELECT COUNT(*)::int FROM players p WHERE p.game_id = g.id) AS players,
              (SELECT COUNT(*)::int FROM players p WHERE p.game_id = g.id AND p.status = 'alive') AS alive
       FROM games g ORDER BY g.created_at DESC, g.id DESC`,
    ),
  }));

  route('POST', '/admin/games', 'admin', async ({ body }) => {
    const name = str(body.name, 120);
    if (!name) throw new GameError('Donnez un nom à la partie.');
    const row = await db.one('INSERT INTO games (name, theme, ends_at) VALUES ($1, $2, $3) RETURNING id', [
      name,
      str(body.theme, 2000),
      optionalDate(body.ends_at),
    ]);
    return created({ id: row.id });
  });

  route('GET', '/admin/games/:id', 'admin', ({ params }) => adminGameState(db, id(params.id)));

  route('PATCH', '/admin/games/:id', 'admin', async ({ params, body }) => {
    const game = await getGame(db, id(params.id));
    const name = body.name !== undefined ? str(body.name, 120) : game.name;
    if (!name) throw new GameError('Le nom ne peut pas être vide.');
    const theme = body.theme !== undefined ? str(body.theme, 2000) : game.theme;
    const endsAt = body.ends_at !== undefined ? optionalDate(body.ends_at) : game.ends_at;
    await db.query('UPDATE games SET name = $1, theme = $2, ends_at = $3 WHERE id = $4', [name, theme, endsAt, game.id]);
    return { ok: true };
  });

  route('DELETE', '/admin/games/:id', 'admin', async ({ params }) => {
    const game = await getGame(db, id(params.id));
    await db.tx(async (t) => {
      await t.query("DELETE FROM sessions WHERE kind = 'player' AND subject_id IN (SELECT id FROM players WHERE game_id = $1)", [game.id]);
      await t.query('DELETE FROM games WHERE id = $1', [game.id]);
    });
    return { ok: true };
  });

  route('POST', '/admin/games/:id/launch', 'admin', async ({ params }) => {
    notify(await launchGame(db, id(params.id)));
    return { ok: true };
  });

  route('POST', '/admin/games/:id/finish', 'admin', async ({ params }) => {
    notify(await finishGame(db, id(params.id)));
    return { ok: true };
  });

  // ---------------- Admin : joueurs ----------------

  route('POST', '/admin/games/:id/players', 'admin', async ({ params, body }) => {
    const gameId = id(params.id);
    await requireDraft(gameId, "d'ajouter des joueurs");
    const entries = (Array.isArray(body.players) ? body.players : [body])
      .slice(0, 500)
      .map((e) => ({ name: str(e.name, 80), notes: str(e.notes, 1000), email: email(e.email) }))
      .filter((e) => e.name);
    if (!entries.length) throw new GameError('Aucun nom de joueur fourni.');
    const codes = [];
    for (let i = 0; i < entries.length; i++) codes.push(await uniqueCode());
    await db.tx(async (t) => {
      for (const [i, e] of entries.entries()) {
        await t.query('INSERT INTO players (game_id, name, notes, email, code) VALUES ($1, $2, $3, $4, $5)', [gameId, e.name, e.notes, e.email, codes[i]]);
      }
      await resetPlan(t, gameId);
    });
    return created({ created: entries.length });
  });

  route('PATCH', '/admin/players/:pid', 'admin', async ({ params, body }) => {
    const p = await playerOf(id(params.pid));
    const name = body.name !== undefined ? str(body.name, 80) : p.name;
    if (!name) throw new GameError('Le nom ne peut pas être vide.');
    const notes = body.notes !== undefined ? str(body.notes, 1000) : p.notes;
    const mail = body.email !== undefined ? email(body.email) : p.email;
    await db.query('UPDATE players SET name = $1, notes = $2, email = $3 WHERE id = $4', [name, notes, mail, p.id]);
    return { ok: true };
  });

  route('DELETE', '/admin/players/:pid', 'admin', async ({ params }) => {
    const p = await playerOf(id(params.pid));
    await requireDraft(p.game_id, 'de supprimer un joueur');
    await db.tx(async (t) => {
      await destroySubjectSessions(t, 'player', p.id);
      await t.query('DELETE FROM players WHERE id = $1', [p.id]);
      await resetPlan(t, p.game_id);
    });
    return { ok: true };
  });

  route('POST', '/admin/players/:pid/regenerate-code', 'admin', async ({ params }) => {
    const p = await playerOf(id(params.pid));
    const code = await uniqueCode();
    await db.query('UPDATE players SET code = $1 WHERE id = $2', [code, p.id]);
    await destroySubjectSessions(db, 'player', p.id);
    return { code };
  });

  route('POST', '/admin/players/:pid/eliminate', 'admin', async ({ params }) => {
    const result = await eliminatePlayer(db, id(params.pid));
    notify(result);
    return { finished: result.finished };
  });

  // ---------------- Admin : défis ----------------

  route('POST', '/admin/games/:id/challenges', 'admin', async ({ params, body }) => {
    const gameId = (await getGame(db, id(params.id))).id;
    const texts = (Array.isArray(body.texts) ? body.texts : [body.text]).map((t) => str(t, 500)).filter(Boolean).slice(0, 200);
    if (!texts.length) throw new GameError('Défi vide.');
    const source = ['admin', 'ai', 'library'].includes(body.source) ? body.source : 'admin';
    await db.tx(async (t) => {
      for (const text of texts) await t.query('INSERT INTO challenges (game_id, text, source) VALUES ($1, $2, $3)', [gameId, text, source]);
    });
    return created({ created: texts.length });
  });

  route('PATCH', '/admin/challenges/:cid', 'admin', async ({ params, body }) => {
    const text = str(body.text, 500);
    if (!text) throw new GameError('Défi vide.');
    const row = await db.one('UPDATE challenges SET text = $1 WHERE id = $2 RETURNING id', [text, id(params.cid)]);
    if (!row) throw new GameError('Défi introuvable.', 404);
    return { ok: true };
  });

  route('DELETE', '/admin/challenges/:cid', 'admin', async ({ params }) => {
    await db.query('DELETE FROM challenges WHERE id = $1', [id(params.cid)]);
    return { ok: true };
  });

  route('POST', '/admin/games/:id/ai/challenges', 'admin', async ({ params, body }) => {
    const game = await getGame(db, id(params.id));
    const existing = (await db.query('SELECT text FROM challenges WHERE game_id = $1', [game.id])).map((c) => c.text);
    return generateChallenges({ theme: game.theme, count: body.count, existing, instructions: str(body.instructions, 1000) });
  });

  // ---------------- Admin : attribution des cibles ----------------

  async function planContext(gameId) {
    await requireDraft(gameId, "de modifier l'attribution");
    const players = await db.query('SELECT id, name, notes FROM players WHERE game_id = $1 ORDER BY id', [gameId]);
    if (players.length < 3) throw new GameError('Ajoutez au moins 3 joueurs.');
    const challenges = await db.query('SELECT id, text FROM challenges WHERE game_id = $1 ORDER BY id', [gameId]);
    return { players, challenges };
  }

  route('POST', '/admin/games/:id/plan/random', 'admin', async ({ params }) => {
    const gameId = id(params.id);
    const { players, challenges } = await planContext(gameId);
    if (!challenges.length) throw new GameError("Ajoutez des défis avant le tirage (ou utilisez l'IA).");
    const plan = await savePlan(db, gameId, buildRandomPlan(players.map((p) => p.id), challenges.map((c) => c.text)));
    return { source: 'random', plan, errors: [] };
  });

  route('POST', '/admin/games/:id/plan/ai', 'admin', async ({ params, body }) => {
    const game = await getGame(db, id(params.id));
    const { players, challenges } = await planContext(game.id);
    const result = await proposeAssignments({ theme: game.theme, players, challenges, instructions: str(body.instructions, 1000) });
    const plan = await savePlan(db, game.id, result.plan);
    return { ...result, plan, errors: validatePlan(plan, players.map((p) => p.id)) };
  });

  route('PUT', '/admin/games/:id/plan', 'admin', async ({ params, body }) => {
    const gameId = id(params.id);
    const { players } = await planContext(gameId);
    if (!Array.isArray(body.plan)) throw new GameError('Plan invalide.');
    const plan = await savePlan(db, gameId, body.plan);
    return { plan, errors: validatePlan(plan, players.map((p) => p.id)) };
  });

  // ---------------- Admin : contrats en cours ----------------

  route('POST', '/admin/contracts/:cid/confirm', 'admin', async ({ params }) => {
    const result = await confirmKill(db, (await contractOf(id(params.cid))).id, 'admin');
    notify(result);
    return { finished: result.finished };
  });

  route('POST', '/admin/contracts/:cid/reject', 'admin', async ({ params }) => {
    notify(await contestKill(db, (await contractOf(id(params.cid))).id, 'admin'));
    return { ok: true };
  });

  route('PATCH', '/admin/contracts/:cid', 'admin', async ({ params, body }) => {
    notify(await updateContractChallenge(db, (await contractOf(id(params.cid))).id, str(body.challenge_text, 500)));
    return { ok: true };
  });

  // ---------------- Admin : messagerie ----------------

  route('GET', '/admin/games/:id/messages', 'admin', async ({ params }) => {
    const gameId = (await getGame(db, id(params.id))).id;
    return adminMessages(db, gameId);
  });

  route('POST', '/admin/games/:id/messages', 'admin', async ({ params, body }) => {
    const result = await sendAdminMessage(db, id(params.id), {
      body: body.body,
      audience: str(body.audience, 20),
      playerIds: Array.isArray(body.player_ids) ? body.player_ids : [],
    });
    notify(result);
    return created({ sent: result.sent });
  });

  route('POST', '/admin/games/:id/messages/read', 'admin', async ({ params, body }) => {
    await markThreadRead(db, id(params.id), id(body.player_id));
    return { ok: true };
  });

  // ---------------- Joueur ----------------

  route('POST', '/player/login', null, async ({ body, ip }) => {
    if (await loginBlocked(db, ip)) throw new GameError('Trop de tentatives, réessayez plus tard.', 429);
    const row = await db.one('SELECT id FROM players WHERE code = $1', [normalizeCode(body.code)]);
    if (!row) {
      await loginFailed(db, ip);
      throw new GameError('Code inconnu.', 401);
    }
    await loginSucceeded(db, ip);
    return { token: await createSession(db, 'player', row.id) };
  });

  route('POST', '/player/logout', null, async ({ token }) => {
    await destroySession(db, token);
    return { ok: true };
  });

  route('GET', '/player/me', 'player', async ({ subjectId }) => ({
    ...(await playerView(db, subjectId)),
    unread_messages: await playerUnread(db, subjectId),
  }));

  route('GET', '/player/messages', 'player', async ({ subjectId }) => ({ messages: await playerThread(db, subjectId) }));

  route('POST', '/player/messages', 'player', async ({ body, subjectId }) => {
    notify(await sendPlayerMessage(db, subjectId, body.body));
    return created({ ok: true });
  });

  route('POST', '/player/kill', 'player', async ({ subjectId }) => {
    notify(await declareKill(db, subjectId));
    return { ok: true };
  });

  route('POST', '/player/kill/cancel', 'player', async ({ subjectId }) => {
    await cancelDeclaration(db, subjectId);
    return { ok: true };
  });

  // Préférences de notification du joueur.
  route('GET', '/player/notifications', 'player', async ({ subjectId }) => {
    const p = await playerOf(subjectId);
    const subs = await db.one('SELECT COUNT(*)::int AS n FROM push_subscriptions WHERE player_id = $1', [p.id]);
    return { email: p.email, push_devices: subs.n, push_key: notifier.pushPublicKey, mail_enabled: notifier.mailEnabled };
  });

  route('PUT', '/player/email', 'player', async ({ body, subjectId }) => {
    await db.query('UPDATE players SET email = $1 WHERE id = $2', [email(body.email), subjectId]);
    return { ok: true };
  });

  route('POST', '/player/push/subscribe', 'player', ({ body, subjectId }) =>
    subscribePush('push_subscriptions', 'player_id', subjectId, body.subscription),
  );
  route('POST', '/player/push/unsubscribe', 'player', ({ body, subjectId }) =>
    unsubscribePush('push_subscriptions', 'player_id', subjectId, body.endpoint),
  );

  // La victime répond à une déclaration de kill la concernant.
  async function incomingContract(playerId) {
    const c = await db.one("SELECT * FROM contracts WHERE target_id = $1 AND status = 'pending'", [playerId]);
    if (!c) throw new GameError('Aucune déclaration de kill vous concernant.');
    return c;
  }
  route('POST', '/player/incoming/confirm', 'player', async ({ subjectId }) => {
    notify(await confirmKill(db, (await incomingContract(subjectId)).id, 'target'));
    return { ok: true };
  });
  route('POST', '/player/incoming/contest', 'player', async ({ subjectId }) => {
    notify(await contestKill(db, (await incomingContract(subjectId)).id));
    return { ok: true };
  });

  // ---------- Gestionnaire ----------

  const cors = {
    'access-control-allow-origin': allowedOrigin,
    'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'access-control-allow-headers': `content-type, ${TOKEN_HEADER}`,
    'access-control-max-age': '86400',
    vary: 'origin',
  };
  const json = (status, data) =>
    new Response(JSON.stringify(data), { status, headers: { ...cors, 'content-type': 'application/json; charset=utf-8' } });

  return async function handle(request) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    // L'URL est /functions/v1/api/<route> chez Supabase et /api/<route> en local.
    const path = new URL(request.url).pathname.replace(/^.*?\/api(?=\/|$)/, '') || '/';
    try {
      for (const r of routes) {
        if (r.method !== request.method) continue;
        const m = r.regex.exec(path);
        if (!m) continue;
        const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
        const token = request.headers.get(TOKEN_HEADER) || '';
        let subjectId = null;
        if (r.auth) {
          const session = await readSession(db, r.auth, token);
          if (!session) return json(401, { error: 'Non connecté.' });
          subjectId = session.subject_id;
        }
        let body = {};
        if (request.method !== 'GET') {
          const text = await request.text();
          if (text) {
            try {
              body = JSON.parse(text);
            } catch {
              return json(400, { error: 'JSON invalide.' });
            }
          }
        }
        const ip = (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'inconnue';
        const out = await r.handler({ params, body, token, subjectId, ip });
        return out?.[CREATED] ? json(201, out[CREATED]) : json(200, out);
      }
      return json(404, { error: 'Route inconnue.' });
    } catch (err) {
      if (err instanceof GameError) return json(err.status, { error: err.message });
      console.error(err);
      return json(500, { error: 'Erreur interne du serveur.' });
    }
  };
}
