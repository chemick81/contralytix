// netlify/functions/start-trial.js
//
// Essai Premium d'un mois (25/11/2026, décision de Mickael) : sans carte bancaire, activé par
// l'utilisateur quand il veut, une seule fois par personne.
// POST /api/start-trial (Authorization: Bearer <jeton Supabase de l'utilisateur>)
// → { ok, trialEndsAt } ou { error, code }
// Conditions : rôle FREE (pas Premium, Beta, Admin), aucun essai déjà commencé sur ce profil, et
// aucune empreinte de son e-mail dans trial_claims (compte supprimé puis recréé).
// Écrit trial_started_at / trial_ends_at avec la clé service_role (le trigger protect_profile_role
// interdit à l'utilisateur de le faire lui-même). Voir migration_essai_premium_20261125.sql.

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const TRIAL_DAYS = 30;
const json = (statusCode, body) => ({ statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Méthode non autorisée' });
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return json(500, { error: 'Configuration serveur manquante' });
  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const h = event.headers || {};
  const auth = h.authorization || h.Authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token) return json(401, { error: 'Connexion requise' });
  const { data: u, error: uErr } = await db.auth.getUser(token);
  if (uErr || !u || !u.user) return json(401, { error: 'Session expirée, reconnecte-toi' });
  const user = u.user;

  const { data: prof, error: pErr } = await db.from('profiles').select('role, trial_started_at, trial_ends_at').eq('id', user.id).maybeSingle();
  if (pErr) return json(500, { error: 'Essai indisponible pour le moment', code: 'not_ready' });
  if (!prof) return json(404, { error: 'Profil introuvable' });
  if ((prof.role || 'FREE') !== 'FREE') return json(409, { error: 'Ton compte a déjà accès à Premium.', code: 'already_premium' });
  if (prof.trial_started_at) return json(409, { error: 'Tu as déjà profité de ton mois d’essai.', code: 'already_used', trialEndsAt: prof.trial_ends_at });

  const email = String(user.email || '').trim().toLowerCase();
  const emailHash = email ? crypto.createHash('sha256').update(email).digest('hex') : null;
  if (emailHash) {
    // L'insertion échoue si l'empreinte existe déjà (clé primaire) : un seul essai par e-mail.
    const { error: cErr } = await db.from('trial_claims').insert({ email_hash: emailHash });
    if (cErr) {
      if (cErr.code === '23505') return json(409, { error: 'Un essai a déjà été utilisé avec cette adresse e-mail.', code: 'already_used' });
      return json(500, { error: 'Essai indisponible pour le moment', code: 'not_ready' });
    }
  }
  const now = new Date();
  const ends = new Date(now.getTime() + TRIAL_DAYS * 86400000);
  const { error: wErr } = await db.from('profiles').update({ trial_started_at: now.toISOString(), trial_ends_at: ends.toISOString() }).eq('id', user.id).is('trial_started_at', null);
  if (wErr) {
    if (emailHash) await db.from('trial_claims').delete().eq('email_hash', emailHash);
    return json(500, { error: 'Activation impossible, réessaie dans un instant' });
  }
  console.log(`start-trial: essai activé pour ${user.id} jusqu'au ${ends.toISOString()}`);
  return json(200, { ok: true, trialStartedAt: now.toISOString(), trialEndsAt: ends.toISOString() });
};
