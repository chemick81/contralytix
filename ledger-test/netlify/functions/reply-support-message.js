// netlify/functions/reply-support-message.js
//
// Envoie la réponse d'un admin à un message de contact, par email via l'API
// transactionnelle Brevo. Appelée depuis Admin > Support > "Répondre" (voir
// openReplyMsgModal() dans index.html). Réponse en aller simple (pas de fil de
// discussion in-app) : l'email arrive directement dans la boîte de l'utilisateur,
// avec le message original en rappel.
//
// Variables d'environnement Netlify requises (mêmes que notify-support-message.js) :
//   BREVO_API_KEY       — clé API Brevo (Transactional > SMTP & API > API Keys)
//   NOTIFY_SENDER_EMAIL  — adresse d'expédition (expéditeur validé dans Brevo)
//
// Contrairement à notify-support-message.js (fire-and-forget, échoue en silence),
// cette fonction renvoie une vraie erreur au client : si l'email de réponse ne
// part pas, l'admin doit le savoir (le message ne doit pas être marqué "traité"
// à tort côté index.html).

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Méthode non autorisée' }) };
  }

  let toEmail, subject, originalMessage, reply;
  try {
    const body = JSON.parse(event.body || '{}');
    toEmail = typeof body.toEmail === 'string' ? body.toEmail : '';
    subject = typeof body.subject === 'string' ? body.subject : '';
    originalMessage = typeof body.originalMessage === 'string' ? body.originalMessage : '';
    reply = typeof body.reply === 'string' ? body.reply : '';
  } catch (err) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Corps de requête JSON invalide' }) };
  }

  if (!toEmail || !reply) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Champs "toEmail" et "reply" requis' }) };
  }

  const apiKey = process.env.BREVO_API_KEY;
  const senderEmail = process.env.NOTIFY_SENDER_EMAIL;

  if (!apiKey || !senderEmail) {
    console.warn('reply-support-message : BREVO_API_KEY ou NOTIFY_SENDER_EMAIL manquant(e) sur Netlify.');
    return { statusCode: 200, body: JSON.stringify({ sent: false, error: 'Envoi non configuré (BREVO_API_KEY / NOTIFY_SENDER_EMAIL manquant côté serveur).' }) };
  }

  const escapeHtml = (s) => String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  try {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'api-key': apiKey,
      },
      body: JSON.stringify({
        sender: { email: senderEmail, name: 'Contralytix' },
        to: [{ email: toEmail }],
        subject: `Re : ${subject || 'ton message'} — Contralytix`,
        htmlContent: `
          <p>Bonjour,</p>
          <p style="white-space:pre-wrap;">${escapeHtml(reply)}</p>
          ${originalMessage ? `<p style="color:#888;font-size:12px;margin-top:24px;">Ton message initial :<br/>« ${escapeHtml(originalMessage)} »</p>` : ''}
          <p>— L'équipe Contralytix</p>
        `,
      }),
    });

    if (!res.ok) {
      const bodyText = await res.text().catch(() => '');
      console.error('reply-support-message : échec Brevo', res.status, bodyText);
      return { statusCode: 200, body: JSON.stringify({ sent: false, error: `Brevo a refusé l'envoi (${res.status}).` }) };
    }

    return { statusCode: 200, body: JSON.stringify({ sent: true }) };
  } catch (err) {
    console.error('reply-support-message error:', err);
    return { statusCode: 200, body: JSON.stringify({ sent: false, error: err.message }) };
  }
};