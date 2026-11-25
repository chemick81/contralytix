// netlify/functions/import-stale-alert.js
//
// Fonction planifiée (voir netlify.toml) : chaque matin du mardi au samedi, e-mail « relevés à
// importer » aux utilisateurs qui l'ont activé (Paramètres › Notifications), seulement s'ils ont des
// comptes sans relevé récent. Logique dans _import-stale-lib.js.
// Netlify refuse l'appel HTTP direct d'une fonction planifiée (403) : pas de test manuel par URL.

const { runImportStaleAlert } = require('./_import-stale-lib');

exports.handler = async () => {
  try {
    const result = await runImportStaleAlert();
    return { statusCode: 200, body: JSON.stringify({ mode: 'scheduled', ...result }) };
  } catch (err) {
    console.error('import-stale-alert error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
