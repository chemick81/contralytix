// netlify/functions/admin-delete-user.js
//
// Appelée depuis Admin > Utilisateurs > bouton "Supprimer" (voir deleteUserProfile() dans
// index.html). Avant, ce bouton supprimait uniquement la ligne 'profiles' directement depuis
// le front (anon key + RLS) — sans jamais toucher à un éventuel abonnement Stripe actif, qui
// continuait donc à être facturé au client même après suppression de son profil Contralytix.
//
// Cette fonction utilise la service_role key + la clé secrète Stripe pour :
//   1. Vérifier que l'appelant est bien un admin connecté (comme admin-ban-signup.js — le anon
//      key + RLS ne protège pas cet endpoint HTTP, la vérification doit être refaite ici).
//   2. Si l'utilisateur ciblé a un abonnement Stripe ACTIF et récurrent (Mensuel/Annuel — pas
//      Lifetime, qui est un paiement unique sans abonnement à résilier), l'annuler dans Stripe
//      AVANT de supprimer quoi que ce soit côté Contralytix, pour ne jamais laisser un client
//      continuer à être prélevé après suppression de son compte.
//   3. Supprimer la ligne 'profiles' (et la ligne 'subscriptions' associée, pour ne pas laisser
//      de ligne orpheline). Ne supprime PAS le compte Supabase Auth (auth.users) — comportement
//      inchangé par rapport à avant : l'utilisateur peut toujours se reconnecter en simple
//      utilisateur Free. Pour une suppression complète du compte de connexion, voir "Bannir"
//      (admin-ban-signup.js), qui a un objectif différent (anti-spam).
//
// Variables d'environnement Netlify requises : SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
// STRIPE_SECRET_KEY (déjà utilisées par les autres fonctions Stripe/admin).

const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
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

  const { userId } = body;
  if (!userId || typeof userId !== 'string') {
    return { statusCode: 400, body: JSON.stringify({ error: 'userId requis' }) };
  }
  if (userId === callerData.user.id) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Impossible de te supprimer toi-même' }) };
  }

  // 3. Abonnement Stripe actif ? On l'annule AVANT de supprimer le profil.
  let cancelledStripeSubscription = false;
  let stripeCancelError = null;
  const { data: sub } = await supabaseAdmin
    .from('subscriptions')
    .select('stripe_subscription_id, status, billing_cycle')
    .eq('user_id', userId)
    .maybeSingle();

  if (sub?.stripe_subscription_id && sub.status === 'ACTIVE' && sub.billing_cycle !== 'LIFETIME') {
    try {
      await stripe.subscriptions.cancel(sub.stripe_subscription_id);
      cancelledStripeSubscription = true;
    } catch (err) {
      // Déjà annulé/supprimé côté Stripe, ou erreur API : on log mais on NE bloque PAS la
      // suppression du profil pour autant — mieux vaut informer l'admin (stripeCancelError
      // renvoyé dans la réponse) que de le laisser bloqué sans pouvoir supprimer le compte.
      console.warn('admin-delete-user : échec annulation abonnement Stripe :', err.message);
      stripeCancelError = err.message;
    }
  }

  // 4. Suppression du profil + de la ligne subscriptions associée (comportement inchangé :
  //    le compte Supabase Auth n'est PAS supprimé, l'utilisateur peut se reconnecter en Free).
  const { data: deletedProfile, error: deleteErr } = await supabaseAdmin
    .from('profiles')
    .delete()
    .eq('id', userId)
    .select();
  if (deleteErr) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Échec de suppression du profil : ' + deleteErr.message, cancelledStripeSubscription, stripeCancelError }) };
  }
  if (!deletedProfile || deletedProfile.length === 0) {
    return { statusCode: 500, body: JSON.stringify({ error: "Aucune ligne supprimée (profil déjà absent ?)", cancelledStripeSubscription, stripeCancelError }) };
  }
  await supabaseAdmin.from('subscriptions').delete().eq('user_id', userId);

  return { statusCode: 200, body: JSON.stringify({ ok: true, cancelledStripeSubscription, stripeCancelError }) };
};