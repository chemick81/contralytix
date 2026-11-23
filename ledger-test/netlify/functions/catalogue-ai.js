// netlify/functions/catalogue-ai.js — URL : /edge/catalogue-ai   (23/11/2026)
//
// Admin › Catalogue, bloc « Contrôle IA » : l'admin indique un lien (page officielle de la prop
// firm), le serveur lit la page et demande à l'IA Contralytix (Gemini du site) de comparer ce qu'elle
// dit avec les valeurs de la formule affichées dans la fiche.
// LECTURE SEULE : rien n'est écrit en base. L'admin reprend (ou non) chaque valeur dans la fiche puis
// enregistre avec un motif, comme une modification à la main (historique propfirm_program_history).
//
// Même principe que ai-edge.js : réponse en flux (un espace toutes les 5 s, puis le JSON final avec le
// vrai code dans `status`), budget ~55 s, car lire une page + l'analyser dépasse souvent 10 s.
//
// POST { url, firm, program, phase, fields:[{ key, label, value }] }
//   key = clé de la case dans la fiche : « s:<taille>:<règle> » ou « g::<règle> ».
// En-tête Authorization: Bearer <jeton Supabase> d'un ADMIN.
// Variables Netlify : SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GEMINI_API_KEY (déjà utilisées).

const TIME_BUDGET_MS = 55000;
const PAGE_TIMEOUT_MS = 12000;
const MAX_PAGE_CHARS = 90000;
const MIN_PAGE_CHARS = 1200;   // en dessous : page chargée en JavaScript ou bloquée, l'IA la lit elle-même
const MAX_FIELDS = 200;
// Surcharge Google fréquente (« high demand ») : plusieurs essais espacés, puis modèles de repli.
const SITE_MODELS = ['gemini-3.6-flash', 'gemini-flash-latest', 'gemini-flash-lite-latest'];
const RETRY_WAITS_MS = [1500, 4000, 8000];

const env = (name) => {
  try { if (typeof Netlify !== 'undefined' && Netlify.env) return Netlify.env.get(name); } catch (e) { /* */ }
  try { if (typeof process !== 'undefined') return process.env[name]; } catch (e) { /* */ }
  return undefined;
};
const out = (status, body) => ({ status, body });
const SECRET_RE = /(AIza[0-9A-Za-z_-]{20,}|Bearer\s+[A-Za-z0-9._-]{16,})/g;
function safeLog(label, err) {
  const s = err && err.message ? err.message : String(err);
  console.error(label, s.replace(SECRET_RE, '[clé]').slice(0, 500));
}

/* ---------- Session admin (REST Supabase, clé service_role) ---------- */
async function getAdmin(token) {
  const url = (env('SUPABASE_URL') || '').replace(/\/$/, '');
  const key = env('SUPABASE_SERVICE_ROLE_KEY') || '';
  if (!url || !key || !token) return null;
  const res = await fetch(`${url}/auth/v1/user`, { headers: { apikey: key, Authorization: `Bearer ${token}` } });
  if (!res.ok) return null;
  const u = await res.json().catch(() => null);
  if (!u || !u.id) return null;
  const r = await fetch(`${url}/rest/v1/profiles?id=eq.${encodeURIComponent(u.id)}&select=role`, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
  const rows = r.ok ? await r.json().catch(() => []) : [];
  return rows[0] && rows[0].role === 'ADMIN' ? { id: u.id } : false;
}

/* ---------- Lecture de la page ---------- */
function htmlToText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<\/(p|div|li|tr|h[1-6]|br|section|article|td|th)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<td[^>]*>/gi, ' | ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;|&rsquo;/g, '’').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
}
async function readPage(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), PAGE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow', headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; ContralytixCatalogueCheck/1.0; +https://contralytix.fr)',
      Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5', 'Accept-Language': 'fr,en;q=0.8' } });
    if (!res.ok) return { text: '', why: 'HTTP ' + res.status };
    const raw = await res.text();
    return { text: htmlToText(raw).slice(0, MAX_PAGE_CHARS), why: '' };
  } catch (e) {
    const code = String((e && e.cause && e.cause.code) || (e && e.name === 'AbortError' ? 'délai dépassé' : (e && e.message) || e));
    return { text: '', why: code.slice(0, 80) };
  } finally { clearTimeout(t); }
}

/* ---------- IA (Gemini du site) ---------- */
function aiError(code, msg) { const e = new Error(msg || code); e.code = code; return e; }
async function gemini(model, body, deadline) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), Math.max(1000, deadline - Date.now()));
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST', signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env('GEMINI_API_KEY') || '' }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const m = String((data.error && data.error.message) || '');
      throw aiError(res.status === 404 ? 'bad_model' : (res.status === 429 || res.status === 503 || /overload|unavailable/i.test(m)) ? 'overloaded' : 'provider_error', m);
    }
    const cand = (data.candidates && data.candidates[0]) || {};
    if (cand.finishReason === 'MAX_TOKENS') throw aiError('truncated', 'réponse coupée');
    return (cand.content && (cand.content.parts || []).filter((x) => !x.thought).map((x) => x.text || '').join('')) || '';
  } catch (e) {
    if (e.code) throw e;
    throw aiError(e && e.name === 'AbortError' ? 'timeout' : 'unreachable');
  } finally { clearTimeout(t); }
}
async function callSite(prompt, { urlContext, deadline }) {
  if (!env('GEMINI_API_KEY')) throw aiError('not_configured', 'GEMINI_API_KEY absente');
  const body = { contents: [{ parts: [{ text: prompt }] }], generationConfig: { thinkingConfig: { thinkingLevel: 'low' } } };
  // Le mode JSON strict n'est pas accepté avec l'outil de lecture d'URL : on lit alors le JSON dans le texte.
  if (urlContext) body.tools = [{ url_context: {} }];
  else body.generationConfig.responseMimeType = 'application/json';
  let last = null;
  for (const model of SITE_MODELS) {
    for (let attempt = 1; attempt <= RETRY_WAITS_MS.length + 1; attempt++) {
      if (deadline - Date.now() < 4000) throw last || aiError('timeout');
      try { return { text: await gemini(model, body, deadline), model }; }
      catch (e) {
        last = e;
        if (e.code === 'provider_error' && /thinking/i.test(e.message) && body.generationConfig.thinkingConfig) { delete body.generationConfig.thinkingConfig; continue; }
        if (e.code === 'overloaded' && attempt <= RETRY_WAITS_MS.length && deadline - Date.now() > RETRY_WAITS_MS[attempt - 1] + 6000) {
          console.log(`catalogue-ai: ${model} surchargé, nouvel essai dans ${RETRY_WAITS_MS[attempt - 1] / 1000} s`);
          await new Promise((r) => setTimeout(r, RETRY_WAITS_MS[attempt - 1])); continue;
        }
        if (e.code === 'overloaded' || e.code === 'bad_model') break;
        throw e;
      }
    }
  }
  throw last || aiError('overloaded');
}
function parseJson(text) {
  let t = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const i = t.indexOf('{'), j = t.lastIndexOf('}');
  if (i < 0 || j < i) return null;
  try { return JSON.parse(t.slice(i, j + 1)); } catch (e) { return null; }
}

function buildPrompt({ url, firm, program, phase, fields, pageText }) {
  const list = fields.map((f) => `${f.key} | ${f.label} | ${f.value === '' ? '(vide)' : f.value}`).join('\n');
  return `Tu contrôles le catalogue des règles d'une prop firm de trading de futures.
Prop firm : ${firm}. Formule : ${program}. Phase : ${phase === 'LIVE' ? 'compte Live' : 'compte financé (PA / funded / Master), PAS l’évaluation ni le challenge'}.
Page à lire : ${url}

Voici les valeurs actuelles du catalogue (clé | règle | valeur). « s:50000:… » = taille de compte 50 000 $ ; « g::… » = commun à toutes les tailles.
${list}

Conventions de format (réponds dans le même format que le catalogue) :
- Montants en dollars sans symbole ni espace (ex. 2600). Buffer = montant à garder au-dessus du solde de départ après un payout (réserve, safety net…). Profit min pour demander = profit au-dessus du départ requis pour faire une demande.
- Cohérence = pourcentage maximum du meilleur jour, une valeur par numéro de payout séparée par des virgules (ex. 40, 40, 45) ou une seule valeur.
- Plafond par payout = montant max par numéro de payout, séparé par des virgules ; « — » = sans plafond.
- Split = part du trader en % (ex. 90). Drawdown : EOD, INTRADAY ou EOD,INTRADAY. Jours comptés : winning (jours gagnants) ou trading. Activation : free, paid ou choice. Paiement : one_time ou monthly. DLL en PA : yes, no ou optional.

Consignes :
- Utilise UNIQUEMENT le contenu de la page indiquée. N’utilise pas tes connaissances générales, pas d’autre site.
- Pour chaque clé : status « ok » si la page confirme la valeur, « ecart » si la page donne une autre valeur, « absent » si la page ne parle pas de cette règle pour cette taille. Ne devine jamais : en cas de doute, « absent ».
- « page » = la valeur lue sur la page, au format du catalogue (vide si absent). « citation » = courte phrase recopiée de la page qui le prouve (25 mots maximum, dans la langue de la page), vide si absent.
- Ne réponds que pour les clés de la liste. Ajoute dans « autres » (5 maximum) les règles importantes de la page qui ne rentrent dans aucune clé (ex. condition de date d’achat, jour de traitement).
- Si la page ne concerne pas cette formule ou cette phase, mets « pageHorsSujet » à true.

Réponds uniquement par ce JSON :
{"pageHorsSujet":false,"resume":"une phrase sur ce que couvre la page","checks":[{"key":"s:50000:buffer","status":"ok","page":"2600","citation":"…"}],"autres":["…"]}
${pageText ? `\n--- CONTENU DE LA PAGE (texte extrait) ---\n${pageText}\n--- FIN DE LA PAGE ---` : '\n(Lis la page à l’adresse indiquée.)'}`;
}

async function handle(request) {
  if (request.method !== 'POST') return out(405, { error: 'Méthode non autorisée' });
  const deadline = Date.now() + TIME_BUDGET_MS;
  const admin = await getAdmin((request.headers.get('authorization') || '').replace('Bearer ', '').trim()).catch(() => null);
  if (admin === null) return out(401, { error: 'Session invalide, reconnecte-toi.', code: 'unauthorized' });
  if (admin === false) return out(403, { error: 'Réservé aux administrateurs.', code: 'forbidden' });

  let body = {};
  try { body = await request.json(); } catch (e) { return out(400, { error: 'Requête invalide' }); }
  const url = String(body.url || '').trim();
  if (!/^https:\/\/[^\s/]+\.[^\s]+$/i.test(url) || url.length > 600) return out(400, { error: 'Lien invalide : indique une adresse https:// complète.', code: 'bad_url' });
  try { const h = new URL(url).hostname; if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|\[)/i.test(h)) return out(400, { error: 'Lien non autorisé.', code: 'bad_url' }); }
  catch (e) { return out(400, { error: 'Lien invalide.', code: 'bad_url' }); }
  const fields = (Array.isArray(body.fields) ? body.fields : []).slice(0, MAX_FIELDS)
    .filter((f) => f && /^[gs]:\d*:[A-Za-z]+$/.test(String(f.key || '')))
    .map((f) => ({ key: String(f.key), label: String(f.label || '').slice(0, 80), value: String(f.value == null ? '' : f.value).slice(0, 120) }));
  if (!fields.length) return out(400, { error: 'Aucune valeur à contrôler.', code: 'empty' });
  const meta = { firm: String(body.firm || '').slice(0, 80), program: String(body.program || '').slice(0, 80), phase: body.phase === 'LIVE' ? 'LIVE' : 'PA' };

  const page = await readPage(url);
  const useUrlTool = page.text.length < MIN_PAGE_CHARS;
  try {
    const prompt = buildPrompt({ url, ...meta, fields, pageText: useUrlTool ? '' : page.text });
    const res = await callSite(prompt, { urlContext: useUrlTool, deadline });
    const data = parseJson(res.text);
    if (!data || !Array.isArray(data.checks)) throw aiError('bad_answer', 'réponse illisible');
    const keys = new Set(fields.map((f) => f.key));
    const checks = data.checks.filter((c) => c && keys.has(String(c.key)))
      .map((c) => ({ key: String(c.key), status: ['ok', 'ecart', 'absent'].includes(c.status) ? c.status : 'absent',
        page: String(c.page == null ? '' : c.page).slice(0, 120), citation: String(c.citation || '').slice(0, 300) }));
    return out(200, {
      checks, autres: (Array.isArray(data.autres) ? data.autres : []).slice(0, 5).map((x) => String(x).slice(0, 300)),
      resume: String(data.resume || '').slice(0, 300), offTopic: !!data.pageHorsSujet,
      read: useUrlTool ? 'ia' : 'serveur', pageChars: page.text.length, pageWhy: page.why, model: res.model,
    });
  } catch (e) {
    safeLog('catalogue-ai:', e);
    const msg = { timeout: 'L’analyse a pris trop de temps. Réessaie, ou indique une page plus ciblée.', overloaded: 'Les serveurs de l’IA (Google Gemini) sont saturés en ce moment, même après plusieurs essais. Réessaie dans quelques minutes.',
      not_configured: 'IA non configurée sur le serveur (GEMINI_API_KEY).', bad_answer: 'L’IA a renvoyé une réponse illisible. Réessaie.' }[e.code];
    return out(e.code === 'timeout' ? 504 : e.code === 'overloaded' ? 503 : 502, { error: msg || 'Analyse impossible pour le moment. Réessaie.', code: e.code || 'error', pageWhy: page.why });
  }
}

export default (request) => {
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      controller.enqueue(enc.encode(' '));
      const keepAlive = setInterval(() => { try { controller.enqueue(enc.encode(' ')); } catch (e) { /* fermé */ } }, 5000);
      let result;
      try { result = await handle(request); }
      catch (err) { safeLog('catalogue-ai fatal:', err); result = out(500, { error: 'Erreur serveur. Réessaie.' }); }
      clearInterval(keepAlive);
      controller.enqueue(enc.encode(JSON.stringify({ ...result.body, status: result.status })));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
};

export const config = { path: '/edge/catalogue-ai' };
