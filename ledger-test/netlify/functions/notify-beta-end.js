// netlify/functions/notify-beta-end.js
//
// Email de fin de beta (01/10/2026, voir claude/fin-beta-conversion.md). Appelée depuis
// Admin > Utilisateurs > "Repasser Free" sur un compte BETA (voir endBetaForUser() dans
// index.html), APRÈS le passage en Free. Explique au bêta-testeur que ses données sont
// conservées et lui transmet le code promo éventuellement offert.
//
// Sécurité : contrairement à reply-support-message.js, l'email du destinataire n'est PAS pris
// dans le corps de la requête — il est relu en base (service_role) à partir du userId, et
// l'appelant doit être ADMIN (même vérification que admin-delete-user.js). Impossible donc
// d'utiliser cet endpoint pour envoyer un email arbitraire.
//
// Variables d'environnement Netlify requises : SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
// BREVO_API_KEY, NOTIFY_SENDER_EMAIL (toutes déjà utilisées par d'autres fonctions).
//
// Habillage : brandedEmail() copié de reply-support-message.js (pas de fichier partagé entre
// fonctions Netlify) — si le style change, le répercuter ici aussi.

const { createClient } = require('@supabase/supabase-js');

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

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

const escapeHtml = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Méthode non autorisée' }) };
  }

  // 1. L'appelant doit être un admin connecté.
  const authHeader = event.headers.authorization || event.headers.Authorization;
  if (!authHeader) return { statusCode: 401, body: JSON.stringify({ error: 'Non authentifié' }) };
  const token = authHeader.replace('Bearer ', '');
  const { data: callerData, error: callerErr } = await supabaseAdmin.auth.getUser(token);
  if (callerErr || !callerData?.user) return { statusCode: 401, body: JSON.stringify({ error: 'Session invalide' }) };
  const { data: callerProfile } = await supabaseAdmin.from('profiles').select('role').eq('id', callerData.user.id).maybeSingle();
  if (callerProfile?.role !== 'ADMIN') return { statusCode: 403, body: JSON.stringify({ error: 'Réservé aux administrateurs' }) };

  // 2. Cible : relue en base, doit être Free avec une fin de beta enregistrée.
  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (err) { return { statusCode: 400, body: JSON.stringify({ error: 'Corps de requête JSON invalide' }) }; }
  const { userId } = body;
  const promoCode = typeof body.promoCode === 'string' ? body.promoCode.slice(0, 40) : '';
  const offerLabel = typeof body.offerLabel === 'string' ? body.offerLabel.slice(0, 120) : '';
  if (!userId || typeof userId !== 'string') return { statusCode: 400, body: JSON.stringify({ error: 'userId requis' }) };

  const { data: target, error: targetErr } = await supabaseAdmin
    .from('profiles').select('email, role, beta_ended_at, display_name').eq('id', userId).maybeSingle();
  if (targetErr || !target) return { statusCode: 404, body: JSON.stringify({ error: 'Utilisateur introuvable' }) };
  if (!target.email) return { statusCode: 200, body: JSON.stringify({ sent: false, error: 'Aucun email sur ce profil.' }) };
  if (target.role !== 'FREE' || !target.beta_ended_at) {
    return { statusCode: 400, body: JSON.stringify({ error: "Cet utilisateur n'est pas en fin de beta." }) };
  }

  const apiKey = process.env.BREVO_API_KEY;
  const senderEmail = process.env.NOTIFY_SENDER_EMAIL;
  if (!apiKey || !senderEmail) {
    return { statusCode: 200, body: JSON.stringify({ sent: false, error: 'Envoi non configuré (BREVO_API_KEY / NOTIFY_SENDER_EMAIL manquant côté serveur).' }) };
  }

  const hello = target.display_name ? `Bonjour ${escapeHtml(target.display_name)},` : 'Bonjour,';
  const offerHtml = promoCode ? `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:22px 0 4px;border:1px dashed #E3B564;border-radius:10px;background:#FBF6EC;">
      <tr><td style="padding:18px 20px;">
        <div style="font-size:12px;font-weight:bold;color:#B9803C;letter-spacing:1px;text-transform:uppercase;padding-bottom:6px;">Offre bêta-testeur</div>
        <div style="font-size:14px;color:#10151A;padding-bottom:10px;">${escapeHtml(offerLabel || 'Une réduction sur ton abonnement Premium')}</div>
        <div style="font-family:Menlo,Consolas,monospace;font-size:20px;font-weight:bold;letter-spacing:2px;color:#10151A;">${escapeHtml(promoCode.toUpperCase())}</div>
        <div style="font-size:12px;color:#8B98A5;padding-top:6px;">Il est déjà pré-rempli sur ta page Abonnement.</div>
      </td></tr>
    </table>` : '';

  try {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'api-key': apiKey },
      body: JSON.stringify({
        sender: { email: senderEmail, name: 'Contralytix' },
        to: [{ email: target.email }],
        subject: 'Fin de la beta Contralytix — tes données sont conservées',
        htmlContent: brandedEmail({
          title: "Merci d'avoir testé Contralytix",
          bodyHtml: `
            <p style="margin:0 0 14px;">${hello}</p>
            <p style="margin:0 0 14px;">Ta période beta est terminée et ton compte repasse en formule <b>Free</b>. Tes retours ont directement façonné l'application : merci pour ton temps.</p>
            <p style="margin:0 0 14px;"><b>Rien n'est supprimé.</b> Tes traders, comptes et payouts restent consultables. Les modules Premium (Calendrier, Bilan visuel, Fiscalité, Frais généraux, exports) sont simplement en pause : tes données y réapparaissent telles quelles dès que tu passes Premium.</p>
            ${offerHtml}
            <table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0 0;"><tr><td style="border-radius:8px;background:#E3B564;">
              <a href="https://contralytix.fr" style="display:inline-block;padding:12px 22px;font-size:14px;font-weight:bold;color:#0B0F14;text-decoration:none;">Retrouver mon espace</a>
            </td></tr></table>
          `,
          footerNote: "Une question sur la suite ? Réponds simplement à cet email — L'équipe Contralytix",
        }),
      }),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      console.error('notify-beta-end : échec Brevo', res.status, t);
      return { statusCode: 200, body: JSON.stringify({ sent: false, error: `Brevo a refusé l'envoi (${res.status}).` }) };
    }
    return { statusCode: 200, body: JSON.stringify({ sent: true }) };
  } catch (err) {
    console.error('notify-beta-end error:', err);
    return { statusCode: 200, body: JSON.stringify({ sent: false, error: err.message }) };
  }
};