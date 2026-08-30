// netlify/functions/bulk-sync-brevo-contacts.js
//
// Renvoie TOUS les utilisateurs Contralytix vers Brevo en un seul appel (import
// en masse), pour rattraper les comptes créés avant la mise en place de la
// synchro automatique (sync-brevo-contact.js), ou en cas de doute sur l'état de
// la liste Brevo. Appelée depuis Admin > Utilisateurs > "Resynchroniser avec
// Brevo" (bouton admin uniquement, voir bulkSyncBrevoContacts() dans index.html).
//
// Variables d'environnement Netlify requises : mêmes que sync-brevo-contact.js
// (BREVO_API_KEY, BREVO_LIST_ID).
//
// Utilise l'import Brevo (/v3/contacts/import), pensé pour de gros volumes en un
// seul appel plutôt qu'une boucle de créations individuelles. Le traitement est
// asynchrone côté Brevo (l'API renvoie un processId) : cette fonction confirme
// que Brevo a bien accepté la demande, pas que chaque contact est déjà visible
// dans la liste (généralement quelques secondes à quelques minutes selon le volume).

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Méthode non autorisée' }) };
  }

  let contacts;
  try {
    const body = JSON.parse(event.body || '{}');
    contacts = Array.isArray(body.contacts) ? body.contacts : [];
  } catch (err) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Corps de requête JSON invalide' }) };
  }

  contacts = contacts.filter(c => c && typeof c.email === 'string' && c.email.includes('@'));

  if (contacts.length === 0) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Aucun contact valide fourni' }) };
  }

  const apiKey = process.env.BREVO_API_KEY;
  const listId = process.env.BREVO_LIST_ID;

  if (!apiKey || !listId) {
    console.warn('bulk-sync-brevo-contacts : BREVO_API_KEY ou BREVO_LIST_ID manquant(e) sur Netlify.');
    return { statusCode: 200, body: JSON.stringify({ sent: false, error: 'Synchro Brevo non configurée (BREVO_API_KEY / BREVO_LIST_ID).' }) };
  }

  try {
    const res = await fetch('https://api.brevo.com/v3/contacts/import', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'api-key': apiKey,
      },
      body: JSON.stringify({
        listIds: [Number(listId)],
        updateExistingContacts: true,
        emptyContactsAttributes: false,
        jsonBody: contacts.map(c => ({ email: c.email, attributes: { ROLE: c.role || 'FREE' } })),
      }),
    });

    if (!res.ok) {
      const bodyText = await res.text().catch(() => '');
      console.error('bulk-sync-brevo-contacts : échec Brevo', res.status, bodyText);
      return { statusCode: 200, body: JSON.stringify({ sent: false, error: `Brevo a refusé l'import (${res.status}).` }) };
    }

    return { statusCode: 200, body: JSON.stringify({ sent: true, count: contacts.length }) };
  } catch (err) {
    console.error('bulk-sync-brevo-contacts error:', err);
    return { statusCode: 200, body: JSON.stringify({ sent: false, error: err.message }) };
  }
};