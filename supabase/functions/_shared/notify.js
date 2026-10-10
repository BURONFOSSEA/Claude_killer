// Notifications des joueurs : push navigateur (Web Push) et e-mail (API Brevo).
// Les messages ne contiennent jamais le nom de la cible ni le défi : un écran verrouillé
// ou une boîte mail partagée ne doit rien révéler. Le joueur ouvre l'appli pour voir les détails.
import webpush from 'web-push';
import { getSetting, setSetting } from './db.js';

const preview = (text, max = 140) => {
  const t = String(text ?? '');
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

// Messages destinés aux joueurs.
const MESSAGES = {
  message_received: (ctx) => ({
    title: "💬 Message de l'organisateur",
    body: preview(ctx.body),
  }),
  kill_declared_reminder: () => ({
    title: '⏳ On attend ta réponse',
    body: "Quelqu'un affirme toujours t'avoir éliminé : confirme ou conteste dans l'appli.",
  }),
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

// Messages destinés à l'organisateur : lui a le droit de tout savoir.
const ADMIN_MESSAGES = {
  admin_kill_declared: (c) => ({
    title: `⏳ Kill déclaré · ${c.game}`,
    body: `${c.killer} affirme avoir éliminé ${c.victim}. En attente de confirmation.`,
  }),
  admin_kill_contested: (c) => ({
    title: `✋ Kill contesté · ${c.game}`,
    body: `${c.victim} conteste le kill de ${c.killer} : à vous de trancher.`,
  }),
  admin_kill_confirmed: (c) => ({
    title: `💀 ${c.killer} a éliminé ${c.victim}`,
    body: `Partie « ${c.game} » : kill confirmé par la victime.`,
  }),
  admin_kill_pending: (c) => ({
    title: `⏰ Kill en attente · ${c.game}`,
    body: `${c.killer} → ${c.victim} : la cible n'a toujours pas répondu. Vous pouvez valider ou refuser.`,
  }),
  admin_game_finished: (c) => ({
    title: `🏆 Partie « ${c.game} » terminée`,
    body: `Vainqueur : ${c.winner}.`,
  }),
  admin_message: (c) => ({
    title: `💬 ${c.player} · ${c.game}`,
    body: preview(c.body),
  }),
};

export function messageFor(evt, ctx) {
  const make = (evt.admins ? ADMIN_MESSAGES : MESSAGES)[evt.type];
  return make ? make(ctx) : null;
}

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

function emailHtml({ title, body, url, greeting }) {
  return `<!doctype html><html lang="fr"><body style="margin:0;background:#0f0f12;font-family:Arial,sans-serif;color:#f1f1f4">
  <div style="max-width:480px;margin:0 auto;padding:32px 20px">
    <div style="font-size:28px;letter-spacing:3px;font-weight:bold">KILL<span style="color:#e5383b">ER</span></div>
    <div style="background:#18181d;border:1px solid #2e2e37;border-radius:14px;padding:24px;margin-top:20px">
      <p style="margin:0 0 6px;color:#a2a2ad">${esc(greeting)}</p>
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
  const name = async (id) => (id ? (await db.one('SELECT name FROM players WHERE id = $1', [id]))?.name ?? '?' : null);

  // Envoie à tous les appareils abonnés ; les abonnements expirés sont supprimés.
  async function sendPush(subscriptions, table, msg, url, tag) {
    if (!push) return;
    const payload = JSON.stringify({ title: msg.title, body: msg.body, url, tag });
    for (const sub of subscriptions) {
      try {
        await push.send({ endpoint: sub.endpoint, keys: JSON.parse(sub.keys_json) }, payload);
      } catch (err) {
        // 404/410 : abonnement expiré ou révoqué par le navigateur → on l'oublie.
        if (err.statusCode === 404 || err.statusCode === 410) await db.query(`DELETE FROM ${table} WHERE id = $1`, [sub.id]);
        else logger.error('[push]', err.message);
      }
    }
  }

  async function sendMail(to, toName, greeting, msg, url) {
    if (!mailer || !to) return;
    try {
      await mailer.send({
        to,
        toName,
        subject: msg.title,
        text: `${greeting}\n\n${msg.body}\n\nOuvrir le jeu : ${url}`,
        html: emailHtml({ ...msg, url, greeting }),
      });
    } catch (err) {
      logger.error('[mail]', err.message);
    }
  }

  async function dispatch(events = [], { siteUrl = '' } = {}) {
    const site = siteUrl.replace(/\/$/, '');
    const jobs = [];
    for (const evt of events) {
      const game = await db.one('SELECT id, name FROM games WHERE id = $1', [evt.gameId]);
      if (!game) continue;
      const d = evt.data || {};
      const ctx = {
        game: game.name,
        body: d.body,
        winner: await name(d.winnerId),
        killer: await name(d.killerId),
        victim: await name(d.victimId),
        player: await name(d.playerId),
      };

      if (evt.admins) {
        const msg = messageFor(evt, ctx);
        if (!msg) continue;
        const url = `${site}/admin.html#/game/${game.id}/${evt.type === 'admin_message' ? 'messages' : 'live'}`;
        for (const admin of await db.query('SELECT id, username, email FROM admins')) {
          const subs = await db.query('SELECT * FROM admin_push_subscriptions WHERE admin_id = $1', [admin.id]);
          jobs.push(sendPush(subs, 'admin_push_subscriptions', msg, url, `killer-admin-${game.id}-${evt.type}`));
          jobs.push(sendMail(admin.email, admin.username, 'Bonjour,', msg, url));
        }
        continue;
      }

      const url = `${site}/player.html`;
      for (const playerId of evt.to) {
        const p = await db.one('SELECT id, name, email FROM players WHERE id = $1', [playerId]);
        if (!p) continue;
        const msg = messageFor(evt, { ...ctx, isWinner: d.winnerId === playerId });
        if (!msg) continue;
        const subs = await db.query('SELECT * FROM push_subscriptions WHERE player_id = $1', [p.id]);
        jobs.push(sendPush(subs, 'push_subscriptions', msg, url, `killer-${p.id}-${evt.type}`));
        jobs.push(sendMail(p.email, p.name, `Salut ${p.name},`, msg, url));
      }
    }
    await Promise.all(jobs);
  }

  return { dispatch, pushPublicKey: push?.publicKey ?? null, mailEnabled: Boolean(mailer) };
}
