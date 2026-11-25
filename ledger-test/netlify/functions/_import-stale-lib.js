// netlify/functions/_import-stale-lib.js
//
// Alerte « relevés à importer » (24/11/2026, demande de Mickael) : un e-mail le matin quand des
// comptes PA / Live actifs sans Deltalytix n'ont pas reçu de relevé (Tradovate / R|Trader) depuis
// N jours de bourse ou plus. Appelée par import-stale-alert.js (fonction planifiée, voir netlify.toml).
//
// Réglages et données, tous écrits par l'app dans profiles.payout_plan :
//   importAlert = { site, email, days (1-10, défaut 3), accIds (comptes suivis, sans Deltalytix), sentOn }
//   payoutBalances[accId] = { v, at, day? } : solde saisi ou du dernier relevé
// Dernière donnée d'un compte = la plus récente entre sa dernière journée (dormancy_logs), le solde
// du relevé / saisi et, à défaut, sa date d'activation. Jours de bourse : week-ends et fermetures
// complètes du CME exclus (même calcul que le Radar d'inactivité, dmCmeClosures dans index.html).
// Un seul e-mail par jour au plus (importAlert.sentOn), seulement s'il y a des comptes en retard.
//
// Le préfixe "_" : module partagé, pas publié comme fonction HTTP.
// Variables : SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, BREVO_API_KEY, NOTIFY_SENDER_EMAIL,
// NOTIFY_ADMIN_EMAIL (optionnelle), APP_URL (optionnelle, défaut https://contralytix.fr).

const { createClient } = require('@supabase/supabase-js');

const TZ = 'Europe/Paris';
function parisTodayISO(now = new Date()) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const g = (t) => p.find(x => x.type === t).value;
  return `${g('year')}-${g('month')}-${g('day')}`;
}
const iso = (d) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
const addDays = (s, n) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
const dow = (s) => new Date(s + 'T00:00:00Z').getUTCDay();
function easter(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3),
    h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451),
    mo = Math.floor((h + l - 7 * m + 114) / 31), da = ((h + l - 7 * m + 114) % 31) + 1;
  return `${y}-${String(mo).padStart(2, '0')}-${String(da).padStart(2, '0')}`;
}
function nthDow(y, month, wd, n) {
  if (n > 0) { const d = new Date(Date.UTC(y, month - 1, 1)); while (d.getUTCDay() !== wd) d.setUTCDate(d.getUTCDate() + 1); d.setUTCDate(d.getUTCDate() + 7 * (n - 1)); return iso(d); }
  const d = new Date(Date.UTC(y, month, 0)); while (d.getUTCDay() !== wd) d.setUTCDate(d.getUTCDate() - 1); return iso(d);
}
const observed = (s) => { const w = dow(s); return w === 6 ? addDays(s, -1) : w === 0 ? addDays(s, 1) : s; };
const closuresCache = {};
function cmeClosures(y) {
  if (!closuresCache[y]) closuresCache[y] = new Set([
    observed(`${y}-01-01`), nthDow(y, 1, 1, 3), nthDow(y, 2, 1, 3), addDays(easter(y), -2),
    nthDow(y, 5, 1, -1), observed(`${y}-06-19`), observed(`${y}-07-04`), nthDow(y, 9, 1, 1),
    nthDow(y, 11, 4, 4), observed(`${y}-12-25`),
  ]);
  return closuresCache[y];
}
const isTradingDay = (s) => { const w = dow(s); return w !== 0 && w !== 6 && !cmeClosures(Number(s.slice(0, 4))).has(s); };
// Jours de bourse d tels que after < d <= to
function tradingDaysBetween(after, to) { let n = 0, d = addDays(after, 1); while (d <= to) { if (isTradingDay(d)) n++; d = addDays(d, 1); } return n; }

function staleAccounts({ accounts, lastLogDay, balances, days, today }) {
  const yesterday = addDays(today, -1);
  return accounts.map(a => {
    let last = lastLogDay.get(a.id) || null;
    const b = balances && balances[a.id];
    const bd = b ? String(b.day || b.at || '').slice(0, 10) : '';
    if (bd && (!last || bd > last)) last = bd;
    const none = !last;
    const ref = last || a.activation_date || a.purchase_date || null;
    return { a, last: ref, none, missing: ref ? tradingDaysBetween(ref, yesterday) : 99 };
  }).filter(x => x.missing >= days).sort((x, y) => y.missing - x.missing);
}

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDate = (s) => s ? `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}` : '—';
const mask = (n) => { const t = String(n || ''); return t.length > 4 ? '•••' + t.slice(-4) : t; };

function buildEmailHtml({ name, list, days, appUrl, firmsById }) {
  const rows = list.map(x => {
    const firm = firmsById.get(x.a.prop_firm_id) || '';
    return `<tr><td style="padding:10px 12px;border-bottom:1px solid #232D38;"><b style="color:#E8EDF2;">${esc(firm)}</b> <span style="color:#8B98A5;">${esc(mask(x.a.account_number))} · ${x.a.type === 'LIVE' ? 'Live' : 'PA'}</span></td>
      <td style="padding:10px 12px;border-bottom:1px solid #232D38;color:#8B98A5;">${x.none ? 'aucun relevé' : 'dernière donnée le ' + fmtDate(x.last)}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #232D38;text-align:right;color:#F5C542;white-space:nowrap;">${x.missing >= 99 ? '—' : x.missing + ' j de bourse'}</td></tr>`;
  }).join('');
  return `<!doctype html><html lang="fr"><body style="margin:0;background:#0B0F14;font-family:Inter,Arial,sans-serif;color:#E8EDF2;">
  <div style="max-width:600px;margin:0 auto;padding:28px 20px;">
    <div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#3ED6B5;font-weight:700;">Contralytix · relevés à importer</div>
    <h1 style="font-size:21px;margin:8px 0 6px;">${name ? esc(name) + ', ' : ''}${list.length} compte${list.length > 1 ? 's' : ''} à mettre à jour</h1>
    <p style="color:#8B98A5;font-size:14px;line-height:1.55;margin:0 0 16px;">Ces comptes n'ont pas reçu de relevé depuis ${days} jour${days > 1 ? 's' : ''} de bourse ou plus. Sans relevé récent, le Radar d'inactivité et le Prochain payout travaillent sur des données anciennes.</p>
    <table role="presentation" style="width:100%;border-collapse:collapse;background:#12181F;border:1px solid #232D38;border-radius:10px;font-size:13px;">${rows}</table>
    <div style="margin:18px 0;padding:14px 16px;background:#12181F;border:1px solid #232D38;border-radius:10px;font-size:13px;line-height:1.6;color:#8B98A5;">
      <b style="color:#E8EDF2;">Fichiers à exporter</b><br>
      <b style="color:#E8EDF2;">Tradovate</b> : Account Balance History (indispensable) + Cash History (facultatif : retraits vers le wallet et frais).<br>
      <b style="color:#E8EDF2;">R|Trader Pro</b> : Performance + Trader Dashboard.
    </div>
    <a href="${appUrl}/#accounts" style="display:inline-block;background:#3ED6B5;color:#0B0F14;text-decoration:none;font-weight:700;padding:11px 18px;border-radius:9px;font-size:14px;">Importer un relevé</a>
    <p style="color:#5B6673;font-size:12px;line-height:1.5;margin-top:22px;">Tu reçois cet e-mail car l'alerte « Relevés à importer » est activée. Pour la couper ou changer le délai : Contralytix › Paramètres › Notifications.</p>
  </div></body></html>`;
}

async function fetchAll(q) { const out = []; for (let from = 0; ; from += 1000) { const { data, error } = await q().range(from, from + 999); if (error) throw error; out.push(...(data || [])); if (!data || data.length < 1000) break; } return out; }
const chunk = (arr, n) => { const o = []; for (let i = 0; i < arr.length; i += n) o.push(arr.slice(i, i + n)); return o; };

async function runImportStaleAlert(options = {}) {
  const { onlyUid, refDate, dryRun, force } = options;
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return { skipped: 'missing supabase config' };
  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const appUrl = (process.env.APP_URL || 'https://contralytix.fr').replace(/\/+$/, '');
  const today = refDate || parisTodayISO();
  if (!isTradingDay(addDays(today, -1)) && !force) return { skipped: 'no trading day yesterday', today };

  // Alerte réservée à Premium (formules du 25/11/2026) : rôle Premium / Beta / Admin ou essai en cours.
  let q = db.from('profiles').select('id, display_name, payout_plan, role, trial_ends_at');
  q = onlyUid ? q.eq('id', onlyUid) : q.eq('payout_plan->importAlert->>email', 'true');
  let { data: profiles, error } = await q;
  if (error) {   // migration de l'essai pas encore passée : sans trial_ends_at
    let q2 = db.from('profiles').select('id, display_name, payout_plan, role');
    q2 = onlyUid ? q2.eq('id', onlyUid) : q2.eq('payout_plan->importAlert->>email', 'true');
    ({ data: profiles, error } = await q2);
    if (error) throw error;
  }
  const subs = (profiles || []).filter(p => {
    const ia = p.payout_plan && p.payout_plan.importAlert;
    const prem = ['ADMIN', 'PREMIUM', 'BETA'].includes(p.role) || (p.trial_ends_at && new Date(p.trial_ends_at) > new Date());
    return ia && prem && (onlyUid || ia.email === true) && Array.isArray(ia.accIds) && ia.accIds.length && (force || ia.sentOn !== today);
  });
  if (!subs.length) return { sent: 0, total: 0, today };

  const allIds = [...new Set(subs.flatMap(p => p.payout_plan.importAlert.accIds))];
  const accounts = (await Promise.all(chunk(allIds, 100).map(ids => fetchAll(() => db.from('accounts').select('id, created_by, prop_firm_id, account_number, type, status, activation_date, purchase_date').in('id', ids).order('id'))))).flat();
  const since = addDays(today, -120);
  const logs = (await Promise.all(chunk(allIds, 100).map(ids => fetchAll(() => db.from('dormancy_logs').select('account_id, day').in('account_id', ids).gte('day', since).order('id'))))).flat();
  const lastLogDay = new Map();
  logs.forEach(l => { if (!lastLogDay.has(l.account_id) || l.day > lastLogDay.get(l.account_id)) lastLogDay.set(l.account_id, l.day); });
  const firms = await fetchAll(() => db.from('propfirms').select('id, name').order('id'));
  const firmsById = new Map(firms.map(f => [f.id, f.name]));

  const apiKey = process.env.BREVO_API_KEY, senderEmail = process.env.NOTIFY_SENDER_EMAIL, replyToEmail = process.env.NOTIFY_ADMIN_EMAIL;
  if (!dryRun && (!apiKey || !senderEmail)) return { skipped: 'missing brevo config' };
  let sent = 0, none = 0, failed = 0; const previews = [];
  for (const p of subs) {
    const ia = p.payout_plan.importAlert;
    const days = Math.min(10, Math.max(1, Number(ia.days) || 3));
    const mine = accounts.filter(a => ia.accIds.includes(a.id) && a.created_by === p.id && a.status === 'ACTIF' && (a.type === 'PA' || a.type === 'LIVE'));
    const list = staleAccounts({ accounts: mine, lastLogDay, balances: p.payout_plan.payoutBalances || {}, days, today });
    if (!list.length) { none++; continue; }
    const html = buildEmailHtml({ name: (p.display_name || '').trim(), list, days, appUrl, firmsById });
    if (dryRun) { previews.push({ uid: p.id, count: list.length, html }); continue; }
    const { data: u, error: uErr } = await db.auth.admin.getUserById(p.id);
    if (uErr || !u?.user?.email) { failed++; continue; }
    try {
      const res = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'api-key': apiKey },
        body: JSON.stringify({
          sender: { email: senderEmail, name: 'Contralytix' },
          ...(replyToEmail ? { replyTo: { email: replyToEmail, name: 'Support Contralytix' } } : {}),
          to: [{ email: u.user.email }],
          subject: `⏰ ${list.length} compte${list.length > 1 ? 's' : ''} sans relevé depuis ${days} jour${days > 1 ? 's' : ''} de bourse`,
          htmlContent: html,
        }),
      });
      if (!res.ok) { failed++; console.error('import-stale-alert: échec Brevo', p.id, res.status); continue; }
      sent++;
      // Une fois par jour au plus : relu juste avant l'écriture pour ne rien écraser d'autre.
      const { data: fresh } = await db.from('profiles').select('payout_plan').eq('id', p.id).single();
      const plan = (fresh && fresh.payout_plan) || p.payout_plan;
      await db.from('profiles').update({ payout_plan: { ...plan, importAlert: { ...(plan.importAlert || {}), sentOn: today } } }).eq('id', p.id);
    } catch (e) { failed++; console.error('import-stale-alert: erreur', p.id, e.message); }
  }
  console.log(`import-stale-alert ${today}: ${sent} envoyés, ${none} sans retard, ${failed} échecs (sur ${subs.length}).`);
  return { sent, none, failed, total: subs.length, today, ...(dryRun ? { previews } : {}) };
}

module.exports = { runImportStaleAlert, _internal: { tradingDaysBetween, isTradingDay, staleAccounts, buildEmailHtml, addDays } };
