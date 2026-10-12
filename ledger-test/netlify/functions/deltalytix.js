// netlify/functions/deltalytix.js
//
// Connexion Deltalytix (OAuth, voir deltalytix-oauth.js) : une fois connecté, cette fonction
//   - renvoie les comptes (numéro, taille, libellé de prop firm) et leurs payouts pour l'import ;
//   - pointe automatiquement le Radar inactivité à partir du P&L journalier (net des commissions).
// Les jetons OAuth sont conservés CHIFFRÉS dans broker_connections.token_enc (illisible par les
// utilisateurs) et renouvelés ici quand ils expirent. L'API Deltalytix n'envoie pas d'en-têtes CORS :
// tous les appels passent par le serveur.
//
// POST /api/deltalytix  { action: 'accounts' | 'sync' | 'disconnect' }
// En-tête Authorization: Bearer <jeton Supabase> obligatoire. Configuration : voir _deltalytix-lib.js.

const { createClient } = require('@supabase/supabase-js');
const L = require('./_deltalytix-lib');

const SYNC_DAYS = 70;              // pointages écrits sur les ~2 derniers mois
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
    breached: !!(m && m.isConfigured && Number(m.totalTradingDays) > 0 && Number(m.remainingLoss) <= 0),
    lastTradeDay: lastDay,
    // Comptes masqués dans Deltalytix : pas encore exposé par l'API (champ lu s'il apparaît).
    hidden: a.hidden === true || !!(a.group && /hidden/i.test(String(a.group.name || a.group))),
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
      await db.from('broker_connections').delete().eq('user_id', user.id).eq('provider', L.PROVIDER);
      return json(200, { connected: false });
    }

    const token = await L.accessTokenFor(db, user.id);

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

exports._test = { slimAccount, normAccNum };
