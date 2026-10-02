// Notifications des joueurs : push navigateur (Web Push) et e-mail (API Brevo).
// Les messages ne contiennent jamais le nom de la cible ni le défi : un écran verrouillé
// ou une boîte mail partagée ne doit rien révéler. Le joueur ouvre l'appli pour voir les détails.
import webpush from 'web-push';
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
    title: 'Tu as été retiré de la partie',
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
    Pour ne plus recevoir d'e-mails, efface ton adresse dans l'appli.</p>
  </div></body></html>`;
}

// ---------- Transports ----------

// E-mails via l'API HTTP de Brevo (gratuit : 300 e-mails/jour). Les Edge Functions Supabase
// bloquent le SMTP classique, d'où l'utilisation d'une API HTTP.
export function createBrevoMailer(env = {}, fetchImpl = fetch) {
  if (!env.BREVO_API_KEY || !env.MAIL_FROM) return null;
  // MAIL_FROM : "adresse@exemple.fr" ou "Nom <adresse@exemple.fr>"
  const m = /^\s*(?:(.*?)\s*<([^>]+)>|([^<>\s]+))\s*$/.exec(env.MAIL_FROM);
  const sender = m ? { email: (m[2] || m[3]).trim(), name: (m[1] || 'Killer').trim() || 'Killer' } : { email: env.MAIL_FROM, name: 'Killer' };
  return {
    async send({ to, toName, subject, text, html }) {
      const res = await fetchImpl('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'api-key': env.BREVO_API_KEY, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ sender, to: [{ email: to, name: toName }], subject, textContent: text, htmlContent: html }),
      });
      if (!res.ok) throw new Error(`Brevo ${res.status} : ${(await res.text()).slice(0, 200)}`);
    },
  };
}

// Clés VAPID : prises dans l'environnement, sinon générées une fois et conservées en base.
export async function createPush(db, env = {}) {
  let publicKey = env.VAPID_PUBLIC_KEY;
  let privateKey = env.VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) {
    publicKey = await getSetting(db, 'vapid_public_key');
    privateKey = await getSetting(db, 'vapid_private_key');
    if (!publicKey || !privateKey) {
      ({ publicKey, privateKey } = webpush.generateVAPIDKeys());
      await setSetting(db, 'vapid_public_key', publicKey);
      await setSetting(db, 'vapid_private_key', privateKey);
    }
  }
  const subject =
    env.VAPID_SUBJECT || (env.SITE_URL?.startsWith('https://') ? env.SITE_URL : 'mailto:killer@example.com');
  const vapidDetails = { subject, publicKey, privateKey };
  return {
    publicKey,
    send: (subscription, payload) => webpush.sendNotification(subscription, payload, { vapidDetails, TTL: 24 * 3600 }),
  };
}

// ---------- Distribution ----------

export function createNotifier({ db, mailer = null, push = null, logger = console }) {
  const player = (id) => db.one('SELECT id, name, email FROM players WHERE id = $1', [id]);

  async function sendPush(p, msg, url) {
    if (!push) return;
    const payload = JSON.stringify({ title: msg.title, body: msg.body, url, tag: `killer-${p.id}` });
    for (const sub of await db.query('SELECT * FROM push_subscriptions WHERE player_id = $1', [p.id])) {
      try {
        await push.send({ endpoint: sub.endpoint, keys: JSON.parse(sub.keys_json) }, payload);
      } catch (err) {
        // 404/410 : abonnement expiré ou révoqué par le navigateur → on l'oublie.
        if (err.statusCode === 404 || err.statusCode === 410) await db.query('DELETE FROM push_subscriptions WHERE id = $1', [sub.id]);
        else logger.error(`[push] joueur ${p.id} :`, err.message);
      }
    }
  }

  async function sendMail(p, msg, url) {
    if (!mailer || !p.email) return;
    try {
      await mailer.send({
        to: p.email,
        toName: p.name,
        subject: msg.title,
        text: `Salut ${p.name},\n\n${msg.body}\n\nOuvrir le jeu : ${url}`,
        html: emailHtml({ ...msg, url, playerName: p.name }),
      });
    } catch (err) {
      logger.error(`[mail] joueur ${p.id} :`, err.message);
    }
  }

  async function dispatch(events = [], { siteUrl = '' } = {}) {
    const url = `${siteUrl.replace(/\/$/, '')}/player.html`;
    const jobs = [];
    for (const evt of events) {
      const game = await db.one('SELECT name FROM games WHERE id = $1', [evt.gameId]);
      if (!game) continue;
      const winner = evt.data?.winnerId ? (await player(evt.data.winnerId))?.name : null;
      for (const playerId of evt.to) {
        const p = await player(playerId);
        if (!p) continue;
        const msg = messageFor(evt, { game: game.name, winner, isWinner: evt.data?.winnerId === playerId });
        if (!msg) continue;
        jobs.push(sendPush(p, msg, url), sendMail(p, msg, url));
      }
    }
    await Promise.all(jobs);
  }

  return { dispatch, pushPublicKey: push?.publicKey ?? null, mailEnabled: Boolean(mailer) };
}
