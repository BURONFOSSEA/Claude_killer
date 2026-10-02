// Utilitaires partagés par les pages admin et joueur.

// Appel à l'API du jeu (Edge Function Supabase, ou /api en local).
// La session est un jeton conservé dans le navigateur (un pour l'admin, un pour le joueur),
// envoyé dans l'en-tête x-killer-token : les cookies ne fonctionnent pas entre github.io et supabase.co.
const API_URL = (window.KILLER_CONFIG?.apiUrl || '/api').replace(/\/$/, '');
const tokenKey = (path) => (path.startsWith('/api/admin') ? 'killer_admin_token' : 'killer_player_token');

function storage(action, key, value) {
  try {
    if (action === 'get') return localStorage.getItem(key);
    if (action === 'set') localStorage.setItem(key, value);
    if (action === 'remove') localStorage.removeItem(key);
  } catch {
    /* stockage indisponible (navigation privée stricte) */
  }
  return null;
}

export async function api(path, { method = 'GET', body } = {}) {
  const key = tokenKey(path);
  const token = storage('get', key);
  const headers = {};
  if (method !== 'GET') headers['Content-Type'] = 'application/json';
  if (token) headers['x-killer-token'] = token;
  let res;
  try {
    res = await fetch(API_URL + path.replace(/^\/api/, ''), {
      method,
      headers,
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    });
  } catch {
    throw new Error('Serveur injoignable. Vérifie ta connexion et réessaie.');
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* réponse vide */
  }
  if (data?.token) storage('set', key, data.token);
  if (path.endsWith('/logout') || res.status === 401) storage('remove', key);
  if (!res.ok) {
    const err = new Error(data?.error || `Erreur ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

let toastTimer;
export function toast(message, type = 'info') {
  let el = $('#toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.setAttribute('role', 'status');
    document.body.appendChild(el);
  }
  el.className = `toast ${type}`;
  el.textContent = message;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 4000);
}

// Durée lisible : "2 j 3 h", "1 h 05 min", "4 min 12 s"
export function formatDuration(ms) {
  if (ms == null || Number.isNaN(ms)) return '—';
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d) return `${d} j ${h} h`;
  if (h) return `${h} h ${String(m).padStart(2, '0')} min`;
  if (m) return `${m} min ${String(sec).padStart(2, '0')} s`;
  return `${sec} s`;
}

// Chrono "HH:MM:SS" (avec jours si nécessaire)
export function formatClock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400);
  const hh = String(Math.floor((s % 86400) / 3600)).padStart(2, '0');
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${d ? `${d}j ` : ''}${hh}:${mm}:${ss}`;
}

export function formatDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
}

export function ago(iso) {
  if (!iso) return '—';
  return `il y a ${formatDuration(Date.now() - new Date(iso).getTime())}`;
}

// Valeur pour un <input type="datetime-local"> à partir d'une date ISO.
export function toLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export const STATUS_LABEL = { draft: 'Préparation', running: 'En cours', finished: 'Terminée' };
