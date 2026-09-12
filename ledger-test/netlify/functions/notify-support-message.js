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
//
// Habillage visuel (logo + couleurs Contralytix) : voir brandedEmail() ci-dessous,
// même structure que template-email-contralytix.html (le template des campagnes
// Brevo) et que reply-support-message.js, pour que tous les emails envoyés par
// Contralytix se ressemblent. Si le style change un jour, le répercuter dans les
// deux fichiers (pas de fichier partagé entre fonctions Netlify indépendantes).

function brandedEmail({ title, bodyHtml, footerNote }) {
  return `<!DOCTYPE html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background-color:#F1F3F5;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#F1F3F5;">
<tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;background-color:#FFFFFF;border-radius:14px;overflow:hidden;font-family:Arial,Helvetica,sans-serif;">
<tr><td style="background-color:#0B0F14;padding:28px 32px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
<td width="44" valign="middle" style="padding-right:12px;"><img src="https://contralytix.fr/favicon.png" width="44" height="44" alt="Contralytix" style="border-radius:10px;display:block;"></td>
<td valign="middle"><span style="font-size:20px;font-weight:bold;color:#FFFFFF;">Contralytix</span><br><span style="font-size:11px;font-weight:bold;color:#E3B564;letter-spacing:1px;text-transform:uppercase;">Gestion PropFirm</span></td>
</tr></table>
</td></tr>
<tr><td style="background-color:#E3B564;height:3px;line-height:3px;font-size:0;">&nbsp;</td></tr>
<tr><td style="padding:32px;">
<div style="font-size:19px;font-weight:bold;color:#10151A;padding-bottom:14px;">${title}</div>
<div style="font-size:14px;line-height:1.65;color:#3C4551;">${bodyHtml}</div>
</td></tr>
<tr><td style="padding:0 32px;"><div style="border-top:1px solid #EDEFF1;font-size:0;line-height:0;">&nbsp;</div></td></tr>
<tr><td style="padding:20px 32px 28px;">
<div style="font-size:11px;line-height:1.6;color:#8B98A5;">${footerNote || 'Contralytix — Gestion PropFirm · <a href="https://contralytix.fr" style="color:#8B98A5;">contralytix.fr</a>'}</div>
</td></tr>
</table>
</td></tr>
</table>
</body></html>`;
}

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
      htmlContent: brandedEmail({
        title: 'Nouveau message de contact',
        bodyHtml: `
          <p style="margin:0 0 10px;"><b>De :</b> ${escapeHtml(userEmail)}</p>
          <p style="margin:0 0 10px;"><b>Sujet :</b> ${escapeHtml(subject || '—')}</p>
          <p style="margin:0 0 6px;"><b>Message :</b></p>
          <p style="margin:0;white-space:pre-wrap;background-color:#F7F8F9;border-radius:8px;padding:12px 14px;">${escapeHtml(message)}</p>
        `,
        footerNote: 'Réponds directement à cet email pour contacter l\'utilisateur, ou traite le message depuis Admin &gt; Support sur Contralytix.',
      }),
    });

    // 2. Accusé de réception à l'utilisateur
    const userRes = await sendEmail({
      sender: { email: senderEmail, name: 'Contralytix' },
      to: [{ email: userEmail }],
      subject: 'Contralytix — Ton message a bien été reçu',
      htmlContent: brandedEmail({
        title: 'Ton message a bien été reçu',
        bodyHtml: `
          <p style="margin:0 0 14px;">Bonjour,</p>
          <p style="margin:0 0 14px;">Ton message a bien été reçu, on te répond au plus vite.</p>
          <p style="margin:0;color:#8B98A5;font-size:13px;">Récapitulatif de ton message :<br/>« ${escapeHtml(message)} »</p>
        `,
      }),
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