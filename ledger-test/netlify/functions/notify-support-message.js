// netlify/functions/notify-support-message.js
//
// Envoie deux e-mails via l'API transactionnelle Brevo lorsqu'un utilisateur
// soumet le formulaire de contact de Contralytix :
//   1. Une notification à l'administrateur (toi), avec le contenu du message.
//   2. Un accusé de réception à l'utilisateur, pour le rassurer.
//
// Variables d'environnement Netlify requises (Site configuration > Environment variables) :
//   BREVO_API_KEY       — clé API Brevo (Transactional > SMTP & API > API Keys)
//   NOTIFY_ADMIN_EMAIL   — ton adresse e-mail, qui reçoit la notification
//   NOTIFY_SENDER_EMAIL  — adresse d'expédition (doit être un expéditeur validé dans Brevo,
//                          ex. contact@contralytix.fr ou l'adresse Brevo par défaut)
//
// Cette fonction échoue silencieusement côté utilisateur (elle est appelée en
// "fire and forget" depuis index.html) : le message est déjà enregistré dans
// Supabase avant l'appel, donc un échec d'e-mail ne fait jamais perdre le message.

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Méthode non autorisée' }) };
  }

  let subject, message, userEmail;
  try {
    const body = JSON.parse(event.body || '{}');
    subject = typeof body.subject === 'string' ? body.subject : '';
    message = typeof body.message === 'string' ? body.message : '';
    userEmail = typeof body.userEmail === 'string' ? body.userEmail : '';
  } catch (err) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Corps de requête JSON invalide' }) };
  }

  if (!message || !userEmail) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Champs "message" et "userEmail" requis' }) };
  }

  const apiKey = process.env.BREVO_API_KEY;
  const adminEmail = process.env.NOTIFY_ADMIN_EMAIL;
  const senderEmail = process.env.NOTIFY_SENDER_EMAIL;

  if (!apiKey || !adminEmail || !senderEmail) {
    console.warn('notify-support-message : BREVO_API_KEY, NOTIFY_ADMIN_EMAIL ou NOTIFY_SENDER_EMAIL manquant(e) sur Netlify — notification ignorée.');
    return { statusCode: 200, body: JSON.stringify({ sent: false, reason: 'Notification non configurée' }) };
  }

  const escapeHtml = (s) => String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const sendEmail = (payload) => fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'api-key': apiKey,
    },
    body: JSON.stringify(payload),
  });

  try {
    // 1. Notification à l'admin
    const adminRes = await sendEmail({
      sender: { email: senderEmail, name: 'Contralytix' },
      to: [{ email: adminEmail }],
      replyTo: { email: userEmail },
      subject: `[Contralytix] Nouveau message : ${subject || 'Contact'}`,
      htmlContent: `
        <p><b>De :</b> ${escapeHtml(userEmail)}</p>
        <p><b>Sujet :</b> ${escapeHtml(subject || '—')}</p>
        <p><b>Message :</b></p>
        <p style="white-space:pre-wrap;">${escapeHtml(message)}</p>
        <p style="color:#888;font-size:12px;">Réponds directement à cet e-mail pour contacter l'utilisateur, ou traite le message depuis l'espace Admin de Contralytix.</p>
      `,
    });

    // 2. Accusé de réception à l'utilisateur
    const userRes = await sendEmail({
      sender: { email: senderEmail, name: 'Contralytix' },
      to: [{ email: userEmail }],
      subject: 'Contralytix — Ton message a bien été reçu',
      htmlContent: `
        <p>Bonjour,</p>
        <p>Ton message a bien été reçu, on te répond au plus vite.</p>
        <p style="color:#888;font-size:13px;">Récapitulatif de ton message :<br/>« ${escapeHtml(message)} »</p>
        <p>— L'équipe Contralytix</p>
      `,
    });

    const ok = adminRes.ok && userRes.ok;
    if (!ok) {
      const adminBody = await adminRes.text().catch(() => '');
      const userBody = await userRes.text().catch(() => '');
      console.error('notify-support-message : échec Brevo', adminRes.status, adminBody, userRes.status, userBody);
    }

    return { statusCode: 200, body: JSON.stringify({ sent: ok }) };
  } catch (err) {
    console.error('notify-support-message error:', err);
    // On répond quand même 200 : côté client, l'échec d'e-mail ne doit jamais
    // faire croire à l'utilisateur que son message n'a pas été enregistré.
    return { statusCode: 200, body: JSON.stringify({ sent: false, error: err.message }) };
  }
};
