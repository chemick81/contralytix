// netlify/functions/stripe-webhook.js
//
// Point d'entrée unique appelé par Stripe. Met à jour Supabase automatiquement.
// Aucune intervention manuelle après déploiement : ce fichier fait tout le travail.
//
// IMPORTANT (Netlify) : ce endpoint doit recevoir le body BRUT (non parsé) pour
// que la vérification de signature Stripe fonctionne. Netlify Functions fournit
// event.body déjà en string ; on n'utilise jamais bodyParser/JSON.parse dessus
// avant stripe.webhooks.constructEvent.

const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function upsertSubscription({ userId, plan, status, billingCycle, stripeCustomerId, stripeSubscriptionId, expiresAt }) {
  const payload = {
    user_id: userId,
    plan,
    status,
    billing_cycle: billingCycle,
    stripe_customer_id: stripeCustomerId,
    stripe_subscription_id: stripeSubscriptionId || null,
    expires_at: expiresAt || null,
  };
  const { error } = await supabaseAdmin
    .from('subscriptions')
    .upsert(payload, { onConflict: 'user_id' });
  if (error) throw error;

  // Le rôle profiles reste synchro avec le plan (sauf ADMIN, jamais touché)
  const newRole = plan === 'PREMIUM' && status === 'ACTIVE' ? 'PREMIUM' : 'FREE';

  const { data: profile } = await supabaseAdmin
    .from('profiles')
    .select('role')
    .eq('id', userId)
    .maybeSingle();

  if (profile) {
    if (profile.role !== 'ADMIN') {
      await supabaseAdmin
        .from('profiles')
        .update({ role: newRole })
        .eq('id', userId);
    }
  } else {
    // Aucune ligne profiles pour cet utilisateur (ex: trigger de création de profil
    // qui a échoué ou compte créé avant sa mise en place). On la crée ici pour ne
    // pas laisser l'utilisateur bloqué en FREE alors qu'il a payé.
    console.warn(`Aucun profile trouvé pour user_id=${userId}, création à la volée.`);
    const { data: authUser } = await supabaseAdmin.auth.admin.getUserById(userId);
    const { error: insertErr } = await supabaseAdmin
      .from('profiles')
      .insert({
        id: userId,
        email: authUser?.user?.email || null,
        role: newRole,
      });
    if (insertErr) {
      console.error('Échec création profile de secours:', insertErr);
    }
  }
}

// Depuis les versions récentes de l'API Stripe (facturation flexible),
// `current_period_end` n'existe plus forcément à la racine de l'objet Subscription :
// il faut aller le chercher dans le premier item de l'abonnement.
// Ce helper gère les deux cas pour ne jamais planter sur une date invalide.
function getCurrentPeriodEnd(subscription) {
  const ts =
    subscription.current_period_end ||
    subscription.items?.data?.[0]?.current_period_end;
  return ts ? new Date(ts * 1000).toISOString() : null;
}

async function findUserIdByCustomer(stripeCustomerId) {
  const { data } = await supabaseAdmin
    .from('subscriptions')
    .select('user_id')
    .eq('stripe_customer_id', stripeCustomerId)
    .maybeSingle();
  return data?.user_id || null;
}

exports.handler = async (event) => {
  const sig = event.headers['stripe-signature'];

  // Netlify encode parfois le body en base64 selon le Content-Type de la
  // requête entrante. Stripe a besoin du body brut EXACT pour vérifier la
  // signature, donc on le décode ici si nécessaire avant de le passer à
  // constructEvent (c'était la cause du "No signatures found").
  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64')
    : event.body;

  let stripeEvent;

  try {
    stripeEvent = stripe.webhooks.constructEvent(
      rawBody,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return { statusCode: 400, body: `Webhook Error: ${err.message}` };
  }

  try {
    switch (stripeEvent.type) {
      // Paiement Checkout terminé : abonnement OU paiement unique (Lifetime)
      case 'checkout.session.completed': {
        const session = stripeEvent.data.object;
        const userId = session.client_reference_id || session.metadata?.supabase_user_id;
        const billingCycle = session.metadata?.billing_cycle || 'MONTHLY';

        if (!userId) break;

        if (session.mode === 'payment') {
          // Lifetime : paiement unique, pas d'abonnement récurrent Stripe
          await upsertSubscription({
            userId,
            plan: 'PREMIUM',
            status: 'ACTIVE',
            billingCycle: 'LIFETIME',
            stripeCustomerId: session.customer,
            stripeSubscriptionId: null,
            expiresAt: null,
          });
        } else {
          // Mensuel / Annuel : l'objet subscription contient la date d'expiration réelle
          const subscription = await stripe.subscriptions.retrieve(session.subscription);
          await upsertSubscription({
            userId,
            plan: 'PREMIUM',
            status: 'ACTIVE',
            billingCycle,
            stripeCustomerId: session.customer,
            stripeSubscriptionId: subscription.id,
            expiresAt: getCurrentPeriodEnd(subscription),
          });
        }
        break;
      }

      // Renouvellement mensuel/annuel réussi -> on prolonge expires_at
      case 'invoice.paid': {
        const invoice = stripeEvent.data.object;
        if (!invoice.subscription) break;
        const subscription = await stripe.subscriptions.retrieve(invoice.subscription);
        const userId = subscription.metadata?.supabase_user_id
          || (await findUserIdByCustomer(invoice.customer));
        if (!userId) break;

        await upsertSubscription({
          userId,
          plan: 'PREMIUM',
          status: 'ACTIVE',
          billingCycle: subscription.metadata?.billing_cycle || undefined,
          stripeCustomerId: invoice.customer,
          stripeSubscriptionId: subscription.id,
          expiresAt: getCurrentPeriodEnd(subscription),
        });
        break;
      }

      // Paiement échoué -> retour automatique en FREE
      case 'invoice.payment_failed': {
        const invoice = stripeEvent.data.object;
        const userId = await findUserIdByCustomer(invoice.customer);
        if (!userId) break;

        await upsertSubscription({
          userId,
          plan: 'FREE',
          status: 'EXPIRED',
          billingCycle: null,
          stripeCustomerId: invoice.customer,
          stripeSubscriptionId: invoice.subscription || null,
          expiresAt: new Date().toISOString(),
        });
        break;
      }

      // Résiliation (immédiate ou en fin de période, selon config Stripe)
      case 'customer.subscription.deleted': {
        const subscription = stripeEvent.data.object;
        const userId = subscription.metadata?.supabase_user_id
          || (await findUserIdByCustomer(subscription.customer));
        if (!userId) break;

        await upsertSubscription({
          userId,
          plan: 'FREE',
          status: 'CANCELLED',
          billingCycle: null,
          stripeCustomerId: subscription.customer,
          stripeSubscriptionId: subscription.id,
          expiresAt: new Date().toISOString(),
        });
        break;
      }

      // Mise à jour d'abonnement (ex: changement de formule via le portail Stripe)
      case 'customer.subscription.updated': {
        const subscription = stripeEvent.data.object;
        const userId = subscription.metadata?.supabase_user_id
          || (await findUserIdByCustomer(subscription.customer));
        if (!userId) break;

        const isActive = subscription.status === 'active' || subscription.status === 'trialing';
        await upsertSubscription({
          userId,
          plan: isActive ? 'PREMIUM' : 'FREE',
          status: isActive ? (subscription.cancel_at_period_end ? 'CANCELLED' : 'ACTIVE') : 'EXPIRED',
          billingCycle: subscription.metadata?.billing_cycle || undefined,
          stripeCustomerId: subscription.customer,
          stripeSubscriptionId: subscription.id,
          expiresAt: getCurrentPeriodEnd(subscription),
        });
        break;
      }

      default:
        // Événement non géré, on ignore silencieusement
        break;
    }

    return { statusCode: 200, body: JSON.stringify({ received: true }) };
  } catch (err) {
    console.error('stripe-webhook processing error:', err);
    // 500 -> Stripe réessaiera automatiquement l'envoi du webhook
    return { statusCode: 500, body: 'Webhook handler failed' };
  }
};
