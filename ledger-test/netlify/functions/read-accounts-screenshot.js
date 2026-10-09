// netlify/functions/read-accounts-screenshot.js
//
// Import de comptes depuis une capture d'écran (page Comptes > « Importer depuis une capture »).
// Reçoit une image (liste de comptes affichée dans Tradovate, Rithmic, NinjaTrader…), la fait lire
// par Gemini (vision) et renvoie les numéros de compte détectés, avec — quand c'est lisible —
// la PropFirm (choisie dans le catalogue Contralytix envoyé par le navigateur), la taille et le type.
// Rien n'est écrit en base ici : le navigateur affiche la liste, le trader la corrige puis la
// valide via le formulaire « Ajout en masse » existant (mêmes règles anti-doublon que la saisie
// manuelle).
//
// Sécurité :
//   - réservé aux utilisateurs connectés (jeton Supabase vérifié côté serveur), pour que la clé
//     Gemini du site ne puisse pas être consommée par n'importe qui ;
//   - l'image n'est jamais stockée, ni ici ni en base : elle est transmise à Gemini puis oubliée.
//
// Variables d'environnement Netlify requises (déjà utilisées par les autres fonctions) :
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GEMINI_API_KEY

const { createClient } = require('@supabase/supabase-js');

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const ALLOWED_MIME = ['image/png', 'image/jpeg', 'image/webp'];
const MAX_IMAGE_BYTES = 6 * 1024 * 1024; // 6 Mo une fois décodée — largement assez pour une capture
const MAX_ACCOUNTS = 50;                 // même plafond que le formulaire « Ajout en masse »

const MODELS = ['gemini-3.5-flash', 'gemini-flash-latest'];
const MAX_ATTEMPTS_PER_MODEL = 3;
const BASE_RETRY_DELAY_MS = 900;

// Consigne de lecture. `firmNames` = catalogue des PropFirms de Contralytix (envoyé par le
// navigateur) : Gemini ne peut répondre qu'un de ces noms, jamais une PropFirm inventée.
function buildPrompt(firmNames) {
  const firms = firmNames.length ? firmNames.map((n) => `"${n}"`).join(', ') : '(aucune)';
  return `Tu lis une capture d'écran d'une plateforme de trading (Tradovate, Rithmic, NinjaTrader, Project X, tableau de bord de prop firm…).
Pour CHAQUE compte de trading visible, renvoie un objet avec ces champs :

- "number" : l'identifiant du compte, recopié exactement, caractère par caractère, tirets compris, sans le corriger ni le compléter (exemples : "FFFUNDED541223", "APEX-123456-03", "PP-F150K-000247-000010", "LFF050-KE249Z1F-PRO002", "DEMO19714"). Recopie aussi les comptes de démo ou de simulation (ils sont filtrés ensuite).
- "propfirm" : la PropFirm du compte, en choisissant UNIQUEMENT un nom de cette liste, écrit à l'identique : ${firms}. Sinon null.
- "propfirmSource" : "screen" si le nom (ou le logo) de la PropFirm est affiché à l'écran pour ce compte (colonne, en-tête, titre de la page) ; "number" si tu le déduis d'un nom ou d'une abréviation sans ambiguïté contenu dans l'identifiant (ex : "APEX" dans "APEX-123456-03") ; null si propfirm est null. Ne devine jamais : en cas de doute, propfirm = null.
- "size" : la taille du compte en dollars (nombre entier, ex : 50000), uniquement si elle est affichée comme taille ou plan du compte, ou écrite explicitement dans l'identifiant avec un K (ex : "150K" → 150000, "50K" → 50000). Ne JAMAIS utiliser le solde, l'équité, le P&L ou un autre montant comme taille. Sinon null.
- "sizeSource" : "screen", "number" ou null, sur le même principe.
- "type" : "CHALLENGE" (évaluation : mots EVAL, EVALUATION, TEST, COMBINE, CHALLENGE, QUALIF), "PA" (compte financé : mots FUNDED, PA, PRO, XFA, PERFORMANCE, EXPRESS), "LIVE" (mot LIVE), uniquement si ce mot est affiché à l'écran pour ce compte ou contenu dans l'identifiant. Sinon null.
- "typeSource" : "screen", "number" ou null.

Ignore les en-têtes de colonnes, soldes, montants, dates, noms de personnes, adresses e-mail et libellés de menus. Ne mets pas deux fois le même compte. Si aucun compte n'est lisible, renvoie une liste vide.
Réponds uniquement avec du JSON de la forme {"accounts":[{"number":"...","propfirm":null,"propfirmSource":null,"size":null,"sizeSource":null,"type":null,"typeSource":null}]}.`;
}

const json = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isOverloaded = (status, message) =>
  status === 503 || status === 429 || /overload|high demand|unavailable/i.test(message || '');

// Comptes de démo / simulation propres à la plateforme (ex: "DEMO19714" chez Tradovate,
// "Sim101" chez NinjaTrader) : ce ne sont pas des comptes de PropFirm, on ne les importe jamais.
function isDemoAccount(id) {
  const k = id.toLowerCase().replace(/[._-]+/g, '');
  return /demo|practice|paper/.test(k) || /^sim\d/.test(k);
}

const TYPES = ['CHALLENGE', 'PA', 'LIVE'];
const SOURCES = ['screen', 'number'];

// Nettoie la réponse du modèle : garde des identifiants plausibles, sans doublon, et ne conserve
// PropFirm / taille / type que s'ils sont valides (PropFirm présente dans le catalogue, taille
// réaliste, type connu). Renvoie { accounts:[{number, propfirm, propfirmSource, size, sizeSource,
// type, typeSource}], ignored } — `ignored` = comptes de démo écartés, affichés au trader.
function cleanAccounts(list, firmNames) {
  const firmByLower = new Map(firmNames.map((n) => [n.toLowerCase(), n]));
  const seen = new Set();
  const out = [];
  const ignored = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const item = typeof raw === 'string' ? { number: raw } : (raw && typeof raw === 'object' ? raw : null);
    if (!item || typeof item.number !== 'string') continue;
    const id = item.number.trim().replace(/\s+/g, '');
    // Un identifiant de compte : 3 à 40 caractères, au moins un chiffre, alphanumérique + - _ .
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

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Méthode non autorisée' });

  // 1. Utilisateur connecté obligatoire
  const authHeader = event.headers.authorization || event.headers.Authorization;
  if (!authHeader) return json(401, { error: 'Non authentifié' });
  try {
    const token = authHeader.replace('Bearer ', '');
    const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
    if (userErr || !userData?.user) return json(401, { error: 'Session invalide, reconnecte-toi.' });
  } catch (e) {
    return json(401, { error: 'Session invalide, reconnecte-toi.' });
  }

  // 2. Image valide
  let image, mimeType, firmNames = [];
  try {
    const body = JSON.parse(event.body || '{}');
    // Catalogue des PropFirms (noms seulement) : 100 max, noms courts et sans guillemets.
    if (Array.isArray(body.firms)) {
      firmNames = [...new Set(body.firms
        .filter((n) => typeof n === 'string')
        .map((n) => n.replace(/["\\\n\r]/g, '').trim())
        .filter((n) => n && n.length <= 60))].slice(0, 100);
    }
    image = typeof body.image === 'string' ? body.image.replace(/^data:[^,]*,/, '') : '';
    mimeType = typeof body.mimeType === 'string' ? body.mimeType : '';
  } catch (e) {
    return json(400, { error: 'Requête invalide.' });
  }
  if (!image) return json(400, { error: 'Aucune image reçue.' });
  if (!ALLOWED_MIME.includes(mimeType)) return json(400, { error: 'Format non pris en charge : utilise une image PNG, JPG ou WEBP.' });
  if (Math.floor(image.length * 3 / 4) > MAX_IMAGE_BYTES) return json(413, { error: 'Image trop lourde (6 Mo maximum). Recadre la capture sur la liste des comptes.' });

  const key = process.env.GEMINI_API_KEY;
  if (!key) return json(500, { error: 'GEMINI_API_KEY non configurée sur Netlify.' });

  // 3. Lecture par Gemini, avec les mêmes reprises que gemini-synthesis.js en cas de surcharge
  let lastError = 'Erreur API Gemini';
  for (const model of MODELS) {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_MODEL; attempt++) {
      try {
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: buildPrompt(firmNames) }, { inline_data: { mime_type: mimeType, data: image } }] }],
            generationConfig: { temperature: 0, responseMimeType: 'application/json' },
          }),
        });
        const data = await res.json();
        if (res.ok) {
          const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
          let parsed = null;
          try { parsed = JSON.parse(text); }
          catch (e) {
            const m = text.match(/\{[\s\S]*\}/);
            if (m) { try { parsed = JSON.parse(m[0]); } catch (e2) { /* ignoré */ } }
          }
          return json(200, cleanAccounts(parsed && parsed.accounts, firmNames));
        }
        lastError = data.error?.message || 'Erreur API Gemini';
        if (isOverloaded(res.status, lastError)) {
          if (attempt < MAX_ATTEMPTS_PER_MODEL) { await sleep(BASE_RETRY_DELAY_MS * attempt); continue; }
          break; // modèle de repli
        }
        console.error('read-accounts-screenshot Gemini error:', lastError);
        return json(502, { error: 'La lecture de la capture a échoué. Réessaie dans un instant.' });
      } catch (err) {
        console.error('read-accounts-screenshot error:', err);
        lastError = 'Erreur serveur lors de la lecture de la capture';
      }
    }
  }
  return json(503, { error: 'Le service de lecture est saturé pour le moment. Réessaie dans une minute.' });
};
