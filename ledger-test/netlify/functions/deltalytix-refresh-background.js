// netlify/functions/deltalytix-refresh-background.js
//
// Synchro Deltalytix complète, pilotée par Contralytix (27/11/2026) :
//   1. demande à Deltalytix de récupérer les derniers trades de chaque connexion broker
//      (POST /connections/{id}/sync : Tradovate reliée dans le tableau de bord Deltalytix, Rithmic, IBKR, dxFeed) ;
//   2. lit ensuite comptes, trades et P&L comme le bouton « Synchro Deltalytix » (runSync de deltalytix.js).
// Le trader n'a plus besoin d'ouvrir Deltalytix après y avoir relié sa plateforme une fois.
//
// Fonction d'ARRIÈRE-PLAN (suffixe -background) : Netlify répond 202 tout de suite et la laisse tourner
// jusqu'à 15 min, car la synchro chez Tradovate / Rithmic peut durer bien plus que 10 s.
// Le résultat est visible dans broker_connections (last_sync_at, last_error), que l'app relit.
//
// Deux façons de l'appeler (POST) :
//   - par l'app : en-tête Authorization: Bearer <jeton Supabase>, corps { radar?: boolean } → cet utilisateur ;
//   - par la tâche planifiée deltalytix-autosync : en-tête x-cx-autosync = L.cronKey() → tous les connectés.
// Portée connections:write nécessaire pour l'étape 1 ; sans elle (connexion plus ancienne), l'étape 1 est
// sautée, la lecture se fait quand même et last_error vaut 'broker_scope' (l'app propose de reconnecter).

const { createClient } = require('@supabase/supabase-js');
const L = require('./_deltalytix-lib');
const { runSync, guardOwner } = require('./deltalytix');

const SYNCABLE = new Set(['tradovate', 'rithmic-protocol', 'ibkr', 'dxfeed']);
const BROKER_TIMEOUT_MS = 150000;     // par connexion (les connexions d'un utilisateur partent en parallèle)
const READ_BUDGET_MS = 90000;         // lecture après la synchro broker
const TOTAL_BUDGET_MS = 13 * 60000;   // marge sous la limite de 15 min de Netlify

async function brokerSync(token) {
  let list = [];
  try {
    const body = await L.dltx(token, '/connections?limit=100', Date.now() + 15000);
    list = Array.isArray(body && body.data) ? body.data : [];
  } catch (e) {
    if (e.code === 'token_invalid') throw e;
    if (e.code === 'insufficient_scope') return { scopeMissing: true, results: [] };
    return { scopeMissing: false, results: [], error: e.code || 'error' };
  }
  const targets = list.filter((c) => c && c.id && SYNCABLE.has(String(c.service || '').toLowerCase()));
  const results = await Promise.all(targets.map(async (c) => {
    try {
      const r = await L.dltxPost(token, `/connections/${encodeURIComponent(c.id)}/sync`, BROKER_TIMEOUT_MS);
      return { service: c.service, ok: true, imported: Number(r && r.imported) || 0 };
    } catch (e) {
      if (e.code === 'token_invalid') throw e;
      return { service: c.service, ok: false, code: e.code || 'error' };
    }
  }));
  return { scopeMissing: results.some((r) => r.code === 'insufficient_scope'), results };
}

async function refreshUser(db, user, radar) {
  const saveState = (patch) => db.from('broker_connections').update({ ...patch, updated_at: new Date().toISOString() })
    .eq('user_id', user.id).eq('provider', L.PROVIDER);
  try {
    if (await guardOwner(db, user)) return { userId: user.id, cut: true };
    let token = await L.accessTokenFor(db, user.id);
    const broker = await brokerSync(token);
    // La synchro broker a pu durer plusieurs minutes : jeton relu (renouvelé s'il expire bientôt).
    token = await L.accessTokenFor(db, user.id);
    const out = await runSync(db, user, token, { radar, deadline: Date.now() + READ_BUDGET_MS });
    if (broker.scopeMissing) await saveState({ last_error: 'broker_scope' });
    return { userId: user.id, brokers: broker.results, scopeMissing: broker.scopeMissing, days: out.days };
  } catch (e) {
    const code = e.code || 'error';
    console.error('Deltalytix refresh :', user.id, code, e.message);
    if (code !== 'not_connected') { try { await saveState({ last_error: code }); } catch (_) { /* */ } }
    return { userId: user.id, error: code };
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST' || !L.configured()) return { statusCode: 400 };
  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const h = event.headers || {};
  const auto = h['x-cx-autosync'] || h['X-Cx-Autosync'];

  if (auto) {
    if (auto !== L.cronKey()) return { statusCode: 403 };
    const stop = Date.now() + TOTAL_BUDGET_MS;
    const { data: conns, error } = await db.from('broker_connections').select('user_id').eq('provider', L.PROVIDER);
    if (error) { console.error('Deltalytix autosync :', error.message); return { statusCode: 500 }; }
    const ids = [...new Set((conns || []).map((c) => c.user_id))];
    const { data: profs } = ids.length ? await db.from('profiles').select('id, radar_enabled').in('id', ids) : { data: [] };
    const radarOf = new Map((profs || []).map((p) => [p.id, p.radar_enabled === true]));
    const report = [];
    for (const id of ids) {
      if (Date.now() > stop - BROKER_TIMEOUT_MS - READ_BUDGET_MS) { report.push({ userId: id, skipped: 'time' }); continue; }
      const { data: u } = await db.auth.admin.getUserById(id);
      if (!u || !u.user) continue;
      report.push(await refreshUser(db, u.user, radarOf.get(id) === true));
    }
    console.log('Deltalytix autosync :', JSON.stringify(report));
    return { statusCode: 200 };
  }

  const user = await L.supabaseUser(db, event);
  if (!user) return { statusCode: 401 };
  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch (e) { /* corps facultatif */ }
  const r = await refreshUser(db, user, body.radar !== false);
  console.log('Deltalytix refresh :', JSON.stringify(r));
  return { statusCode: 200 };
};

exports._test = { brokerSync, refreshUser };
