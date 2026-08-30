// netlify/functions/sync-brevo-contact.js
//
// Crée ou met à jour UN contact dans Brevo (email + attribut ROLE), pour tenir
// la liste de contacts Brevo à jour sans jamais stocker de contenu d'email côté
// Contralytix. Le contenu et l'envoi des campagnes restent gérés directement
// dans l'interface Brevo (Contacts > Listes > "Contralytix" — filtrable par
// l'attribut ROLE pour cibler Free/Premium/Admin).
//
// Appelée en fire-and-forget par index.html (syncBrevoContact()) :
//   - à chaque connexion (nouvelle inscription incluse),
//   - à chaque changement de plan par un admin (setUserPlan()).
//
// Variables d'environnement Netlify requises :
//   BREVO_API_KEY  — même clé que les autres fonctions Brevo du projet
//   BREVO_LIST_ID  — identifiant numérique de la liste Brevo "Contralytix"
//                    (Brevo > Contacts > Listes > ouvrir la liste > l'ID est
//                    dans l'URL, ex. .../list/12 → BREVO_LIST_ID=12)
//
// Ne bloque jamais l'utilisateur : toujours 200, avec { synced: true|false }.

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Méthode non autorisée' }) };
  }

  let email, role;
  try {
    const body = JSON.parse(event.body || '{}');
    email = typeof body.email === 'string' ? body.email : '';
    role = typeof body.role === 'string' ? body.role : 'FREE';
  } catch (err) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Corps de requête JSON invalide' }) };
  }

  if (!email) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Champ "email" requis' }) };
  }

  const apiKey = process.env.BREVO_API_KEY;
  const listId = process.env.BREVO_LIST_ID;

  if (!apiKey || !listId) {
    console.warn('sync-brevo-contact : BREVO_API_KEY ou BREVO_LIST_ID manquant(e) sur Netlify — synchro ignorée.');
    return { statusCode: 200, body: JSON.stringify({ synced: false, reason: 'Synchro Brevo non configurée (BREVO_API_KEY / BREVO_LIST_ID).' }) };
  }

  try {
    const res = await fetch('https://api.brevo.com/v3/contacts', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'api-key': apiKey,
      },
      body: JSON.stringify({
        email,
        attributes: { ROLE: role },
        listIds: [Number(listId)],
        updateEnabled: true, // crée le contact s'il n'existe pas, le met à jour sinon
      }),
    });

    // Brevo répond 201 (créé) ou 204 (mis à jour, corps vide) — les deux sont un succès.
    if (!res.ok) {
      const bodyText = await res.text().catch(() => '');
      console.error('sync-brevo-contact : échec Brevo', res.status, bodyText);
      return { statusCode: 200, body: JSON.stringify({ synced: false, error: `Brevo a refusé la synchro (${res.status}).` }) };
    }

    return { statusCode: 200, body: JSON.stringify({ synced: true }) };
  } catch (err) {
    console.error('sync-brevo-contact error:', err);
    return { statusCode: 200, body: JSON.stringify({ synced: false, error: err.message }) };
  }
};