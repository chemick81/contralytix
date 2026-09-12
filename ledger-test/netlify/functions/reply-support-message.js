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
//
// Habillage visuel (logo + couleurs Contralytix) : voir brandedEmail() ci-dessous,
// même structure que template-email-contralytix.html (le template des campagnes
// Brevo) et que notify-support-message.js, pour que tous les emails envoyés par
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
        htmlContent: brandedEmail({
          title: 'Réponse à ton message',
          bodyHtml: `
            <p style="margin:0 0 14px;">Bonjour,</p>
            <p style="margin:0 0 20px;white-space:pre-wrap;">${escapeHtml(reply)}</p>
            ${originalMessage ? `<p style="margin:0;color:#8B98A5;font-size:13px;">Ton message initial :<br/>« ${escapeHtml(originalMessage)} »</p>` : ''}
          `,
          footerNote: 'Réponds directement à cet email si tu as une autre question — L\'équipe Contralytix',
        }),
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