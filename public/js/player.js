import { api, esc, $, toast, formatDuration, formatClock, formatDate, ago } from './common.js';

let state = null;
let revealed = false; // la cible reste masquée tant que le joueur ne tape pas dessus
let pollTimer = null;

async function boot() {
  // Lien direct /jouer#CODE fourni par l'organisateur : connexion automatique.
  const hashCode = decodeURIComponent(location.hash.slice(1));
  if (hashCode) {
    history.replaceState(null, '', location.pathname);
    try {
      await api('/api/player/login', { method: 'POST', body: { code: hashCode } });
    } catch (err) {
      toast(err.message, 'error');
    }
  }
  await load();
}

async function load() {
  try {
    state = await api('/api/player/me');
    showApp();
    render();
    loadNotifications();
  } catch (err) {
    if (err.status === 401) showLogin();
    else toast(err.message, 'error');
  }
}

function showLogin() {
  clearInterval(pollTimer);
  $('#app').classList.add('hidden');
  $('#login').classList.remove('hidden');
  $('#code').focus();
}

function showApp() {
  $('#login').classList.add('hidden');
  $('#app').classList.remove('hidden');
  clearInterval(pollTimer);
  pollTimer = setInterval(() => !document.hidden && refresh(), 15000);
}

async function refresh() {
  try {
    state = await api('/api/player/me');
    render();
  } catch (err) {
    if (err.status === 401) showLogin();
  }
}

function render() {
  const { me, game, target, incoming, death, stats, kills, final } = state;
  const parts = [];

  parts.push(`
    <div class="row spread">
      <div>
        <div class="eyebrow">${esc(game.name)}</div>
        <h2 class="mb-0">${esc(me.name)}</h2>
      </div>
      ${statusBadge()}
    </div>`);

  // Chronos : temps écoulé depuis le début, temps restant avant la fin prévue.
  if (game.started_at) {
    parts.push(`
      <div class="grid cols-2 mt">
        <div class="stat"><div class="timer" data-clock-since="${esc(game.started_at)}" data-clock-until="${esc(game.finished_at || '')}">--:--:--</div><div class="k">depuis le début de la partie</div></div>
        ${
          game.ends_at && game.status === 'running'
            ? `<div class="stat"><div class="timer" data-countdown="${esc(game.ends_at)}">--:--:--</div><div class="k">avant la fin (${esc(formatDate(game.ends_at))})</div></div>`
            : game.status === 'finished'
              ? `<div class="stat"><div class="timer">FIN</div><div class="k">terminée le ${esc(formatDate(game.finished_at))}</div></div>`
              : ''
        }
      </div>`);
  }

  if (game.status === 'draft') {
    parts.push(`
      <div class="card warn mt">
        <h3>⏳ La partie n'a pas encore commencé</h3>
        <p class="dim mb-0">Ta cible et ton défi apparaîtront ici dès que l'organisateur lancera la partie${
          game.ends_at ? ` (fin prévue le ${esc(formatDate(game.ends_at))})` : ''
        }. Garde cette page ouverte ou reviens plus tard.</p>
      </div>`);
  }

  if (incoming) {
    parts.push(`
      <div class="card accent mt">
        <div class="eyebrow">⚠️ Alerte</div>
        <h3><strong>${esc(incoming.killer)}</strong> affirme t'avoir éliminé !</h3>
        <p>Défi annoncé : <em>« ${esc(incoming.challenge)} »</em></p>
        <p class="small dim">Sois fair-play : si le défi a vraiment été réalisé, confirme ta mort.</p>
        <div class="grid cols-2">
          <button class="primary" data-action="confirm-death">💀 Oui, je suis mort</button>
          <button data-action="contest">✋ Non, je conteste</button>
        </div>
      </div>`);
  }

  if (target) {
    parts.push(`
      <div class="card accent mt reveal">
        <div class="eyebrow">🎯 Ta cible</div>
        <div class="target-name">${esc(target.name)}</div>
        <div class="eyebrow">Ton défi</div>
        <div class="challenge">${esc(target.challenge)}</div>
        <p class="small dim mt mb-0">Cible attribuée ${esc(ago(target.since))}</p>
        ${
          revealed
            ? ''
            : `<div class="veil" data-action="reveal" role="button" tabindex="0">
                 <div class="timer">🔒</div>
                 <strong>Touche pour révéler ta cible</strong>
                 <span class="small dim">Assure-toi que personne ne regarde ton écran.</span>
               </div>`
        }
      </div>`);
    parts.push(
      target.pending
        ? `<div class="card warn">
             <h3>⏳ Kill déclaré</h3>
             <p class="dim">En attente de la confirmation de ta cible (ou de l'organisateur).</p>
             <button class="block" data-action="cancel-kill">Annuler la déclaration</button>
           </div>`
        : `<button class="primary block big" data-action="declare-kill">⚔️ J'ai éliminé ma cible</button>`,
    );
    if (revealed) parts.push(`<button class="ghost block sm mt" data-action="hide">🙈 Masquer la cible</button>`);
  }

  if (death) {
    parts.push(`
      <div class="card mt">
        <div class="eyebrow">💀 Éliminé</div>
        <h3>${death.by ? `Tu as été éliminé par <strong>${esc(death.by)}</strong>` : "Tu as été retiré de la partie par l'organisateur"}</h3>
        ${death.challenge ? `<p>Avec le défi : <em>« ${esc(death.challenge)} »</em></p>` : ''}
        <p class="small dim mb-0">Le ${esc(formatDate(death.at))}. Chut… ne révèle rien aux survivants !</p>
      </div>`);
  }

  if (final) {
    parts.push(`
      <div class="card ok mt">
        <div class="eyebrow">🏆 Partie terminée</div>
        <h3>${final.winner ? `Vainqueur : <strong>${esc(final.winner)}</strong>` : "Partie arrêtée par l'organisateur"}</h3>
        ${final.winner && final.winner === me.name ? '<p>🎉 Félicitations, tu es le dernier survivant !</p>' : ''}
        <ol class="list">
          ${final.ranking
            .map(
              (r, i) => `<li><span class="dim">${i + 1}.</span><span class="grow">${esc(r.name)}</span>
                <span class="small dim">${r.kills} kill${r.kills > 1 ? 's' : ''}</span>
                ${r.status === 'alive' ? '<span class="badge alive">survivant</span>' : ''}</li>`,
            )
            .join('')}
        </ol>
      </div>`);
  }

  // Statistiques personnelles (jamais le nombre de joueurs restants).
  if (game.status !== 'draft') {
    const endOfLife = me.eliminated_at || game.finished_at;
    parts.push(`
      <h3 class="mt-lg">📊 Tes statistiques</h3>
      <div class="grid pair">
        <div class="stat"><div class="v">${stats.kills}</div><div class="k">kill${stats.kills > 1 ? 's' : ''}</div></div>
        <div class="stat"><div class="v" data-clock-since="${esc(game.started_at)}" data-clock-until="${esc(endOfLife || '')}" data-format="duration">—</div><div class="k">${me.status === 'alive' ? 'de survie' : 'de survie au total'}</div></div>
        <div class="stat"><div class="v">${esc(formatDuration(stats.fastest_kill_ms))}</div><div class="k">kill le plus rapide</div></div>
        <div class="stat"><div class="v">${esc(formatDuration(stats.average_kill_ms))}</div><div class="k">temps moyen par kill</div></div>
      </div>
      <p class="small dim mt">Dernière élimination dans la partie : ${stats.last_game_kill_at ? esc(ago(stats.last_game_kill_at)) : 'aucune pour le moment'}.</p>`);
  }

  if (kills.length) {
    parts.push(`
      <h3 class="mt-lg">🗡️ Tes victimes</h3>
      <ul class="list">
        ${kills
          .map(
            (k) => `<li><div class="grow"><strong>${esc(k.victim)}</strong>
              <div class="small dim">${esc(k.challenge || '')}</div></div>
              <div class="small dim center">${esc(formatDate(k.at))}<br>${k.duration_ms != null ? `en ${esc(formatDuration(k.duration_ms))}` : ''}</div></li>`,
          )
          .join('')}
      </ul>`);
  }

  $('#view').innerHTML = parts.join('');
  tick();
}

function statusBadge() {
  const { me, game } = state;
  if (game.status === 'draft') return '<span class="badge draft">En attente</span>';
  if (game.status === 'finished' && me.status === 'alive') return '<span class="badge alive">🏆 Vainqueur</span>';
  if (me.status === 'dead') return '<span class="badge dead">Éliminé</span>';
  if (game.status === 'finished') return '<span class="badge finished">Terminée</span>';
  return '<span class="badge alive">En vie</span>';
}

// Mise à jour des chronos chaque seconde, sans rappeler le serveur.
function tick() {
  const now = Date.now();
  for (const el of document.querySelectorAll('[data-clock-since]')) {
    if (!el.dataset.clockSince) continue;
    const end = el.dataset.clockUntil ? new Date(el.dataset.clockUntil).getTime() : now;
    const ms = end - new Date(el.dataset.clockSince).getTime();
    el.textContent = el.dataset.format === 'duration' ? formatDuration(ms) : formatClock(ms);
  }
  for (const el of document.querySelectorAll('[data-countdown]')) {
    const ms = new Date(el.dataset.countdown).getTime() - now;
    el.textContent = ms > 0 ? formatClock(ms) : 'Temps écoulé';
  }
}
setInterval(tick, 1000);

async function act(path, successMessage) {
  try {
    await api(path, { method: 'POST' });
    if (successMessage) toast(successMessage, 'success');
  } catch (err) {
    toast(err.message, 'error');
  }
  await refresh();
}

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  switch (el.dataset.action) {
    case 'reveal':
      revealed = true;
      render();
      break;
    case 'hide':
      revealed = false;
      render();
      break;
    case 'declare-kill':
      if (confirm(`Confirmes-tu avoir réalisé ton défi sur ${state.target.name} ?\nTa cible devra confirmer.`)) {
        await act('/api/player/kill', 'Kill déclaré ! En attente de confirmation.');
      }
      break;
    case 'cancel-kill':
      await act('/api/player/kill/cancel', 'Déclaration annulée.');
      break;
    case 'confirm-death':
      if (confirm('Tu confirmes avoir été éliminé ? Cette action est définitive.')) {
        await act('/api/player/incoming/confirm', 'Repose en paix… 💀');
      }
      break;
    case 'contest':
      await act('/api/player/incoming/contest', "Contestation envoyée. L'organisateur pourra trancher.");
      break;
  }
});

document.addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.dataset?.action === 'reveal') {
    e.preventDefault();
    e.target.click();
  }
});

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/api/player/login', { method: 'POST', body: { code: $('#code').value } });
    $('#code').value = '';
    await load();
  } catch (err) {
    toast(err.message, 'error');
  }
});

$('#logoutBtn').addEventListener('click', async () => {
  // Sur un appareil partagé, le joueur suivant ne doit pas recevoir les notifications du précédent.
  if (deviceSubscribed) await disablePush();
  await api('/api/player/logout', { method: 'POST' }).catch(() => {});
  revealed = false;
  notif = null;
  $('#notif').innerHTML = '';
  showLogin();
});
$('#refreshBtn').addEventListener('click', refresh);

// ---------------------------------------------------------------- notifications

const pushSupported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
const isStandalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
let notif = null; // { email, push_key, mail_enabled }
let deviceSubscribed = false;

async function registration() {
  return navigator.serviceWorker.register('/sw.js');
}

async function loadNotifications() {
  try {
    notif = await api('/api/player/notifications');
    if (pushSupported) {
      const reg = await registration();
      deviceSubscribed = Boolean(await reg.pushManager.getSubscription()) && Notification.permission === 'granted';
    }
  } catch (err) {
    console.error(err);
  }
  renderNotifications();
}

function renderNotifications() {
  if (!notif) return;
  let pushPart;
  if (!notif.push_key) {
    pushPart = '<p class="small dim">Les notifications push ne sont pas disponibles sur ce serveur.</p>';
  } else if (!pushSupported) {
    pushPart = isIos && !isStandalone
      ? `<p class="small">📱 Sur iPhone : touche <strong>Partager</strong> puis <strong>« Sur l'écran d'accueil »</strong>,
         ouvre le jeu depuis la nouvelle icône, puis active les notifications ici.</p>`
      : '<p class="small dim">Ton navigateur ne gère pas les notifications push.</p>';
  } else if (Notification.permission === 'denied') {
    pushPart = '<p class="small">🔕 Notifications bloquées : autorise-les dans les réglages de ton navigateur pour ce site.</p>';
  } else if (deviceSubscribed) {
    pushPart = `<div class="row spread"><span>✅ Notifications activées sur cet appareil</span>
      <button class="sm ghost" data-action="push-off">Désactiver</button></div>`;
  } else {
    pushPart = '<button class="primary block" data-action="push-on">🔔 Activer les notifications sur cet appareil</button>';
  }
  $('#notif').innerHTML = `
    <div class="card mt-lg">
      <h3>🔔 Être prévenu</h3>
      <p class="small dim">Lancement de la partie, nouvelle cible, kill à confirmer, fin de partie… Les messages ne
        révèlent jamais ta cible : ouvre l'appli pour voir les détails.</p>
      ${pushPart}
      <form id="emailForm" class="mt">
        <label for="email">E-mail${notif.mail_enabled ? '' : ' <span class="dim small">(envoi désactivé sur ce serveur)</span>'}</label>
        <div class="row">
          <input id="email" type="email" autocomplete="email" placeholder="toi@exemple.fr" value="${esc(notif.email)}" style="flex:1 1 200px">
          <button type="submit">Enregistrer</button>
        </div>
        <div class="hint">Laisse vide pour ne pas recevoir d'e-mails.</div>
      </form>
    </div>`;
  $('#emailForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/api/player/email', { method: 'PUT', body: { email: $('#email').value } });
      notif.email = $('#email').value.trim();
      toast(notif.email ? 'E-mail enregistré.' : 'E-mails désactivés.', 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}

function urlBase64ToUint8Array(base64) {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

async function enablePush() {
  try {
    if ((await Notification.requestPermission()) !== 'granted') {
      toast('Notifications refusées.', 'error');
      return renderNotifications();
    }
    const reg = await registration();
    await navigator.serviceWorker.ready;
    const sub =
      (await reg.pushManager.getSubscription()) ||
      (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(notif.push_key) }));
    await api('/api/player/push/subscribe', { method: 'POST', body: { subscription: sub.toJSON() } });
    deviceSubscribed = true;
    toast('Notifications activées 🔔', 'success');
  } catch (err) {
    toast(`Impossible d'activer les notifications : ${err.message}`, 'error');
  }
  renderNotifications();
}

async function disablePush() {
  try {
    const sub = await (await registration()).pushManager.getSubscription();
    if (sub) {
      await api('/api/player/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } });
      await sub.unsubscribe();
    }
    deviceSubscribed = false;
    toast('Notifications désactivées sur cet appareil.');
  } catch (err) {
    toast(err.message, 'error');
  }
  renderNotifications();
}

document.addEventListener('click', (e) => {
  const action = e.target.closest('[data-action]')?.dataset.action;
  if (action === 'push-on') enablePush();
  if (action === 'push-off') disablePush();
});

// Clic sur une notification alors que la page est ouverte, ou retour sur l'onglet : on rafraîchit.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (e) => e.data?.type === 'refresh' && refresh());
}
document.addEventListener('visibilitychange', () => !document.hidden && !$('#app').classList.contains('hidden') && refresh());

boot();
