// netlify/functions/delete-account.js
//
// Suppression de compte en libre-service (RGPD, page Profil > Zone de danger) — étape 2 : exige
// le code à 6 chiffres envoyé par request-account-deletion.js (POST { code }), revérifié ici côté
// serveur (jamais fait confiance au fait que le front ait "l'air" d'avoir validé le code).
// La suppression réelle d'un utilisateur Supabase Auth (auth.admin.deleteUser) n'est possible
// que côté serveur, avec la clé service_role — jamais depuis le client, d'où cette fonction.
//
// Anti-brute-force : 5 tentatives max sur le code (1 million de combinaisons à 6 chiffres serait
// sinon trinquable en quelques minutes par un script, pour qui détient déjà un token de session
// valide). Au-delà, la demande est invalidée — il faut recommencer depuis la page Profil (un
// nouveau code est envoyé, reçu uniquement sur l'email réel du compte).
//
// Ordre de suppression : mêmes tables et même ordre que RESET_TABLE_ORDER côté client
// (index.html), filtrées sur created_by = l'utilisateur courant plutôt que "tout le monde"
// (voir resetAllData(), réservé aux admins). Parent -> enfants d'abord (payout_receipts avant
// payouts, etc.) pour respecter les contraintes de clé étrangère. Inclut aussi : annulation de
// l'abonnement Stripe actif s'il y en a un (sans quoi l'utilisateur continuerait à être facturé
// après suppression de son compte — RGPD à part, ce serait juste un bug grave), suppression de la
// ligne "subscriptions", et suppression du contact Brevo (sinon l'email reste dans la liste
// marketing indéfiniment après "suppression complète" du compte).
//
// Volontairement NON supprimés (choix à assumer/ajuster si besoin) :
//   - support_messages : correspondance du formulaire de contact, gardée côté admin comme les
//     autres échanges support.
//   - activity_log : journal d'audit, pratique RGPD courante de le conserver (éventuellement
//     anonymisé) plutôt que de l'effacer avec le compte. ⚠️ Ce choix suppose une politique de
//     rétention/anonymisation documentée (il stocke actorEmail en clair) — à formaliser, pas
//     seulement "assumé" en commentaire (voir l'audit sécurité/RGPD livré séparément).
//   - propfirms : catalogue partagé réservé aux admins, un utilisateur normal n'en possède pas.
//
// Variables d'environnement Netlify requises :
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (déjà utilisées par les autres fonctions)
//   STRIPE_SECRET_KEY (déjà utilisée par create-checkout-session.js / stripe-webhook.js)
//   BREVO_API_KEY (déjà utilisée par les autres fonctions Brevo) — optionnelle : si absente, la
//   suppression du compte continue quand même (best-effort), juste sans nettoyer Brevo.
//
// ⚠️ Non testé contre une vraie base Supabase / Stripe / Brevo dans cet environnement (pas d'accès
// réseau/creds ici) — à tester avec `netlify dev` sur un compte de test AVANT tout déploiement en
// prod, et à vérifier une fois sur dev avant de rejouer sur prod (même précaution que les autres
// migrations du projet).

const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

const stripe = process.env.STRIPE_SECRET_KEY ? Stripe(process.env.STRIPE_SECRET_KEY) : null;
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const MAX_CODE_ATTEMPTS = 5;

// Même ordre que RESET_TABLE_ORDER dans index.html (enfants avant parents).
const OWNED_DELETE_ORDER = [
  'expense_receipts',   // 26/09/2026 — justificatifs de dépenses (migration_ecole_justificatifs_20260926.sql)
  'payout_receipts',
  'account_resets',     // 26/09/2026 — manquait (module Resets), sinon lignes orphelines après suppression
  'general_expenses',   // 26/09/2026 — manquait (module Frais généraux)
  'payouts',
  'account_notes',
  'propfirm_ratings',
  'market_prep',
  'yt_sessions',
  'accounts',
  'traders',
];

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

    // 0. Vérification du code de confirmation (étape 1 : request-account-deletion.js).
    let body = {};
    try { body = JSON.parse(event.body || '{}'); } catch (e) {}
    const code = typeof body.code === 'string' ? body.code.trim() : '';
    if (!code) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Code de confirmation manquant.' }) };
    }
    const { data: reqRow, error: reqErr } = await supabaseAdmin
      .from('account_deletion_requests')
      .select('code, expires_at, attempts')
      .eq('user_id', uid)
      .maybeSingle();
    if (reqErr || !reqRow) {
      return { statusCode: 400, body: JSON.stringify({ error: "Aucune demande de suppression en cours. Recommence depuis la page Profil." }) };
    }
    if (new Date(reqRow.expires_at).getTime() < Date.now()) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Ce code a expiré. Recommence depuis la page Profil.' }) };
    }
    if ((reqRow.attempts || 0) >= MAX_CODE_ATTEMPTS) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Trop de tentatives. Recommence une nouvelle demande depuis la page Profil.' }) };
    }
    if (reqRow.code !== code) {
      // Incrémente le compteur d'essais AVANT de répondre, pour que le verrou tienne même si
      // l'appelant abandonne après une erreur réseau côté client.
      await supabaseAdmin
        .from('account_deletion_requests')
        .update({ attempts: (reqRow.attempts || 0) + 1 })
        .eq('user_id', uid);
      const remaining = MAX_CODE_ATTEMPTS - (reqRow.attempts || 0) - 1;
      return { statusCode: 400, body: JSON.stringify({ error: remaining > 0 ? `Code incorrect (${remaining} essai${remaining>1?'s':''} restant${remaining>1?'s':''}).` : 'Code incorrect. Recommence une nouvelle demande depuis la page Profil.' }) };
    }

    // 1. Abonnement Stripe actif : on l'annule avant d'effacer quoi que ce soit, pour ne jamais
    //    laisser un client continuer à être facturé après suppression de son compte.
    const { data: subRow } = await supabaseAdmin
      .from('subscriptions')
      .select('stripe_subscription_id')
      .eq('user_id', uid)
      .maybeSingle();
    if (subRow && subRow.stripe_subscription_id && stripe) {
      try {
        await stripe.subscriptions.cancel(subRow.stripe_subscription_id);
      } catch (stripeErr) {
        // Si l'abonnement est déjà annulé/inexistant côté Stripe, on continue quand même la
        // suppression du compte — ne bloque jamais l'utilisateur sur ce point.
        console.warn('delete-account: échec annulation Stripe (peut-être déjà annulé)', stripeErr.message);
      }
    }
    const { error: subDelErr } = await supabaseAdmin.from('subscriptions').delete().eq('user_id', uid);
    if (subDelErr) console.warn('delete-account: échec suppression subscriptions', subDelErr.message);

    // 2. Justificatifs de payout dans le stockage (bucket 'fiscal-receipts'), avant de
    //    supprimer les lignes payout_receipts qui référencent leur chemin.
    const { data: receipts } = await supabaseAdmin
      .from('payout_receipts')
      .select('path')
      .eq('created_by', uid);
    // + justificatifs de DÉPENSES (même bucket, sous <uid>/expenses/...) — table absente tant que
    //   la migration du 26/09/2026 n'est pas passée : l'erreur éventuelle est simplement ignorée.
    const { data: expReceipts } = await supabaseAdmin
      .from('expense_receipts')
      .select('path')
      .eq('created_by', uid);
    const paths = [...(receipts || []), ...(expReceipts || [])].map(r => r.path).filter(Boolean);
    if (paths.length) {
      const { error: storageErr } = await supabaseAdmin.storage.from('fiscal-receipts').remove(paths);
      if (storageErr) console.warn('delete-account: échec suppression stockage', storageErr.message);
    }

    // 3. Lignes des tables "possédées" par l'utilisateur.
    for (const table of OWNED_DELETE_ORDER) {
      const { error } = await supabaseAdmin.from(table).delete().eq('created_by', uid);
      if (error) console.warn(`delete-account: échec suppression ${table}`, error.message);
    }

    // 4. Réglages déclaratifs fiscaux (checklist par année).
    const { error: fiscalErr } = await supabaseAdmin.from('fiscal_checklist_items').delete().eq('user_id', uid);
    if (fiscalErr) console.warn('delete-account: échec suppression fiscal_checklist_items', fiscalErr.message);

    // 5. Contact Brevo (liste marketing "Contralytix", voir sync-brevo-contact.js) — sans ça,
    //    l'email reste indéfiniment dans la liste marketing après "suppression complète" du
    //    compte. Best-effort : n'empêche jamais la suppression du compte si Brevo échoue/n'est
    //    pas configuré.
    if (email && process.env.BREVO_API_KEY) {
      try {
        const brevoRes = await fetch(`https://api.brevo.com/v3/contacts/${encodeURIComponent(email)}`, {
          method: 'DELETE',
          headers: { 'Accept': 'application/json', 'api-key': process.env.BREVO_API_KEY },
        });
        if (!brevoRes.ok && brevoRes.status !== 404) {
          const t = await brevoRes.text().catch(() => '');
          console.warn('delete-account: échec suppression contact Brevo', brevoRes.status, t);
        }
      } catch (brevoErr) {
        console.warn('delete-account: erreur appel Brevo', brevoErr.message);
      }
    }

    // 6. Ligne "profiles".
    const { error: profileErr } = await supabaseAdmin.from('profiles').delete().eq('id', uid);
    if (profileErr) console.warn('delete-account: échec suppression profiles', profileErr.message);

    // 7. Le compte Auth lui-même — en dernier, une fois toutes les données liées effacées.
    const { error: authDelErr } = await supabaseAdmin.auth.admin.deleteUser(uid);
    if (authDelErr) {
      console.error('delete-account: échec suppression du compte Auth', authDelErr.message);
      return { statusCode: 500, body: JSON.stringify({ error: "Les données ont été effacées mais la suppression du compte de connexion a échoué. Contacte le support." }) };
    }

    return { statusCode: 200, body: JSON.stringify({ deleted: true }) };
  } catch (err) {
    console.error('delete-account error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Erreur serveur lors de la suppression du compte.' }) };
  }
};
