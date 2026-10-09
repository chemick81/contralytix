// netlify/edge-functions/read-accounts-edge.js — URL : /edge/read-accounts-screenshot
//
// Lecture d'une capture d'écran de comptes (page Comptes > « Importer une capture ») par Gemini.
// Même rôle que netlify/functions/read-accounts-screenshot.js, mais en Edge Function :
// une fonction classique est coupée par Netlify au bout d'environ 10 s, ce que la lecture
// détaillée (numéro + PropFirm + taille + type) peut dépasser. Une Edge Function a 40 s pour
// répondre, et le temps passé à attendre Gemini ne compte pas dans sa limite de calcul.
// Le navigateur appelle cette URL en premier et retombe sur l'ancienne fonction si elle
// n'est pas déployée (404).
//
// Sécurité : utilisateur connecté obligatoire (jeton Supabase vérifié), image jamais stockée,
// 20 lectures réussies par jour (heure de Paris) et par compte, admins exemptés
// (table screenshot_reads, migration_screenshot_reads.sql — si elle n'existe pas, pas de limite).
//
// Variables d'environnement Netlify (déjà présentes pour les autres fonctions) :
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GEMINI_API_KEY

const ALLOWED_MIME = ['image/png', 'image/jpeg', 'image/webp'];
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const MAX_ACCOUNTS = 50;
const DAILY_LIMIT = 20;
const MODELS = ['gemini-3.5-flash', 'gemini-flash-latest'];
const MAX_ATTEMPTS_PER_MODEL = 2;
const BASE_RETRY_DELAY_MS = 800;
// La réponse est ouverte tout de suite (en-têtes envoyés) puis le résultat est écrit quand Gemini
// a fini : la limite Netlify de 40 s ne porte que sur le début de la réponse. On garde malgré tout
// un plafond pour ne jamais laisser le trader attendre indéfiniment.
const TIME_BUDGET_MS = 55000;
// Réflexion au plus bas : lire des numéros sur une capture ne demande pas de raisonnement.
// Si un modèle refuse un niveau, on essaie le suivant, puis sans réglage.
const THINKING_LEVELS = ['minimal', 'low', null];
const TYPES = ['CHALLENGE', 'PA', 'LIVE'];
const SOURCES = ['screen', 'number'];

const env = (name) => {
  try { if (typeof Netlify !== 'undefined' && Netlify.env) return Netlify.env.get(name); } catch (e) { /* */ }
  try { if (typeof Deno !== 'undefined') return Deno.env.get(name); } catch (e) { /* */ }
  return undefined;
};

// Résultat interne { status, body } : écrit dans la réponse en flux (voir le gestionnaire en bas).
const json = (status, body) => ({ status, body });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isOverloaded = (status, message) =>
  status === 503 || status === 429 || /overload|high demand|unavailable/i.test(message || '');

function isDemoAccount(id) {
  const k = id.toLowerCase().replace(/[._-]+/g, '');
  return /demo|practice|paper/.test(k) || /^sim\d/.test(k);
}

function buildPrompt(firmNames) {
  const firms = firmNames.length ? firmNames.map((n) => `"${n}"`).join(', ') : '(aucune)';
  return `Tu lis une capture d'écran d'une plateforme de trading (Tradovate, Rithmic, NinjaTrader, Project X, tableau de bord de prop firm…).
Pour CHAQUE compte de trading visible, renvoie un objet avec ces champs :

- "number" : l'identifiant du compte, recopié exactement, caractère par caractère, tirets compris, sans le corriger ni le compléter (exemples : "FFFUNDED541223", "APEX-123456-03", "PP-F150K-000247-000010", "LFF050-KE249Z1F-PRO002", "DEMO19714"). Recopie aussi les comptes de démo ou de simulation (ils sont filtrés ensuite).
- "propfirm" : la PropFirm du compte, en choisissant UNIQUEMENT un nom de cette liste, écrit à l'identique : ${firms}. Sinon null.
- "propfirmSource" : "screen" si le nom (ou le logo) de la PropFirm est affiché à l'écran pour ce compte ; "number" si tu le déduis d'un nom ou d'une abréviation sans ambiguïté contenu dans l'identifiant ; null si propfirm est null. Ne devine jamais : en cas de doute, propfirm = null.
- "size" : la taille du compte en dollars (entier, ex : 50000), uniquement si elle est affichée comme taille ou plan du compte, ou écrite explicitement dans l'identifiant avec un K (ex : "150K" → 150000). Ne JAMAIS utiliser le solde, l'équité, le P&L ou un autre montant. Sinon null.
- "sizeSource" : "screen", "number" ou null.
- "type" : "CHALLENGE" (mots EVAL, EVALUATION, TEST, COMBINE, CHALLENGE, QUALIF), "PA" (mots FUNDED, PA, PRO, XFA, PERFORMANCE, EXPRESS), "LIVE" (mot LIVE), uniquement si ce mot est affiché pour ce compte ou contenu dans l'identifiant. Sinon null.
- "typeSource" : "screen", "number" ou null.

Ignore les en-têtes de colonnes, soldes, montants, dates, noms de personnes, adresses e-mail et libellés de menus. Ne mets pas deux fois le même compte.
Réponds uniquement avec du JSON : {"accounts":[{"number":"...","propfirm":null,"propfirmSource":null,"size":null,"sizeSource":null,"type":null,"typeSource":null}]}.`;
}

function cleanAccounts(list, firmNames) {
  const firmByLower = new Map(firmNames.map((n) => [n.toLowerCase(), n]));
  const seen = new Set();
  const out = [];
  const ignored = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const item = typeof raw === 'string' ? { number: raw } : (raw && typeof raw === 'object' ? raw : null);
    if (!item || typeof item.number !== 'string') continue;
    const id = item.number.trim().replace(/\s+/g, '');
    if (!/^[A-Za-z0-9._-]{3,40}$/.test(id) || !/\d/.test(id)) continue;
    const key = id.toLowerCase().replace(/[._-]+/g, '');
    if (seen.has(key)) continue;
    seen.add(key);
    if (isDemoAccount(id)) { ignored.push(id); continue; }
    const propfirm = typeof item.propfirm === 'string' ? (firmByLower.get(item.propfirm.trim().toLowerCase()) || null) : null;
    const sizeNum = Math.round(Number(item.size));
    const size = Number.isFinite(sizeNum) && sizeNum >= 1000 && sizeNum <= 2000000 ? sizeNum : null;
    const type = typeof item.type === 'string' && TYPES.includes(item.type.toUpperCase()) ? item.type.toUpperCase() : null;
    const src = (v, has) => (has && SOURCES.includes(v) ? v : (has ? 'number' : null));
    out.push({
      number: id,
      propfirm, propfirmSource: src(item.propfirmSource, !!propfirm),
      size, sizeSource: src(item.sizeSource, !!size),
      type, typeSource: src(item.typeSource, !!type),
    });
    if (out.length >= MAX_ACCOUNTS) break;
  }
  return { accounts: out, ignored };
}

// Début de la journée en cours, heure de Paris, en instant UTC.
function parisDayStart(now = new Date()) {
  const paris = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Paris' }));
  const utcWall = new Date(now.toLocaleString('en-US', { timeZone: 'UTC' }));
  const offset = paris - utcWall;
  const mid = new Date(paris); mid.setHours(0, 0, 0, 0);
  return new Date(mid.getTime() + (now.getTime() - utcWall.getTime()) - offset);
}

// ---- Supabase via son API REST (clé service_role, jamais exposée au navigateur) ----
function sb() {
  const url = (env('SUPABASE_URL') || '').replace(/\/$/, '');
  const key = env('SUPABASE_SERVICE_ROLE_KEY') || '';
  const headers = { apikey: key, Authorization: `Bearer ${key}` };
  return { url, key, headers };
}
async function getUserId(token) {
  const { url, key } = sb();
  if (!url || !key || !token) return null;
  const res = await fetch(`${url}/auth/v1/user`, { headers: { apikey: key, Authorization: `Bearer ${token}` } });
  if (!res.ok) return null;
  const u = await res.json().catch(() => null);
  return u && u.id ? u.id : null;
}
async function isAdminUser(userId) {
  const { url, headers } = sb();
  try {
    const res = await fetch(`${url}/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=role`, { headers });
    if (!res.ok) return false;
    const rows = await res.json();
    return Array.isArray(rows) && rows[0] && rows[0].role === 'ADMIN';
  } catch (e) { return false; }
}
async function countReadsToday(userId) {
  const { url, headers } = sb();
  try {
    const since = encodeURIComponent(parisDayStart().toISOString());
    const res = await fetch(`${url}/rest/v1/screenshot_reads?user_id=eq.${encodeURIComponent(userId)}&created_at=gte.${since}&select=id&limit=1`,
      { headers: { ...headers, Prefer: 'count=exact' } });
    if (!res.ok) { console.error('screenshot_reads count error:', res.status); return null; }
    const range = res.headers.get('content-range') || '';
    const total = Number(range.split('/')[1]);
    return Number.isFinite(total) ? total : null;
  } catch (e) { console.error('screenshot_reads count error:', e); return null; }
}
async function logRead(userId) {
  const { url, headers } = sb();
  try {
    const res = await fetch(`${url}/rest/v1/screenshot_reads`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({ user_id: userId }),
    });
    if (!res.ok) { console.error('screenshot_reads insert error:', res.status); return false; }
    return true;
  } catch (e) { console.error('screenshot_reads insert error:', e); return false; }
}

async function handle(request) {
  if (request.method !== 'POST') return json(405, { error: 'Méthode non autorisée' });

  // 1. Utilisateur connecté
  const authHeader = request.headers.get('authorization') || '';
  const userId = await getUserId(authHeader.replace('Bearer ', '').trim()).catch(() => null);
  if (!userId) return json(401, { error: 'Session invalide, reconnecte-toi.' });

  // 2. Limite quotidienne (admins exemptés)
  const admin = await isAdminUser(userId);
  const usedToday = admin ? null : await countReadsToday(userId);
  if (usedToday !== null && usedToday >= DAILY_LIMIT) {
    return json(429, { error: `Tu as atteint la limite de ${DAILY_LIMIT} lectures de capture pour aujourd'hui. Réessaie demain, ou ajoute tes comptes avec « Ajout en masse ».`, remaining: 0, limit: DAILY_LIMIT });
  }

  // 3. Image valide
  let image = '', mimeType = '', firmNames = [];
  try {
    const body = await request.json();
    image = typeof body.image === 'string' ? body.image.replace(/^data:[^,]*,/, '') : '';
    mimeType = typeof body.mimeType === 'string' ? body.mimeType : '';
    if (Array.isArray(body.firms)) {
      firmNames = [...new Set(body.firms
        .filter((n) => typeof n === 'string')
        .map((n) => n.replace(/["\\\n\r]/g, '').trim())
        .filter((n) => n && n.length <= 60))].slice(0, 100);
    }
  } catch (e) {
    return json(400, { error: 'Requête invalide.' });
  }
  if (!image) return json(400, { error: 'Aucune image reçue.' });
  if (!ALLOWED_MIME.includes(mimeType)) return json(400, { error: 'Format non pris en charge : utilise une image PNG, JPG ou WEBP.' });
  if (Math.floor(image.length * 3 / 4) > MAX_IMAGE_BYTES) return json(413, { error: 'Image trop lourde (6 Mo maximum). Recadre la capture sur la liste des comptes.' });

  const key = env('GEMINI_API_KEY');
  if (!key) return json(500, { error: 'GEMINI_API_KEY non configurée sur Netlify.' });

  // 4. Lecture par Gemini
  const prompt = buildPrompt(firmNames);
  const startedAt = Date.now();
  const timeLeft = () => TIME_BUDGET_MS - (Date.now() - startedAt);
  let thinkingIdx = 0;
  let timedOut = false;
  for (const model of MODELS) {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_MODEL; attempt++) {
      if (timeLeft() < 2000) { timedOut = true; break; }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeLeft());
      try {
        const generationConfig = { temperature: 0, responseMimeType: 'application/json' };
        if (THINKING_LEVELS[thinkingIdx]) generationConfig.thinkingConfig = { thinkingLevel: THINKING_LEVELS[thinkingIdx] };
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
          signal: controller.signal,
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: mimeType, data: image } }] }],
            generationConfig,
          }),
        });
        const data = await res.json().catch(() => ({}));
        clearTimeout(timer);
        if (res.ok) {
          const text = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
          let parsed = null;
          try { parsed = JSON.parse(text); }
          catch (e) {
            const m = text.match(/\{[\s\S]*\}/);
            if (m) { try { parsed = JSON.parse(m[0]); } catch (e2) { /* ignoré */ } }
          }
          let remaining = null;
          if (!admin && await logRead(userId) && usedToday !== null) remaining = Math.max(0, DAILY_LIMIT - usedToday - 1);
          return json(200, { ...cleanAccounts(parsed && parsed.accounts, firmNames), remaining, limit: DAILY_LIMIT, model });
        }
        const msg = data.error?.message || `HTTP ${res.status}`;
        console.error(`read-accounts-screenshot (edge) Gemini ${model} ${res.status}: ${msg}`);
        if (THINKING_LEVELS[thinkingIdx] && res.status === 400 && /thinking/i.test(msg)) { thinkingIdx++; attempt--; continue; }
        if (isOverloaded(res.status, msg)) {
          if (attempt < MAX_ATTEMPTS_PER_MODEL && timeLeft() > BASE_RETRY_DELAY_MS * attempt + 2000) { await sleep(BASE_RETRY_DELAY_MS * attempt); continue; }
          break;
        }
        if (res.status === 404) break;
        return json(502, { error: `La lecture de la capture a échoué (Gemini ${res.status}). Réessaie dans un instant.` });
      } catch (err) {
        clearTimeout(timer);
        if (err && err.name === 'AbortError') { timedOut = true; break; }
        console.error('read-accounts-screenshot (edge) error:', err);
      }
    }
    if (timedOut) break;
  }
  if (timedOut) return json(504, { error: 'La lecture a pris trop de temps. Réessaie dans un instant.' });
  return json(503, { error: 'Le service de lecture est saturé pour le moment. Réessaie dans une minute.' });
}

// Réponse en flux : en-têtes envoyés immédiatement, quelques espaces toutes les 5 s pour garder la
// connexion ouverte (ignorés par JSON.parse), puis le JSON final. Le vrai code d'erreur éventuel est
// dans le champ `status` du JSON (le code HTTP est 200 puisqu'il part avant le résultat).
export default (request) => {
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      controller.enqueue(enc.encode(' '));
      const keepAlive = setInterval(() => { try { controller.enqueue(enc.encode(' ')); } catch (e) { /* fermé */ } }, 5000);
      let result;
      try { result = await handle(request); }
      catch (err) {
        console.error('read-accounts-screenshot (edge) fatal:', err);
        result = json(500, { error: 'Erreur serveur lors de la lecture de la capture. Réessaie.' });
      }
      clearInterval(keepAlive);
      controller.enqueue(enc.encode(JSON.stringify({ ...result.body, status: result.status })));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
  });
};

export const config = { path: '/edge/read-accounts-screenshot' };
