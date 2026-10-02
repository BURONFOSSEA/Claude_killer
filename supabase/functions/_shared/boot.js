// Initialisation commune (Edge Function et serveur local) : schéma, compte admin, IA, notifications.
import { migrate } from './db.js';
import { ensureAdmin } from './auth.js';
import { configureAi } from './ai.js';
import { createBrevoMailer, createNotifier, createPush } from './notify.js';
import { createHandler } from './app.js';

export async function boot({ db, env = {}, waitUntil, logger = console }) {
  await migrate(db);
  const created = await ensureAdmin(db, { username: env.ADMIN_USERNAME || 'admin', password: env.ADMIN_PASSWORD });
  if (created) {
    logger.log(`Compte administrateur créé : ${created.username}`);
    if (created.password) logger.log(`Mot de passe généré (à changer depuis l'interface) : ${created.password}`);
  }
  configureAi(env);
  const mailer = createBrevoMailer(env);
  const notifier = createNotifier({ db, mailer, push: await createPush(db, env), logger });
  const siteUrl = (env.SITE_URL || '').replace(/\/$/, '');
  return createHandler({
    db,
    notifier,
    siteUrl,
    allowedOrigin: siteUrl ? new URL(siteUrl).origin : '*',
    waitUntil,
  });
}
