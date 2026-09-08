// netlify/functions/admin-ban-signup.js
//
// Appelée depuis Admin > Dashboard > "Dernières inscriptions" > bouton "Bannir"
// (voir banSpamSignup() dans index.html). Contrairement à la suppression de profil
// "classique" (deleteUserProfile(), limitée à la table 'profiles' via l'anon key),
// cette fonction utilise la service_role key pour :
//   1. Vérifier que l'appelant est bien un admin connecté (le anon key + RLS ne
//      protège pas cet endpoint HTTP — la vérification doit être refaite ici).
//   2. Supprimer réellement le compte dans Supabase Auth (auth.users), pas
//      seulement la ligne 'profiles'.
//   3. Ajouter le domaine e-mail à 'blocked_email_domains', pour que le hook
//      "Before User Created" rejette les futures inscriptions sur ce domaine
//      (voir migration_anti_spam_signup.sql et claude/anti-spam-inscriptions.md).
//
// Variables d'environnement Netlify requises : SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// (déjà utilisées par create-checkout-session.js / create-portal-session.js).

const { createClient } = require('@supabase/supabase-js');

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Méthode non autorisée' }) };
  }

  // 1. Authentification : le token du caller doit correspondre à un profil ADMIN.
  const authHeader = event.headers.authorization || event.headers.Authorization;
  if (!authHeader) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Non authentifié' }) };
  }
  const token = authHeader.replace('Bearer ', '');
  const { data: callerData, error: callerErr } = await supabaseAdmin.auth.getUser(token);
  if (callerErr || !callerData?.user) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Session invalide' }) };
  }
  const { data: callerProfile, error: profileErr } = await supabaseAdmin
    .from('profiles')
    .select('role')
    .eq('id', callerData.user.id)
    .maybeSingle();
  if (profileErr || callerProfile?.role !== 'ADMIN') {
    return { statusCode: 403, body: JSON.stringify({ error: 'Réservé aux administrateurs' }) };
  }

  // 2. Validation de la cible.
  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (err) { return { statusCode: 400, body: JSON.stringify({ error: 'Corps de requête JSON invalide' }) }; }

  const { userId, email } = body;
  if (!userId || typeof userId !== 'string') {
    return { statusCode: 400, body: JSON.stringify({ error: 'userId requis' }) };
  }
  if (userId === callerData.user.id) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Impossible de se bannir soi-même' }) };
  }

  const domain = typeof email === 'string' && email.includes('@')
    ? email.split('@')[1].trim().toLowerCase()
    : null;

  // 3. Bloquer le domaine pour l'avenir — avant la suppression, pour que le blocage tienne
  //    même si la suppression du compte échoue (ex: contrainte FK oubliée quelque part).
  if (domain) {
    const { error: blockErr } = await supabaseAdmin
      .from('blocked_email_domains')
      .upsert({ domain, reason: 'Banni depuis Admin > Dernières inscriptions', banned_by: callerData.user.id }, { onConflict: 'domain' });
    if (blockErr) {
      console.warn('admin-ban-signup : échec ajout blocked_email_domains :', blockErr.message);
      // On continue quand même — mieux vaut supprimer le compte spam sans bloquer le domaine
      // que de ne rien faire du tout.
    }
  }

  // 4. Supprimer le compte (auth.users → cascade vers 'profiles' si la FK est ON DELETE CASCADE,
  //    sinon on nettoie 'profiles' explicitement juste après par sécurité).
  const { error: deleteErr } = await supabaseAdmin.auth.admin.deleteUser(userId);
  if (deleteErr && deleteErr.message && !/not.?found/i.test(deleteErr.message)) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Échec de suppression du compte : ' + deleteErr.message, domain }) };
  }
  await supabaseAdmin.from('profiles').delete().eq('id', userId);

  return { statusCode: 200, body: JSON.stringify({ ok: true, domain }) };
};