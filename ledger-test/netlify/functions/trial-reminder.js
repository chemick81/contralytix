// netlify/functions/trial-reminder.js
//
// Fonction planifiée (voir netlify.toml), chaque jour : e-mail aux utilisateurs dont l'essai
// Premium se termine dans 3 jours (J-3) ou s'est terminé hier (fin d'essai). Une seule exécution
// par jour, donc un seul e-mail par étape, sans marqueur en base. Rôle FREE seulement (un abonné
// pendant l'essai ne reçoit rien). Envoi par Brevo, comme le résumé hebdo.
// Variables : SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, BREVO_API_KEY, NOTIFY_SENDER_EMAIL,
// NOTIFY_ADMIN_EMAIL (optionnelle), APP_URL (optionnelle).

const { createClient } = require('@supabase/supabase-js');

function parisISO(d) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
  const g = (t) => p.find(x => x.type === t).value;
  return `${g('year')}-${g('month')}-${g('day')}`;
}
const dayDiff = (a, b) => Math.round((Date.parse(a + 'T00:00:00Z') - Date.parse(b + 'T00:00:00Z')) / 86400000);
const fmt = (s) => `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}`;
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function mailHtml({ name, kind, endDay, appUrl }) {
  const soon = kind === 'soon';
  return `<!doctype html><html lang="fr"><body style="margin:0;background:#0B0F14;font-family:Inter,Arial,sans-serif;color:#E8EDF2;">
  <div style="max-width:560px;margin:0 auto;padding:28px 20px;">
    <div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#3ED6B5;font-weight:700;">Contralytix · essai Premium</div>
    <h1 style="font-size:21px;margin:8px 0 10px;">${name ? esc(name) + ', ' : ''}${soon ? `ton essai Premium se termine le ${fmt(endDay)}` : 'ton essai Premium est terminé'}</h1>
    <p style="color:#8B98A5;font-size:14px;line-height:1.6;margin:0 0 14px;">${soon
      ? 'Plus que 3 jours pour profiter de tout Contralytix : Prochain payout sur tous tes comptes, trading plan, imports Tradovate et R|Trader, alertes, exports et fiscalité.'
      : 'Ton compte est repassé en Free. Tes comptes et tes données sont conservés. Le Prochain payout reste disponible sur un compte ; les imports de relevés, les alertes et le trading plan sont en pause.'}</p>
    <p style="color:#8B98A5;font-size:14px;line-height:1.6;margin:0 0 18px;">Premium : 9,90 €/mois, 90 €/an ou 199 € à vie. Sans engagement.</p>
    <a href="${appUrl}/#subscription" style="display:inline-block;background:#3ED6B5;color:#0B0F14;text-decoration:none;font-weight:700;padding:11px 18px;border-radius:9px;font-size:14px;">${soon ? 'Garder Premium' : 'Passer à Premium'}</a>
    <p style="color:#5B6673;font-size:12px;line-height:1.5;margin-top:22px;">Tu reçois cet e-mail car tu as activé l'essai Premium d'un mois sur Contralytix.</p>
  </div></body></html>`;
}

exports.handler = async () => {
  try {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return { statusCode: 200, body: JSON.stringify({ skipped: 'missing supabase config' }) };
    const apiKey = process.env.BREVO_API_KEY, senderEmail = process.env.NOTIFY_SENDER_EMAIL, replyToEmail = process.env.NOTIFY_ADMIN_EMAIL;
    if (!apiKey || !senderEmail) return { statusCode: 200, body: JSON.stringify({ skipped: 'missing brevo config' }) };
    const appUrl = (process.env.APP_URL || 'https://contralytix.fr').replace(/\/+$/, '');
    const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const now = new Date(), today = parisISO(now);
    const from = new Date(now.getTime() - 2 * 86400000).toISOString(), to = new Date(now.getTime() + 5 * 86400000).toISOString();
    const { data, error } = await db.from('profiles').select('id, display_name, role, trial_ends_at').eq('role', 'FREE').gte('trial_ends_at', from).lte('trial_ends_at', to);
    if (error) throw error;
    let sent = 0;
    for (const p of data || []) {
      const endDay = parisISO(new Date(p.trial_ends_at));
      const d = dayDiff(endDay, today);
      const kind = d === 3 ? 'soon' : d === -1 ? 'ended' : null;
      if (!kind) continue;
      const { data: u } = await db.auth.admin.getUserById(p.id);
      if (!u || !u.user || !u.user.email) continue;
      const res = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'api-key': apiKey },
        body: JSON.stringify({
          sender: { email: senderEmail, name: 'Contralytix' },
          ...(replyToEmail ? { replyTo: { email: replyToEmail, name: 'Support Contralytix' } } : {}),
          to: [{ email: u.user.email }],
          subject: kind === 'soon' ? 'Ton essai Premium se termine dans 3 jours' : 'Ton essai Premium est terminé',
          htmlContent: mailHtml({ name: (p.display_name || '').trim(), kind, endDay, appUrl }),
        }),
      });
      if (res.ok) sent++; else console.error('trial-reminder: échec Brevo', p.id, res.status);
    }
    console.log(`trial-reminder ${today}: ${sent} e-mail(s).`);
    return { statusCode: 200, body: JSON.stringify({ sent, today }) };
  } catch (err) {
    console.error('trial-reminder error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
