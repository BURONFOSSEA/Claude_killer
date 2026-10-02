// Notifications des joueurs : push navigateur (Web Push) et e-mail (SMTP).
// Les messages ne contiennent jamais le nom de la cible ni le défi : un écran verrouillé
// ou une boîte mail partagée ne doit rien révéler. Le joueur ouvre l'appli pour voir les détails.
import webpush from 'web-push';
import nodemailer from 'nodemailer';
import { getSetting, setSetting } from './db.js';

const MESSAGES = {
  game_started: (ctx) => ({
    title: `🔪 La partie « ${ctx.game} » commence !`,
    body: "Ta cible et ton défi t'attendent. Ouvre l'appli, discrètement…",
  }),
  kill_declared: () => ({
    title: "⚠️ Quelqu'un affirme t'avoir éliminé",
    body: "Ouvre l'appli pour confirmer ou contester.",
  }),
  kill_confirmed: () => ({
    title: '✅ Kill validé !',
    body: "Une nouvelle cible t'attend dans l'appli.",
  }),
  target_removed: () => ({
    title: '🔄 Nouvelle cible',
    body: "Ta cible a quitté la partie : une nouvelle cible t'attend dans l'appli.",
  }),
  kill_contested: () => ({
    title: '✋ Kill contesté',
    body: "Ta cible conteste. L'organisateur pourra trancher ; en attendant, ta mission continue.",
  }),
  kill_rejected: () => ({
    title: "❌ Kill refusé par l'organisateur",
    body: 'Ta mission continue : même cible, même défi.',
  }),
  challenge_changed: () => ({
    title: '✏️ Ton défi a changé',
    body: "L'organisateur a modifié ton défi. Ouvre l'appli pour le découvrir.",
  }),
  you_were_killed: () => ({
    title: '💀 Tu as été éliminé',
    body: "Merci d'avoir joué ! Chut… ne révèle rien aux survivants.",
  }),
  you_were_removed: () => ({
    title: "Tu as été retiré de la partie",
    body: "L'organisateur t'a retiré de la partie.",
  }),
  game_finished: (ctx) => ({
    title: ctx.isWinner ? '🏆 Tu as gagné !' : `🏁 La partie « ${ctx.game} » est terminée`,
    body: ctx.isWinner
      ? 'Tu es le dernier survivant. Bravo !'
      : ctx.winner
        ? `Vainqueur : ${ctx.winner}. Découvre le classement dans l'appli.`
        : "Découvre le classement dans l'appli.",
  }),
};

export function messageFor(evt, ctx) {
  const make = MESSAGES[evt.type];
  return make ? make(ctx) : null;
}

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

function emailHtml({ title, body, url, playerName }) {
  return `<!doctype html><html lang="fr"><body style="margin:0;background:#0f0f12;font-family:Arial,sans-serif;color:#f1f1f4">
  <div style="max-width:480px;margin:0 auto;padding:32px 20px">
    <div style="font-size:28px;letter-spacing:3px;font-weight:bold">KILL<span style="color:#e5383b">ER</span></div>
    <div style="background:#18181d;border:1px solid #2e2e37;border-radius:14px;padding:24px;margin-top:20px">
      <p style="margin:0 0 6px;color:#a2a2ad">Salut ${esc(playerName)},</p>
      <h1 style="font-size:20px;margin:0 0 12px">${esc(title)}</h1>
      <p style="margin:0 0 20px;line-height:1.5">${esc(body)}</p>
      <a href="${esc(url)}" style="display:inline-block;background:#e5383b;color:#fff;text-decoration:none;font-weight:bold;padding:12px 20px;border-radius:10px">Ouvrir le jeu</a>
    </div>
    <p style="font-size:12px;color:#a2a2ad;margin-top:16px">Tu reçois ce message parce que tu participes à une partie de Killer.
    Pour ne plus recevoir d'e-mails, efface ton adresse dans l'onglet notifications de l'appli.</p>
  </div></body></html>`;
}

// ---------- Transports ----------

export function createMailerFromEnv(env = process.env) {
  if (!env.SMTP_HOST) return null;
  const port = Number(env.SMTP_PORT) || 587;
  const transporter = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port,
    secure: env.SMTP_SECURE ? env.SMTP_SECURE === 'true' : port === 465,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
  });
  const from = env.MAIL_FROM || env.SMTP_USER;
  return { send: (mail) => transporter.sendMail({ from, ...mail }) };
}

// Clés VAPID : prises dans l'environnement, sinon générées une fois et conservées en base.
export function createPushFromEnv(db, env = process.env) {
  let publicKey = env.VAPID_PUBLIC_KEY;
  let privateKey = env.VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) {
    publicKey = getSetting(db, 'vapid_public_key');
    privateKey = getSetting(db, 'vapid_private_key');
    if (!publicKey || !privateKey) {
      ({ publicKey, privateKey } = webpush.generateVAPIDKeys());
      setSetting(db, 'vapid_public_key', publicKey);
      setSetting(db, 'vapid_private_key', privateKey);
    }
  }
  const subject =
    env.VAPID_SUBJECT ||
    (env.PUBLIC_URL?.startsWith('https://') ? env.PUBLIC_URL : `mailto:${env.MAIL_FROM || 'killer@example.com'}`);
  const vapidDetails = { subject, publicKey, privateKey };
  return {
    publicKey,
    send: (subscription, payload) => webpush.sendNotification(subscription, payload, { vapidDetails, TTL: 24 * 3600 }),
  };
}

// ---------- Distribution ----------

export function createNotifier({ db, mailer = null, push = null, logger = console }) {
  const playerStmt = db.prepare('SELECT id, name, email FROM players WHERE id = ?');
  const subsStmt = db.prepare('SELECT * FROM push_subscriptions WHERE player_id = ?');
  const dropSub = db.prepare('DELETE FROM push_subscriptions WHERE id = ?');

  async function sendPush(player, msg, url) {
    if (!push) return;
    const payload = JSON.stringify({ title: msg.title, body: msg.body, url, tag: `killer-${player.id}` });
    for (const sub of subsStmt.all(player.id)) {
      try {
        await push.send({ endpoint: sub.endpoint, keys: JSON.parse(sub.keys_json) }, payload);
      } catch (err) {
        // 404/410 : abonnement expiré ou révoqué par le navigateur → on l'oublie.
        if (err.statusCode === 404 || err.statusCode === 410) dropSub.run(sub.id);
        else logger.error(`[push] joueur ${player.id} :`, err.message);
      }
    }
  }

  async function sendMail(player, msg, url) {
    if (!mailer || !player.email) return;
    try {
      await mailer.send({
        to: player.email,
        subject: msg.title,
        text: `Salut ${player.name},\n\n${msg.body}\n\nOuvrir le jeu : ${url}`,
        html: emailHtml({ ...msg, url, playerName: player.name }),
      });
    } catch (err) {
      logger.error(`[mail] joueur ${player.id} :`, err.message);
    }
  }

  // N'attend pas forcément la fin : les routes appellent dispatch() sans bloquer la réponse.
  async function dispatch(events = [], { baseUrl = '' } = {}) {
    const url = `${baseUrl}/jouer`;
    const jobs = [];
    for (const evt of events) {
      const game = db.prepare('SELECT name, winner_id FROM games WHERE id = ?').get(evt.gameId);
      if (!game) continue;
      const winner = evt.data?.winnerId ? playerStmt.get(evt.data.winnerId)?.name : null;
      for (const playerId of evt.to) {
        const player = playerStmt.get(playerId);
        if (!player) continue;
        const msg = messageFor(evt, { game: game.name, winner, isWinner: evt.data?.winnerId === playerId });
        if (!msg) continue;
        jobs.push(sendPush(player, msg, url), sendMail(player, msg, url));
      }
    }
    await Promise.all(jobs);
  }

  return {
    dispatch,
    pushPublicKey: push?.publicKey ?? null,
    mailEnabled: Boolean(mailer),
  };
}
