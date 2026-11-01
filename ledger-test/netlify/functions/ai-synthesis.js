// netlify/functions/ai-synthesis.js — FERMÉE le 01/11/2026.
//
// Cette fonction acceptait n'importe quel appel, sans session, et pouvait donc consommer la clé IA
// du site depuis l'extérieur ; elle acceptait aussi une clé personnelle envoyée en clair par le
// navigateur. Elle est remplacée par /api/ai (session obligatoire, quotas, clé personnelle chiffrée
// côté serveur — voir ai.js et _ai-lib.js). Ce fichier peut être supprimé du dépôt ; tant qu'il
// existe, il répond seulement « 410 Gone » et n'appelle aucun service.

exports.handler = async () => ({
  statusCode: 410,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify({ error: 'Ce service a été remplacé. Recharge la page.', code: 'gone' }),
});
