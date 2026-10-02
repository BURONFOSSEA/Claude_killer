import { api, esc, $, $$, toast, formatDate, formatDuration, ago, toLocalInput, STATUS_LABEL } from './common.js';

let aiOn = false;
let current = null; // état complet de la partie ouverte
let tab = 'players';
let draftPlan = null; // plan en cours d'édition (ordonné selon la boucle)
let planDirty = false;
let planInfo = null; // { source, warning } de la dernière génération
let suggestions = []; // défis proposés par l'IA, en attente de validation
let busy = false;

// ---------------------------------------------------------------- navigation

function route() {
  const [, page, gameId, t] = location.hash.split('/');
  if (page === 'game' && gameId) {
    if (t) tab = t;
    return openGame(Number(gameId));
  }
  if (page === 'password') return renderPassword();
  current = null;
  return renderGames();
}
window.addEventListener('hashchange', route);

async function boot() {
  try {
    const me = await api('/api/admin/me');
    aiOn = me.ai;
    $('#login').classList.add('hidden');
    $('#app').classList.remove('hidden');
    route();
  } catch (err) {
    if (err.status !== 401) toast(err.message, 'error');
    $('#app').classList.add('hidden');
    $('#login').classList.remove('hidden');
    $('#username').focus();
  }
}

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/api/admin/login', { method: 'POST', body: { username: $('#username').value, password: $('#password').value } });
    $('#password').value = '';
    boot();
  } catch (err) {
    toast(err.message, 'error');
  }
});

const view = () => $('#view');

// ---------------------------------------------------------------- liste des parties

async function renderGames() {
  const { games } = await api('/api/admin/games');
  view().innerHTML = `
    <div class="row spread">
      <h1>Mes parties</h1>
      ${aiOn ? '<span class="badge ai">IA activée</span>' : '<span class="badge" title="Définissez ANTHROPIC_API_KEY côté serveur">IA désactivée</span>'}
    </div>
    <div class="grid cols-2">
      <form class="card" id="newGameForm">
        <h2>➕ Nouvelle partie</h2>
        <div class="field"><label for="ng-name">Nom</label><input id="ng-name" required maxlength="120" placeholder="Killer du séminaire 2026"></div>
        <div class="field">
          <label for="ng-theme">Contexte (pour l'IA)</label>
          <textarea id="ng-theme" maxlength="2000" placeholder="Week-end entre amis dans un gîte, 15 personnes, ambiance détendue…"></textarea>
          <div class="hint">Lieu, durée, ambiance, contraintes : l'IA s'en sert pour proposer des défis adaptés.</div>
        </div>
        <div class="field"><label for="ng-end">Fin prévue (optionnel)</label><input id="ng-end" type="datetime-local"></div>
        <button class="primary block" type="submit">Créer la partie</button>
      </form>
      <div>
        ${
          games.length
            ? games
                .map(
                  (g) => `
          <a class="card btn block" href="#/game/${g.id}" style="display:block;text-align:left">
            <div class="row spread"><strong>${esc(g.name)}</strong><span class="badge ${g.status}">${STATUS_LABEL[g.status]}</span></div>
            <div class="small dim">${g.players} joueur${g.players > 1 ? 's' : ''}${g.status === 'running' ? ` · ${g.alive} en vie` : ''}
              · ${g.started_at ? `lancée le ${esc(formatDate(g.started_at))}` : `créée le ${esc(formatDate(g.created_at))}`}</div>
          </a>`,
                )
                .join('')
            : '<div class="card dim">Aucune partie pour le moment. Créez-en une !</div>'
        }
      </div>
    </div>`;
  $('#newGameForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const { id } = await api('/api/admin/games', {
        method: 'POST',
        body: { name: $('#ng-name').value, theme: $('#ng-theme').value, ends_at: localToIso($('#ng-end').value) },
      });
      tab = 'players';
      location.hash = `#/game/${id}/players`;
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}

function localToIso(v) {
  return v ? new Date(v).toISOString() : null;
}

// ---------------------------------------------------------------- partie

async function openGame(id, { keepPlan = false } = {}) {
  try {
    const previousId = current?.game.id;
    current = await api(`/api/admin/games/${id}`);
    if (!keepPlan || previousId !== id) {
      draftPlan = current.plan ? planToOrder(current.plan) : null;
      planDirty = false;
      if (previousId !== id) {
        planInfo = null;
        suggestions = [];
      }
    }
    if (current.game.status !== 'draft' && tab === 'plan') tab = 'live';
    if (current.game.status === 'draft' && tab === 'live') tab = 'players';
    renderGame();
  } catch (err) {
    toast(err.message, 'error');
    if (err.status === 404) location.hash = '#/';
  }
}

const reload = (opts) => openGame(current.game.id, opts);

function renderGame() {
  const { game, players } = current;
  const tabs = [
    ['players', `Joueurs (${players.length})`],
    ['challenges', `Défis (${current.challenges.length})`],
    game.status === 'draft' ? ['plan', 'Attribution'] : ['live', game.status === 'running' ? 'Suivi en direct' : 'Bilan'],
    ['settings', 'Réglages'],
  ];
  view().innerHTML = `
    <div class="no-print">
      <div class="row spread">
        <div>
          <a href="#/" class="small dim">← Mes parties</a>
          <h1 class="mb-0">${esc(game.name)}</h1>
        </div>
        <div class="row">
          <span class="badge ${game.status}">${STATUS_LABEL[game.status]}</span>
          ${game.status === 'draft' ? '<button class="primary" data-action="launch">🚀 Lancer la partie</button>' : ''}
          ${game.status === 'running' ? '<button class="danger" data-action="finish">⏹ Terminer</button>' : ''}
        </div>
      </div>
      ${headerStats()}
      <nav class="tabs mt">${tabs
        .map(([key, label]) => `<button data-tab="${key}" class="${tab === key ? 'active' : ''}">${esc(label)}</button>`)
        .join('')}</nav>
      <section id="tab"></section>
    </div>
    ${printableCodes()}`;
  ({ players: renderPlayers, challenges: renderChallenges, plan: renderPlan, live: renderLive, settings: renderSettings })[tab]?.();
}

function headerStats() {
  const { game, players, kills, alive } = current;
  if (game.status === 'draft') return '';
  const end = game.finished_at ? new Date(game.finished_at) : new Date();
  return `
    <div class="grid cols-3 mt">
      <div class="stat"><div class="v">${alive} / ${players.length}</div><div class="k">joueurs en vie (visible uniquement par vous)</div></div>
      <div class="stat"><div class="v">${kills.filter((k) => k.killer_id).length}</div><div class="k">kills validés</div></div>
      <div class="stat"><div class="v">${esc(formatDuration(end - new Date(game.started_at)))}</div><div class="k">${game.status === 'running' ? 'depuis le lancement' : 'durée totale'}</div></div>
      ${game.ends_at && game.status === 'running' ? `<div class="stat"><div class="v">${esc(formatDuration(new Date(game.ends_at) - Date.now()))}</div><div class="k">avant la fin prévue</div></div>` : ''}
    </div>`;
}

const tabEl = () => $('#tab');
const playerName = (id) => current.players.find((p) => p.id === id)?.name ?? '?';
const playerLink = (code) => `${location.origin}/jouer#${code}`;

// ---------------------------------------------------------------- onglet joueurs

function renderPlayers() {
  const { game, players } = current;
  const draft = game.status === 'draft';
  tabEl().innerHTML = `
    ${
      draft
        ? `<form class="card" id="addPlayersForm">
        <h2>Ajouter des joueurs</h2>
        <textarea id="newPlayers" placeholder="Un joueur par ligne. Optionnel : ajoutez des infos après un « ; »&#10;Alice ; compta, adore le café&#10;Bob ; arrive samedi midi"></textarea>
        <div class="hint">Les infos après « ; » ne sont visibles que par vous et servent à l'IA pour personnaliser défis et attributions.</div>
        <button class="primary mt" type="submit">Ajouter</button>
      </form>`
        : ''
    }
    <div class="card">
      <div class="row spread">
        <h2 class="mb-0">Liste des joueurs</h2>
        ${players.length ? '<button class="sm" data-action="print-codes">🖨️ Imprimer les codes</button>' : ''}
      </div>
      <p class="small dim">Chaque joueur se connecte sur <strong>${esc(location.origin)}/jouer</strong> avec son code personnel, ou via son lien direct.</p>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Nom</th><th>Infos (privées)</th><th>Code</th>${draft ? '' : '<th>Statut</th><th>Kills</th>'}<th></th></tr></thead>
          <tbody>
          ${players
            .map(
              (p) => `<tr data-player="${p.id}">
              <td><input value="${esc(p.name)}" data-field="name" maxlength="80" aria-label="Nom"></td>
              <td><input value="${esc(p.notes)}" data-field="notes" maxlength="1000" placeholder="—" aria-label="Infos"></td>
              <td class="mono">${esc(p.code)}</td>
              ${draft ? '' : `<td><span class="badge ${p.status}">${p.status === 'alive' ? 'en vie' : 'éliminé'}</span></td><td>${p.kills}</td>`}
              <td><div class="row">
                <button class="sm" data-action="copy-link" data-code="${esc(p.code)}" title="Copier le lien de connexion">🔗</button>
                <button class="sm ghost" data-action="regen-code" title="Générer un nouveau code">♻️</button>
                ${draft ? '<button class="sm danger" data-action="delete-player" title="Supprimer">✕</button>' : ''}
                ${game.status === 'running' && p.status === 'alive' ? '<button class="sm danger" data-action="eliminate" title="Retirer de la partie">☠️</button>' : ''}
              </div></td>
            </tr>`,
            )
            .join('')}
          </tbody>
        </table>
      </div>
      ${players.length ? '' : '<p class="dim">Aucun joueur.</p>'}
    </div>`;

  $('#addPlayersForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const entries = $('#newPlayers')
      .value.split('\n')
      .map((line) => {
        const [name, ...rest] = line.split(';');
        return { name: name.trim(), notes: rest.join(';').trim() };
      })
      .filter((p) => p.name);
    if (!entries.length) return;
    try {
      const { created } = await api(`/api/admin/games/${current.game.id}/players`, { method: 'POST', body: { players: entries } });
      toast(`${created} joueur(s) ajouté(s).`, 'success');
      reload();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  // Enregistrement automatique des modifications de nom / infos.
  for (const input of $$('tr[data-player] input', tabEl())) {
    input.addEventListener('change', async () => {
      const pid = input.closest('tr').dataset.player;
      try {
        await api(`/api/admin/players/${pid}`, { method: 'PATCH', body: { [input.dataset.field]: input.value } });
        toast('Enregistré.', 'success');
        reload({ keepPlan: true });
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  }
}

function printableCodes() {
  return `
    <section class="print-only">
      <h2>${esc(current.game.name)} — codes joueurs</h2>
      <p>Connexion : ${esc(location.origin)}/jouer</p>
      <div class="code-cards">
        ${current.players
          .map((p) => `<div class="code-card"><strong>${esc(p.name)}</strong><div class="mono">${esc(p.code)}</div><div class="small">${esc(playerLink(p.code))}</div></div>`)
          .join('')}
      </div>
    </section>`;
}

// ---------------------------------------------------------------- onglet défis

function renderChallenges() {
  const { challenges } = current;
  tabEl().innerHTML = `
    <div class="grid cols-2">
      <form class="card" id="addChallengesForm">
        <h2>✍️ Ajouter des défis</h2>
        <textarea id="newChallenges" placeholder="Un défi par ligne&#10;Faire dire « ananas » à ta cible"></textarea>
        <button class="primary mt" type="submit">Ajouter</button>
      </form>
      <form class="card" id="aiForm">
        <h2>${aiOn ? '✨ Suggestions de l’IA' : '📚 Bibliothèque de défis'}</h2>
        <p class="small dim">${
          aiOn
            ? 'Claude propose des défis adaptés au contexte de la partie. Vous choisissez ceux à garder.'
            : "L'IA n'est pas configurée sur le serveur : les suggestions viennent de la bibliothèque intégrée."
        }</p>
        <div class="row">
          <div class="field" style="flex:0 0 110px"><label for="aiCount">Nombre</label><input id="aiCount" type="number" min="1" max="50" value="10"></div>
          <div class="field" style="flex:1 1 200px"><label for="aiInstr">Consignes (optionnel)</label><input id="aiInstr" maxlength="1000" placeholder="plutôt verbaux, faciles, thème pirate…"></div>
        </div>
        <button class="block" type="submit" ${busy ? 'disabled' : ''}>${busy ? '⏳ Génération…' : aiOn ? '✨ Proposer des défis' : '🎲 Piocher des défis'}</button>
        ${
          suggestions.length
            ? `<ul class="list mt">${suggestions
                .map(
                  (s, i) => `<li><input type="checkbox" id="sg-${i}" data-sugg="${i}" checked style="width:auto;min-height:0">
                    <label for="sg-${i}" class="grow" style="font-weight:400;margin:0">${esc(s.text)}</label></li>`,
                )
                .join('')}</ul>
               <div class="row mt"><button class="primary" type="button" data-action="add-suggestions">Ajouter la sélection</button>
               <button class="ghost" type="button" data-action="clear-suggestions">Ignorer</button></div>`
            : ''
        }
      </form>
    </div>
    <div class="card">
      <h2>Défis de la partie</h2>
      ${
        challenges.length
          ? `<ul class="list">${challenges
              .map(
                (c) => `<li data-challenge="${c.id}">
                <span class="badge ${c.source === 'ai' ? 'ai' : ''}">${c.source === 'ai' ? 'IA' : c.source === 'library' ? 'biblio' : 'perso'}</span>
                <input class="grow" value="${esc(c.text)}" maxlength="500" aria-label="Défi">
                <button class="sm danger" data-action="delete-challenge" title="Supprimer">✕</button></li>`,
              )
              .join('')}</ul>`
          : '<p class="dim">Aucun défi. Ajoutez-en à la main ou demandez des suggestions.</p>'
      }
    </div>`;

  $('#addChallengesForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const texts = $('#newChallenges').value.split('\n').map((t) => t.trim()).filter(Boolean);
    if (!texts.length) return;
    await addChallenges(texts, 'admin');
  });

  $('#aiForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    busy = true;
    renderChallenges();
    try {
      const res = await api(`/api/admin/games/${current.game.id}/ai/challenges`, {
        method: 'POST',
        body: { count: Number($('#aiCount').value) || 10, instructions: $('#aiInstr').value },
      });
      suggestions = res.challenges.map((text) => ({ text, source: res.source === 'ai' ? 'ai' : 'library' }));
      if (res.warning) toast(res.warning);
      if (!suggestions.length) toast('Aucune nouvelle suggestion.');
    } catch (err) {
      toast(err.message, 'error');
    }
    busy = false;
    renderChallenges();
  });

  for (const input of $$('li[data-challenge] input', tabEl())) {
    input.addEventListener('change', async () => {
      try {
        await api(`/api/admin/challenges/${input.closest('li').dataset.challenge}`, { method: 'PATCH', body: { text: input.value } });
        toast('Défi modifié.', 'success');
        reload({ keepPlan: true });
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  }
}

async function addChallenges(texts, source) {
  try {
    await api(`/api/admin/games/${current.game.id}/challenges`, { method: 'POST', body: { texts, source } });
    toast(`${texts.length} défi(s) ajouté(s).`, 'success');
    reload({ keepPlan: true });
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ---------------------------------------------------------------- onglet attribution

// Convertit un plan {tueur → cible} en liste ordonnée le long de la boucle.
function planToOrder(plan) {
  const byKiller = new Map(plan.map((r) => [r.killer_id, r]));
  const ordered = [];
  let row = plan[0];
  const seen = new Set();
  while (row && !seen.has(row.killer_id)) {
    seen.add(row.killer_id);
    ordered.push({ ...row });
    row = byKiller.get(row.target_id);
  }
  return ordered.length === plan.length ? ordered : plan.map((r) => ({ ...r }));
}

// Après réordonnancement, chaque joueur chasse le suivant dans la liste.
function relink(rows) {
  rows.forEach((r, i) => (r.target_id = rows[(i + 1) % rows.length].killer_id));
}

function renderPlan() {
  const { players, challenges } = current;
  const enough = players.length >= 3;
  tabEl().innerHTML = `
    <div class="card">
      <h2>🎲 Qui tue qui ?</h2>
      <p class="small dim">Générez une boucle unique : chaque joueur chasse le suivant, le dernier chasse le premier.
        Vous pouvez ensuite réordonner la boucle et modifier chaque défi avant de lancer la partie.</p>
      ${enough ? '' : '<p class="small">⚠️ Ajoutez au moins 3 joueurs.</p>'}
      <div class="field">
        <label for="planInstr">Consignes pour l'IA (optionnel)</label>
        <input id="planInstr" maxlength="1000" placeholder="Évite que les couples se ciblent ; défis plus durs pour les habitués…" ${aiOn ? '' : 'disabled'}>
      </div>
      <div class="row">
        <button data-action="plan-random" ${enough && !busy ? '' : 'disabled'}>🎲 Tirage aléatoire</button>
        <button class="primary" data-action="plan-ai" ${enough && !busy && aiOn ? '' : 'disabled'} title="${aiOn ? '' : 'IA non configurée sur le serveur'}">
          ${busy ? '⏳ L’IA réfléchit…' : '✨ Proposition de l’IA'}</button>
      </div>
      ${planInfo?.warning ? `<p class="small mt">⚠️ ${esc(planInfo.warning)}</p>` : ''}
    </div>
    ${
      draftPlan
        ? `<div class="card">
        <div class="row spread">
          <h2 class="mb-0">La boucle ${planInfo?.source === 'ai' ? '<span class="badge ai">IA</span>' : ''}</h2>
          <div class="row">
            ${planDirty ? '<span class="small dim">Modifications non enregistrées</span>' : '<span class="small dim">Enregistré</span>'}
            <button class="sm" data-action="plan-save" ${planDirty ? '' : 'disabled'}>💾 Enregistrer</button>
          </div>
        </div>
        <datalist id="challengeList">${challenges.map((c) => `<option value="${esc(c.text)}">`).join('')}</datalist>
        <div class="table-wrap mt">
          <table>
            <thead><tr><th>#</th><th>Tueur</th><th></th><th>Cible</th><th>Défi</th><th></th></tr></thead>
            <tbody>
              ${draftPlan
                .map(
                  (r, i) => `<tr data-row="${i}">
                  <td class="dim">${i + 1}</td>
                  <td><strong>${esc(playerName(r.killer_id))}</strong></td>
                  <td class="chain-arrow">→</td>
                  <td>${esc(playerName(r.target_id))}</td>
                  <td style="min-width:260px"><input list="challengeList" value="${esc(r.challenge_text)}" data-plan-challenge="${i}" maxlength="500" aria-label="Défi">
                    ${r.reason ? `<div class="reason">💡 ${esc(r.reason)}</div>` : ''}</td>
                  <td><div class="row">
                    <button class="sm ghost" data-action="plan-up" ${i === 0 ? 'disabled' : ''} title="Monter">↑</button>
                    <button class="sm ghost" data-action="plan-down" ${i === draftPlan.length - 1 ? 'disabled' : ''} title="Descendre">↓</button>
                  </div></td>
                </tr>`,
                )
                .join('')}
            </tbody>
          </table>
        </div>
        <button class="primary block big mt" data-action="launch">🚀 Lancer la partie</button>
      </div>`
        : ''
    }`;

  for (const input of $$('[data-plan-challenge]', tabEl())) {
    input.addEventListener('input', () => {
      draftPlan[Number(input.dataset.planChallenge)].challenge_text = input.value;
      if (!planDirty) {
        planDirty = true;
        const btn = $('[data-action="plan-save"]');
        btn.disabled = false;
        btn.previousElementSibling.textContent = 'Modifications non enregistrées';
      }
    });
  }
}

async function generatePlan(kind) {
  busy = true;
  renderPlan();
  try {
    const res = await api(`/api/admin/games/${current.game.id}/plan/${kind}`, {
      method: 'POST',
      body: kind === 'ai' ? { instructions: $('#planInstr').value } : {},
    });
    planInfo = { source: res.source, warning: res.warning };
    draftPlan = planToOrder(res.plan);
    planDirty = false;
    if (res.errors?.length) toast(res.errors.join(' '), 'error');
  } catch (err) {
    toast(err.message, 'error');
  }
  busy = false;
  renderPlan();
}

async function savePlan() {
  const res = await api(`/api/admin/games/${current.game.id}/plan`, { method: 'PUT', body: { plan: draftPlan } });
  planDirty = false;
  if (res.errors.length) throw new Error(res.errors.join(' '));
}

// ---------------------------------------------------------------- onglet suivi

function renderLive() {
  const { game, contracts, kills, players } = current;
  const pending = contracts.filter((c) => c.status === 'pending');
  const ranking = [...players].sort((a, b) => b.kills - a.kills || (a.status === 'alive' ? -1 : 1));
  tabEl().innerHTML = `
    ${
      game.status === 'finished'
        ? `<div class="card ok"><h2>🏆 ${game.winner_id ? `Vainqueur : ${esc(playerName(game.winner_id))}` : 'Partie arrêtée manuellement'}</h2>
           <p class="dim mb-0">Terminée le ${esc(formatDate(game.finished_at))}.</p></div>`
        : ''
    }
    ${
      pending.length
        ? `<div class="card warn"><h2>⏳ Kills en attente de confirmation</h2>
        <ul class="list">${pending
          .map(
            (c) => `<li data-contract="${c.id}"><div class="grow"><strong>${esc(playerName(c.killer_id))}</strong> → ${esc(playerName(c.target_id))}
              <div class="small dim">« ${esc(c.challenge_text)} » · déclaré ${esc(ago(c.declared_at))}</div></div>
              <button class="sm ok" data-action="confirm-kill">Valider</button>
              <button class="sm danger" data-action="reject-kill">Refuser</button></li>`,
          )
          .join('')}</ul></div>`
        : ''
    }
    ${
      game.status === 'running'
        ? `<div class="card">
      <div class="row spread"><h2 class="mb-0">🔗 Contrats en cours</h2><button class="sm ghost" data-action="refresh">↻ Actualiser</button></div>
      <p class="small dim">Vous seul voyez la boucle complète. Vous pouvez modifier un défi en cours de partie.</p>
      <div class="table-wrap"><table>
        <thead><tr><th>Tueur</th><th></th><th>Cible</th><th>Défi</th><th class="hide-mobile">Depuis</th></tr></thead>
        <tbody>${chainOrder(contracts)
          .map(
            (c) => `<tr data-contract="${c.id}">
            <td><strong>${esc(playerName(c.killer_id))}</strong>${c.contested ? ` <span class="badge pending" title="Kill contesté">contesté ×${c.contested}</span>` : ''}</td>
            <td class="chain-arrow">→</td>
            <td>${esc(playerName(c.target_id))}${c.status === 'pending' ? ' <span class="badge pending">kill déclaré</span>' : ''}</td>
            <td style="min-width:240px"><input value="${esc(c.challenge_text)}" data-contract-challenge maxlength="500" aria-label="Défi"></td>
            <td class="small dim hide-mobile">${esc(formatDuration(Date.now() - new Date(c.created_at)))}</td>
          </tr>`,
          )
          .join('')}</tbody>
      </table></div>
    </div>`
        : ''
    }
    <div class="grid cols-2">
      <div class="card">
        <h2>📜 Journal des éliminations</h2>
        ${
          kills.length
            ? `<ul class="list">${kills
                .map(
                  (k) => `<li><div class="grow">${
                    k.killer_id
                      ? `<strong>${esc(playerName(k.killer_id))}</strong> a éliminé <strong>${esc(playerName(k.victim_id))}</strong>
                         <div class="small dim">« ${esc(k.challenge_text || '')} » · ${k.confirmed_by === 'admin' ? 'validé par vous' : 'confirmé par la victime'}</div>`
                      : `<strong>${esc(playerName(k.victim_id))}</strong> a été retiré par l'organisateur`
                  }</div><span class="small dim">${esc(formatDate(k.created_at))}</span></li>`,
                )
                .join('')}</ul>`
            : '<p class="dim">Aucune élimination pour le moment.</p>'
        }
      </div>
      <div class="card">
        <h2>🏅 Classement</h2>
        <ol class="list">${ranking
          .map(
            (p) => `<li><span class="grow">${esc(p.name)}</span><span class="small dim">${p.kills} kill${p.kills > 1 ? 's' : ''}</span>
            <span class="badge ${p.status}">${p.status === 'alive' ? 'en vie' : 'éliminé'}</span></li>`,
          )
          .join('')}</ol>
      </div>
    </div>`;

  for (const input of $$('[data-contract-challenge]', tabEl())) {
    input.addEventListener('change', async () => {
      try {
        await api(`/api/admin/contracts/${input.closest('tr').dataset.contract}`, { method: 'PATCH', body: { challenge_text: input.value } });
        toast('Défi mis à jour : le joueur le verra immédiatement.', 'success');
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  }
}

// Affiche les contrats dans l'ordre de la boucle.
function chainOrder(contracts) {
  const byKiller = new Map(contracts.map((c) => [c.killer_id, c]));
  const out = [];
  const seen = new Set();
  let c = contracts[0];
  while (c && !seen.has(c.id)) {
    seen.add(c.id);
    out.push(c);
    c = byKiller.get(c.target_id);
  }
  return out.length === contracts.length ? out : contracts;
}

// ---------------------------------------------------------------- onglet réglages

function renderSettings() {
  const { game } = current;
  tabEl().innerHTML = `
    <form class="card" id="settingsForm">
      <h2>Réglages de la partie</h2>
      <div class="field"><label for="st-name">Nom</label><input id="st-name" value="${esc(game.name)}" maxlength="120" required></div>
      <div class="field"><label for="st-theme">Contexte (pour l'IA)</label><textarea id="st-theme" maxlength="2000">${esc(game.theme)}</textarea></div>
      <div class="field"><label for="st-end">Fin prévue</label><input id="st-end" type="datetime-local" value="${esc(toLocalInput(game.ends_at))}">
        <div class="hint">Affichée aux joueurs sous forme de compte à rebours. Laissez vide pour une partie sans limite.</div></div>
      <button class="primary" type="submit">Enregistrer</button>
    </form>
    <div class="card">
      <h2>Zone dangereuse</h2>
      <p class="small dim">Supprime la partie, ses joueurs, ses défis et tout l'historique. Irréversible.</p>
      <button class="danger" data-action="delete-game">🗑️ Supprimer la partie</button>
    </div>`;
  $('#settingsForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api(`/api/admin/games/${game.id}`, {
        method: 'PATCH',
        body: { name: $('#st-name').value, theme: $('#st-theme').value, ends_at: localToIso($('#st-end').value) },
      });
      toast('Réglages enregistrés.', 'success');
      reload({ keepPlan: true });
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}

// ---------------------------------------------------------------- mot de passe

function renderPassword() {
  view().innerHTML = `
    <form class="card narrow" id="pwdForm">
      <a href="#/" class="small dim">← Mes parties</a>
      <h1>Mot de passe</h1>
      <div class="field"><label for="pw-cur">Mot de passe actuel</label><input id="pw-cur" type="password" autocomplete="current-password" required></div>
      <div class="field"><label for="pw-new">Nouveau mot de passe (8 caractères min.)</label><input id="pw-new" type="password" autocomplete="new-password" minlength="8" required></div>
      <button class="primary" type="submit">Changer</button>
    </form>`;
  $('#pwdForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/api/admin/password', { method: 'POST', body: { current: $('#pw-cur').value, next: $('#pw-new').value } });
      toast('Mot de passe modifié.', 'success');
      location.hash = '#/';
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}

// ---------------------------------------------------------------- actions (délégation)

async function run(fn, success) {
  try {
    await fn();
    if (success) toast(success, 'success');
  } catch (err) {
    toast(err.message, 'error');
  }
}

document.addEventListener('click', async (e) => {
  const tabBtn = e.target.closest('[data-tab]');
  if (tabBtn) {
    tab = tabBtn.dataset.tab;
    history.replaceState(null, '', `#/game/${current.game.id}/${tab}`);
    renderGame();
    return;
  }
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const pid = el.closest('[data-player]')?.dataset.player;
  const cid = el.closest('[data-contract]')?.dataset.contract;
  const row = Number(el.closest('[data-row]')?.dataset.row);

  switch (el.dataset.action) {
    case 'go-home':
      location.hash = '#/';
      break;
    case 'password':
      location.hash = '#/password';
      break;
    case 'logout':
      await api('/api/admin/logout', { method: 'POST' }).catch(() => {});
      location.hash = '';
      boot();
      break;
    case 'refresh':
      reload({ keepPlan: true });
      break;

    case 'copy-link': {
      const link = playerLink(el.dataset.code);
      try {
        await navigator.clipboard.writeText(link);
        toast('Lien copié : envoyez-le au joueur en privé.', 'success');
      } catch {
        prompt('Lien de connexion du joueur :', link);
      }
      break;
    }
    case 'print-codes':
      window.print();
      break;
    case 'regen-code':
      if (confirm("Générer un nouveau code ? L'ancien ne fonctionnera plus et le joueur sera déconnecté.")) {
        await run(() => api(`/api/admin/players/${pid}/regenerate-code`, { method: 'POST' }), 'Nouveau code généré.');
        reload({ keepPlan: true });
      }
      break;
    case 'delete-player':
      if (confirm(`Supprimer ${playerName(Number(pid))} ? L'attribution des cibles sera à refaire.`)) {
        await run(() => api(`/api/admin/players/${pid}`, { method: 'DELETE' }), 'Joueur supprimé.');
        reload();
      }
      break;
    case 'eliminate':
      if (confirm(`Retirer ${playerName(Number(pid))} de la partie ? Son tueur héritera de sa cible et de son défi.`)) {
        await run(() => api(`/api/admin/players/${pid}/eliminate`, { method: 'POST' }), 'Joueur retiré.');
        reload();
      }
      break;

    case 'delete-challenge':
      await run(() => api(`/api/admin/challenges/${el.closest('[data-challenge]').dataset.challenge}`, { method: 'DELETE' }));
      reload({ keepPlan: true });
      break;
    case 'add-suggestions': {
      const chosen = $$('[data-sugg]').filter((c) => c.checked).map((c) => suggestions[Number(c.dataset.sugg)]);
      if (!chosen.length) return toast('Aucun défi sélectionné.');
      suggestions = [];
      await addChallenges(chosen.map((s) => s.text), chosen[0].source);
      break;
    }
    case 'clear-suggestions':
      suggestions = [];
      renderChallenges();
      break;

    case 'plan-random':
      generatePlan('random');
      break;
    case 'plan-ai':
      generatePlan('ai');
      break;
    case 'plan-up':
    case 'plan-down': {
      const j = el.dataset.action === 'plan-up' ? row - 1 : row + 1;
      [draftPlan[row], draftPlan[j]] = [draftPlan[j], draftPlan[row]];
      relink(draftPlan);
      planDirty = true;
      renderPlan();
      break;
    }
    case 'plan-save':
      await run(savePlan, 'Attribution enregistrée.');
      renderPlan();
      break;

    case 'launch':
      if (!draftPlan) {
        tab = 'plan';
        renderGame();
        return toast("Générez d'abord l'attribution des cibles.");
      }
      if (!confirm('Lancer la partie ? Chaque joueur verra immédiatement sa cible et son défi.')) return;
      await run(async () => {
        if (planDirty) await savePlan();
        await api(`/api/admin/games/${current.game.id}/launch`, { method: 'POST' });
        tab = 'live';
        history.replaceState(null, '', `#/game/${current.game.id}/live`);
      }, 'La partie est lancée ! 🔪');
      reload();
      break;
    case 'finish':
      if (confirm('Terminer la partie maintenant ? Le classement sera révélé à tous les joueurs.')) {
        await run(() => api(`/api/admin/games/${current.game.id}/finish`, { method: 'POST' }), 'Partie terminée.');
        reload();
      }
      break;
    case 'confirm-kill':
      await run(() => api(`/api/admin/contracts/${cid}/confirm`, { method: 'POST' }), 'Kill validé.');
      reload();
      break;
    case 'reject-kill':
      await run(() => api(`/api/admin/contracts/${cid}/reject`, { method: 'POST' }), 'Kill refusé : le contrat reprend.');
      reload();
      break;
    case 'delete-game':
      if (confirm(`Supprimer définitivement « ${current.game.name} » ?`)) {
        await run(() => api(`/api/admin/games/${current.game.id}`, { method: 'DELETE' }), 'Partie supprimée.');
        location.hash = '#/';
      }
      break;
  }
});

boot();
