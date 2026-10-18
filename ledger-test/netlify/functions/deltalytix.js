// netlify/functions/deltalytix.js
//
// Connexion Deltalytix (OAuth, voir deltalytix-oauth.js) : une fois connecté, cette fonction
//   - renvoie les comptes (numéro, taille, libellé de prop firm, dates, breached) pour l'import ;
//   - pointe automatiquement le Radar inactivité à partir du P&L journalier (net des commissions).
// Les jetons OAuth sont conservés CHIFFRÉS dans broker_connections.token_enc (illisible par les
// utilisateurs) et renouvelés ici quand ils expirent. L'API Deltalytix n'envoie pas d'en-têtes CORS :
// tous les appels passent par le serveur.
//
// POST /api/deltalytix  { action: 'accounts' | 'sync' | 'disconnect', radar?: boolean }
// sync renvoie aussi la santé des comptes actifs (breached, marge avant drawdown) et les connexions
// broker en retard de synchro ; disconnect révoque l'accès chez Deltalytix.
// En-tête Authorization: Bearer <jeton Supabase> obligatoire. Configuration : voir _deltalytix-lib.js.

const { createClient } = require('@supabase/supabase-js');
const L = require('./_deltalytix-lib');

const SYNC_DAYS = 70;              // pointages écrits sur les ~2 derniers mois
const STALE_DAYS = 3;              // connexion broker sans synchro depuis plus longtemps : alerte
const TIME_BUDGET_MS = 8500;       // Netlify coupe une fonction synchrone vers 10 s

function json(status, body) {
  return { statusCode: status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(body) };
}
const normAccNum = (s) => String(s || '').trim().toLowerCase().replace(/[\s._-]+/g, '');
const isoDay = (v) => { const s = String(v || ''); return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null; };

async function allAccounts(token, deadline) {
  const out = [];
  let cursor = null;
  for (let page = 0; page < 10; page++) {
    const q = `/accounts?includeMetrics=true&limit=500${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const body = await L.dltx(token, q, deadline);
    (Array.isArray(body && body.data) ? body.data : []).forEach((a) => out.push(a));
    cursor = body && body.nextCursor;
    if (!cursor) break;
  }
  return out;
}

// Journées tradées d'après les trades bruts (GET /trades, portée trades:read), par compte.
// Pourquoi pas seulement metrics.dailyPnL : Deltalytix y écarte les trades « sous le buffer » d'un
// compte qui a eu un payout (lib/account-metrics.ts, considerBuffer) — un compte réellement tradé
// pouvait donc paraître inactif dans le Radar (constaté le 14/10/2026 sur un PA Bulenox).
// Même découpage des journées que Deltalytix : date UTC de l'heure d'entrée, P&L net des commissions.
// Renvoie { map: Map(numéro normalisé → { 'AAAA-MM-JJ': pnl }), complete } ; incomplet si le temps manque
// ou si la portée manque (on complète alors avec dailyPnL).
async function recentTradesDaily(token, since, deadline) {
  const map = new Map();
  let cursor = null;
  let complete = false;
  try {
    for (let page = 0; page < 40; page++) {
      if (deadline - Date.now() < 2500) break;   // garder du temps pour écrire les pointages
      const q = `/trades?from=${encodeURIComponent(since)}&limit=500${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const body = await L.dltx(token, q, deadline);
      (Array.isArray(body && body.data) ? body.data : []).forEach((t) => {
        const n = normAccNum(t.accountNumber);
        const d = new Date(t.entryDate);
        if (!n || Number.isNaN(d.getTime())) return;
        const day = d.toISOString().slice(0, 10);
        const pnl = (Number(t.pnl) || 0) - (Number(t.commission) || 0);
        if (!map.has(n)) map.set(n, {});
        const m = map.get(n);
        m[day] = (m[day] || 0) + pnl;
      });
      cursor = body && body.nextCursor;
      if (!cursor) { complete = true; break; }
    }
  } catch (e) {
    if (e.code === 'token_invalid') throw e;
    // insufficient_scope, timeout, erreur ponctuelle : on garde ce qui a été lu, dailyPnL complète.
  }
  return { map, complete };
}

// Plateforme de chaque compte, d'après les connexions broker Deltalytix (portée connections:read).
const SERVICE_PLATFORM = { tradovate: 'TRADOVATE', rithmic: 'RITHMIC', 'rithmic-protocol': 'RITHMIC', dxfeed: 'DXFEED', projectx: 'PROJECTX', topstepx: 'PROJECTX' };
async function connectionsOf(token, deadline) {
  try {
    const body = await L.dltx(token, '/connections?limit=100', deadline);
    return { list: Array.isArray(body && body.data) ? body.data : [], scope: true };
  } catch (e) {
    if (e.code === 'insufficient_scope') return { list: [], scope: false };
    if (e.code === 'token_invalid') throw e;
    return { list: [], scope: true };   // information facultative
  }
}
// Abonnement Deltalytix de l'utilisateur (18/10/2026). Sert à débloquer solde / drawdown / objectif
// sur les cartes pour un compte Contralytix Free abonné chez Deltalytix (partenariat).
// À ce jour GET /me ne renvoie que { id, email, language } : le statut est lu de façon tolérante
// (subscription.plan / status / endDate / trialEndsAt, ou plan / isPaid / isPro) pour fonctionner dès
// que Deltalytix l'ajoutera. Inconnu → known:false (jamais considéré comme payant par défaut).
async function deltalytixPlanOf(token, deadline) {
  try {
    const me = await L.dltx(token, '/me', deadline);
    const sub = (me && (me.subscription || me.subscriptions)) || null;
    const plan = String((sub && sub.plan) || (me && me.plan) || '').trim();
    const status = String((sub && sub.status) || (me && me.subscriptionStatus) || '').toUpperCase();
    const ends = (sub && (sub.endDate || sub.trialEndsAt)) || null;
    const flag = me && (me.isPaid ?? me.isPro ?? me.paid);
    if (typeof flag === 'boolean') return { known: true, paid: flag, plan: plan || null };
    if (!plan && !status) return { known: false, paid: false, plan: null };
    const notExpired = !ends || new Date(ends).getTime() > Date.now();
    const paid = !/^(FREE|BASIC_FREE|NONE)$/i.test(plan || 'FREE') && /^(ACTIVE|TRIAL|TRIALING|PAST_DUE)?$/.test(status) && notExpired;
    return { known: true, paid, plan: plan || null };
  } catch (e) {
    if (e.code === 'token_invalid') throw e;
    return { known: false, paid: false, plan: null };
  }
}
function platformMap(conns) {
  const map = new Map();
  conns.forEach((c) => {
    const p = SERVICE_PLATFORM[String(c.service || '').toLowerCase()] || null;
    if (!p) return;
    (Array.isArray(c.accountNumbers) ? c.accountNumbers : []).forEach((n) => { const k = normAccNum(n); if (k && !map.has(k)) map.set(k, p); });
  });
  return map;
}

// Drawdown réellement configuré dans Deltalytix (18/10/2026). `isConfigured` est vrai dès qu'un objectif
// OU un drawdown est saisi : avec un objectif seul, Deltalytix calcule un « niveau de drawdown » égal au
// solde de départ (ou au plus haut en trailing) et un remainingLoss sans signification. On ne retient
// donc le drawdown que si son niveau diffère de ces deux valeurs (cf. lib/account-metrics.ts).
const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v))) ? null : Number(v);
const round2 = (v) => v == null ? null : Math.round(v * 100) / 100;
function hasDrawdown(a, m) {
  if (!m || !m.isConfigured || num(m.remainingLoss) == null) return false;
  const level = num(m.drawdownLevel), start = num(a && a.startingBalance), high = num(m.highestBalance);
  if (level == null) return true; // ancien format sans niveau : on fait confiance à isConfigured
  const near = (x) => x != null && Math.abs(level - x) < 0.01;
  return !(near(start) || near(high));
}
// Compte breached d'après Deltalytix : drawdown configuré, au moins un jour tradé, plus aucune marge.
const isBreached = (m, a) => !!(m && hasDrawdown(a, m) && Number(m.totalTradingDays) > 0 && Number(m.remainingLoss) <= 0);
const lastDayOf = (m) => {
  const days = m && m.dailyPnL && typeof m.dailyPnL === 'object' ? Object.keys(m.dailyPnL).map(isoDay).filter(Boolean).sort() : [];
  return days.length ? days[days.length - 1] : null;
};
// Santé d'un compte Contralytix actif (cartes de compte, proposition « passer en Breached »).
function healthOf(a, tradeDays) {
  const m = a.metrics || null;
  const rl = m && m.isConfigured && Number.isFinite(Number(m.remainingLoss)) ? Math.round(Number(m.remainingLoss) * 100) / 100 : null;
  const fromTrades = tradeDays ? Object.keys(tradeDays).sort().slice(-1)[0] || null : null;
  const fromMetrics = lastDayOf(m);
  // Jauges des cartes de compte (18/10/2026) : drawdown restant et objectif, seulement s'ils sont
  // configurés dans Deltalytix. Montants arrondis au centime ; jamais de valeur inventée.
  const dd = hasDrawdown(a, m);
  const ddUsed = dd ? num(m.drawdownProgress) : null;               // % du drawdown déjà consommé
  const ddLeft = dd ? Math.max(0, num(m.remainingLoss)) : null;
  const ddTotal = dd && ddUsed != null && ddUsed < 100 ? ddLeft * 100 / (100 - ddUsed) : null;
  const toTarget = m ? num(m.remainingToTarget) : null;
  const prog = m ? num(m.progress) : null;
  const hasTarget = (toTarget != null && toTarget > 0) || (prog != null && prog > 0);
  return {
    breached: isBreached(m, a),
    lastTradeDay: [fromMetrics, fromTrades].filter(Boolean).sort().slice(-1)[0] || null,
    remainingLoss: dd ? round2(ddLeft) : null,
    drawdownTotal: round2(ddTotal),
    drawdownLevel: dd ? round2(num(m.drawdownLevel)) : null,
    remainingToTarget: hasTarget ? round2(Math.max(0, toTarget || 0)) : null,
    targetProgress: hasTarget && prog != null ? Math.round(prog * 10) / 10 : null,
    balance: Number.isFinite(Number(a.balance)) ? Number(a.balance) : null,
    startingBalance: num(a.startingBalance),
    hidden: a.hidden === true,
  };
}

// Comptes renvoyés au navigateur pour l'import (pas de P&L détaillé ici).
function slimAccount(a) {
  const number = String(a.number || a.accountNumber || '').trim();
  const label = String(a.propfirm || '').trim();
  const m = a.metrics || null;
  const days = m && m.dailyPnL && typeof m.dailyPnL === 'object' ? Object.keys(m.dailyPnL).map(isoDay).filter(Boolean).sort() : [];
  const lastDay = days.length ? days[days.length - 1] : null;
  return {
    number,
    // Le libellé « propfirm » est saisi dans Deltalytix : parfois vide ou égal au numéro.
    propfirm: label && normAccNum(label) !== normAccNum(number) ? label : null,
    size: Number(a.startingBalance) > 0 ? Math.round(Number(a.startingBalance)) : null,
    balance: Number.isFinite(Number(a.balance)) ? Number(a.balance) : null,
    // Compte perdu d'après Deltalytix : drawdown configuré et plus aucune marge de perte.
    breached: isBreached(m, a),
    // Premier jour tradé : sert de date d'activation (PA) ou d'achat (challenge) à l'import.
    firstTradeDay: days.length ? days[0] : null,
    lastTradeDay: lastDay,
    // Comptes masqués dans le tableau de bord Deltalytix (groupe « Hidden Accounts ») : ignorés à l'import.
    hidden: a.hidden === true || !!(a.group && a.group.name === 'Hidden Accounts'),
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
  if (!L.configured()) return json(501, { error: 'not_configured' });
  const deadline = Date.now() + TIME_BUDGET_MS;
  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const user = await L.supabaseUser(db, event);
  if (!user) return json(401, { error: 'Session invalide, reconnecte-toi.' });

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { error: 'Requête invalide' }); }
  const action = body.action;
  const saveState = (patch) => db.from('broker_connections').update({ ...patch, updated_at: new Date().toISOString() })
    .eq('user_id', user.id).eq('provider', L.PROVIDER);

  try {
    if (action === 'disconnect') {
      // Révoque aussi l'accès chez Deltalytix (refresh token + jeton d'accès), puis efface notre copie.
      const { data: conn } = await db.from('broker_connections').select('token_enc')
        .eq('user_id', user.id).eq('provider', L.PROVIDER).maybeSingle();
      const t = conn ? L.unpackTokens(conn.token_enc) : null;
      if (t) await Promise.all([L.revokeToken(t.refresh_token), L.revokeToken(t.access_token)]);
      await db.from('broker_connections').delete().eq('user_id', user.id).eq('provider', L.PROVIDER);
      return json(200, { connected: false });
    }

    // Contrôle à chaque action (18/10/2026) : une connexion dont l'e-mail Deltalytix est celui d'un AUTRE
    // utilisateur Contralytix (par ex. inscrit après coup) est coupée, jetons révoqués chez Deltalytix.
    {
      const { data: conn } = await db.from('broker_connections').select('account_email, token_enc')
        .eq('user_id', user.id).eq('provider', L.PROVIDER).maybeSingle();
      const de = conn && conn.account_email ? String(conn.account_email).trim() : '';
      const same = de && String(user.email || '').trim().toLowerCase() === de.toLowerCase();
      const taken = conn && de && !same ? await L.otherUserWithEmail(db, de, user.id) : false;
      if (taken === true) {
        const t = L.unpackTokens(conn.token_enc);
        if (t) await Promise.all([L.revokeToken(t.refresh_token), L.revokeToken(t.access_token)]);
        await db.from('broker_connections').delete().eq('user_id', user.id).eq('provider', L.PROVIDER);
        return json(409, { error: 'email_other_user', code: 'email_other_user', email: de });
      }
    }
    const token = await L.accessTokenFor(db, user.id);

    if (action === 'accounts') {
      const raw = await allAccounts(token, deadline);
      const conns = await connectionsOf(token, deadline);
      const plat = platformMap(conns.list);
      const accounts = raw.map(slimAccount).filter((a) => a.number)
        .map((a) => ({ ...a, platform: plat.get(normAccNum(a.number)) || null }));
      await saveState({ last_error: null });
      return json(200, { accounts, connectionsScope: conns.scope });
    }

    if (action === 'sync') {
      const remote = await allAccounts(token, deadline);
      const byNum = new Map();
      const remoteByNum = new Map();
      remote.forEach((a) => {
        const n = normAccNum(a.number || a.accountNumber);
        if (!n) return;
        remoteByNum.set(n, a);
        byNum.set(n, (a.metrics && a.metrics.dailyPnL && typeof a.metrics.dailyPnL === 'object') ? a.metrics.dailyPnL : {});
      });
      const since = new Date(Date.now() - SYNC_DAYS * 86400000).toISOString().slice(0, 10);
      const allMine = await userAccounts(db, user.id, user.email);
      // Connexions broker : plateforme de chaque compte + connexions en retard de synchro
      // (portée connections:read ; absente des autorisations données avant le 13/10/2026).
      const conns = await connectionsOf(token, deadline);
      const connectionsScope = conns.scope;
      const plat = platformMap(conns.list);
      const trades = await recentTradesDaily(token, since, deadline);
      // Santé des comptes (tous types) trouvés dans Deltalytix : actifs, ou sans plateforme connue.
      const health = [];
      allMine.forEach((a) => {
        const k = normAccNum(a.account_number);
        const r = remoteByNum.get(k);
        if (!r && !plat.has(k)) return;
        if (a.status === 'ACTIF' && r) health.push({ accountId: a.id, ...healthOf(r, trades.map.get(k)), platform: plat.get(k) || null });
        else if (plat.has(k)) health.push({ accountId: a.id, platform: plat.get(k), inactive: a.status !== 'ACTIF' });
      });
      const stale = [];
      const activeNums = new Set(allMine.filter((a) => a.status === 'ACTIF').map((a) => normAccNum(a.account_number)));
      const limit = Date.now() - STALE_DAYS * 86400000;
      conns.list.forEach((c) => {
        const nums = (Array.isArray(c.accountNumbers) ? c.accountNumbers : []).filter((n) => activeNums.has(normAccNum(n)));
        if (!nums.length) return;
        const last = c.lastSyncedAt ? Date.parse(c.lastSyncedAt) : 0;
        if (!last || last < limit) stale.push({ service: String(c.service || ''), lastSyncedAt: c.lastSyncedAt || null, accounts: nums.length });
      });
      const mine = allMine.filter((a) => (a.type === 'PA' || a.type === 'LIVE') && a.status === 'ACTIF');
      const now = new Date().toISOString();
      const rows = [];
      let matched = 0;
      const matchedIds = [];
      const missingIds = [];
      mine.forEach((a) => {
        const k = normAccNum(a.account_number);
        const fromTrades = trades.map.get(k);
        if (!byNum.has(k) && !fromTrades) { missingIds.push(a.id); return; }
        matchedIds.push(a.id);
        // dailyPnL d'abord, puis les journées des trades bruts (prioritaires sur la période lue).
        const daily = { ...(byNum.get(k) || {}), ...(fromTrades || {}) };
        matched++;
        let lastOld = null;
        Object.entries(daily).forEach(([day, pnl]) => {
          const d = isoDay(day);
          if (!d || !Number.isFinite(Number(pnl))) return;
          if (d < since) { if (!lastOld || d > lastOld[0]) lastOld = [d, pnl]; return; }
          rows.push({ user_id: user.id, account_id: a.id, day: d, traded: true, pnl: Math.round(Number(pnl) * 100) / 100, source: 'deltalytix', updated_at: now });
        });
        // Aucun trade récent : on écrit quand même le dernier jour tradé connu (point de départ du Radar).
        if (lastOld && !rows.some((r) => r.account_id === a.id)) {
          rows.push({ user_id: user.id, account_id: a.id, day: lastOld[0], traded: true, pnl: Math.round(Number(lastOld[1]) * 100) / 100, source: 'deltalytix', updated_at: now });
        }
      });
      // Pointages écrits seulement si le Radar est activé (le navigateur l'indique ; absent = oui).
      if (body.radar === false) rows.length = 0;
      for (let i = 0; i < rows.length; i += 500) {
        const { error } = await db.from('dormancy_logs').upsert(rows.slice(i, i + 500), { onConflict: 'account_id,day' });
        if (error) throw new Error(`dormancy_logs : ${error.message}`);
      }
      const dltxPlan = await deltalytixPlanOf(token, deadline);
      await saveState({ last_sync_at: now, last_error: null });
      return json(200, { matched, funded: mine.length, matchedIds, missingIds, days: rows.length, syncedAt: now, health, stale, connectionsScope, tradesComplete: trades.complete, dltxPlan });
    }

    return json(400, { error: 'Action inconnue' });
  } catch (e) {
    const code = e.code || 'error';
    if (code === 'not_connected') return json(409, { error: 'not_connected', code });
    if (code === 'migration_missing') return json(500, { error: 'migration_missing', code });
    console.error('Deltalytix :', code, e.message);
    try { await saveState({ last_error: code }); } catch (_) { /* */ }
    const msg = {
      token_invalid: 'Deltalytix a refusé l’accès (autorisation retirée ou expirée). Reconnecte Deltalytix.',
      timeout: 'Deltalytix met trop de temps à répondre. Réessaie dans un instant.',
      unreachable: 'Deltalytix est injoignable pour le moment. Réessaie plus tard.',
      api_error: 'Deltalytix a renvoyé une erreur. Réessaie plus tard.',
    }[code] || 'Erreur pendant l’échange avec Deltalytix. Réessaie plus tard.';
    return json(code === 'token_invalid' ? 409 : 502, { error: msg, code });
  }
};

exports._test = { slimAccount, normAccNum, healthOf, platformMap, recentTradesDaily };
