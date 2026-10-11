// netlify/functions/_weekly-perf-summary-lib.js
//
// Logique de l'email hebdomadaire « Résumé de performance » (Paramètres > Notifications),
// appelée par weekly-perf-summary.js (fonction planifiée, chaque lundi 8h UTC — voir netlify.toml).
//
// Le préfixe "_" fait que Netlify NE PUBLIE PAS ce fichier comme une fonction HTTP (convention
// des Netlify Functions pour les modules partagés).
//
// ── Fenêtre de calcul (corrigée le 11/10/2026) ──────────────────────────────────────────────
// Avant : 7 jours glissants se terminant le jour de l'envoi (mardi → lundi). Une opération datée
// du lundi mais saisie après l'envoi n'apparaissait jamais (trop tard pour cet email, et la
// fenêtre suivante démarrait le mardi).
// Maintenant : la SEMAINE CALENDAIRE PRÉCÉDENTE COMPLÈTE, du lundi au dimanche, en heure de Paris.
// Les fenêtres s'enchaînent sans trou ni chevauchement, et la semaine est close au moment de
// l'envoi.
//
// ── Contenu (refonte du 11/10/2026, format « dashboard » aéré) ──────────────────────────────
// Calculé UNIQUEMENT sur les données du destinataire (created_by = son uid — même règle que le
// reste de l'app, voir claude/kpi-scope-compte-uniquement.md) :
//   - Résultat net de la semaine + écart vs la semaine précédente
//   - Payouts reçus (montant, nombre) / Dépenses (achats, mensualités, activations, resets,
//     frais généraux) avec leur détail
//   - Évolution du résultat net sur 6 semaines (graphique en barres, compatible clients mail)
//   - Comptes : actifs par type + mouvements de la semaine (nouveaux comptes, réussis, breached,
//     fermés) d'après account_status_history
//   - Cumul depuis le début : résultat net et rentabilité (net / dépenses)
// Aucun email n'est envoyé à un utilisateur sans activité financière ni mouvement de compte sur
// la semaine (sauf options.forceOne), pour éviter le bruit.
//
// La logique de dépenses reproduit computeAccountExpenses() / computeGeneralExpenseLines() /
// sumMoneyNet() de index.html (mêmes règles), recalculée côté serveur car cette fonction n'a pas
// accès à l'état client.
//
// Variables d'environnement : SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, BREVO_API_KEY,
// NOTIFY_SENDER_EMAIL, NOTIFY_ADMIN_EMAIL (optionnelle, adresse de réponse), APP_URL (optionnelle,
// défaut https://contralytix.fr — à mettre à https://contralytixdev.netlify.app sur le site dev).

const { createClient } = require('@supabase/supabase-js');

const TZ = 'Europe/Paris';
const TREND_WEEKS = 6;

/* ── Dates ─────────────────────────────────────────────────────────────────────────────── */
function pad2(n) { return String(n).padStart(2, '0'); }
// Date du jour "YYYY-MM-DD" en heure de Paris (le serveur Netlify tourne en UTC).
function parisTodayISO(now = new Date()) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const get = (t) => p.find(x => x.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
// Date Paris "YYYY-MM-DD" d'un timestamp ISO (pour account_status_history.changed_at).
function parisDateOf(ts) { return ts ? parisTodayISO(new Date(ts)) : null; }
function isoToUTC(iso) { const [y, m, d] = iso.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); }
function utcToISO(dt) { return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`; }
function addDays(iso, n) { const dt = isoToUTC(iso); dt.setUTCDate(dt.getUTCDate() + n); return utcToISO(dt); }
function mondayOf(iso) { const dow = (isoToUTC(iso).getUTCDay() + 6) % 7; return addDays(iso, -dow); } // lundi = 0
function daysInMonth(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); } // m = 1-12
function addMonths(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const total = (m - 1) + n;
  const newY = y + Math.floor(total / 12);
  const newM = ((total % 12) + 12) % 12;
  return `${newY}-${pad2(newM + 1)}-${pad2(Math.min(d, daysInMonth(newY, newM + 1)))}`;
}
function monthsBetweenCount(startStr, endStr) {
  const [sy, sm] = startStr.split('-').map(Number);
  const [ey, em] = endStr.split('-').map(Number);
  return (ey - sy) * 12 + (em - sm);
}
const MONTHS_SHORT = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
function fmtRange(from, to) {
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  if (fy === ty && fm === tm) return `${fd} – ${td} ${MONTHS_SHORT[tm - 1]} ${ty}`;
  if (fy === ty) return `${fd} ${MONTHS_SHORT[fm - 1]} – ${td} ${MONTHS_SHORT[tm - 1]} ${ty}`;
  return `${fd} ${MONTHS_SHORT[fm - 1]} ${fy} – ${td} ${MONTHS_SHORT[tm - 1]} ${ty}`;
}
function fmtDayMonth(iso) { const [, m, d] = iso.split('-').map(Number); return `${pad2(d)}/${pad2(m)}`; }

/* ── Montants ──────────────────────────────────────────────────────────────────────────── */
const CURRENCY_SYMBOLS = { USD: '$', EUR: '€', GBP: '£' };
function fmtMoney(amount, currency, { sign = false } = {}) {
  const v = Number(amount || 0);
  const abs = Math.abs(v);
  const whole = Math.abs(abs - Math.round(abs)) < 0.005;
  const s = abs.toLocaleString('fr-FR', { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: whole ? 0 : 2 }).replace(/ | /g, ' ');
  const prefix = v < -0.004 ? '−' : (sign && v > 0.004 ? '+' : '');
  return `${prefix}${s} ${CURRENCY_SYMBOLS[currency] || currency || '$'}`;
}
function fmtPct(v) { return `${v > 0 ? '+' : (v < 0 ? '−' : '')}${Math.abs(v).toLocaleString('fr-FR', { maximumFractionDigits: 0 })} %`; }
function escapeHtml(s) { return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

/* ── Lignes de dépenses / payouts (mêmes règles que index.html) ────────────────────────── */
// Toutes les lignes de dépense d'un compte jusqu'à `until` inclus (le filtrage par fenêtre se
// fait ensuite, ce qui permet de calculer semaine, tendance et cumul avec la même source).
function accountExpenseLines(acc, resetsByAccount, until) {
  const lines = [];
  const cur = acc.currency || 'USD', fx = acc.fx_rate_to_eur || 1;
  if (acc.payment_type === 'UNIQUE') {
    if (acc.purchase_price && acc.purchase_date) lines.push({ kind: 'ACHAT', date: acc.purchase_date, amount: Number(acc.purchase_price), currency: cur, fx });
  } else if (acc.payment_type === 'MENSUEL' && acc.monthly_amount && acc.purchase_date) {
    const stop = acc.end_date && acc.end_date < until ? acc.end_date : until;
    const n = monthsBetweenCount(acc.purchase_date, stop);
    for (let i = 0; i <= n; i++) {
      const d = addMonths(acc.purchase_date, i);
      if (d <= stop) lines.push({ kind: 'MENSUALITE', date: d, amount: Number(acc.monthly_amount), currency: cur, fx });
    }
  }
  if ((acc.type === 'PA' || acc.type === 'LIVE') && acc.activation_fee) {
    lines.push({ kind: 'ACTIVATION', date: acc.activation_date || acc.purchase_date, amount: Number(acc.activation_fee), currency: cur, fx });
  }
  (resetsByAccount.get(acc.id) || []).forEach(r => {
    lines.push({ kind: 'RESET', date: r.date, amount: Number(r.fee) || 0, currency: r.currency || cur, fx: r.fx_rate_to_eur || fx });
  });
  return lines.filter(l => l.date && l.date <= until);
}
function generalExpenseLines(r, until) {
  const lines = [];
  const cur = r.currency || 'EUR', fx = r.fx_rate_to_eur || 1;
  if (!r.start_date) return lines;
  if (r.recurrence === 'MENSUEL' || r.recurrence === 'ANNUEL') {
    if (!r.amount) return lines;
    const stop = r.end_date && r.end_date < until ? r.end_date : until;
    const step = r.recurrence === 'ANNUEL' ? 12 : 1;
    const n = Math.floor(monthsBetweenCount(r.start_date, stop) / step);
    for (let i = 0; i <= n; i++) {
      const d = addMonths(r.start_date, i * step);
      if (d <= stop) lines.push({ kind: 'GENERAL', date: d, amount: Number(r.amount), currency: cur, fx });
    }
  } else {
    lines.push({ kind: 'GENERAL', date: r.start_date, amount: Number(r.amount) || 0, currency: cur, fx });
  }
  return lines.filter(l => l.date <= until);
}

/* ── Données Supabase (pagination : PostgREST plafonne à 1000 lignes par requête) ─────────── */
async function fetchAll(buildQuery) {
  const PAGE = 1000;
  let from = 0, rows = [];
  for (;;) {
    const { data, error } = await buildQuery().range(from, from + PAGE - 1);
    if (error) throw error;
    rows = rows.concat(data || []);
    if (!data || data.length < PAGE) return rows;
    from += PAGE;
  }
}
function chunk(arr, n) { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; }

/* ── Calcul du résumé d'un utilisateur ─────────────────────────────────────────────────── */
function computeSummary(ctx) {
  const { accounts, payouts, generalExpenses, resetsByAccount, statusHistory, firmsById, weekStart, weekEnd } = ctx;

  const expLines = [
    ...accounts.flatMap(a => accountExpenseLines(a, resetsByAccount, weekEnd)),
    ...generalExpenses.flatMap(g => generalExpenseLines(g, weekEnd)),
  ];
  const payLines = payouts.filter(p => p.date && p.date <= weekEnd)
    .map(p => ({ date: p.date, amount: Number(p.amount) || 0, currency: p.currency || 'USD', fx: p.fx_rate_to_eur || 1, accountId: p.account_id }));

  // Une seule devise d'affichage pour tout l'email (semaine, tendance, cumul restent comparables) :
  // la devise commune si tout est dans la même, sinon EUR (même principe que sumMoneyNet()).
  const currencies = new Set([...expLines, ...payLines].map(l => l.currency));
  const converted = currencies.size > 1;
  const currency = converted ? 'EUR' : ([...currencies][0] || 'USD');
  const val = (l) => converted ? l.amount / (Number(l.fx) || 1) : l.amount;
  const sumIn = (lines, from, to) => lines.filter(l => l.date >= from && l.date <= to).reduce((s, l) => s + val(l), 0);

  // Semaine
  const wExp = expLines.filter(l => l.date >= weekStart && l.date <= weekEnd);
  const wPay = payLines.filter(l => l.date >= weekStart && l.date <= weekEnd);
  const totalPay = wPay.reduce((s, l) => s + val(l), 0);
  const totalExp = wExp.reduce((s, l) => s + val(l), 0);
  const breakdown = {};
  wExp.forEach(l => { breakdown[l.kind] = (breakdown[l.kind] || 0) + val(l); });

  // Tendance : TREND_WEEKS semaines, la dernière = la semaine résumée
  const trend = [];
  for (let k = TREND_WEEKS - 1; k >= 0; k--) {
    const from = addDays(weekStart, -7 * k), to = addDays(weekEnd, -7 * k);
    trend.push({ from, to, net: sumIn(payLines, from, to) - sumIn(expLines, from, to) });
  }
  const prevNet = trend[trend.length - 2].net;
  const prevHasActivity = [...expLines, ...payLines].some(l => l.date >= trend[trend.length - 2].from && l.date <= trend[trend.length - 2].to);

  // Cumul depuis le début (jusqu'à la fin de la semaine résumée)
  const cumPay = payLines.reduce((s, l) => s + val(l), 0);
  const cumExp = expLines.reduce((s, l) => s + val(l), 0);

  // Comptes
  const accById = new Map(accounts.map(a => [a.id, a]));
  const label = (a) => {
    const firm = firmsById.get(a.prop_firm_id) || 'PropFirm';
    const size = a.size === 'AUTRE' ? (a.custom_size ? fmtMoney(a.custom_size, a.currency || 'USD') : '') : (SIZE_LABELS[a.size] || '');
    return [firm, TYPE_LABELS[a.type] || a.type, size].filter(Boolean).join(' · ');
  };
  const activeByType = { CHALLENGE: 0, PA: 0, LIVE: 0 };
  accounts.forEach(a => { if (a.status === 'ACTIF' && activeByType[a.type] !== undefined) activeByType[a.type]++; });

  const events = [];
  accounts.filter(a => a.purchase_date && a.purchase_date >= weekStart && a.purchase_date <= weekEnd)
    .forEach(a => events.push({ kind: 'NEW', date: a.purchase_date, text: label(a) }));
  statusHistory.forEach(h => {
    const d = parisDateOf(h.changed_at);
    const a = accById.get(h.account_id);
    if (!a || !d || d < weekStart || d > weekEnd || h.new_status === h.old_status) return;
    if (['REUSSI', 'BREACHED', 'FERME', 'ACTIF'].includes(h.new_status)) events.push({ kind: h.new_status, date: d, text: label(a) });
  });
  // Dédoublonnage : un même compte peut changer plusieurs fois de statut dans la semaine
  const seen = new Set();
  const uniqEvents = events.filter(e => { const k = e.kind + '|' + e.text + '|' + e.date; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => b.date.localeCompare(a.date));
  const eventCounts = {};
  uniqEvents.forEach(e => { eventCounts[e.kind] = (eventCounts[e.kind] || 0) + 1; });

  // Payouts de la semaine (les plus gros d'abord)
  const payoutRows = wPay.slice().sort((a, b) => val(b) - val(a))
    .map(p => ({ amount: val(p), date: p.date, text: accById.get(p.accountId) ? label(accById.get(p.accountId)) : 'Payout' }));

  return {
    currency, converted,
    week: { totalPay, totalExp, net: totalPay - totalExp, payoutCount: wPay.length, breakdown },
    prevNet, prevHasActivity,
    trend,
    cumulative: { totalPay: cumPay, totalExp: cumExp, net: cumPay - cumExp, roi: cumExp > 0 ? ((cumPay - cumExp) / cumExp) * 100 : null },
    activeByType, events: uniqEvents, eventCounts, payoutRows,
    hasActivity: wExp.length > 0 || wPay.length > 0 || uniqEvents.length > 0,
  };
}
const SIZE_LABELS = { S25K: '25K', S50K: '50K', S100K: '100K', S150K: '150K', S250K: '250K' };
const TYPE_LABELS = { CHALLENGE: 'Challenge', PA: 'PA', LIVE: 'Live' };

/* ── Rendu de l'email ──────────────────────────────────────────────────────────────────────
   Contraintes clients mail (Gmail, Outlook, Apple Mail) : uniquement des <table>, styles inline,
   pas de SVG ni de flex/grid, polices système. Le graphique est construit en cellules de tableau. */
const C = {
  bg: '#F1F3F5', card: '#FFFFFF', soft: '#F7F8F9', line: '#E6E9EC',
  text: '#10151A', dim: '#5B6673', faint: '#8B98A5',
  accent: '#149A80', accentSoft: '#E3F4F0', danger: '#C6402E', dangerSoft: '#FAE8E5',
  ink: '#0B0F14', inkAccent: '#3ED6B5', amber: '#B7791F', amberSoft: '#FBF1E1',
};
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const EXP_LABELS = { ACHAT: 'Achats de comptes', MENSUALITE: 'Mensualités', ACTIVATION: 'Frais d’activation', RESET: 'Resets', GENERAL: 'Frais généraux' };
const EVENT_STYLE = {
  NEW: { label: 'Nouveau', color: C.dim, bg: C.soft },
  REUSSI: { label: 'Réussi', color: C.accent, bg: C.accentSoft },
  BREACHED: { label: 'Breached', color: C.danger, bg: C.dangerSoft },
  FERME: { label: 'Fermé', color: C.faint, bg: C.soft },
  ACTIF: { label: 'Réactivé', color: C.amber, bg: C.amberSoft },
};
const netColor = (v) => v > 0.004 ? C.accent : (v < -0.004 ? C.danger : C.text);

function card(inner, pad = '24px') {
  return `<tr><td style="padding:0 0 16px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.card};border-radius:14px;border:1px solid ${C.line};"><tr><td style="padding:${pad};">${inner}</td></tr></table></td></tr>`;
}
function sectionTitle(t, right = '') {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
    <td style="font:600 11px/1.4 ${FONT};letter-spacing:1.2px;text-transform:uppercase;color:${C.faint};padding-bottom:14px;">${t}</td>
    <td align="right" style="font:400 12px/1.4 ${FONT};color:${C.faint};padding-bottom:14px;">${right}</td></tr></table>`;
}

function trendChart(trend, currency) {
  const H = 64; // hauteur max d'une barre (px), de chaque côté de la ligne de base
  const max = Math.max(...trend.map(t => Math.abs(t.net)), 1);
  const anyNeg = trend.some(t => t.net < -0.004);
  const last = trend.length - 1;
  const bar = (h, color) => h > 0
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td height="${h}" style="height:${h}px;line-height:${h}px;font-size:0;background:${color};border-radius:4px;">&nbsp;</td></tr></table>`
    : '';
  const cols = trend.map((t, i) => {
    const h = Math.max(Math.round((Math.abs(t.net) / max) * H), Math.abs(t.net) > 0.004 ? 3 : 0);
    const isLast = i === last;
    const pos = t.net > 0.004 ? (isLast ? C.accent : '#9FD9CB') : null;
    const neg = t.net < -0.004 ? (isLast ? C.danger : '#EBB1A8') : null;
    return { h, pos, neg, isLast, t };
  });
  const w = Math.floor(100 / trend.length);
  const cell = (content, valign, extra = '') => `<td width="${w}%" valign="${valign}" style="padding:0 6px;${extra}">${content}</td>`;
  const valuesRow = cols.map(c => cell(`<div style="font:${c.isLast ? 700 : 500} 11px/1.3 ${FONT};color:${c.isLast ? netColor(c.t.net) : C.faint};text-align:center;white-space:nowrap;">${Math.abs(c.t.net) > 0.004 ? fmtMoney(c.t.net, currency, { sign: true }) : '0'}</div>`, 'bottom', 'padding-bottom:6px;')).join('');
  const posRow = cols.map(c => cell(c.pos ? bar(c.h, c.pos) : '', 'bottom', `height:${H}px;`)).join('');
  const negRow = anyNeg ? `<tr>${cols.map(c => cell(c.neg ? bar(c.h, c.neg) : '', 'top', `height:${Math.round(H / 2)}px;`)).join('')}</tr>` : '';
  const labels = cols.map(c => cell(`<div style="font:${c.isLast ? 700 : 400} 11px/1.3 ${FONT};color:${c.isLast ? C.text : C.faint};text-align:center;">${c.isLast ? 'Cette sem.' : fmtDayMonth(c.t.from)}</div>`, 'top', 'padding-top:8px;')).join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
    <tr>${valuesRow}</tr>
    <tr>${posRow}</tr>
    <tr><td colspan="${trend.length}" style="padding:0;"><div style="height:1px;line-height:1px;font-size:0;background:${C.line};">&nbsp;</div></td></tr>
    ${negRow}
    <tr>${labels}</tr>
  </table>`;
}

function buildEmailHtml({ name, weekStart, weekEnd, s, appUrl }) {
  const cur = s.currency;
  const w = s.week;
  const delta = w.net - s.prevNet;
  const range = fmtRange(weekStart, weekEnd);

  // Résumé une ligne pour l'aperçu dans la boîte de réception
  const pre = [
    `Net ${fmtMoney(w.net, cur, { sign: true })}`,
    w.payoutCount ? `${w.payoutCount} payout${w.payoutCount > 1 ? 's' : ''}` : null,
    s.eventCounts.REUSSI ? `${s.eventCounts.REUSSI} compte${s.eventCounts.REUSSI > 1 ? 's' : ''} réussi${s.eventCounts.REUSSI > 1 ? 's' : ''}` : null,
    s.eventCounts.BREACHED ? `${s.eventCounts.BREACHED} breach` : null,
  ].filter(Boolean).join(' · ');

  // 1. Héros : résultat net
  const deltaPill = s.prevHasActivity || Math.abs(s.prevNet) > 0.004
    ? `<span style="display:inline-block;padding:5px 10px;border-radius:999px;background:${delta >= 0 ? C.accentSoft : C.dangerSoft};color:${delta >= 0 ? C.accent : C.danger};font:600 12px/1 ${FONT};">${delta >= 0 ? '▲' : '▼'} ${fmtMoney(Math.abs(delta), cur)}</span><span style="font:400 12px/1 ${FONT};color:${C.faint};padding-left:8px;">vs semaine précédente</span>`
    : `<span style="font:400 12px/1 ${FONT};color:${C.faint};">Pas d’activité la semaine précédente</span>`;
  const hero = card(`
    <div style="font:600 11px/1.4 ${FONT};letter-spacing:1.2px;text-transform:uppercase;color:${C.faint};">Résultat net de la semaine</div>
    <div style="font:700 40px/1.15 ${FONT};color:${netColor(w.net)};letter-spacing:-1px;padding:8px 0 12px 0;">${fmtMoney(w.net, cur, { sign: true })}</div>
    ${deltaPill}`, '28px 24px');

  // 2. Payouts / Dépenses
  const expDetail = Object.keys(EXP_LABELS).filter(k => s.week.breakdown[k] > 0.004)
    .map(k => `<tr><td style="font:400 12px/1.7 ${FONT};color:${C.dim};">${EXP_LABELS[k]}</td><td align="right" style="font:500 12px/1.7 ${FONT};color:${C.dim};white-space:nowrap;">${fmtMoney(s.week.breakdown[k], cur)}</td></tr>`).join('');
  const payDetail = s.payoutRows.slice(0, 3)
    .map(p => `<tr><td style="font:400 12px/1.7 ${FONT};color:${C.dim};">${escapeHtml(p.text)}</td><td align="right" style="font:500 12px/1.7 ${FONT};color:${C.dim};white-space:nowrap;">${fmtMoney(p.amount, cur)}</td></tr>`).join('')
    + (s.payoutRows.length > 3 ? `<tr><td colspan="2" style="font:400 12px/1.7 ${FONT};color:${C.faint};">+ ${s.payoutRows.length - 3} autre${s.payoutRows.length - 3 > 1 ? 's' : ''}</td></tr>` : '');
  const tile = (label, value, color, sub, detail) => `
    <td width="48%" valign="top" style="padding:0;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.card};border-radius:14px;border:1px solid ${C.line};"><tr><td style="padding:20px;">
        <div style="font:600 11px/1.4 ${FONT};letter-spacing:1.2px;text-transform:uppercase;color:${C.faint};">${label}</div>
        <div style="font:700 24px/1.2 ${FONT};color:${color};padding:6px 0 2px 0;white-space:nowrap;">${value}</div>
        <div style="font:400 12px/1.5 ${FONT};color:${C.faint};padding-bottom:${detail ? 10 : 0}px;">${sub}</div>
        ${detail ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid ${C.line};"><tr><td style="height:8px;font-size:0;line-height:0;">&nbsp;</td></tr>${detail}</table>` : ''}
      </td></tr></table>
    </td>`;
  const tiles = `<tr><td style="padding:0 0 16px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
    ${tile('Payouts reçus', fmtMoney(w.totalPay, cur), w.totalPay > 0.004 ? C.accent : C.text, w.payoutCount ? `${w.payoutCount} payout${w.payoutCount > 1 ? 's' : ''}` : 'Aucun cette semaine', payDetail)}
    <td width="16" style="width:16px;font-size:0;line-height:0;">&nbsp;</td>
    ${tile('Dépenses', fmtMoney(w.totalExp, cur), C.text, w.totalExp > 0.004 ? 'Engagées sur la semaine' : 'Aucune cette semaine', expDetail)}
  </tr></table></td></tr>`;

  // 3. Évolution
  const evolution = card(`${sectionTitle('Évolution du résultat net', `${TREND_WEEKS} dernières semaines`)}${trendChart(s.trend, cur)}`);

  // 4. Comptes
  const typeStat = (label, n) => `<td width="33%" align="center" style="padding:4px;">
      <div style="font:700 22px/1.2 ${FONT};color:${C.text};">${n}</div>
      <div style="font:400 12px/1.4 ${FONT};color:${C.faint};">${label}</div></td>`;
  const MAX_EVENTS = 6;
  const eventRows = s.events.slice(0, MAX_EVENTS).map(e => {
    const st = EVENT_STYLE[e.kind];
    return `<tr>
      <td width="84" style="padding:7px 0;"><span style="display:inline-block;min-width:64px;text-align:center;padding:4px 8px;border-radius:999px;background:${st.bg};color:${st.color};font:600 11px/1.2 ${FONT};">${st.label}</span></td>
      <td style="padding:7px 0 7px 8px;font:500 13px/1.4 ${FONT};color:${C.text};">${escapeHtml(e.text)}</td>
      <td align="right" style="padding:7px 0;font:400 12px/1.4 ${FONT};color:${C.faint};white-space:nowrap;">${fmtDayMonth(e.date)}</td></tr>`;
  }).join('') + (s.events.length > MAX_EVENTS ? `<tr><td colspan="3" style="padding:6px 0 0 0;font:400 12px/1.4 ${FONT};color:${C.faint};">+ ${s.events.length - MAX_EVENTS} autre${s.events.length - MAX_EVENTS > 1 ? 's' : ''} mouvement${s.events.length - MAX_EVENTS > 1 ? 's' : ''}</td></tr>` : '');
  const comptes = card(`${sectionTitle('Tes comptes', 'Actifs aujourd’hui')}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.soft};border-radius:10px;"><tr>
      ${typeStat('Challenges', s.activeByType.CHALLENGE)}${typeStat('PA', s.activeByType.PA)}${typeStat('Live', s.activeByType.LIVE)}
    </tr></table>
    <div style="font:600 13px/1.4 ${FONT};color:${C.text};padding:20px 0 6px 0;">Mouvements de la semaine</div>
    ${s.events.length
      ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${eventRows}</table>`
      : `<div style="font:400 13px/1.5 ${FONT};color:${C.faint};">Aucun changement de statut cette semaine.</div>`}`);

  // 5. Cumul
  const c = s.cumulative;
  const cumul = card(`${sectionTitle('Depuis le début')}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
      <td width="50%" valign="top">
        <div style="font:700 22px/1.2 ${FONT};color:${netColor(c.net)};">${fmtMoney(c.net, cur, { sign: true })}</div>
        <div style="font:400 12px/1.5 ${FONT};color:${C.faint};">Résultat net cumulé</div></td>
      <td width="50%" valign="top" align="right">
        <div style="font:700 22px/1.2 ${FONT};color:${c.roi === null ? C.text : netColor(c.roi)};">${c.roi === null ? '—' : fmtPct(c.roi)}</div>
        <div style="font:400 12px/1.5 ${FONT};color:${C.faint};">Rentabilité (net / dépenses)</div></td>
    </tr></table>
    <div style="font:400 12px/1.5 ${FONT};color:${C.faint};padding-top:12px;border-top:1px solid ${C.line};margin-top:14px;">${fmtMoney(c.totalPay, cur)} de payouts pour ${fmtMoney(c.totalExp, cur)} de dépenses</div>`);

  const cta = `<tr><td align="center" style="padding:8px 0 28px 0;">
    <a href="${appUrl}/#dashboard" style="display:inline-block;background:${C.accent};color:#FFFFFF;text-decoration:none;font:600 14px/1 ${FONT};padding:15px 28px;border-radius:10px;">Ouvrir mon Dashboard</a></td></tr>`;

  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light">
<title>Ton résumé de la semaine</title></head>
<body style="margin:0;padding:0;background:${C.bg};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${C.bg};">${escapeHtml(pre)}&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.bg};"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;">
  <tr><td style="padding:0 0 16px 0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.ink};border-radius:14px;"><tr>
      <td style="padding:20px 24px;font:700 15px/1 ${FONT};letter-spacing:2px;color:#FFFFFF;">CONTRA<span style="color:${C.inkAccent};">LYTIX</span></td>
      <td align="right" style="padding:20px 24px;font:400 12px/1.4 ${FONT};color:#8B98A5;">Résumé hebdo<br><span style="color:#E8EDF2;font-weight:600;">${range}</span></td>
    </tr></table></td></tr>
  <tr><td style="padding:4px 4px 18px 4px;font:400 15px/1.5 ${FONT};color:${C.text};">Bonjour${name ? ' ' + escapeHtml(name) : ''}, voici ta semaine en un coup d’œil.</td></tr>
  ${hero}
  ${tiles}
  ${evolution}
  ${comptes}
  ${cumul}
  ${cta}
  <tr><td style="padding:0 8px;font:400 11.5px/1.6 ${FONT};color:${C.faint};text-align:center;">
    ${s.converted ? 'Montants convertis en EUR (comptes dans plusieurs devises).<br>' : ''}
    Semaine du lundi au dimanche, heure de Paris. Calculé uniquement sur tes propres comptes.<br>
    Tu reçois cet email car le résumé hebdomadaire est activé. <a href="${appUrl}/#parametres" style="color:${C.dim};">Le désactiver dans Paramètres</a>.<br><br>
    — L’équipe Contralytix</td></tr>
</table></td></tr></table>
</body></html>`;
}

/* ── Exécution ─────────────────────────────────────────────────────────────────────────── */
// options: { onlyUid?: string, forceOne?: boolean, refDate?: 'YYYY-MM-DD', dryRun?: boolean }
//   - onlyUid  : restreint à un seul utilisateur (test), sans regarder son toggle.
//   - forceOne : envoie même sans activité (test).
//   - refDate  : date "du jour" simulée (test) — la semaine résumée est celle qui précède.
//   - dryRun   : calcule et renvoie le HTML sans rien envoyer.
async function runWeeklySummary(options = {}) {
  const { onlyUid, forceOne, refDate, dryRun } = options;

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.warn('weekly-perf-summary : configuration Supabase manquante — exécution ignorée.');
    return { skipped: 'missing supabase config' };
  }
  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const appUrl = (process.env.APP_URL || 'https://contralytix.fr').replace(/\/+$/, '');

  // Semaine calendaire précédente complète (lundi → dimanche, heure de Paris)
  const today = refDate || parisTodayISO();
  const weekStart = addDays(mondayOf(today), -7);
  const weekEnd = addDays(weekStart, 6);

  let profilesQ = db.from('profiles').select('id, display_name, notif_perf_summary');
  profilesQ = onlyUid ? profilesQ.eq('id', onlyUid) : profilesQ.eq('notif_perf_summary', true);
  const { data: profiles, error: profErr } = await profilesQ;
  if (profErr) throw profErr;
  if (!profiles || !profiles.length) return onlyUid ? { error: 'Aucun profil avec cet uid.', notFound: true } : { sent: 0, skippedNoActivity: 0, failed: 0, total: 0, weekStart, weekEnd };

  // Uniquement les lignes des destinataires (minimisation des données lues)
  const uids = profiles.map(p => p.id);
  const byOwner = async (table, cols) => {
    const parts = await Promise.all(chunk(uids, 100).map(ids => fetchAll(() => db.from(table).select(cols).in('created_by', ids).order('id'))));
    return parts.flat();
  };
  const [accounts, payouts, firms] = await Promise.all([
    byOwner('accounts', 'id, created_by, prop_firm_id, type, status, size, custom_size, currency, fx_rate_to_eur, payment_type, purchase_price, purchase_date, monthly_amount, end_date, activation_fee, activation_date'),
    byOwner('payouts', 'id, created_by, account_id, amount, date, currency, fx_rate_to_eur'),
    fetchAll(() => db.from('propfirms').select('id, name').order('id')),
  ]);
  // Frais généraux : module récent — si la table n'existe pas encore sur un environnement,
  // l'email part quand même sans eux plutôt que d'échouer.
  let generalExpenses = [];
  try { generalExpenses = await byOwner('general_expenses', '*'); }
  catch (e) { console.warn('weekly-perf-summary : general_expenses ignorée —', e.message); }

  const accountIds = accounts.map(a => a.id);
  const [resets, statusHistory] = await Promise.all([
    Promise.all(chunk(accountIds, 200).map(ids => fetchAll(() => db.from('account_resets').select('id, account_id, fee, date, currency, fx_rate_to_eur').in('account_id', ids).order('id')))).then(r => r.flat()),
    Promise.all(chunk(accountIds, 200).map(ids => fetchAll(() => db.from('account_status_history').select('id, account_id, old_status, new_status, changed_at')
      .in('account_id', ids).gte('changed_at', addDays(weekStart, -1)).order('id')))).then(r => r.flat()),
  ]);

  const firmsById = new Map(firms.map(f => [f.id, f.name]));
  const group = (rows, key) => { const m = new Map(); rows.forEach(r => { if (!m.has(r[key])) m.set(r[key], []); m.get(r[key]).push(r); }); return m; };
  const accByOwner = group(accounts, 'created_by');
  const payByOwner = group(payouts, 'created_by');
  const genByOwner = group(generalExpenses, 'created_by');
  const resetsByAccount = group(resets, 'account_id');
  const histByAccount = group(statusHistory, 'account_id');

  const apiKey = process.env.BREVO_API_KEY;
  const senderEmail = process.env.NOTIFY_SENDER_EMAIL;
  // Adresse de réponse unique (boîte support) : un clic sur « Répondre » arrive dans une boîte lue.
  const replyToEmail = process.env.NOTIFY_ADMIN_EMAIL;
  const replyTo = replyToEmail ? { replyTo: { email: replyToEmail, name: 'Support Contralytix' } } : {};
  if (!dryRun && (!apiKey || !senderEmail)) {
    console.warn('weekly-perf-summary : BREVO_API_KEY ou NOTIFY_SENDER_EMAIL manquant — aucun email envoyé.');
    return { skipped: 'missing brevo config' };
  }

  let sent = 0, skippedNoActivity = 0, failed = 0;
  const previews = [];

  for (const profile of profiles) {
    const uid = profile.id;
    const myAccounts = accByOwner.get(uid) || [];
    const s = computeSummary({
      accounts: myAccounts,
      payouts: payByOwner.get(uid) || [],
      generalExpenses: genByOwner.get(uid) || [],
      resetsByAccount,
      statusHistory: myAccounts.flatMap(a => histByAccount.get(a.id) || []),
      firmsById, weekStart, weekEnd,
    });
    if (!s.hasActivity && !forceOne) { skippedNoActivity++; continue; }

    const name = (profile.display_name || '').trim();
    const html = buildEmailHtml({ name, weekStart, weekEnd, s, appUrl });
    if (dryRun) { previews.push({ uid, html }); continue; }

    // Adresse réelle du compte via l'API admin — jamais un champ modifiable côté client.
    const { data: userData, error: userErr } = await db.auth.admin.getUserById(uid);
    if (userErr || !userData?.user?.email) { failed++; continue; }

    try {
      const res = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'api-key': apiKey },
        body: JSON.stringify({
          sender: { email: senderEmail, name: 'Contralytix' },
          ...replyTo,
          to: [{ email: userData.user.email }],
          subject: `Ta semaine : ${fmtMoney(s.week.net, s.currency, { sign: true })} · ${fmtRange(weekStart, weekEnd)}`,
          htmlContent: html,
        }),
      });
      if (res.ok) sent++; else { failed++; console.error('weekly-perf-summary: échec Brevo pour', uid, res.status); }
    } catch (err) {
      failed++;
      console.error('weekly-perf-summary: erreur envoi pour', uid, err.message);
    }
  }

  console.log(`weekly-perf-summary${onlyUid ? ' [TEST]' : ''} ${weekStart}→${weekEnd}: ${sent} envoyés, ${skippedNoActivity} sans activité, ${failed} échecs (sur ${profiles.length} abonnés).`);
  return { sent, skippedNoActivity, failed, total: profiles.length, weekStart, weekEnd, ...(dryRun ? { previews } : {}) };
}

module.exports = { runWeeklySummary, _internal: { computeSummary, buildEmailHtml, parisTodayISO, mondayOf, addDays } };
