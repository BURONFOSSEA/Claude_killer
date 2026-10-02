// Assistance IA (Claude) : génération de défis et proposition de "qui tue qui".
// Sans clé API (ou en cas d'erreur), on bascule sur un mode hors-ligne : bibliothèque de défis + tirage aléatoire.
import Anthropic from '@anthropic-ai/sdk';
import { CHALLENGE_LIBRARY } from './challenge-library.js';
import { buildRandomPlan, planFromOrder, shuffle, pickChallenges } from './game.js';

// Configuration lue une fois au démarrage (variables d'environnement / secrets Supabase).
let config = { apiKey: '', model: 'claude-opus-5-5' };
let client = null;
export function configureAi(env = {}) {
  config = { apiKey: env.ANTHROPIC_API_KEY || '', model: env.ANTHROPIC_MODEL || 'claude-opus-5-5' };
  client = null;
}
export function aiEnabled() {
  return Boolean(config.apiKey);
}
function getClient() {
  if (!client) client = new Anthropic({ apiKey: config.apiKey });
  return client;
}

const SYSTEM = `Tu es le maître du jeu d'une partie de "Killer", jeu d'ambiance en français.
Règles : chaque joueur reçoit secrètement une cible et un défi. Pour "tuer" sa cible, il doit lui faire faire
le défi (dire un mot, faire un geste, accepter un objet...) sans qu'elle se doute de rien. La cible éliminée
transmet sa propre cible et son défi à son tueur, jusqu'au dernier survivant.
Un bon défi est : réalisable en quelques minutes de conversation, discret, drôle, vérifiable sans ambiguïté,
sans danger, sans humiliation, sans contact non consenti, sans alcool obligatoire, et adapté au contexte donné.
Écris toujours en français, en tutoyant le tueur ("Faire dire... à ta cible").`;

async function askJson(prompt, schema) {
  // Fallbacks serveur : si une requête est refusée par un filtre de sécurité, l'API la rejoue
  // automatiquement sur un modèle de repli.
  const response = await getClient().beta.messages.create({
    model: config.model,
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system: SYSTEM,
    output_config: { effort: 'medium', format: { type: 'json_schema', schema } },
    messages: [{ role: 'user', content: prompt }],
  });
  if (response.stop_reason === 'refusal') throw new Error("L'IA a refusé la demande.");
  if (response.stop_reason === 'max_tokens') throw new Error("Réponse de l'IA tronquée.");
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  return JSON.parse(text);
}

function describeContext(theme) {
  return theme?.trim() ? `Contexte de la partie : ${theme.trim()}` : 'Contexte de la partie : non précisé (soirée entre amis).';
}

// ---------- Génération de défis ----------

export async function generateChallenges({ theme, count = 10, existing = [], instructions = '' }) {
  count = Math.max(1, Math.min(50, Number(count) || 10));
  if (!aiEnabled()) return offlineChallenges(count, existing, 'IA non configurée : défis tirés de la bibliothèque intégrée.');
  try {
    const prompt = [
      describeContext(theme),
      instructions?.trim() ? `Consignes de l'organisateur : ${instructions.trim()}` : '',
      existing.length ? `Défis déjà présents (ne pas les répéter ni les paraphraser) :\n- ${existing.join('\n- ')}` : '',
      `Propose ${count} nouveaux défis variés (mots à faire dire, gestes, objets, situations).`,
    ]
      .filter(Boolean)
      .join('\n\n');
    const data = await askJson(prompt, {
      type: 'object',
      properties: { challenges: { type: 'array', items: { type: 'string' } } },
      required: ['challenges'],
      additionalProperties: false,
    });
    const seen = new Set(existing.map(normalize));
    const challenges = [];
    for (const c of data.challenges || []) {
      const text = String(c).trim();
      if (text && !seen.has(normalize(text))) {
        seen.add(normalize(text));
        challenges.push(text);
      }
    }
    return { source: 'ai', challenges: challenges.slice(0, count) };
  } catch (err) {
    console.error('[IA] génération de défis :', err.message);
    return offlineChallenges(count, existing, `IA indisponible (${err.message}) : défis tirés de la bibliothèque.`);
  }
}

function normalize(s) {
  return String(s).toLowerCase().normalize('NFD').replace(/[^a-z0-9]/g, '');
}

function offlineChallenges(count, existing, warning) {
  const used = new Set(existing.map(normalize));
  const available = shuffle(CHALLENGE_LIBRARY.filter((c) => !used.has(normalize(c))));
  return { source: 'library', warning, challenges: available.slice(0, count) };
}

// ---------- Proposition d'attribution (qui tue qui + défi) ----------

export async function proposeAssignments({ theme, players, challenges, instructions = '' }) {
  const challengeTexts = challenges.map((c) => c.text);
  const ids = players.map((p) => p.id);
  if (!aiEnabled()) {
    return { source: 'random', warning: 'IA non configurée : tirage aléatoire.', plan: buildRandomPlan(ids, challengeTexts) };
  }
  try {
    // On présente les joueurs sous des étiquettes courtes (J1, J2...) pour fiabiliser la réponse.
    const labels = players.map((p, i) => ({ label: `J${i + 1}`, player: p }));
    const byLabel = new Map(labels.map((l) => [l.label, l.player.id]));
    const prompt = [
      describeContext(theme),
      instructions?.trim() ? `Consignes de l'organisateur : ${instructions.trim()}` : '',
      'Joueurs (avec les infos connues de l’organisateur, à utiliser pour personnaliser) :',
      labels.map((l) => `- ${l.label} : ${l.player.name}${l.player.notes ? ` — ${l.player.notes}` : ''}`).join('\n'),
      challengeTexts.length
        ? `Défis disponibles (C1, C2...) :\n${challengeTexts.map((t, i) => `- C${i + 1} : ${t}`).join('\n')}`
        : 'Aucun défi n’a encore été saisi : invente un défi adapté pour chaque ligne.',
      `Construis UNE seule boucle passant par tous les joueurs : "order" liste chaque étiquette exactement une fois,
chaque joueur chasse le suivant et le dernier chasse le premier. Évite de faire se chasser des personnes très
proches si les infos l'indiquent, et répartis les défis pour qu'ils soient adaptés au duo tueur/cible.
Pour chaque position de "order", donne dans "assignments" le défi du joueur à cette position (réutilise un
texte de la liste ou propose-en un nouveau si nécessaire) et une courte justification.`,
    ]
      .filter(Boolean)
      .join('\n\n');
    const data = await askJson(prompt, {
      type: 'object',
      properties: {
        order: { type: 'array', items: { type: 'string' } },
        assignments: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              killer: { type: 'string' },
              challenge: { type: 'string' },
              reason: { type: 'string' },
            },
            required: ['killer', 'challenge', 'reason'],
            additionalProperties: false,
          },
        },
      },
      required: ['order', 'assignments'],
      additionalProperties: false,
    });

    const order = (data.order || []).map((l) => byLabel.get(String(l).trim()));
    if (order.length !== ids.length || order.some((id) => id == null) || new Set(order).size !== ids.length) {
      throw new Error('boucle proposée invalide');
    }
    const byKiller = new Map((data.assignments || []).map((a) => [byLabel.get(String(a.killer).trim()), a]));
    const fallback = pickChallenges(challengeTexts.length ? challengeTexts : [...CHALLENGE_LIBRARY], order.length);
    const plan = planFromOrder(order, []).map((row, i) => {
      const a = byKiller.get(row.killer_id);
      return {
        ...row,
        challenge_text: resolveChallenge(a?.challenge, challengeTexts) || fallback[i],
        ...(a?.reason ? { reason: a.reason } : {}),
      };
    });
    return { source: 'ai', plan };
  } catch (err) {
    console.error('[IA] attribution :', err.message);
    return { source: 'random', warning: `IA indisponible (${err.message}) : tirage aléatoire.`, plan: buildRandomPlan(ids, challengeTexts) };
  }
}

// L'IA peut répondre "C3" ou recopier le texte : on accepte les deux.
function resolveChallenge(answer, challengeTexts) {
  const text = String(answer || '').trim();
  const ref = /^C(\d+)$/i.exec(text);
  if (ref) return challengeTexts[Number(ref[1]) - 1] || '';
  return text;
}
