// netlify/edge-functions/ai-edge.js — URL : /edge/ai   (01/11/2026)
//
// Même rôle que netlify/functions/ai.js (Coach, brief météo, assistant), mais en Edge Function :
// une fonction classique est coupée par Netlify vers 10 s, ce que le brief météo avec recherche web
// (Gemini + Google Search) peut dépasser. Ici, la réponse est ouverte tout de suite puis complétée
// quand l'IA a fini : jusqu'à ~55 s. Le navigateur appelle cette URL en premier et retombe sur
// /api/ai si elle n'est pas déployée (404) — même principe que /edge/read-accounts-screenshot.
//
// Règles identiques à ai.js / _ai-lib.js (À GARDER SYNCHRONISÉES) :
//   - session Supabase obligatoire ; IA Contralytix réservée au Premium sur le Coach ;
//   - clé de l'utilisateur lue dans user_ai_keys et déchiffrée ici (AES-256-GCM, même secret AI_KEY_ENC,
//     même format v1:iv:tag:ct que _ai-lib.js) ; jamais renvoyée, jamais journalisée ;
//   - clés toujours en en-tête ; quotas ai_usage ; consignes météo ajoutées côté serveur.
//
// Variables Netlify : SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GEMINI_API_KEY, AI_KEY_ENC,
// AI_SITE_DAILY_LIMIT (40), AI_MINE_DAILY_LIMIT (300), AI_MODEL_<FOURNISSEUR> (facultatif).

const TIME_BUDGET_MS = 55000;
const MAX_PROMPT = 40000;
const SITE_MODELS = ['gemini-3.6-flash', 'gemini-flash-latest'];
const PROVIDERS = {
  gemini:     { name: 'Gemini',     model: 'gemini-flash-latest' },
  openai:     { name: 'OpenAI',     model: 'gpt-4.1-mini' },
  anthropic:  { name: 'Anthropic',  model: 'claude-haiku-5-5' },
  openrouter: { name: 'OpenRouter', model: 'openrouter/auto' },
  groq:       { name: 'Groq',       model: 'openai/gpt-oss-120b' },
};
const MODULES = { coach: { premium: true }, meteo: { premium: false }, chat: { premium: false } };

const env = (name) => {
  try { if (typeof Netlify !== 'undefined' && Netlify.env) return Netlify.env.get(name); } catch (e) { /* */ }
  try { if (typeof Deno !== 'undefined') return Deno.env.get(name); } catch (e) { /* */ }
  try { if (typeof process !== 'undefined') return process.env[name]; } catch (e) { /* */ }
  return undefined;
};
const intEnv = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) && n >= 0 ? n : d; };
const out = (status, body) => ({ status, body });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- Journaux sans secret ---------- */
const SECRET_RE = /(AIza[0-9A-Za-z_-]{20,}|sk-[A-Za-z0-9_-]{16,}|gsk_[A-Za-z0-9]{16,}|key=[^&\s"']+|Bearer\s+[A-Za-z0-9._-]{16,})/g;
function safeLog(label, err, secrets) {
  let s = err && err.message ? err.message : String(err);
  (secrets || []).filter((x) => x && x.length >= 8).forEach((x) => { s = s.split(x).join('[clé]'); });
  console.error(label, s.replace(SECRET_RE, '[clé]').slice(0, 500));
}

/* ---------- Supabase (REST, clé service_role) ---------- */
function sb() {
  const url = (env('SUPABASE_URL') || '').replace(/\/$/, '');
  const key = env('SUPABASE_SERVICE_ROLE_KEY') || '';
  return { url, key, headers: { apikey: key, Authorization: `Bearer ${key}` } };
}
async function getUser(token) {
  const { url, key, headers } = sb();
  if (!url || !key || !token) return null;
  const res = await fetch(`${url}/auth/v1/user`, { headers: { apikey: key, Authorization: `Bearer ${token}` } });
  if (!res.ok) return null;
  const u = await res.json().catch(() => null);
  if (!u || !u.id) return null;
  let role = 'FREE';
  try {
    const r = await fetch(`${url}/rest/v1/profiles?id=eq.${encodeURIComponent(u.id)}&select=role`, { headers });
    const rows = r.ok ? await r.json() : [];
    role = (rows[0] && rows[0].role) || 'FREE';
  } catch (e) { /* profil illisible : Free */ }
  return { id: u.id, role, isAdmin: role === 'ADMIN', isPremium: ['ADMIN', 'PREMIUM', 'BETA'].includes(role) };
}
async function loadUserKey(userId) {
  const { url, headers } = sb();
  const res = await fetch(`${url}/rest/v1/user_ai_keys?user_id=eq.${encodeURIComponent(userId)}&select=provider,key_enc,model,last_error`, { headers });
  if (!res.ok) { const e = new Error('user_ai_keys ' + res.status); e.code = res.status === 404 ? 'migration_missing' : 'db_error'; throw e; }
  const rows = await res.json();
  return rows[0] || null;
}
async function patchUserKey(userId, patch) {
  const { url, headers } = sb();
  await fetch(`${url}/rest/v1/user_ai_keys?user_id=eq.${encodeURIComponent(userId)}`, { method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json', Prefer: 'return=minimal' }, body: JSON.stringify(patch) }).catch(() => {});
}
function parisDayStartISO(now = new Date()) {
  const offset = Date.parse(now.toLocaleString('en-US', { timeZone: 'Europe/Paris' })) - Date.parse(now.toLocaleString('en-US', { timeZone: 'UTC' }));
  const [y, m, d] = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) - offset).toISOString();
}
async function quotaOk(user, engine) {
  if (user.isAdmin) return true;
  const limit = engine === 'site' ? intEnv(env('AI_SITE_DAILY_LIMIT'), 40) : intEnv(env('AI_MINE_DAILY_LIMIT'), 300);
  if (!limit) return true;
  const { url, headers } = sb();
  try {
    const res = await fetch(`${url}/rest/v1/ai_usage?user_id=eq.${encodeURIComponent(user.id)}&engine=eq.${engine}&created_at=gte.${encodeURIComponent(parisDayStartISO())}&select=id&limit=1`, { headers: { ...headers, Prefer: 'count=exact' } });
    if (!res.ok) return true; // compteur indisponible : on n'empêche pas
    const total = Number((res.headers.get('content-range') || '').split('/')[1]);
    return !Number.isFinite(total) || total < limit;
  } catch (e) { return true; }
}
async function logUsage(user, module, engine, ok) {
  const { url, headers } = sb();
  await fetch(`${url}/rest/v1/ai_usage`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', Prefer: 'return=minimal' }, body: JSON.stringify({ user_id: user.id, module, engine, ok: !!ok }) }).catch(() => {});
}

/* ---------- Déchiffrement (format de _ai-lib.js : v1:iv:tag:ct, clé = SHA-256(AI_KEY_ENC)) ---------- */
const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
async function decrypt(packed) {
  const secret = env('AI_KEY_ENC') || '';
  if (secret.length < 32) { const e = new Error('AI_KEY_ENC'); e.code = 'not_configured'; throw e; }
  const [v, iv, tag, ct] = String(packed || '').split(':');
  if (v !== 'v1' || !iv || !tag || !ct) { const e = new Error('format'); e.code = 'key_unreadable'; throw e; }
  const raw = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  const k = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['decrypt']);
  const c = b64(ct), t = b64(tag), buf = new Uint8Array(c.length + t.length);
  buf.set(c); buf.set(t, c.length);
  try {
    return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64(iv) }, k, buf));
  } catch (e) { const er = new Error('decrypt'); er.code = 'key_unreadable'; throw er; }
}

/* ---------- Consignes (identiques à moduleRules de _ai-lib.js) ---------- */
function moduleRules(module, web) {
  if (module !== 'meteo') return '';
  return `\n\n---\nRègles de réponse (prioritaires) :
- Réponds en français, en texte lisible : un titre court par partie (## Titre), puis des puces courtes. Pas de tableau, pas de HTML, pas de balise <br>.
- ${web ? 'Appuie-toi sur une recherche web récente pour le contexte du jour (calendrier économique, actualité, échéances).' : 'Tu n’as PAS accès à internet ni aux données de marché du jour : ne donne aucun niveau de prix, horaire, statistique ou volume précis ; décris seulement des points de vigilance généraux et indique clairement que les données du jour sont à vérifier.'}
- N’invente jamais un niveau de prix, un horaire d’annonce, un volume ou une statistique : si tu ne l’as pas trouvé dans une source, écris « à vérifier ».
- Tu ne vois pas le carnet d’ordres ni ATAS : ne décris jamais leur contenu, donne seulement à quoi être attentif.
- Ne donne pas de conseil d’investissement personnalisé ; formule des points d’attention.`;
}

/* ---------- Fournisseurs ---------- */
function aiError(code, msg) { const e = new Error(msg || code); e.code = code; return e; }
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
  const t = setTimeout(() => ctrl.abort(), Math.max(1000, deadline - Date.now()));
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    return { res, data: await res.json().catch(() => ({})) };
  } catch (e) {
    throw aiError(e && e.name === 'AbortError' ? 'timeout' : 'unreachable');
  } finally { clearTimeout(t); }
}
async function callProvider(provider, key, { prompt, model, search, maxTokens, deadline }) {
  const p = PROVIDERS[provider];
  if (!p) throw aiError('bad_provider');
  const mdl = model || env(`AI_MODEL_${provider.toUpperCase()}`) || p.model;
  const max = maxTokens || 2048;
  if (provider === 'gemini') {
    const body = { contents: [{ parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: max } };
    if (search) { body.tools = [{ google_search: {} }]; body.generationConfig.thinkingConfig = { thinkingLevel: 'low' }; }
    const send = () => fetchJson(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(mdl)}:generateContent`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify(body),
    }, deadline);
    let { res, data } = await send();
    if (!res.ok && res.status === 400 && body.generationConfig.thinkingConfig && /thinking/i.test((data.error && data.error.message) || '')) {
      delete body.generationConfig.thinkingConfig; ({ res, data } = await send());
    }
    if (!res.ok) throw aiError(classify(res.status, data.error && data.error.message));
    const cand = (data.candidates && data.candidates[0]) || {};
    const text = (cand.content && (cand.content.parts || []).map((x) => x.text || '').join('')) || '';
    const seen = new Set();
    const sources = ((cand.groundingMetadata && cand.groundingMetadata.groundingChunks) || []).map((c) => c && c.web)
      .filter((w) => w && /^https?:\/\//.test(w.uri || ''))
      .filter((w) => { const k = w.title || w.uri; if (seen.has(k)) return false; seen.add(k); return true; })
      .slice(0, 8).map((w) => ({ title: String(w.title || w.uri).slice(0, 120), url: w.uri }));
    return { text: text.trim(), model: mdl, web: !!search, sources };
  }
  if (provider === 'anthropic') {
    const { res, data } = await fetchJson('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: mdl, max_tokens: max, messages: [{ role: 'user', content: prompt }] }),
    }, deadline);
    if (!res.ok) throw aiError(classify(res.status, data.error && data.error.message));
    const text = (Array.isArray(data.content) ? data.content : []).filter((c) => c.type === 'text').map((c) => c.text).join('');
    return { text: text.trim(), model: mdl, web: false, sources: [] };
  }
  const url = { openai: 'https://api.openai.com/v1/chat/completions', openrouter: 'https://openrouter.ai/api/v1/chat/completions', groq: 'https://api.groq.com/openai/v1/chat/completions' }[provider];
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` };
  if (provider === 'openrouter') { headers['HTTP-Referer'] = 'https://contralytix.fr'; headers['X-Title'] = 'Contralytix'; }
  const { res, data } = await fetchJson(url, { method: 'POST', headers, body: JSON.stringify({ model: mdl, messages: [{ role: 'user', content: prompt }], max_tokens: max }) }, deadline);
  if (!res.ok) throw aiError(classify(res.status, data.error && (data.error.message || data.error)));
  const c = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  return { text: String(Array.isArray(c) ? c.map((x) => x.text || '').join('') : (c || '')).trim(), model: mdl, web: false, sources: [] };
}
async function callSite({ prompt, search, maxTokens, deadline }) {
  const key = env('GEMINI_API_KEY');
  if (!key) throw aiError('not_configured');
  let last = null;
  for (const model of SITE_MODELS) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (deadline - Date.now() < 3000) throw last || aiError('timeout');
      try {
        return await callProvider('gemini', key, { prompt, model, search, maxTokens, deadline });
      } catch (e) {
        last = e;
        if (e.code === 'overloaded' && attempt < 3) { await sleep(900 * attempt); continue; }
        if (e.code === 'overloaded' || e.code === 'bad_model') break;
        throw e;
      }
    }
  }
  throw last || aiError('overloaded');
}
function userMessage(code, n) {
  n = n || 'Le fournisseur';
  return {
    invalid_key: `${n} refuse cette clé : vérifie qu’elle est complète et toujours active.`,
    no_credit: `Ton compte ${n} n’a plus de crédit ou de moyen de paiement.`,
    rate_limited: `${n} limite le nombre de requêtes de ta clé : réessaie dans une minute.`,
    overloaded: 'Le service IA est surchargé, réessaie dans quelques minutes.',
    bad_model: `Le modèle demandé n’existe pas chez ${n}.`,
    timeout: 'L’IA met trop de temps à répondre. Réessaie.',
    unreachable: `${n} est injoignable pour le moment.`,
    not_configured: 'L’IA n’est pas encore configurée sur ce site.',
    migration_missing: 'La base n’est pas prête : exécute migration_ia_cle.sql sur Supabase.',
    key_unreadable: 'Ta clé enregistrée est illisible : enregistre-la à nouveau.',
    no_key: 'Aucune clé IA enregistrée : ajoute-la dans Profil → Connexions.',
    premium_only: 'L’IA Contralytix est incluse dans Premium pour ce module. Utilise ta propre clé, ou passe Premium.',
    quota: 'Limite d’utilisation de l’IA atteinte pour aujourd’hui.',
  }[code] || 'Erreur pendant l’échange avec l’IA. Réessaie plus tard.';
}

/* ---------- Traitement ---------- */
async function handle(request) {
  if (request.method !== 'POST') return out(405, { error: 'Méthode non autorisée' });
  const deadline = Date.now() + TIME_BUDGET_MS;
  const user = await getUser((request.headers.get('authorization') || '').replace('Bearer ', '').trim()).catch(() => null);
  if (!user) return out(401, { error: 'Session invalide, reconnecte-toi.', code: 'unauthorized' });

  let body = {};
  try { body = await request.json(); } catch (e) { return out(400, { error: 'Requête invalide' }); }
  const module = String(body.module || '');
  const prompt = typeof body.prompt === 'string' ? body.prompt : '';
  const engine = body.engine === 'mine' ? 'mine' : 'site';
  const M = MODULES[module];
  if (!M) return out(400, { error: 'Module inconnu', code: 'bad_module' });
  if (!prompt.trim()) return out(400, { error: 'Le texte de la demande est vide.', code: 'empty' });
  if (prompt.length > MAX_PROMPT) return out(413, { error: 'Demande trop longue.', code: 'too_long' });

  let row = null, key = null;
  try {
    row = await loadUserKey(user.id).catch((e) => { if (e.code === 'migration_missing' && engine === 'site') return null; throw e; });
    const hasKey = !!row;
    if (engine === 'site' && M.premium && !user.isPremium) return out(403, { error: userMessage('premium_only'), code: 'premium_only', hasKey });
    if (engine === 'mine' && !row) return out(409, { error: userMessage('no_key'), code: 'no_key', hasKey: false });
    if (!(await quotaOk(user, engine))) return out(429, { error: userMessage('quota'), code: 'quota', hasKey });

    const wantsWeb = module === 'meteo';
    let res;
    if (engine === 'mine') {
      key = await decrypt(row.key_enc);
      const web = wantsWeb && row.provider === 'gemini';
      res = await callProvider(row.provider, key, { prompt: prompt + moduleRules(module, web), model: row.model, search: web, maxTokens: wantsWeb ? 2500 : undefined, deadline });
      res.provider = row.provider;
    } else {
      res = await callSite({ prompt: prompt + moduleRules(module, wantsWeb), search: wantsWeb, maxTokens: wantsWeb ? 2500 : undefined, deadline });
      res.provider = 'contralytix';
    }
    if (!res.text) throw aiError('provider_error', 'réponse vide');
    await logUsage(user, module, engine, true);
    if (engine === 'mine' && row.last_error) await patchUserKey(user.id, { last_error: null });
    return out(200, { text: res.text, engine, provider: res.provider, model: res.model, web: !!res.web, sources: res.sources || [] });
  } catch (e) {
    safeLog(`ai-edge ${module}/${engine}:`, e, [key, env('GEMINI_API_KEY')]);
    const code = e.code || 'error';
    await logUsage(user, module, engine, false);
    if (engine === 'mine' && row && ['invalid_key', 'no_credit', 'bad_model'].includes(code)) await patchUserKey(user.id, { last_error: code });
    const name = engine === 'mine' && row ? (PROVIDERS[row.provider] || {}).name : null;
    const status = { invalid_key: 422, no_credit: 422, bad_model: 422, rate_limited: 429, overloaded: 503, timeout: 504, migration_missing: 503, not_configured: 503 }[code] || 502;
    return out(status, { error: userMessage(code, name), code, overloaded: code === 'overloaded', hasKey: !!row });
  }
}

// Réponse en flux : en-têtes envoyés tout de suite, un espace toutes les 5 s pour garder la connexion
// (ignoré par JSON.parse), puis le JSON final avec le vrai code dans `status`.
export default (request) => {
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      controller.enqueue(enc.encode(' '));
      const keepAlive = setInterval(() => { try { controller.enqueue(enc.encode(' ')); } catch (e) { /* fermé */ } }, 5000);
      let result;
      try { result = await handle(request); }
      catch (err) { safeLog('ai-edge fatal:', err); result = out(500, { error: 'Erreur serveur. Réessaie.' }); }
      clearInterval(keepAlive);
      controller.enqueue(enc.encode(JSON.stringify({ ...result.body, status: result.status })));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
};

export const config = { path: '/edge/ai' };
