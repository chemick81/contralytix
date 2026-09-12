// netlify/functions/weekly-perf-summary.js
//
// Fonction planifiée (voir netlify.toml : [functions."weekly-perf-summary"].schedule) qui envoie,
// une fois par semaine, un email "Résumé de performance" à chaque utilisateur ayant activé le
// toggle correspondant dans Paramètres > Notifications (colonne profiles.notif_perf_summary,
// migration_profil_parametres.sql).
//
// Contenu de l'email, calculé UNIQUEMENT sur les comptes/traders du destinataire (jamais les
// données d'un autre utilisateur — même règle que le reste de l'app, voir
// claude/kpi-scope-compte-uniquement.md) sur les 7 derniers jours glissants :
//   - Payouts reçus (montant + nombre)
//   - Dépenses engagées (achats de challenges, mensualités échues, frais de reset)
//   - Résultat net, avec comparaison à la semaine précédente (▲/▼)
// Aucun email n'est envoyé à un utilisateur sans la moindre activité sur la période, pour éviter
// le bruit.
//
// La logique de dépenses reproduit délibérément computeAccountExpenses() / sumMoneyNet() de
// index.html (mêmes règles : achat unique, mensualités via addMonths/monthsBetweenCount, frais
// d'activation PA/Live, resets), mais restreinte à une fenêtre de dates au lieu de tout l'historique
// — recalculée côté serveur car cette fonction n'a pas accès à l'état client déjà chargé.
//
// Variables d'environnement Netlify requises (déjà utilisées par les autres fonctions) :
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, BREVO_API_KEY, NOTIFY_SENDER_EMAIL
//
// ⚠️ Non testé contre une vraie base Supabase / API Brevo dans cet environnement — à tester avec
// `netlify dev` (invocation manuelle de la fonction planifiée) sur un compte de test avant tout
// déploiement, et à surveiller après la première exécution planifiée réelle.
//
// --- MODE TEST MANUEL (TEMPORAIRE — à retirer une fois le test effectué) ---------------------
// Une fonction planifiée ne peut pas être déclenchée depuis le bouton "Tester" de Netlify avant
// sa première échéance réelle. Pour vérifier le rendu de l'email sans attendre le prochain lundi,
// cette fonction accepte aussi un appel direct en GET :
//
//   https://<ton-site>.netlify.app/.netlify/functions/weekly-perf-summary?secret=XXX&uid=YYY&force=1
//
//   - secret : doit correspondre à la variable d'environnement WEEKLY_SUMMARY_TEST_SECRET
//     (à créer sur Netlify — Site configuration > Environment variables — avec une valeur
//     longue et aléatoire connue de toi seul). Sans cette variable définie, le mode test est
//     désactivé, même avec le bon paramètre dans l'URL.
//   - uid : l'UUID du compte à tester (obligatoire en mode test, pour ne jamais risquer d'envoyer
//     à tous les abonnés pendant un essai) — visible dans Supabase > Authentication > Users, ou
//     dans la table "profiles".
//   - force=1 (optionnel) : envoie l'email même si le compte n'a aucune activité sur la semaine,
//     pour voir le rendu avec des totaux à 0.
//
// Une fois le test validé, retire ce bloc "MODE TEST MANUEL" (et supprime la variable
// WEEKLY_SUMMARY_TEST_SECRET sur Netlify) pour ne garder que l'exécution planifiée normale.

const { createClient } = require('@supabase/supabase-js');

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

/* ---------- Petits utilitaires de dates, copiés de index.html pour rester cohérents ---------- */

function pad2(n) { return String(n).padStart(2, '0'); }
function toISO(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
function daysInMonth(y, m) { return new Date(y, m, 0).getDate(); } // m = 1-12
function addMonths(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const total = (m - 1) + n;
  const newY = y + Math.floor(total / 12);
  const newM = ((total % 12) + 12) % 12;
  const lastDay = daysInMonth(newY, newM + 1);
  return `${newY}-${pad2(newM + 1)}-${pad2(Math.min(d, lastDay))}`;
}
function monthsBetweenCount(startStr, endStr) {
  const [sy, sm] = startStr.split('-').map(Number);
  const [ey, em] = endStr.split('-').map(Number);
  return (ey - sy) * 12 + (em - sm);
}
function toEur(amount, fxRateToEur) {
  const rate = Number(fxRateToEur) || 1;
  return Number(amount || 0) / rate;
}
const CURRENCY_SYMBOLS = { USD: '$', EUR: '€', GBP: '£' };
function fmtMoneyCur(amount, currency) {
  const symbol = CURRENCY_SYMBOLS[currency] || '$';
  const sign = amount < 0 ? '-' : '';
  return sign + Math.abs(Number(amount || 0)).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ' + symbol;
}

// Combine dépenses + payouts d'une fenêtre en un total net, dans une seule devise — même principe
// que sumMoneyNet() côté client : si tout est dans la même devise, total exact sans conversion ;
// sinon conversion en EUR via fxRateToEur.
function sumMoneyNet(expenseItems, payoutItems) {
  const all = [...expenseItems, ...payoutItems];
  const currencies = new Set(all.map(it => it.currency || 'USD'));
  const useEur = currencies.size > 1;
  const currency = useEur ? 'EUR' : (all[0] ? (all[0].currency || 'USD') : 'USD');
  const val = (it) => useEur ? toEur(it.amount, it.fxRateToEur) : Number(it.amount || 0);
  const totalExp = expenseItems.reduce((s, it) => s + val(it), 0);
  const totalPay = payoutItems.reduce((s, it) => s + val(it), 0);
  return { totalExp, totalPay, net: totalPay - totalExp, currency, converted: useEur };
}

// Reproduit computeAccountExpenses(), restreinte aux lignes dont la date tombe dans [from, to]
// (bornes incluses, format "YYYY-MM-DD").
function accountExpensesInWindow(acc, resets, from, to) {
  const lines = [];
  const cur = acc.currency || 'USD', fx = acc.fx_rate_to_eur || 1;
  const inWindow = (d) => d && d >= from && d <= to;

  if (acc.payment_type === 'UNIQUE') {
    if (acc.purchase_price && inWindow(acc.purchase_date)) {
      lines.push({ amount: Number(acc.purchase_price), currency: cur, fxRateToEur: fx });
    }
  } else if (acc.payment_type === 'MENSUEL' && acc.monthly_amount && acc.purchase_date) {
    const stopDate = acc.end_date && acc.end_date < to ? acc.end_date : to;
    const n = monthsBetweenCount(acc.purchase_date, stopDate);
    for (let i = 0; i <= n; i++) {
      const d = addMonths(acc.purchase_date, i);
      if (d <= stopDate && inWindow(d)) {
        lines.push({ amount: Number(acc.monthly_amount), currency: cur, fxRateToEur: fx });
      }
    }
  }
  if ((acc.type === 'PA' || acc.type === 'LIVE') && acc.activation_fee) {
    const d = acc.activation_date || acc.purchase_date;
    if (inWindow(d)) lines.push({ amount: Number(acc.activation_fee), currency: cur, fxRateToEur: fx });
  }
  resets.filter(r => r.account_id === acc.id && inWindow(r.date)).forEach(r => {
    lines.push({ amount: Number(r.fee) || 0, currency: r.currency || cur, fxRateToEur: r.fx_rate_to_eur || fx });
  });
  return lines;
}

async function computeWeekFor(uid, fromISO, toISO_, accounts, payouts, resets) {
  const mineAccounts = accounts.filter(a => a.created_by === uid);
  const expenseLines = mineAccounts.flatMap(acc => accountExpensesInWindow(acc, resets, fromISO, toISO_));
  const payoutLines = payouts
    .filter(p => p.created_by === uid && p.date >= fromISO && p.date <= toISO_)
    .map(p => ({ amount: Number(p.amount) || 0, currency: p.currency || 'USD', fxRateToEur: p.fx_rate_to_eur || 1 }));
  const { totalExp, totalPay, net, currency, converted } = sumMoneyNet(expenseLines, payoutLines);
  return { totalExp, totalPay, net, currency, converted, payoutCount: payoutLines.length, hasActivity: expenseLines.length > 0 || payoutLines.length > 0 };
}

exports.handler = async (event) => {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.warn('weekly-perf-summary : configuration Supabase manquante — exécution ignorée.');
    return { statusCode: 200, body: 'skipped: missing supabase config' };
  }

  // --- MODE TEST MANUEL (voir le bloc de commentaires en tête de fichier) ---
  const qs = (event && event.queryStringParameters) || {};
  const testSecret = process.env.WEEKLY_SUMMARY_TEST_SECRET;
  const isManualTest = !!(testSecret && qs.secret && qs.secret === testSecret);
  if (qs.secret && !isManualTest) {
    return { statusCode: 403, body: JSON.stringify({ error: 'Secret de test invalide ou non configuré.' }) };
  }
  if (isManualTest && !qs.uid) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Mode test : paramètre "uid" obligatoire (jamais d\'envoi en masse en mode test).' }) };
  }
  const forceForTest = isManualTest && (qs.force === '1' || qs.force === 'true');

  const today = new Date();
  const to = toISO(today);
  const from = toISO(new Date(today.getTime() - 6 * 86400000)); // fenêtre de 7 jours glissante, bornes incluses
  const prevTo = toISO(new Date(today.getTime() - 7 * 86400000));
  const prevFrom = toISO(new Date(today.getTime() - 13 * 86400000));

  try {
    let profiles;
    if (isManualTest) {
      const { data, error } = await supabaseAdmin
        .from('profiles')
        .select('id, display_name, notif_perf_summary')
        .eq('id', qs.uid)
        .maybeSingle();
      if (error) throw error;
      if (!data) return { statusCode: 404, body: JSON.stringify({ error: 'Aucun profil avec cet uid.' }) };
      profiles = [data];
    } else {
      const { data, error: profErr } = await supabaseAdmin
        .from('profiles')
        .select('id, display_name, notif_perf_summary')
        .eq('notif_perf_summary', true);
      if (profErr) throw profErr;
      profiles = data;
    }
    if (!profiles || !profiles.length) {
      return { statusCode: 200, body: 'no recipients' };
    }

    const [{ data: accounts, error: accErr }, { data: payouts, error: payErr }, { data: resets, error: resErr }] = await Promise.all([
      supabaseAdmin.from('accounts').select('id, created_by, currency, fx_rate_to_eur, payment_type, purchase_price, purchase_date, monthly_amount, end_date, type, activation_fee, activation_date'),
      supabaseAdmin.from('payouts').select('created_by, amount, date, currency, fx_rate_to_eur'),
      supabaseAdmin.from('account_resets').select('account_id, fee, date, currency, fx_rate_to_eur'),
    ]);
    if (accErr) throw accErr;
    if (payErr) throw payErr;
    if (resErr) throw resErr;

    const apiKey = process.env.BREVO_API_KEY;
    const senderEmail = process.env.NOTIFY_SENDER_EMAIL;
    if (!apiKey || !senderEmail) {
      console.warn('weekly-perf-summary : BREVO_API_KEY ou NOTIFY_SENDER_EMAIL manquant — aucun email envoyé.');
      return { statusCode: 200, body: 'skipped: missing brevo config' };
    }

    let sent = 0, skippedNoActivity = 0, failed = 0;

    for (const profile of profiles) {
      const uid = profile.id;
      const week = await computeWeekFor(uid, from, to, accounts, payouts, resets);
      if (!week.hasActivity && !forceForTest) { skippedNoActivity++; continue; }
      const prevWeek = await computeWeekFor(uid, prevFrom, prevTo, accounts, payouts, resets);

      // Adresse réelle du compte via l'API admin — jamais un champ modifiable côté client.
      const { data: userData, error: userErr } = await supabaseAdmin.auth.admin.getUserById(uid);
      if (userErr || !userData?.user?.email) { failed++; continue; }
      const email = userData.user.email;
      const name = (profile.display_name || '').trim();

      const trendArrow = prevWeek.hasActivity
        ? (week.net > prevWeek.net ? '▲' : (week.net < prevWeek.net ? '▼' : '—'))
        : '';
      const trendLine = prevWeek.hasActivity
        ? `<p style="color:#888;font-size:12.5px;">${trendArrow} par rapport à la semaine précédente (${fmtMoneyCur(prevWeek.net, prevWeek.currency)})</p>`
        : '';

      const html = `
        <p>Bonjour${name ? ' ' + name : ''},</p>
        <p>Voici ton résumé de performance Contralytix pour la semaine du ${from} au ${to} :</p>
        <table style="border-collapse:collapse;width:100%;max-width:420px;">
          <tr><td style="padding:6px 0;color:#888;">Payouts reçus</td><td style="padding:6px 0;text-align:right;font-weight:600;">${fmtMoneyCur(week.totalPay, week.currency)} (${week.payoutCount})</td></tr>
          <tr><td style="padding:6px 0;color:#888;">Dépenses engagées</td><td style="padding:6px 0;text-align:right;font-weight:600;">${fmtMoneyCur(week.totalExp, week.currency)}</td></tr>
          <tr><td style="padding:8px 0;border-top:1px solid #eee;color:#888;">Résultat net</td><td style="padding:8px 0;border-top:1px solid #eee;text-align:right;font-weight:700;">${fmtMoneyCur(week.net, week.currency)}</td></tr>
        </table>
        ${trendLine}
        ${week.converted ? '<p style="color:#aaa;font-size:11px;">Montants convertis en EUR (comptes dans plusieurs devises).</p>' : ''}
        <p style="margin-top:16px;"><a href="https://contralytix.fr/#dashboard">Voir le détail sur le Dashboard</a></p>
        <p style="color:#888;font-size:11.5px;margin-top:20px;">Tu reçois cet email car le résumé de performance hebdomadaire est activé dans Paramètres. Tu peux le désactiver à tout moment depuis Paramètres &gt; Notifications.</p>
        <p>— L'équipe Contralytix</p>
      `;

      try {
        const res = await fetch('https://api.brevo.com/v3/smtp/email', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'api-key': apiKey },
          body: JSON.stringify({
            sender: { email: senderEmail, name: 'Contralytix' },
            to: [{ email }],
            subject: 'Contralytix — Ton résumé de performance de la semaine',
            htmlContent: html,
          }),
        });
        if (res.ok) sent++; else { failed++; console.error('weekly-perf-summary: échec Brevo pour', uid, res.status); }
      } catch (err) {
        failed++;
        console.error('weekly-perf-summary: erreur envoi pour', uid, err.message);
      }
    }

    console.log(`weekly-perf-summary${isManualTest ? ' [TEST MANUEL]' : ''}: ${sent} envoyés, ${skippedNoActivity} sans activité, ${failed} échecs (sur ${profiles.length} abonnés).`);
    return { statusCode: 200, body: JSON.stringify({ mode: isManualTest ? 'manual-test' : 'scheduled', sent, skippedNoActivity, failed, total: profiles.length }) };
  } catch (err) {
    console.error('weekly-perf-summary error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};