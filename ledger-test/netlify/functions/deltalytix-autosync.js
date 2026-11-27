// netlify/functions/deltalytix-autosync.js
//
// Fonction planifiée (voir netlify.toml) : soir et matin, lance la synchro Deltalytix complète de tous les
// utilisateurs connectés (Tradovate / Rithmic → Deltalytix → Contralytix), même s'ils n'ouvrent pas l'app.
// Elle ne fait que réveiller deltalytix-refresh-background (jusqu'à 15 min), car une fonction planifiée
// est coupée à 30 s. Netlify refuse l'appel HTTP direct d'une fonction planifiée (403).

const L = require('./_deltalytix-lib');

exports.handler = async () => {
  if (!L.configured()) return { statusCode: 200, body: JSON.stringify({ skipped: 'not_configured' }) };
  const base = (process.env.URL || process.env.SITE_URL || '').replace(/\/+$/, '');
  if (!base) return { statusCode: 500, body: JSON.stringify({ error: 'URL du site inconnue' }) };
  try {
    const res = await fetch(`${base}/.netlify/functions/deltalytix-refresh-background`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-cx-autosync': L.cronKey() },
      body: '{}',
    });
    return { statusCode: 200, body: JSON.stringify({ mode: 'scheduled', started: res.status }) };
  } catch (err) {
    console.error('deltalytix-autosync :', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
