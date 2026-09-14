// netlify/functions/request-account-deletion.js
//
// Étape 1 de la suppression de compte en libre-service (page Profil > Zone de danger) : génère
// un code à 6 chiffres, le stocke (table account_deletion_requests, migration_profil_parametres.sql)
// et l'envoie par email via Brevo (même pattern que notify-support-message.js) à l'adresse réelle
// du compte connecté — jamais à une adresse fournie par le client, pour éviter qu'un tiers avec un
// token volé se fasse envoyer le code ailleurs.
// La suppression réelle se fait ensuite dans delete-account.js, qui revérifie ce code côté serveur.
//
// Variables d'environnement Netlify requises (déjà utilisées par les autres fonctions) :
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, BREVO_API_KEY, NOTIFY_SENDER_EMAIL
//
// ⚠️ Non testé contre une vraie base Supabase / API Brevo dans cet environnement — à tester avec
// `netlify dev` sur un compte de test avant tout déploiement.

const { createClient } = require('@supabase/supabase-js');

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const CODE_TTL_MINUTES = 10;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Méthode non autorisée' }) };
  }

  try {
    const authHeader = event.headers.authorization || event.headers.Authorization;
    if (!authHeader) {
      return { statusCode: 401, body: JSON.stringify({ error: 'Non authentifié' }) };
    }
    const token = authHeader.replace('Bearer ', '');
    const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
    if (userErr || !userData?.user) {
      return { statusCode: 401, body: JSON.stringify({ error: 'Session invalide' }) };
    }
    const uid = userData.user.id;
    const email = userData.user.email;
    if (!email) {
      return { statusCode: 400, body: JSON.stringify({ error: "Aucune adresse email associée à ce compte." }) };
    }

    const code = String(Math.floor(100000 + Math.random() * 900000));
    const expiresAt = new Date(Date.now() + CODE_TTL_MINUTES * 60 * 1000).toISOString();

    const { error: upsertErr } = await supabaseAdmin
      .from('account_deletion_requests')
      .upsert({ user_id: uid, code, requested_at: new Date().toISOString(), expires_at: expiresAt }, { onConflict: 'user_id' });
    if (upsertErr) {
      console.error('request-account-deletion: upsert échoué', upsertErr.message);
      return { statusCode: 500, body: JSON.stringify({ error: "Impossible de préparer la demande de suppression." }) };
    }

    const apiKey = process.env.BREVO_API_KEY;
    const senderEmail = process.env.NOTIFY_SENDER_EMAIL;
    if (!apiKey || !senderEmail) {
      console.warn('request-account-deletion : BREVO_API_KEY ou NOTIFY_SENDER_EMAIL manquant — email non envoyé.');
      return { statusCode: 200, body: JSON.stringify({ sent: false, reason: "Envoi d'email non configuré" }) };
    }

    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'api-key': apiKey },
      body: JSON.stringify({
        sender: { email: senderEmail, name: 'Contralytix' },
        to: [{ email }],
        subject: 'Contralytix — Code de confirmation de suppression de compte',
        htmlContent: `
          <p>Bonjour,</p>
          <p>Voici ton code pour confirmer la <b>suppression définitive</b> de ton compte Contralytix :</p>
          <p style="font-size:28px;font-weight:700;letter-spacing:4px;">${code}</p>
          <p>Ce code est valable ${CODE_TTL_MINUTES} minutes. Si tu n'es pas à l'origine de cette demande, ignore cet email — ton compte ne sera pas supprimé sans ce code.</p>
          <p>— L'équipe Contralytix</p>
        `,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error('request-account-deletion: échec Brevo', res.status, body);
      return { statusCode: 200, body: JSON.stringify({ sent: false }) };
    }

    return { statusCode: 200, body: JSON.stringify({ sent: true }) };
  } catch (err) {
    console.error('request-account-deletion error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Erreur serveur.' }) };
  }
};
