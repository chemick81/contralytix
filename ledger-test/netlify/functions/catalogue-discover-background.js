// netlify/functions/catalogue-discover-background.js   (26/11/2026, fonction d'arrière-plan Netlify)
//
// Admin › Catalogue : « Chercher les formules » d'une prop firm à partir de son site officiel.
// Fonction d'ARRIÈRE-PLAN (suffixe -background) : Netlify répond 202 tout de suite et la laisse tourner
// jusqu'à 15 min. La 1re version (réponse en flux) était coupée par Netlify au bout de 30 s.
// Suivi : table catalogue_discoveries (créée par l'app avant l'appel) : step, puis status done/error et result.
//   1. lit la page d'accueil du site, repère les pages de règles (aide, FAQ, payout, tarifs…) et les lit ;
//   2. lit les deux comparateurs publics (PropFirm Factory, MaPropFirm) pour cette prop firm ;
//   3. demande à l'IA Contralytix (Gemini du site) d'en tirer les formules en compte financé (PA),
//      valeurs du site officiel uniquement, et de rattacher chaque formule aux comptes des comparateurs ;
//   4. compare, valeur par valeur, le site officiel et les comparateurs (fait ici, pas par l'IA).
// LECTURE SEULE pour le catalogue : rien n'est écrit dans propfirm_programs. L'admin coche ensuite dans l'app.
//
// POST /.netlify/functions/catalogue-discover-background { jobId, firm, website }
//   En-tête Authorization: Bearer <jeton Supabase> d'un ADMIN.
// Variables Netlify : SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GEMINI_API_KEY (déjà utilisées).

const https = require('node:https');
const tls = require('node:tls');
const crypto = require('node:crypto');

const TIME_BUDGET_MS = 300000;   // 5 min (Netlify laisse 15 min aux fonctions d'arrière-plan)
const AI_CALL_MS = 90000;         // un appel IA bloqué ne doit pas empêcher d'essayer le modèle suivant
const PAGE_TIMEOUT_MS = 9000;
const MAX_PAGES = 14;
const MAX_PAGE_CHARS = 22000;
const MAX_TOTAL_CHARS = 90000;
const MIN_TEXT_CHARS = 2500;     // en dessous : site chargé en JavaScript, l'IA lit les pages elle-même
const SITE_MODELS = ['gemini-3.6-flash', 'gemini-flash-latest', 'gemini-flash-lite-latest'];
const RETRY_WAITS_MS = [2000, 5000, 10000];
const FACTORY_URL = 'https://factory.trade-with-me.fr/api/account-types/?page_size=1000&page=1';
const MAPROPFIRM_URL = 'https://mapropfirm.fr/funded-data.csv';
const UA = 'Mozilla/5.0 (compatible; ContralytixCatalogueCheck/1.0; +https://contralytix.fr)';

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

/* ---------- Session admin ---------- */
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

/* ---------- Pages du site ---------- */
function htmlToText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ').replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<\/(p|div|li|tr|h[1-6]|br|section|article|td|th)>/gi, '\n').replace(/<br\s*\/?>/gi, '\n')
    .replace(/<td[^>]*>/gi, ' | ').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;|&rsquo;/g, '’').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
}
const safeHost = (h) => !/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.|\[)/i.test(h);
const baseDomain = (h) => String(h || '').toLowerCase().replace(/^www\./, '').split('.').slice(-2).join('.');
async function fetchHtml(url, deadline) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), Math.max(1500, Math.min(PAGE_TIMEOUT_MS, deadline - Date.now() - 60000)));
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow', headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5', 'Accept-Language': 'fr,en;q=0.8' } });
    if (!res.ok) return { url, html: '', why: 'HTTP ' + res.status };
    const type = res.headers.get('content-type') || '';
    if (type && !/html|text/i.test(type)) return { url, html: '', why: 'pas une page' };
    return { url: res.url || url, html: (await res.text()).slice(0, 900000), why: '' };
  } catch (e) {
    return { url, html: '', why: String((e && e.name === 'AbortError') ? 'délai dépassé' : (e && e.cause && e.cause.code) || (e && e.message) || e).slice(0, 80) };
  } finally { clearTimeout(t); }
}
// Liens de la page vers des pages de règles probables (même domaine ou sous-domaine : aide, support…).
const KW = [[/payout|withdraw|retrait|paiement/i, 6], [/rule|r[eè]gle|regla/i, 6], [/funded|financ|master|express|sim-?funded|pa\b|performance/i, 5],
  [/faq|help|aide|support|article|knowledge|docs?\b|guide/i, 4], [/consisten|drawdown|buffer|safety|scaling/i, 5], [/pricing|tarif|plans?|program|account|compte|evaluation|challenge/i, 3], [/terms|conditions|cgv/i, 1]];
const BAD = /login|signin|sign-in|register|signup|cart|checkout|affiliate|blog\/page|privacy|cookie|career|job|press|\.(png|jpe?g|gif|svg|webp|pdf|zip|css|js)(\?|$)|mailto:|tel:|javascript:/i;
function linksOf(html, pageUrl, domain) {
  const seen = new Map();
  const re = /<a\b[^>]*href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    let u; try { u = new URL(m[1], pageUrl); } catch (e) { continue; }
    if (!/^https?:$/.test(u.protocol) || baseDomain(u.hostname) !== domain || !safeHost(u.hostname)) continue;
    u.hash = '';
    const href = u.toString();
    if (BAD.test(href)) continue;
    const text = htmlToText(m[2]).slice(0, 80);
    let score = 0;
    KW.forEach(([r, w]) => { if (r.test(u.pathname) || r.test(u.hostname.split('.')[0])) score += w; if (r.test(text)) score += Math.ceil(w / 2); });
    if (!score) continue;
    seen.set(href, Math.max(seen.get(href) || 0, score));
  }
  return [...seen.entries()].sort((a, b) => b[1] - a[1]).map(([u, s]) => ({ url: u, score: s }));
}

/* ---------- Comparateurs (même lecture que catalogue-check.js) ---------- */
const CHAIN_ERR = /UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT_LOCALLY/;
const errCode = (e) => String((e && e.cause && e.cause.code) || (e && e.code) || (e && e.message) || e || '');
function issuerUrl(host, port, ms) {
  return new Promise((resolve, reject) => {
    const sock = tls.connect({ host, port, servername: host, rejectUnauthorized: false, timeout: ms }, () => {
      const c = sock.getPeerCertificate(); sock.end();
      const ia = c && c.infoAccess; const u = ia && ia['CA Issuers - URI'] && ia['CA Issuers - URI'][0];
      u ? resolve(u) : reject(new Error('pas d’adresse CA Issuers'));
    });
    sock.on('timeout', () => { sock.destroy(); reject(new Error('aborted')); });
    sock.on('error', reject);
  });
}
async function getWithIssuer(url, type, ms) {
  const u = new URL(url);
  const aia = await issuerUrl(u.hostname, Number(u.port) || 443, ms);
  const der = Buffer.from(await (await fetch(aia)).arrayBuffer());
  const pem = new crypto.X509Certificate(der).toString();
  return new Promise((resolve, reject) => {
    const req = https.get(url, { ca: [...tls.rootCertificates, pem], timeout: ms, headers: { 'User-Agent': UA } }, (res) => {
      let body = ''; res.setEncoding('utf8');
      res.on('data', (d) => { body += d; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error('HTTP ' + res.statusCode));
        try { resolve(type === 'json' ? JSON.parse(body) : body); } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('aborted')));
    req.on('error', reject);
  });
}
async function getData(url, type, ms) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': UA, Accept: type === 'json' ? 'application/json' : 'text/csv,text/plain' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return type === 'json' ? await res.json() : await res.text();
  } finally { clearTimeout(t); }
}
async function getRetry(url, type) {
  try { return await getData(url, type, 9000); } catch (e) {
    if (CHAIN_ERR.test(errCode(e))) return getWithIssuer(url, type, 9000);
    return getData(url, type, 7000);
  }
}
function parseCsv(text) {
  const rows = []; let row = []; let cur = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; }
    else cur += ch;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  const head = rows.shift() || [];
  return rows.filter((r) => r.length > 3).map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), r[i]])));
}
const num = (v) => { if (v === null || v === undefined || v === '') return null; const x = Number(String(v).replace(/[^0-9.\-]/g, '')); return Number.isFinite(x) ? x : null; };
const sizeOf = (v) => { const s = String(v || '').toLowerCase(); const x = num(s); if (x === null) return null; return /k/.test(s) && x < 1000 ? x * 1000 : x; };
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '');
function firmMatches(name, firm) {
  const a = norm(name), b = norm(firm);
  if (!a || !b) return false;
  const core = b.replace(/(tradingfunding|traderfunding|funding|trading|trader|futures|capital|prop|firm|llc|inc)$/g, '') || b;
  return a.includes(b) || b.includes(a) || (core.length >= 4 && a.includes(core));
}
function fromFactory(a) {
  const pe = (a.rules || {}).payout_eligibility || {};
  const size = num(a.account_size);
  const none = pe.day_mode === 'none';
  return { size, v: {
    minDays: none ? 0 : num(pe.min_days), dayMin: pe.day_mode === 'winning' ? num(pe.winning_day_min_pnl_usd) : null,
    consistency: pe.consistency_max_best_day_pct === undefined ? null : (num(pe.consistency_max_best_day_pct) || 0),
    minPayout: num(pe.min_withdrawal_usd),
    minRequestProfit: num(pe.min_balance_before_payout_usd) !== null && size ? num(pe.min_balance_before_payout_usd) - size : null } };
}
function fromMapropfirm(r) {
  const size = sizeOf(r.account_size); const bal = num(r.rule_balance_min); const buf = num(r.rule_buffer);
  return { size, v: {
    minDays: r.rule_qualifying_days_min === '' ? 0 : num(r.rule_qualifying_days_min), dayMin: num(r.rule_qualifying_day_min_profit),
    consistency: r.rule_consistency_pct === '' ? null : (num(r.rule_consistency_pct) || 0), minPayout: num(r.rule_payout_min) || null,
    buffer: buf ? buf : (bal && size ? bal - size : (buf === 0 ? 0 : null)), caps: num(r.rule_cap_first) || null, split: num(r.rule_split_pct) } };
}

/* ---------- IA ---------- */
function aiError(code, msg) { const e = new Error(msg || code); e.code = code; return e; }
async function gemini(model, body, deadline) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), Math.max(1000, Math.min(AI_CALL_MS, deadline - Date.now())));
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST', signal: ctrl.signal, headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env('GEMINI_API_KEY') || '' }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const m = String((data.error && data.error.message) || '');
      throw aiError(res.status === 404 ? 'bad_model' : (res.status === 429 || res.status === 503 || /overload|unavailable/i.test(m)) ? 'overloaded' : 'provider_error', m);
    }
    const cand = (data.candidates && data.candidates[0]) || {};
    if (cand.finishReason === 'MAX_TOKENS') throw aiError('truncated', 'réponse coupée');
    return (cand.content && (cand.content.parts || []).filter((x) => !x.thought).map((x) => x.text || '').join('')) || '';
  } catch (e) {
    // AbortError a lui aussi un e.code (20) : il faut le tester avant (bug du 26/11 : « code 20 »).
    if (e && e.name === 'AbortError') throw aiError('timeout');
    if (e && typeof e.code === 'string') throw e;
    throw aiError('unreachable', e && e.message);
  } finally { clearTimeout(t); }
}
async function callSite(prompt, { urlContext, deadline }) {
  if (!env('GEMINI_API_KEY')) throw aiError('not_configured', 'GEMINI_API_KEY absente');
  const body = { contents: [{ parts: [{ text: prompt }] }], generationConfig: { thinkingConfig: { thinkingLevel: 'low' }, maxOutputTokens: 16000 } };
  if (urlContext) body.tools = [{ url_context: {} }];
  else body.generationConfig.responseMimeType = 'application/json';
  let last = null;
  for (const model of SITE_MODELS) {
    for (let attempt = 1; attempt <= RETRY_WAITS_MS.length + 1; attempt++) {
      if (deadline - Date.now() < 15000) throw last || aiError('timeout');
      try { return { text: await gemini(model, body, deadline), model }; }
      catch (e) {
        last = e;
        if (e.code === 'provider_error' && /thinking/i.test(e.message) && body.generationConfig.thinkingConfig) { delete body.generationConfig.thinkingConfig; continue; }
        if (e.code === 'overloaded' && attempt <= RETRY_WAITS_MS.length && deadline - Date.now() > RETRY_WAITS_MS[attempt - 1] + 10000) {
          await new Promise((r) => setTimeout(r, RETRY_WAITS_MS[attempt - 1])); continue;
        }
        if (e.code === 'overloaded' || e.code === 'bad_model' || e.code === 'timeout' || e.code === 'truncated') break;
        throw e;
      }
    }
  }
  throw last || aiError('overloaded');
}
function parseJson(text) {
  const t = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const i = t.indexOf('{'), j = t.lastIndexOf('}');
  if (i < 0 || j < i) return null;
  try { return JSON.parse(t.slice(i, j + 1)); } catch (e) { return null; }
}
const SIZE_FIELDS = ['ddAmount', 'buffer', 'minRequestProfit', 'minPayout', 'minDays', 'dayMin', 'consistency', 'caps', 'activationFee', 'dllAmount'];
const COMMON_FIELDS = ['ddTypes', 'dayType', 'activation', 'payment', 'dll', 'split', 'maxPayouts', 'frequency'];
function buildPrompt({ firm, website, pages, comp, urlMode }) {
  const compTxt = ['factory', 'mapropfirm'].map((s) => {
    const names = comp[s];
    return `${s === 'factory' ? 'PropFirm Factory' : 'MaPropFirm'} (clé « ${s} ») : ${names.length ? names.map((n) => `« ${n.name} » (${n.sizes.map((z) => Math.round(z / 1000) + 'K').join(', ')})`).join(' ; ') : 'aucun compte trouvé'}`;
  }).join('\n');
  return `Tu prépares le catalogue des règles d'une prop firm de trading de futures, pour son COMPTE FINANCÉ (PA / funded / Master / Express funded), PAS l’évaluation ni le challenge.
Prop firm : ${firm}. Site officiel : ${website}

Comptes de cette prop firm chez deux comparateurs (pour le rattachement seulement, n’utilise pas leurs valeurs) :
${compTxt}

À faire :
- Liste chaque formule (programme) vendue aujourd’hui avec ses tailles de compte, d’après les pages officielles ci-dessous UNIQUEMENT. N’utilise pas tes connaissances générales ni d’autre site.
- Pour chaque formule, donne les règles du compte financé, au format ci-dessous. Valeur vide "" si les pages n’en parlent pas. Ne devine jamais.
- « comparateurs » : pour chaque clé (factory, mapropfirm), les noms EXACTS des comptes de la liste ci-dessus qui correspondent à cette formule (liste vide s’il n’y en a pas).
- « source » : l’adresse de la page officielle qui donne le plus de règles de cette formule. « note » : une phrase sur une condition importante qui ne rentre dans aucune case (vide sinon).
- Si une formule apparaît sans aucune règle de compte financé, mets-la quand même avec des valeurs vides et explique-le dans « note ».

Format des valeurs (texte) :
- Montants en dollars sans symbole ni espace (ex. 2600). ddAmount = drawdown maximal du compte financé. buffer = montant à garder au-dessus du solde de départ après un payout (réserve, safety net). minRequestProfit = profit au-dessus du départ requis pour demander un payout. minPayout = retrait minimum. activationFee = frais d’activation du compte financé. dllAmount = perte journalière maximale.
- minDays = nombre de jours requis entre deux payouts ; dayMin = profit minimum d’un jour pour qu’il compte (jours gagnants).
- consistency = % maximum du meilleur jour, une valeur par numéro de payout séparée par des virgules (ex. "40, 40, 45") ou une seule valeur ; "0" s’il n’y a pas de règle de cohérence.
- caps = plafond par payout, par numéro de payout séparé par des virgules ; "—" = sans plafond.
- ddTypes : "EOD", "INTRADAY" ou "EOD,INTRADAY". dayType : "winning" (jours gagnants), "trading" (jours de trading) ou "" (aucun). activation : "free", "paid" ou "choice". payment : "one_time" ou "monthly". dll : "yes", "no" ou "optional". split = part du trader en % (ex. "90"). maxPayouts = nombre maximal de payouts ("" si illimité). frequency = rythme ou jour de traitement des payouts (court texte).

Réponds uniquement par ce JSON :
{"pagesRegles":["https://…"],"formules":[{"nom":"Flex","tailles":[25000,50000],"source":"https://…","note":"","comparateurs":{"factory":["…"],"mapropfirm":["…"]},"commun":{${COMMON_FIELDS.map((f) => `"${f}":""`).join(',')}},"parTaille":{"25000":{${SIZE_FIELDS.map((f) => `"${f}":""`).join(',')}}}}],"remarque":""}
${urlMode ? `\nLis toi-même ces pages officielles (et les pages d’aide qu’elles citent sur le même site) : ${pages.map((p) => p.url).join(' ')}` : `\n--- PAGES OFFICIELLES (texte extrait) ---\n${pages.map((p) => `### ${p.url}\n${p.text}`).join('\n\n')}\n--- FIN DES PAGES ---`}`;
}

/* ---------- Comparaison officiel / comparateurs (ici, pas par l'IA) ---------- */
const COMPARABLE = { minDays: 'minDays', dayMin: 'dayMin', consistency: 'consistency', minPayout: 'minPayout', minRequestProfit: 'minRequestProfit', buffer: 'buffer', caps: 'caps' };
const firstNum = (txt) => { const p = String(txt || '').split(/[,;]/)[0]; return /^\s*[—–-]\s*$/.test(p) ? null : num(p); };
function statusOf(field, offTxt, size, rows) {
  const off = String(offTxt == null ? '' : offTxt).trim();
  const key = COMPARABLE[field];
  const theirs = key ? rows.filter((r) => r.size === size && r.v[key] !== null && r.v[key] !== undefined).map((r) => ({ src: r.src, v: r.v[key] })) : [];
  const altTxt = theirs.length ? [...new Set(theirs.map((t) => `${Math.round(t.v * 100) / 100} (${t.src})`))].join(', ') : '';
  if (!off) return { v: '', st: 'no', alt: altTxt };
  if (!key || !theirs.length) return { v: off, st: 'one', alt: '' };
  const mine = firstNum(off);
  if (mine === null) return { v: off, st: 'one', alt: '' };
  const same = theirs.filter((t) => Math.abs(t.v - mine) < 0.5);
  if (same.length) return { v: off, st: 'ok', alt: '', srcs: [...new Set(same.map((t) => t.src))] };
  return { v: off, st: 'ecart', alt: altTxt };
}

async function handle(body, step) {
  const deadline = Date.now() + TIME_BUDGET_MS;
  const firm = String(body.firm || '').trim().slice(0, 80);
  let website = String(body.website || '').trim();
  if (website && !/^https?:\/\//i.test(website)) website = 'https://' + website;
  let site;
  try { site = new URL(website); } catch (e) { return out(400, { error: 'Indique le site web officiel de la prop firm (adresse complète).', code: 'bad_url' }); }
  if (!firm || !/^https?:$/.test(site.protocol) || !safeHost(site.hostname)) return out(400, { error: 'Nom ou site web invalide.', code: 'bad_url' });
  const domain = baseDomain(site.hostname);

  // Comparateurs en parallèle de la lecture du site.
  const compP = Promise.allSettled([getRetry(FACTORY_URL, 'json'), getRetry(MAPROPFIRM_URL, 'csv')]);

  await step('site');
  const home = await fetchHtml(site.toString(), deadline);
  const pages = [];
  const addPage = (p) => { if (!p.html) return; const text = htmlToText(p.html).slice(0, MAX_PAGE_CHARS); if (text.length > 300 && !pages.some((x) => x.url === p.url)) pages.push({ url: p.url, text }); };
  addPage(home);
  let cands = home.html ? linksOf(home.html, home.url, domain) : [];
  await step('pages');
  const first = cands.slice(0, 7);
  (await Promise.all(first.map((c) => fetchHtml(c.url, deadline)))).forEach((p) => {
    addPage(p);
    if (p.html) linksOf(p.html, p.url, domain).forEach((l) => { if (!cands.some((c) => c.url === l.url)) cands.push({ url: l.url, score: l.score - 1 }); });
  });
  // Deuxième niveau (articles du centre d'aide…) si le temps le permet.
  if (deadline - Date.now() > 120000) {
    const done = new Set([home.url, ...first.map((c) => c.url)]);
    const more = cands.filter((c) => !done.has(c.url)).sort((a, b) => b.score - a.score).slice(0, Math.max(0, MAX_PAGES - first.length));
    (await Promise.all(more.map((c) => fetchHtml(c.url, deadline)))).forEach(addPage);
  }
  // Pages les plus riches en règles d'abord, dans la limite de taille.
  const ruleScore = (t) => (t.match(/payout|withdraw|drawdown|consisten|buffer|funded|retrait|cohérence|minimum/gi) || []).length;
  pages.sort((a, b) => ruleScore(b.text) - ruleScore(a.text));
  let total = 0; const kept = [];
  for (const p of pages) { if (total + p.text.length > MAX_TOTAL_CHARS) continue; kept.push(p); total += p.text.length; }
  const urlMode = total < MIN_TEXT_CHARS;
  const urlList = urlMode ? [{ url: site.toString() }, ...cands.slice(0, 9).map((c) => ({ url: c.url }))] : kept;

  await step('comparators');
  const [fac, mp] = await compP;
  const rows = []; const comp = { factory: new Map(), mapropfirm: new Map() };
  const sources = [];
  if (fac.status === 'fulfilled') {
    const list = Array.isArray(fac.value) ? fac.value : (fac.value && fac.value.results) || [];
    list.filter((a) => firmMatches(a.prop_firm_name, firm)).forEach((a) => {
      const x = fromFactory(a); const name = String(a.name || '').trim(); if (!name) return;
      rows.push({ src: 'PropFirm Factory', key: 'factory', name, size: x.size, v: x.v });
      const e = comp.factory.get(name) || []; if (x.size && !e.includes(x.size)) e.push(x.size); comp.factory.set(name, e);
    });
    sources.push(comp.factory.size ? `PropFirm Factory : ${comp.factory.size} comptes` : 'PropFirm Factory : prop firm absente');
  } else sources.push('PropFirm Factory injoignable');
  if (mp.status === 'fulfilled') {
    parseCsv(mp.value).filter((r) => firmMatches(r.propfirm, firm)).forEach((r) => {
      const x = fromMapropfirm(r); const name = String(r.account_type || '').trim(); if (!name) return;
      rows.push({ src: 'MaPropFirm', key: 'mapropfirm', name, size: x.size, v: x.v });
      const e = comp.mapropfirm.get(name) || []; if (x.size && !e.includes(x.size)) e.push(x.size); comp.mapropfirm.set(name, e);
    });
    sources.push(comp.mapropfirm.size ? `MaPropFirm : ${comp.mapropfirm.size} comptes` : 'MaPropFirm : prop firm absente');
  } else sources.push('MaPropFirm injoignable');
  const compList = { factory: [...comp.factory].map(([name, sizes]) => ({ name, sizes: sizes.sort((a, b) => a - b) })).slice(0, 60),
    mapropfirm: [...comp.mapropfirm].map(([name, sizes]) => ({ name, sizes: sizes.sort((a, b) => a - b) })).slice(0, 60) };

  if (!kept.length && !urlMode) return out(422, { error: `Le site ${site.hostname} n’a pas pu être lu (${home.why || 'aucune page de règles'}). Colle le lien de la page des règles dans le champ Site web et relance.`, code: 'unreadable' });

  await step('ai');
  let data, model;
  try {
    const res = await callSite(buildPrompt({ firm, website: site.toString(), pages: urlList, comp: compList, urlMode }), { urlContext: urlMode, deadline });
    data = parseJson(res.text); model = res.model;
  } catch (e) {
    safeLog('catalogue-discover IA :', e);
    const msg = { timeout: 'L’IA n’a pas répondu à temps (site trop long à analyser). Relance, ou colle le lien de la page des règles pour cibler la recherche.', unreachable: 'L’IA (Google Gemini) est injoignable pour le moment. Réessaie dans quelques minutes.', provider_error: 'L’IA a refusé la demande (' + String(e.message || '').slice(0, 120) + ').', overloaded: 'Les serveurs de l’IA (Google Gemini) sont saturés en ce moment. Réessaie dans quelques minutes.',
      not_configured: 'IA non configurée sur le serveur (GEMINI_API_KEY).', truncated: 'La réponse de l’IA était trop longue. Relance la recherche.' }[e.code];
    return out(e.code === 'timeout' ? 504 : e.code === 'overloaded' ? 503 : 502, { error: msg || 'Analyse impossible pour le moment. Réessaie.', code: e.code || 'error' });
  }
  if (!data || !Array.isArray(data.formules)) return out(502, { error: 'L’IA a renvoyé une réponse illisible. Relance la recherche.', code: 'bad_answer' });

  await step('check');
  const programs = data.formules.slice(0, 20).map((f) => {
    const name = String(f.nom || '').trim().slice(0, 60);
    const sizes = [...new Set((Array.isArray(f.tailles) ? f.tailles : []).map(Number).filter((n) => n >= 1000 && n <= 2000000))].sort((a, b) => a - b).slice(0, 12);
    const want = { factory: new Set((f.comparateurs && f.comparateurs.factory) || []), mapropfirm: new Set((f.comparateurs && f.comparateurs.mapropfirm) || []) };
    const mine = rows.filter((r) => want[r.key].has(r.name));   // seulement les comptes que l'IA a rattachés ET qui existent
    const common = {};
    COMMON_FIELDS.forEach((k) => { const v = String(((f.commun || {})[k]) == null ? '' : f.commun[k]).trim().slice(0, 120); common[k] = { v, st: v ? 'one' : 'no', alt: '' }; });
    if (common.split.v) {
      const sp = num(common.split.v); const th = mine.filter((r) => r.v.split != null).map((r) => r.v.split);
      if (sp !== null && th.length) common.split = th.some((t) => Math.abs(t - sp) < 0.5) ? { v: common.split.v, st: 'ok', alt: '' } : { v: common.split.v, st: 'ecart', alt: [...new Set(th)].join(', ') + ' (MaPropFirm)' };
    }
    const bySize = {};
    sizes.forEach((z) => {
      const src = ((f.parTaille || {})[String(z)]) || {};
      bySize[z] = {};
      SIZE_FIELDS.forEach((k) => { bySize[z][k] = statusOf(k, String(src[k] == null ? '' : src[k]).slice(0, 120), z, mine); });
    });
    const cells = [...Object.values(common), ...Object.values(bySize).flatMap((o) => Object.values(o))];
    return {
      name, sizes, common, bySize,
      source: /^https?:\/\//i.test(String(f.source || '')) ? String(f.source).slice(0, 400) : '',
      note: String(f.note || '').slice(0, 300),
      comparators: { factory: [...want.factory].filter((n) => comp.factory.has(n)), mapropfirm: [...want.mapropfirm].filter((n) => comp.mapropfirm.has(n)) },
      ecarts: cells.filter((c) => c.st === 'ecart').length, missing: cells.filter((c) => c.st === 'no').length, confirmed: cells.filter((c) => c.st === 'ok').length,
    };
  }).filter((p) => p.name);

  return out(200, {
    firm, website: site.toString(), programs,
    pages: (Array.isArray(data.pagesRegles) && data.pagesRegles.length ? data.pagesRegles : kept.map((p) => p.url)).filter((u) => /^https?:\/\//i.test(String(u))).slice(0, 8),
    read: urlMode ? 'ia' : 'serveur', pagesRead: kept.length, sources: sources.join(' · '), remark: String(data.remarque || '').slice(0, 400), model,
  });
}

/* ---------- Suivi dans catalogue_discoveries ---------- */
async function setJob(jobId, patch) {
  const url = (env('SUPABASE_URL') || '').replace(/\/$/, '');
  const key = env('SUPABASE_SERVICE_ROLE_KEY') || '';
  try {
    await fetch(`${url}/rest/v1/catalogue_discoveries?id=eq.${encodeURIComponent(jobId)}`, {
      method: 'PATCH', headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }) });
  } catch (e) { safeLog('catalogue-discover suivi :', e); }
}

exports.handler = async (event) => {
  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch (e) { return { statusCode: 400 }; }
  const jobId = String(body.jobId || '');
  if (!/^[0-9a-f-]{36}$/i.test(jobId)) return { statusCode: 400 };
  const token = String((event.headers && (event.headers.authorization || event.headers.Authorization)) || '').replace(/^Bearer\s+/i, '').trim();
  const admin = await getAdmin(token).catch(() => null);
  if (!admin) { await setJob(jobId, { status: 'error', error: admin === false ? 'Réservé aux administrateurs.' : 'Session invalide, reconnecte-toi.' }); return { statusCode: 403 }; }
  let result;
  try { result = await handle(body, (name) => setJob(jobId, { step: name })); }
  catch (err) { safeLog('catalogue-discover fatal:', err); result = out(500, { error: 'Erreur serveur. Réessaie.' }); }
  if (result.status === 200) await setJob(jobId, { status: 'done', step: 'check', result: result.body, error: null });
  else await setJob(jobId, { status: 'error', error: result.body.error || 'Recherche impossible.', result: { code: result.body.code || 'error' } });
  return { statusCode: 200 };
};
