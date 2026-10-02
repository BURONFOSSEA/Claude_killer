// Serveur HTTP : API JSON + fichiers statiques (interface admin et interface joueur).
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, tx } from './src/db.js';
import {
  COOKIE,
  createRateLimiter,
  createSession,
  destroySession,
  destroySubjectSessions,
  ensureAdmin,
  hashPassword,
  normalizeCode,
  parseCookies,
  randomCode,
  readSession,
  verifyPassword,
} from './src/auth.js';
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
  playerView,
  savePlan,
  updateContractChallenge,
  validatePlan,
} from './src/game.js';
import { aiEnabled, generateChallenges, proposeAssignments } from './src/ai.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export function createApp({ db, secureCookies = false } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '200kb' }));

  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy':
        "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:",
    });
    next();
  });

  // Protection CSRF : toute requête modifiante doit être en JSON (impossible depuis un formulaire tiers).
  app.use('/api', (req, res, next) => {
    if (req.method !== 'GET' && !req.is('application/json')) {
      return res.status(415).json({ error: 'Content-Type application/json requis.' });
    }
    next();
  });

  const loginLimiter = createRateLimiter({ max: 10, windowMs: 15 * 60_000 });

  function setSessionCookie(res, kind, session) {
    res.cookie(COOKIE[kind], session.token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: secureCookies,
      maxAge: session.maxAge,
      path: '/',
    });
  }

  function auth(kind) {
    return (req, res, next) => {
      const token = parseCookies(req.headers.cookie)[COOKIE[kind]];
      const session = readSession(db, kind, token);
      if (!session) return res.status(401).json({ error: 'Non connecté.' });
      req.subjectId = session.subject_id;
      req.sessionToken = token;
      next();
    };
  }
  const admin = auth('admin');
  const player = auth('player');

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
  function uniqueCode() {
    for (;;) {
      const code = randomCode(6);
      if (!db.prepare('SELECT 1 FROM players WHERE code = ?').get(code)) return code;
    }
  }
  function playerOf(pid) {
    const p = db.prepare('SELECT * FROM players WHERE id = ?').get(pid);
    if (!p) throw new GameError('Joueur introuvable.', 404);
    return p;
  }
  function contractOf(cid) {
    const c = db.prepare('SELECT * FROM contracts WHERE id = ?').get(cid);
    if (!c) throw new GameError('Contrat introuvable.', 404);
    return c;
  }
  function requireDraft(gameId, what) {
    if (getGame(db, gameId).status !== 'draft') throw new GameError(`Impossible ${what} une fois la partie lancée.`);
  }
  // Toute modification des joueurs invalide la proposition d'attribution.
  const resetPlan = (gameId) => db.prepare('UPDATE games SET plan_json = NULL WHERE id = ?').run(gameId);

  app.get('/api/config', (req, res) => res.json({ ai: aiEnabled() }));

  // ---------------- Admin : session ----------------

  app.post('/api/admin/login', (req, res) => {
    if (loginLimiter.blocked(req.ip)) return res.status(429).json({ error: 'Trop de tentatives, réessayez plus tard.' });
    const row = db.prepare('SELECT * FROM admins WHERE username = ?').get(str(req.body.username, 100));
    if (!row || !verifyPassword(String(req.body.password || ''), row.password_hash)) {
      loginLimiter.fail(req.ip);
      return res.status(401).json({ error: 'Identifiant ou mot de passe incorrect.' });
    }
    loginLimiter.reset(req.ip);
    setSessionCookie(res, 'admin', createSession(db, 'admin', row.id));
    res.json({ ok: true, username: row.username });
  });

  app.post('/api/admin/logout', (req, res) => {
    destroySession(db, parseCookies(req.headers.cookie)[COOKIE.admin]);
    res.clearCookie(COOKIE.admin, { path: '/' });
    res.json({ ok: true });
  });

  app.get('/api/admin/me', admin, (req, res) => {
    const row = db.prepare('SELECT username FROM admins WHERE id = ?').get(req.subjectId);
    res.json({ username: row?.username, ai: aiEnabled() });
  });

  app.post('/api/admin/password', admin, (req, res) => {
    const row = db.prepare('SELECT * FROM admins WHERE id = ?').get(req.subjectId);
    if (!verifyPassword(String(req.body.current || ''), row.password_hash)) throw new GameError('Mot de passe actuel incorrect.', 403);
    const next = String(req.body.next || '');
    if (next.length < 8) throw new GameError('Le nouveau mot de passe doit faire au moins 8 caractères.');
    db.prepare('UPDATE admins SET password_hash = ? WHERE id = ?').run(hashPassword(next), row.id);
    res.json({ ok: true });
  });

  // ---------------- Admin : parties ----------------

  app.get('/api/admin/games', admin, (req, res) => {
    const games = db
      .prepare(
        `SELECT g.id, g.name, g.status, g.started_at, g.ends_at, g.finished_at, g.created_at,
                (SELECT COUNT(*) FROM players p WHERE p.game_id = g.id) AS players,
                (SELECT COUNT(*) FROM players p WHERE p.game_id = g.id AND p.status = 'alive') AS alive
         FROM games g ORDER BY g.created_at DESC, g.id DESC`,
      )
      .all();
    res.json({ games });
  });

  app.post('/api/admin/games', admin, (req, res) => {
    const name = str(req.body.name, 120);
    if (!name) throw new GameError('Donnez un nom à la partie.');
    const info = db
      .prepare('INSERT INTO games (name, theme, ends_at) VALUES (?, ?, ?)')
      .run(name, str(req.body.theme, 2000), optionalDate(req.body.ends_at));
    res.status(201).json({ id: Number(info.lastInsertRowid) });
  });

  app.get('/api/admin/games/:id', admin, (req, res) => res.json(adminGameState(db, id(req.params.id))));

  app.patch('/api/admin/games/:id', admin, (req, res) => {
    const game = getGame(db, id(req.params.id));
    const name = req.body.name !== undefined ? str(req.body.name, 120) : game.name;
    if (!name) throw new GameError('Le nom ne peut pas être vide.');
    const theme = req.body.theme !== undefined ? str(req.body.theme, 2000) : game.theme;
    const endsAt = req.body.ends_at !== undefined ? optionalDate(req.body.ends_at) : game.ends_at;
    db.prepare('UPDATE games SET name = ?, theme = ?, ends_at = ? WHERE id = ?').run(name, theme, endsAt, game.id);
    res.json({ ok: true });
  });

  app.delete('/api/admin/games/:id', admin, (req, res) => {
    const game = getGame(db, id(req.params.id));
    tx(db, () => {
      const ids = db.prepare('SELECT id FROM players WHERE game_id = ?').all(game.id);
      for (const p of ids) destroySubjectSessions(db, 'player', p.id);
      db.prepare('DELETE FROM games WHERE id = ?').run(game.id);
    });
    res.json({ ok: true });
  });

  app.post('/api/admin/games/:id/launch', admin, (req, res) => {
    launchGame(db, id(req.params.id));
    res.json({ ok: true });
  });

  app.post('/api/admin/games/:id/finish', admin, (req, res) => {
    const game = getGame(db, id(req.params.id));
    if (game.status !== 'running') throw new GameError("La partie n'est pas en cours.");
    finishGame(db, game.id, null);
    res.json({ ok: true });
  });

  // ---------------- Admin : joueurs ----------------

  app.post('/api/admin/games/:id/players', admin, (req, res) => {
    const gameId = id(req.params.id);
    requireDraft(gameId, "d'ajouter des joueurs");
    const entries = Array.isArray(req.body.players) ? req.body.players : [req.body];
    const insert = db.prepare('INSERT INTO players (game_id, name, notes, code) VALUES (?, ?, ?, ?)');
    const created = tx(db, () => {
      const out = [];
      for (const e of entries.slice(0, 500)) {
        const name = str(e.name, 80);
        if (!name) continue;
        insert.run(gameId, name, str(e.notes, 1000), uniqueCode());
        out.push(name);
      }
      if (out.length) resetPlan(gameId);
      return out;
    });
    if (!created.length) throw new GameError('Aucun nom de joueur fourni.');
    res.status(201).json({ created: created.length });
  });

  app.patch('/api/admin/players/:pid', admin, (req, res) => {
    const p = playerOf(id(req.params.pid));
    const name = req.body.name !== undefined ? str(req.body.name, 80) : p.name;
    if (!name) throw new GameError('Le nom ne peut pas être vide.');
    const notes = req.body.notes !== undefined ? str(req.body.notes, 1000) : p.notes;
    db.prepare('UPDATE players SET name = ?, notes = ? WHERE id = ?').run(name, notes, p.id);
    res.json({ ok: true });
  });

  app.delete('/api/admin/players/:pid', admin, (req, res) => {
    const p = playerOf(id(req.params.pid));
    requireDraft(p.game_id, 'de supprimer un joueur');
    tx(db, () => {
      destroySubjectSessions(db, 'player', p.id);
      db.prepare('DELETE FROM players WHERE id = ?').run(p.id);
      resetPlan(p.game_id);
    });
    res.json({ ok: true });
  });

  app.post('/api/admin/players/:pid/regenerate-code', admin, (req, res) => {
    const p = playerOf(id(req.params.pid));
    const code = uniqueCode();
    db.prepare('UPDATE players SET code = ? WHERE id = ?').run(code, p.id);
    destroySubjectSessions(db, 'player', p.id);
    res.json({ code });
  });

  app.post('/api/admin/players/:pid/eliminate', admin, (req, res) => {
    res.json(eliminatePlayer(db, id(req.params.pid)));
  });

  // ---------------- Admin : défis ----------------

  app.post('/api/admin/games/:id/challenges', admin, (req, res) => {
    const gameId = getGame(db, id(req.params.id)).id;
    const texts = (Array.isArray(req.body.texts) ? req.body.texts : [req.body.text]).map((t) => str(t, 500)).filter(Boolean);
    if (!texts.length) throw new GameError('Défi vide.');
    const source = ['admin', 'ai', 'library'].includes(req.body.source) ? req.body.source : 'admin';
    const insert = db.prepare('INSERT INTO challenges (game_id, text, source) VALUES (?, ?, ?)');
    tx(db, () => texts.slice(0, 200).forEach((t) => insert.run(gameId, t, source)));
    res.status(201).json({ created: texts.length });
  });

  app.patch('/api/admin/challenges/:cid', admin, (req, res) => {
    const text = str(req.body.text, 500);
    if (!text) throw new GameError('Défi vide.');
    const r = db.prepare('UPDATE challenges SET text = ? WHERE id = ?').run(text, id(req.params.cid));
    if (!r.changes) throw new GameError('Défi introuvable.', 404);
    res.json({ ok: true });
  });

  app.delete('/api/admin/challenges/:cid', admin, (req, res) => {
    db.prepare('DELETE FROM challenges WHERE id = ?').run(id(req.params.cid));
    res.json({ ok: true });
  });

  app.post('/api/admin/games/:id/ai/challenges', admin, async (req, res) => {
    const game = getGame(db, id(req.params.id));
    const existing = db.prepare('SELECT text FROM challenges WHERE game_id = ?').all(game.id).map((c) => c.text);
    res.json(
      await generateChallenges({
        theme: game.theme,
        count: req.body.count,
        existing,
        instructions: str(req.body.instructions, 1000),
      }),
    );
  });

  // ---------------- Admin : attribution des cibles ----------------

  function planContext(gameId) {
    requireDraft(gameId, "de modifier l'attribution");
    const players = db.prepare('SELECT id, name, notes FROM players WHERE game_id = ?').all(gameId);
    if (players.length < 3) throw new GameError('Ajoutez au moins 3 joueurs.');
    const challenges = db.prepare('SELECT id, text FROM challenges WHERE game_id = ?').all(gameId);
    return { players, challenges };
  }

  app.post('/api/admin/games/:id/plan/random', admin, (req, res) => {
    const gameId = id(req.params.id);
    const { players, challenges } = planContext(gameId);
    if (!challenges.length) throw new GameError("Ajoutez des défis avant le tirage (ou utilisez l'IA).");
    const plan = savePlan(db, gameId, buildRandomPlan(players.map((p) => p.id), challenges.map((c) => c.text)));
    res.json({ source: 'random', plan, errors: [] });
  });

  app.post('/api/admin/games/:id/plan/ai', admin, async (req, res) => {
    const game = getGame(db, id(req.params.id));
    const { players, challenges } = planContext(game.id);
    const result = await proposeAssignments({
      theme: game.theme,
      players,
      challenges,
      instructions: str(req.body.instructions, 1000),
    });
    const plan = savePlan(db, game.id, result.plan);
    res.json({ ...result, plan, errors: validatePlan(plan, players.map((p) => p.id)) });
  });

  app.put('/api/admin/games/:id/plan', admin, (req, res) => {
    const gameId = id(req.params.id);
    const { players } = planContext(gameId);
    if (!Array.isArray(req.body.plan)) throw new GameError('Plan invalide.');
    const plan = savePlan(db, gameId, req.body.plan);
    res.json({ plan, errors: validatePlan(plan, players.map((p) => p.id)) });
  });

  // ---------------- Admin : contrats en cours ----------------

  app.post('/api/admin/contracts/:cid/confirm', admin, (req, res) => {
    res.json(confirmKill(db, contractOf(id(req.params.cid)).id, 'admin'));
  });

  app.post('/api/admin/contracts/:cid/reject', admin, (req, res) => {
    contestKill(db, contractOf(id(req.params.cid)).id);
    res.json({ ok: true });
  });

  app.patch('/api/admin/contracts/:cid', admin, (req, res) => {
    updateContractChallenge(db, contractOf(id(req.params.cid)).id, str(req.body.challenge_text, 500));
    res.json({ ok: true });
  });

  // ---------------- Joueur ----------------

  app.post('/api/player/login', (req, res) => {
    if (loginLimiter.blocked(req.ip)) return res.status(429).json({ error: 'Trop de tentatives, réessayez plus tard.' });
    const row = db.prepare('SELECT * FROM players WHERE code = ?').get(normalizeCode(req.body.code));
    if (!row) {
      loginLimiter.fail(req.ip);
      return res.status(401).json({ error: 'Code inconnu.' });
    }
    loginLimiter.reset(req.ip);
    setSessionCookie(res, 'player', createSession(db, 'player', row.id));
    res.json({ ok: true });
  });

  app.post('/api/player/logout', (req, res) => {
    destroySession(db, parseCookies(req.headers.cookie)[COOKIE.player]);
    res.clearCookie(COOKIE.player, { path: '/' });
    res.json({ ok: true });
  });

  app.get('/api/player/me', player, (req, res) => res.json(playerView(db, req.subjectId)));

  app.post('/api/player/kill', player, (req, res) => {
    declareKill(db, req.subjectId);
    res.json({ ok: true });
  });

  app.post('/api/player/kill/cancel', player, (req, res) => {
    cancelDeclaration(db, req.subjectId);
    res.json({ ok: true });
  });

  // La victime répond à une déclaration de kill la concernant.
  function incomingContract(playerId) {
    const c = db.prepare("SELECT * FROM contracts WHERE target_id = ? AND status = 'pending'").get(playerId);
    if (!c) throw new GameError('Aucune déclaration de kill vous concernant.');
    return c;
  }
  app.post('/api/player/incoming/confirm', player, (req, res) => {
    confirmKill(db, incomingContract(req.subjectId).id, 'target');
    res.json({ ok: true });
  });
  app.post('/api/player/incoming/contest', player, (req, res) => {
    contestKill(db, incomingContract(req.subjectId).id);
    res.json({ ok: true });
  });

  app.use('/api', (req, res) => res.status(404).json({ error: 'Route inconnue.' }));

  // ---------------- Pages ----------------

  const pub = path.join(here, 'public');
  app.use(express.static(pub, { extensions: ['html'] }));
  app.get('/jouer', (req, res) => res.sendFile(path.join(pub, 'player.html')));

  app.use((err, req, res, next) => {
    if (err instanceof GameError) return res.status(err.status).json({ error: err.message });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON invalide.' });
    console.error(err);
    res.status(500).json({ error: 'Erreur interne du serveur.' });
  });

  return app;
}

// Démarrage direct : `node server.js`
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const db = openDb(process.env.DATABASE_PATH || path.join(here, 'data', 'killer.db'));
  const created = ensureAdmin(db, {
    username: process.env.ADMIN_USERNAME || 'admin',
    password: process.env.ADMIN_PASSWORD,
  });
  if (created) {
    console.log(`Compte administrateur créé : ${created.username}`);
    if (created.password) console.log(`Mot de passe généré (à changer depuis l'interface) : ${created.password}`);
  }
  const port = Number(process.env.PORT) || 3000;
  createApp({ db, secureCookies: process.env.COOKIE_SECURE === 'true' }).listen(port, () => {
    console.log(`Killer Game prêt sur http://localhost:${port}`);
    console.log(aiEnabled() ? 'IA : activée (Claude).' : 'IA : désactivée (définissez ANTHROPIC_API_KEY pour l’activer).');
  });
}
