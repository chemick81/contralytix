// netlify/functions/test-weekly-perf-summary.js
//
// --- TEMPORAIRE — à supprimer une fois le test du "Résumé de performance" validé -------------
//
// weekly-perf-summary.js est une fonction PLANIFIÉE (netlify.toml), et Netlify refuse toute
// invocation HTTP directe des fonctions planifiées (403 systématique, avant même d'atteindre le
// code) — c'est pour ça que l'appel direct de son URL a échoué. Cette fonction-ci n'est PAS
// planifiée (absente de netlify.toml), donc invocable normalement en GET, pour prévisualiser
// l'email sans attendre le prochain lundi.
//
// Usage :
//   https://<ton-site>.netlify.app/.netlify/functions/test-weekly-perf-summary?secret=XXX&uid=YYY&force=1
//
//   - secret : doit correspondre à la variable d'environnement WEEKLY_SUMMARY_TEST_SECRET
//     (à créer sur Netlify — Site configuration > Environment variables — valeur longue et
//     aléatoire connue de toi seul). Sans cette variable définie, cette fonction refuse tout appel.
//   - uid : l'UUID du compte à tester (obligatoire — jamais d'envoi en masse ici), visible dans
//     Supabase > Authentication > Users, ou dans la table "profiles".
//   - force=1 (optionnel) : envoie l'email même si le compte n'a aucune activité sur la semaine.
//
// Une fois le test validé : supprime ce fichier (et la variable WEEKLY_SUMMARY_TEST_SECRET sur
// Netlify) — weekly-perf-summary.js continue de tourner seul, chaque lundi.

const { runWeeklySummary } = require('./_weekly-perf-summary-lib');

exports.handler = async (event) => {
  const testSecret = process.env.WEEKLY_SUMMARY_TEST_SECRET;
  const qs = (event && event.queryStringParameters) || {};

  if (!testSecret) {
    return { statusCode: 403, body: JSON.stringify({ error: 'Mode test désactivé : variable WEEKLY_SUMMARY_TEST_SECRET absente sur Netlify.' }) };
  }
  if (!qs.secret || qs.secret !== testSecret) {
    return { statusCode: 403, body: JSON.stringify({ error: 'Secret invalide.' }) };
  }
  if (!qs.uid) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Paramètre "uid" obligatoire.' }) };
  }

  try {
    const result = await runWeeklySummary({ onlyUid: qs.uid, forceOne: qs.force === '1' || qs.force === 'true' });
    if (result.notFound) return { statusCode: 404, body: JSON.stringify(result) };
    return { statusCode: 200, body: JSON.stringify({ mode: 'manual-test', ...result }) };
  } catch (err) {
    console.error('test-weekly-perf-summary error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};