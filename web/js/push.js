// Notifications push (joueur et organisateur) : activation sur l'appareil + carte de réglages.
import { api, esc, toast } from './common.js';

export const pushSupported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
const isStandalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

export const registerWorker = () => navigator.serviceWorker.register('sw.js');

function urlBase64ToUint8Array(base64) {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

/**
 * Carte « Être prévenu » : bouton push + adresse e-mail.
 * @param {object} o
 * @param {string} o.base       préfixe API : '/api/player' ou '/api/admin'
 * @param {HTMLElement} o.root  conteneur de la carte
 * @param {string} o.intro      texte d'explication
 */
export function createNotificationCard({ base, root, intro }) {
  let prefs = null;
  let subscribed = false;

  async function load() {
    try {
      prefs = await api(`${base}/notifications`);
      if (pushSupported) {
        const reg = await registerWorker();
        subscribed = Boolean(await reg.pushManager.getSubscription()) && Notification.permission === 'granted';
      }
    } catch (err) {
      console.error(err);
    }
    render();
  }

  function pushPart() {
    if (!prefs.push_key) return '<p class="small dim">Les notifications push ne sont pas disponibles sur ce serveur.</p>';
    if (!pushSupported) {
      return isIos && !isStandalone
        ? `<p class="small">📱 Sur iPhone : touche <strong>Partager</strong> puis <strong>« Sur l'écran d'accueil »</strong>,
           ouvre le jeu depuis la nouvelle icône, puis active les notifications ici.</p>`
        : '<p class="small dim">Ce navigateur ne gère pas les notifications push.</p>';
    }
    if (Notification.permission === 'denied') {
      return '<p class="small">🔕 Notifications bloquées : autorise-les dans les réglages du navigateur pour ce site.</p>';
    }
    if (subscribed) {
      return `<div class="row spread"><span>✅ Notifications activées sur cet appareil</span>
        <button class="sm ghost" type="button" data-push="off">Désactiver</button></div>`;
    }
    return '<button class="primary block" type="button" data-push="on">🔔 Activer les notifications sur cet appareil</button>';
  }

  function render() {
    if (!prefs) return;
    root.innerHTML = `
      <div class="card">
        <h3>🔔 Être prévenu</h3>
        <p class="small dim">${intro}</p>
        ${pushPart()}
        <form class="mt" data-email-form>
          <label for="${base.replace(/\W/g, '')}-email">E-mail${prefs.mail_enabled ? '' : ' <span class="dim small">(envoi désactivé sur ce serveur)</span>'}</label>
          <div class="row">
            <input id="${base.replace(/\W/g, '')}-email" type="email" autocomplete="email" placeholder="adresse@exemple.fr" value="${esc(prefs.email)}" style="flex:1 1 200px">
            <button type="submit">Enregistrer</button>
          </div>
          <div class="hint">Laisse vide pour ne pas recevoir d'e-mails.</div>
        </form>
      </div>`;
    root.querySelector('[data-email-form]').addEventListener('submit', async (e) => {
      e.preventDefault();
      const value = e.target.querySelector('input').value.trim();
      try {
        await api(`${base}/email`, { method: 'PUT', body: { email: value } });
        prefs.email = value;
        toast(value ? 'E-mail enregistré.' : 'E-mails désactivés.', 'success');
      } catch (err) {
        toast(err.message, 'error');
      }
    });
    root.querySelector('[data-push]')?.addEventListener('click', (e) => (e.target.dataset.push === 'on' ? enable() : disable()));
  }

  async function enable() {
    try {
      if ((await Notification.requestPermission()) !== 'granted') {
        toast('Notifications refusées.', 'error');
        return render();
      }
      const reg = await registerWorker();
      await navigator.serviceWorker.ready;
      const sub =
        (await reg.pushManager.getSubscription()) ||
        (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(prefs.push_key) }));
      await api(`${base}/push/subscribe`, { method: 'POST', body: { subscription: sub.toJSON() } });
      subscribed = true;
      toast('Notifications activées 🔔', 'success');
    } catch (err) {
      toast(`Impossible d'activer les notifications : ${err.message}`, 'error');
    }
    render();
  }

  async function disable({ silent = false } = {}) {
    try {
      const sub = await (await registerWorker()).pushManager.getSubscription();
      if (sub) {
        await api(`${base}/push/unsubscribe`, { method: 'POST', body: { endpoint: sub.endpoint } });
        await sub.unsubscribe();
      }
      subscribed = false;
      if (!silent) toast('Notifications désactivées sur cet appareil.');
    } catch (err) {
      if (!silent) toast(err.message, 'error');
    }
    render();
  }

  return {
    load,
    disable,
    get subscribed() {
      return subscribed;
    },
    clear() {
      prefs = null;
      root.innerHTML = '';
    },
  };
}
