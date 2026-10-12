// netlify/functions/deltalytix.js
//
// Connexion à l'API Deltalytix (beta, https://beta.deltalytix.app/fr/docs) pour :
//   - importer les comptes (numéro, taille, libellé de prop firm) et leurs payouts,
//   - pointer automatiquement le Radar inactivité à partir du P&L journalier (net des commissions).
//
// Le jeton personnel Deltalytix (dltx_pat_…) de l'utilisateur est vérifié (GET /me) puis conservé
// CHIFFRÉ (AES-256-GCM) dans broker_connections.token_enc ; il n'est jamais renvoyé au navigateur
// (la colonne n'est pas lisible par les utilisateurs, voir migration_deltalytix.sql).
// L'API Deltalytix n'envoie pas d'en-têtes CORS : tous les appels passent par cette fonction.
//
// POST /api/deltalytix  { action: 'connect', token } | { action: 'disconnect' } | { action: 'accounts' } | { action: 'sync' }
// En-tête Authorization: Bearer <jeton Supabase> obligatoire.
//
// Variables d'environnement Netlify :
//   DELTALYTIX_TOKEN_KEY   secret servant à chiffrer les jetons (au moins 32 caractères aléatoires)
//   DELTALYTIX_API_BASE    optionnel, défaut https://beta.deltalytix.app/api/v1
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  (déjà utilisées par les autres fonctions)

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const API_BASE = (process.env.DELTALYTIX_API_BASE || 'https://beta.deltalytix.app/api/v1').replace(/\/+$/, '');
const KEY_SECRET = process.env.DELTALYTIX_TOKEN_KEY || '';
const PROVIDER = 'deltalytix';
const SYNC_DAYS = 70;              // pointages écrits sur les ~2 derniers mois
const TIME_BUDGET_MS = 8500;       // Netlify coupe une fonction synchrone vers 10 s

function json(status, body) {
  return { statusCode: status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(body) };
}
const normAccNum = (s) => String(s || '').trim().toLowerCase().replace(/[\s._-]+/g, '');

// ---------- chiffrement du jeton ----------
function key() { return crypto.createHash('sha256').update(KEY_SECRET).digest(); }
function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return 'v1:' + Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
}
function decrypt(blob) {
  const raw = Buffer.from(String(blob).replace(/^v1:/, ''), 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', key(), raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
}

// ---------- appels Deltalytix ----------
class DltxError extends Error { constructor(code, msg) { super(msg || code); this.code = code; } }
async function dltx(token, path, deadline) {
  const remaining = deadline - Date.now();
  if (remaining < 500) throw new DltxError('timeout');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.min(remaining, 7000));
  let res;
  try {
    res = await fetch(`${API_BASE}${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal: ctrl.signal });
  } catch (e) {
    throw new DltxError(e.name === 'AbortError' ? 'timeout' : 'unreachable');
  } finally { clearTimeout(timer); }
  if (res.status === 401 || res.status === 403) throw new DltxError('token_invalid');
  if (!res.ok) throw new DltxError('api_error', `HTTP ${res.status}`);
  return res.json();
}
async function allAccounts(token, deadline) {
  const out = [];
  let cursor = null;
  for (let page = 0; page < 10; page++) {
    const q = `/accounts?includeMetrics=true&limit=500${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const body = await dltx(token, q, deadline);
    (Array.isArray(body && body.data) ? body.data : []).forEach((a) => out.push(a));
    cursor = body && body.nextCursor;
    if (!cursor) break;
  }
  return out;
}
const isoDay = (v) => { const s = String(v || ''); return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null; };

// Comptes renvoyés au navigateur pour l'import (pas de P&L détaillé ici).
function slimAccount(a) {
  const number = String(a.number || a.accountNumber || '').trim();
  const label = String(a.propfirm || '').trim();
  return {
    number,
    // Le libellé « propfirm » est saisi dans Deltalytix : parfois vide ou égal au numéro.
    propfirm: label && normAccNum(label) !== normAccNum(number) ? label : null,
    size: Number(a.startingBalance) > 0 ? Math.round(Number(a.startingBalance)) : null,
    balance: Number.isFinite(Number(a.balance)) ? Number(a.balance) : null,
    payouts: (Array.isArray(a.payouts) ? a.payouts : []).map((p) => ({
      id: String(p.id || ''), amount: Number(p.amount) || 0, date: isoDay(p.date), status: String(p.status || '').toUpperCase(),
    })).filter((p) => p.amount > 0 && p.date),
  };
}

// Comptes Contralytix de l'utilisateur (même règle que l'application : créés par lui, ou rattachés
// à un de ses traders, créé par lui ou dont l'e-mail est celui de son compte).
async function userAccounts(db, userId, email) {
  // E-mail comparé sans tenir compte des majuscules (ilike), caractères spéciaux neutralisés.
  const em = String(email || '').trim().replace(/["\\,()]/g, '').replace(/([%_])/g, '\\$1');
  const orTraders = [`created_by.eq.${userId}`, ...(em ? [`email.ilike."${em}"`] : [])].join(',');
  const { data: traders, error: tErr } = await db.from('traders').select('id').or(orTraders);
  if (tErr) throw new Error(tErr.message);
  const ids = (traders || []).map((t) => `"${String(t.id).replace(/"/g, '')}"`);
  const orAccounts = [`created_by.eq.${userId}`, ...(ids.length ? [`trader_id.in.(${ids.join(',')})`] : [])].join(',');
  const { data: accounts, error } = await db.from('accounts').select('id, account_number, type, status').or(orAccounts);
  if (error) throw new Error(error.message);
  return accounts || [];
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Méthode non autorisée' });
  if (!KEY_SECRET || KEY_SECRET.length < 16) return json(501, { error: 'not_configured' });
  const deadline = Date.now() + TIME_BUDGET_MS;

  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const authHeader = event.headers.authorization || event.headers.Authorization;
  if (!authHeader) return json(401, { error: 'Non authentifié' });
  let user;
  try {
    const { data, error } = await db.auth.getUser(authHeader.replace('Bearer ', ''));
    if (error || !data?.user) return json(401, { error: 'Session invalide, reconnecte-toi.' });
    user = data.user;
  } catch (e) { return json(401, { error: 'Session invalide, reconnecte-toi.' }); }

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { error: 'Requête invalide' }); }
  const action = body.action;

  const saveState = (patch) => db.from('broker_connections').update({ ...patch, updated_at: new Date().toISOString() })
    .eq('user_id', user.id).eq('provider', PROVIDER);

  try {
    // ---- Connexion : vérifier puis enregistrer le jeton chiffré ----
    if (action === 'connect') {
      const token = String(body.token || '').trim();
      if (!/^dltx_[a-z]+_[A-Za-z0-9]{16,200}$/.test(token)) return json(400, { error: 'Ce jeton ne ressemble pas à un jeton Deltalytix (il commence par « dltx_pat_ »).' });
      let me;
      try { me = await dltx(token, '/me', deadline); }
      catch (e) {
        if (e.code === 'token_invalid') return json(400, { error: 'Deltalytix refuse ce jeton : vérifie-le ou crée-en un nouveau.' });
        throw e;
      }
      const row = {
        user_id: user.id, provider: PROVIDER, token_enc: encrypt(token), token_hint: token.slice(-4),
        account_email: me && me.email ? String(me.email) : null, last_error: null,
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      };
      const { error } = await db.from('broker_connections').upsert(row, { onConflict: 'user_id,provider' });
      if (error) return json(500, { error: /relation|does not exist/i.test(error.message) ? 'migration_missing' : 'Connexion non enregistrée. Réessaie.' });
      return json(200, { connected: true, hint: row.token_hint, email: row.account_email });
    }

    if (action === 'disconnect') {
      await db.from('broker_connections').delete().eq('user_id', user.id).eq('provider', PROVIDER);
      return json(200, { connected: false });
    }

    // ---- Les autres actions utilisent le jeton enregistré ----
    const { data: conn, error: connErr } = await db.from('broker_connections').select('token_enc')
      .eq('user_id', user.id).eq('provider', PROVIDER).maybeSingle();
    if (connErr) return json(500, { error: /relation|does not exist/i.test(connErr.message) ? 'migration_missing' : connErr.message });
    if (!conn) return json(409, { error: 'not_connected' });
    let token;
    try { token = decrypt(conn.token_enc); } catch (e) { return json(409, { error: 'token_invalid' }); }

    if (action === 'accounts') {
      const accounts = (await allAccounts(token, deadline)).map(slimAccount).filter((a) => a.number);
      await saveState({ last_error: null });
      return json(200, { accounts });
    }

    if (action === 'sync') {
      const remote = await allAccounts(token, deadline);
      const byNum = new Map();
      remote.forEach((a) => {
        const n = normAccNum(a.number || a.accountNumber);
        if (n) byNum.set(n, (a.metrics && a.metrics.dailyPnL && typeof a.metrics.dailyPnL === 'object') ? a.metrics.dailyPnL : {});
      });
      const mine = (await userAccounts(db, user.id, user.email))
        .filter((a) => (a.type === 'PA' || a.type === 'LIVE') && a.status === 'ACTIF');
      const since = new Date(Date.now() - SYNC_DAYS * 86400000).toISOString().slice(0, 10);
      const now = new Date().toISOString();
      const rows = [];
      let matched = 0;
      mine.forEach((a) => {
        const daily = byNum.get(normAccNum(a.account_number));
        if (!daily) return;
        matched++;
        Object.entries(daily).forEach(([day, pnl]) => {
          const d = isoDay(day);
          if (!d || d < since || !Number.isFinite(Number(pnl))) return;
          rows.push({ user_id: user.id, account_id: a.id, day: d, traded: true, pnl: Math.round(Number(pnl) * 100) / 100, source: 'deltalytix', updated_at: now });
        });
      });
      for (let i = 0; i < rows.length; i += 500) {
        const { error } = await db.from('dormancy_logs').upsert(rows.slice(i, i + 500), { onConflict: 'account_id,day' });
        if (error) throw new Error(`dormancy_logs : ${error.message}`);
      }
      await saveState({ last_sync_at: now, last_error: null });
      return json(200, { matched, funded: mine.length, days: rows.length, syncedAt: now });
    }

    return json(400, { error: 'Action inconnue' });
  } catch (e) {
    const code = e.code || 'error';
    console.error('Deltalytix :', code, e.message);
    try { await saveState({ last_error: code }); } catch (_) { /* */ }
    const msg = {
      token_invalid: 'Deltalytix refuse le jeton enregistré (révoqué ?). Reconnecte Deltalytix avec un nouveau jeton.',
      timeout: 'Deltalytix met trop de temps à répondre. Réessaie dans un instant.',
      unreachable: 'Deltalytix est injoignable pour le moment. Réessaie plus tard.',
      api_error: 'Deltalytix a renvoyé une erreur. Réessaie plus tard.',
    }[code] || 'Erreur pendant l’échange avec Deltalytix. Réessaie plus tard.';
    return json(code === 'token_invalid' ? 409 : 502, { error: msg, code });
  }
};

exports._test = { encrypt, decrypt, slimAccount, normAccNum };
