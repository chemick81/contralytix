// netlify/functions/weekly-perf-summary.js
//
// Fonction planifiée (voir netlify.toml : [functions."weekly-perf-summary"].schedule) qui envoie,
// une fois par semaine, un email "Résumé de performance" à chaque utilisateur ayant activé le
// toggle correspondant dans Paramètres > Notifications (colonne profiles.notif_perf_summary,
// migration_profil_parametres.sql). Logique de calcul et d'envoi dans _weekly-perf-summary-lib.js
// (partagée avec test-weekly-perf-summary.js, la fonction de test manuel temporaire).
//
// Variables d'environnement Netlify requises (déjà utilisées par les autres fonctions) :
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, BREVO_API_KEY, NOTIFY_SENDER_EMAIL
//
// Note : Netlify refuse toute invocation HTTP directe d'une fonction déclarée avec un `schedule`
// dans netlify.toml (403 renvoyé avant même que ce code ne s'exécute) — c'est volontaire côté
// Netlify pour ce type de fonction. Le test manuel se fait donc via une fonction séparée, NON
// planifiée : voir test-weekly-perf-summary.js.
//
// ⚠️ Non testé contre une vraie base Supabase / API Brevo dans cet environnement — vérifié via
// test-weekly-perf-summary.js sur un compte de test avant de laisser tourner la planification
// réelle, et à surveiller après la première exécution planifiée.

const { runWeeklySummary } = require('./_weekly-perf-summary-lib');

exports.handler = async () => {
  try {
    const result = await runWeeklySummary();
    return { statusCode: 200, body: JSON.stringify({ mode: 'scheduled', ...result }) };
  } catch (err) {
    console.error('weekly-perf-summary error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};