// netlify/functions/_ai-lib.js
//
// Bibliothèque commune des appels IA (01/11/2026) — utilisée par ai.js, ai-key.js et
// read-accounts-screenshot.js.
//
//   - Moteur « site » : l'IA Contralytix (Gemini, clé GEMINI_API_KEY du site). Reste le moteur par défaut.
//   - Moteur « mine » : la clé personnelle de l'utilisateur (Gemini, OpenAI, Anthropic, OpenRouter, Groq),
//     conservée CHIFFRÉE (AES-256-GCM) dans user_ai_keys, déchiffrée ici le temps d'un appel.
//
// Règles de sécurité appliquées partout :
//   - session Supabase obligatoire (aucune fonction IA n'est appelable anonymement) ;
//   - les clés passent toujours dans un EN-TÊTE, jamais dans l'URL (sinon elles finissent dans les journaux) ;
//   - aucune clé ne repart vers le navigateur (seulement un indice « sk-…a1f3 ») ;
//   - les journaux sont nettoyés de toute clé (safeLog) ;
//   - quotas journaliers par utilisateur (table ai_usage).
//
// Variables Netlify :
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GEMINI_API_KEY (déjà présentes)
//   AI_KEY_ENC              : secret de chiffrement des clés utilisateurs (≥ 32 caractères, à ne plus changer)
//   AI_SITE_DAILY_LIMIT     : appels IA Contralytix par utilisateur et par jour (défaut 40, admins exemptés)
//   AI_MINE_DAILY_LIMIT     : appels avec la clé de l'utilisateur par jour (défaut 300, anti-abus)
//   AI_MODEL_<FOURNISSEUR>  : modèle par défaut d'un fournisseur (ex. AI_MODEL_OPENAI=gpt-4.1-mini)

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const PROVIDERS = {
  gemini:     { name: 'Gemini',     vision: true,  model: 'gemini-flash-latest' },
  openai:     { name: 'OpenAI',     vision: true,  model: 'gpt-4.1-mini' },
  anthropic:  { name: 'Anthropic',  vision: true,  model: 'claude-haiku-5-5' },
  openrouter: { name: 'OpenRouter', vision: true,  model: 'openrouter/auto' },
  groq:       { name: 'Groq',       vision: false, model: 'openai/gpt-oss-120b' },
};
const MODULES = {
  coach:  { premium: true,  vision: false },
  meteo:  { premium: false, vision: false },   // le brief météo n'a jamais été réservé au Premium
  chat:   { premium: false, vision: false },
  import: { premium: false, vision: true },
};
const SITE_MODELS = ['gemini-3.6-flash', 'gemini-flash-latest'];
// Consignes ajoutées par le serveur à la demande du trader (01/11/2026), selon le module.
// Météo : mise en page lisible et interdiction d'inventer des données de marché.
function moduleRules(module, web) {
  if (module !== 'meteo') return '';
  return `\n\n---\nRègles de réponse (prioritaires) :
- Réponds en français, en texte lisible : un titre court par partie (## Titre), puis des puces courtes. Pas de tableau, pas de HTML, pas de balise <br>.
- ${web ? 'Appuie-toi sur une recherche web récente pour le contexte du jour (calendrier économique, actualité, échéances).' : 'Tu n’as PAS accès à internet ni aux données de marché du jour : ne donne aucun niveau de prix, horaire, statistique ou volume précis ; décris seulement des points de vigilance généraux et indique clairement que les données du jour sont à vérifier.'}
- N’invente jamais un niveau de prix, un horaire d’annonce, un volume ou une statistique : si tu ne l’as pas trouvé dans une source, écris « à vérifier ».
- Tu ne vois pas le carnet d’ordres ni ATAS : ne décris jamais leur contenu, donne seulement à quoi être attentif.
- Ne donne pas de conseil d’investissement personnalisé ; formule des points d’attention.`;
}
const intEnv = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) && n >= 0 ? n : d; };

function db() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
}
function json(status, body) {
  return { statusCode: status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(body) };
}

/* ---------- Chiffrement ---------- */
function encKey() {
  const s = process.env.AI_KEY_ENC || '';
  if (s.length < 32) { const e = new Error('AI_KEY_ENC absente ou trop courte (32 caractères minimum)'); e.code = 'not_configured'; throw e; }
  return crypto.createHash('sha256').update(s, 'utf8').digest();
}
function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', encKey(), iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
}
function decrypt(packed) {
  const [v, iv, tag, ct] = String(packed || '').split(':');
  if (v !== 'v1' || !iv || !tag || !ct) { const e = new Error('clé chiffrée illisible'); e.code = 'key_unreadable'; throw e; }
  const d = crypto.createDecipheriv('aes-256-gcm', encKey(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
}
// Indice affichable : le préfixe du fournisseur et les 4 derniers caractères, jamais plus.
function keyHint(key) {
  const k = String(key || '').trim();
  if (k.length < 10) return '••••';
  const pre = (k.match(/^(sk-ant-|sk-or-v1-|sk-or-|sk-proj-|sk-|gsk_|AIza)/) || [''])[0];
  return `${pre}…${k.slice(-4)}`;
}

/* ---------- Journaux sans secret ---------- */
const SECRET_RE = /(AIza[0-9A-Za-z_-]{20,}|sk-[A-Za-z0-9_-]{16,}|gsk_[A-Za-z0-9]{16,}|key=[^&\s"']+|Bearer\s+[A-Za-z0-9._-]{16,}|x-api-key[^,}]*)/g;
function scrub(v, extra) {
  let s = typeof v === 'string' ? v : (v && v.message) ? v.message : (() => { try { return JSON.stringify(v); } catch (e) { return String(v); } })();
  (extra || []).filter((x) => x && x.length >= 8).forEach((x) => { s = s.split(x).join('[clé]'); });
  return String(s).replace(SECRET_RE, '[clé]').slice(0, 500);
}
function safeLog(label, err, secrets) { console.error(label, scrub(err, secrets)); }

/* ---------- Utilisateur ---------- */
async function userFromEvent(client, event) {
  const h = event.headers || {};
  const auth = h.authorization || h.Authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token) return null;
  const { data, error } = await client.auth.getUser(token);
  if (error || !data || !data.user) return null;
  const { data: prof } = await client.from('profiles').select('role').eq('id', data.user.id).maybeSingle();
  const role = (prof && prof.role) || 'FREE';
  return { id: data.user.id, email: data.user.email, role, isAdmin: role === 'ADMIN', isPremium: ['ADMIN', 'PREMIUM', 'BETA'].includes(role) };
}

/* ---------- Clé de l'utilisateur ---------- */
async function loadUserKey(client, userId) {
  const { data, error } = await client.from('user_ai_keys').select('*').eq('user_id', userId).maybeSingle();
  if (error) { const e = new Error(error.message); e.code = /relation|does not exist/i.test(error.message) ? 'migration_missing' : 'db_error'; throw e; }
  return data || null;
}
function publicStatus(row) {
  if (!row) return { connected: false };
  const p = PROVIDERS[row.provider] || {};
  return { connected: true, provider: row.provider, providerName: p.name || row.provider, vision: !!p.vision, hint: row.key_hint, model: row.model || null, verifiedAt: row.verified_at, lastError: row.last_error || null, engines: row.engines || {} };
}

/* ---------- Quotas ---------- */
function parisDayStartISO(now = new Date()) {
  const offset = Date.parse(now.toLocaleString('en-US', { timeZone: 'Europe/Paris' })) - Date.parse(now.toLocaleString('en-US', { timeZone: 'UTC' }));
  const [y, m, d] = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) - offset).toISOString();
}
async function checkQuota(client, user, engine) {
  if (user.isAdmin) return { ok: true };
  const limit = engine === 'site' ? intEnv(process.env.AI_SITE_DAILY_LIMIT, 40) : intEnv(process.env.AI_MINE_DAILY_LIMIT, 300);
  if (!limit) return { ok: true };
  const { count, error } = await client.from('ai_usage').select('id', { count: 'exact', head: true })
    .eq('user_id', user.id).eq('engine', engine).gte('created_at', parisDayStartISO());
  if (error) { safeLog('ai_usage count:', error); return { ok: true }; } // compteur indisponible : on n'empêche pas
  return { ok: (count || 0) < limit, limit, used: count || 0 };
}
async function logUsage(client, user, module, engine, ok) {
  const { error } = await client.from('ai_usage').insert({ user_id: user.id, module, engine, ok: !!ok });
  if (error) safeLog('ai_usage insert:', error);
}

/* ---------- Appels fournisseurs ---------- */
function aiError(code, message, status) { const e = new Error(message || code); e.code = code; e.status = status; return e; }
function classify(status, msg) {
  const m = String(msg || '');
  if (status === 401 || status === 403 || /api key|invalid.*key|unauthori|permission|authentication/i.test(m)) return 'invalid_key';
  if (status === 402 || /credit|billing|insufficient_quota|payment/i.test(m)) return 'no_credit';
  if (status === 429 && !/overload|high demand/i.test(m)) return 'rate_limited';
  if (status === 503 || status === 529 || status === 429 || /overload|high demand|unavailable/i.test(m)) return 'overloaded';
  if (status === 404 || /model.*not found|does not exist|no such model/i.test(m)) return 'bad_model';
  return 'provider_error';
}
async function fetchJson(url, opts, deadline) {
  const ctrl = new AbortController();
  const ms = Math.max(1000, (deadline || Date.now() + 9000) - Date.now());
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    const data = await res.json().catch(() => ({}));
    return { res, data };
  } catch (e) {
    if (e.name === 'AbortError') throw aiError('timeout', 'délai dépassé');
    throw aiError('unreachable', 'fournisseur injoignable');
  } finally { clearTimeout(t); }
}

// image : { mime, base64 } ou null. json : demande une réponse JSON stricte quand le fournisseur le permet.
// search : recherche Google avant de répondre (Gemini uniquement, « grounding ») ; renvoie alors sources [{title,url}].
async function callProvider(provider, key, { prompt, image, model, json: wantJson, maxTokens, deadline, search }) {
  const p = PROVIDERS[provider];
  if (!p) throw aiError('bad_provider', 'fournisseur inconnu');
  if (image && !p.vision) throw aiError('no_vision', `${p.name} ne lit pas les images`);
  const mdl = model || process.env[`AI_MODEL_${provider.toUpperCase()}`] || p.model;
  // Pas de plafond court par défaut (01/11/2026) : sur les modèles « qui réfléchissent » (Gemini 3,
  // gpt-oss…), la réflexion compte dans le plafond ; un plafond de 2 048 coupait le bilan du coach
  // en pleine réflexion, et c'est ce brouillon (en anglais) qui s'affichait.
  const max = maxTokens || 8192;

  if (provider === 'gemini') {
    const parts = [{ text: prompt }];
    if (image) parts.push({ inline_data: { mime_type: image.mime, data: image.base64 } });
    const body = { contents: [{ parts }], generationConfig: { ...(maxTokens ? { maxOutputTokens: max } : {}), ...(wantJson ? { responseMimeType: 'application/json' } : {}) } };
    if (search) {
      body.tools = [{ google_search: {} }];
      // Réflexion réduite : la recherche prend déjà du temps et Netlify coupe vers 10 s.
      body.generationConfig.thinkingConfig = { thinkingLevel: 'low' };
    }
    const send = () => fetchJson(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(mdl)}:generateContent`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify(body),
    }, deadline);
    let { res, data } = await send();
    if (!res.ok && res.status === 400 && body.generationConfig.thinkingConfig && /thinking/i.test((data.error && data.error.message) || '')) {
      delete body.generationConfig.thinkingConfig;   // modèle qui refuse ce réglage : on réessaie sans
      ({ res, data } = await send());
    }
    if (!res.ok) { const m = data.error && data.error.message; throw aiError(classify(res.status, m), scrub(m, [key]), res.status); }
    const cand = (data.candidates && data.candidates[0]) || {};
    if (cand.finishReason === 'MAX_TOKENS') throw aiError('truncated', 'réponse coupée');
    // Les parties « thought » sont la réflexion interne du modèle : jamais affichées.
    const text = (cand.content && (cand.content.parts || []).filter((x) => !x.thought).map((x) => x.text || '').join('')) || '';
    const chunks = (cand.groundingMetadata && cand.groundingMetadata.groundingChunks) || [];
    const seen = new Set();
    const sources = chunks.map((c) => c && c.web).filter((w) => w && /^https?:\/\//.test(w.uri || ''))
      .filter((w) => { const k = w.title || w.uri; if (seen.has(k)) return false; seen.add(k); return true; })
      .slice(0, 8).map((w) => ({ title: String(w.title || w.uri).slice(0, 120), url: w.uri }));
    return { text: text.trim(), model: mdl, web: !!search, sources };
  }

  if (provider === 'anthropic') {
    const content = [];
    if (image) content.push({ type: 'image', source: { type: 'base64', media_type: image.mime, data: image.base64 } });
    content.push({ type: 'text', text: prompt });
    const { res, data } = await fetchJson('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: mdl, max_tokens: max, messages: [{ role: 'user', content }] }),
    }, deadline);
    if (!res.ok) { const m = data.error && data.error.message; throw aiError(classify(res.status, m), scrub(m, [key]), res.status); }
    if (data.stop_reason === 'max_tokens') throw aiError('truncated', 'réponse coupée');
    const text = (Array.isArray(data.content) ? data.content : []).filter((c) => c.type === 'text').map((c) => c.text).join('');
    return { text: text.trim(), model: mdl };
  }

  // OpenAI, OpenRouter, Groq : même format (chat/completions).
  const url = { openai: 'https://api.openai.com/v1/chat/completions', openrouter: 'https://openrouter.ai/api/v1/chat/completions', groq: 'https://api.groq.com/openai/v1/chat/completions' }[provider];
  const content = image ? [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: `data:${image.mime};base64,${image.base64}` } }] : prompt;
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` };
  if (provider === 'openrouter') { headers['HTTP-Referer'] = 'https://contralytix.fr'; headers['X-Title'] = 'Contralytix'; }
  const body = { model: mdl, messages: [{ role: 'user', content }], max_tokens: max };
  if (wantJson && provider !== 'openrouter') body.response_format = { type: 'json_object' };
  const { res, data } = await fetchJson(url, { method: 'POST', headers, body: JSON.stringify(body) }, deadline);
  if (!res.ok) { const m = data.error && (data.error.message || data.error); throw aiError(classify(res.status, m), scrub(m, [key]), res.status); }
  if (data.choices && data.choices[0] && data.choices[0].finish_reason === 'length') throw aiError('truncated', 'réponse coupée');
  const text = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  return { text: String(Array.isArray(text) ? text.map((x) => x.text || '').join('') : (text || '')).trim(), model: mdl };
}

// Moteur Contralytix : Gemini du site, avec nouvelles tentatives et modèle de repli en cas de surcharge.
async function callSite({ prompt, image, json: wantJson, maxTokens, deadline, search }) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw aiError('not_configured', 'GEMINI_API_KEY absente');
  let last = null;
  for (const model of SITE_MODELS) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      if (deadline && deadline - Date.now() < 1500) throw last || aiError('timeout', 'délai dépassé');
      try {
        return await callProvider('gemini', key, { prompt, image, model, json: wantJson, maxTokens, deadline, search });
      } catch (e) {
        last = e;
        if (e.code === 'overloaded' && attempt < 2) { await new Promise((r) => setTimeout(r, 800)); continue; }
        if (e.code === 'overloaded' || e.code === 'bad_model') break;
        throw e;
      }
    }
  }
  throw last || aiError('overloaded', 'surchargé');
}

// Messages lisibles pour le navigateur (jamais le message brut du fournisseur, qui peut contenir des détails internes).
function userMessage(code, providerName) {
  const n = providerName || 'Le fournisseur';
  return {
    invalid_key: `${n} refuse cette clé : vérifie qu’elle est complète et toujours active.`,
    no_credit: `Ton compte ${n} n’a plus de crédit ou de moyen de paiement.`,
    rate_limited: `${n} limite le nombre de requêtes de ta clé : réessaie dans une minute.`,
    overloaded: 'Le service IA est surchargé, réessaie dans quelques minutes.',
    bad_model: `Le modèle demandé n’existe pas chez ${n}.`,
    no_vision: `${n} ne lit pas les images avec cette clé.`,
    timeout: 'L’IA met trop de temps à répondre. Réessaie.',
    truncated: 'La réponse de l’IA a été coupée avant la fin. Réessaie.',
    unreachable: `${n} est injoignable pour le moment.`,
    not_configured: 'L’IA n’est pas encore configurée sur ce site.',
    migration_missing: 'La base n’est pas prête : exécute migration_ia_cle.sql sur Supabase.',
    key_unreadable: 'Ta clé enregistrée est illisible : enregistre-la à nouveau.',
    no_key: 'Aucune clé IA enregistrée : ajoute-la dans Profil → Connexions.',
    premium_only: 'L’IA Contralytix est incluse dans Premium pour ce module. Utilise ta propre clé, ou passe Premium.',
    quota: 'Limite d’utilisation de l’IA atteinte pour aujourd’hui.',
  }[code] || 'Erreur pendant l’échange avec l’IA. Réessaie plus tard.';
}

module.exports = {
  PROVIDERS, MODULES, moduleRules, db, json, encrypt, decrypt, keyHint, scrub, safeLog, userFromEvent,
  loadUserKey, publicStatus, checkQuota, logUsage, callProvider, callSite, userMessage, aiError, parisDayStartISO,
};
