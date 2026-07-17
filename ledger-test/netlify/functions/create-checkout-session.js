// netlify/functions/create-checkout-session.js
//
// Crée une session Stripe Checkout pour un des 3 plans Premium.
// Appelé depuis le front avec le token Supabase de l'utilisateur connecté.

const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// service_role key : bypass RLS, à utiliser UNIQUEMENT côté serveur (jamais exposée au front)
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Mappe billing_cycle -> Price ID Stripe (créés dans le Dashboard Stripe)
const PRICE_IDS = {
  MONTHLY: process.env.STRIPE_PRICE_MONTHLY,
  YEARLY: process.env.STRIPE_PRICE_YEARLY,
  LIFETIME: process.env.STRIPE_PRICE_LIFETIME,
};

// Devise utilisée pour les réductions en montant fixe (doit correspondre à celle de tes Price Stripe)
const CURRENCY = 'eur';

// Revalide le code promo côté serveur (ne JAMAIS faire confiance à ce que le front envoie).
// Appelle la fonction RPC validate_promo_code créée dans promo_codes.sql — elle ne renvoie
// jamais la liste complète des codes, seulement le résultat pour CE code précis.
async function checkPromoCode(promoCode, billingCycle) {
  if (!promoCode) return null;

  const { data, error } = await supabaseAdmin.rpc('validate_promo_code', { p_code: promoCode });
  if (error) {
    console.error('validate_promo_code error:', error);
    return { valid: false, reason: 'Erreur de vérification du code promo.' };
  }
  const r = Array.isArray(data) ? data[0] : data;
  if (!r || !r.valid) {
    return { valid: false, reason: (r && r.reason) || 'Code promo invalide.' };
  }
  if (!r.applies_to || !r.applies_to.includes(billingCycle)) {
    return { valid: false, reason: "Ce code promo ne s'applique pas à cette formule." };
  }
  return {
    valid: true,
    discountType: r.discount_type,   // 'PERCENT' | 'FIXED'
    discountValue: Number(r.discount_value),
  };
}

// Crée un Stripe Coupon éphémère à partir du résultat de validation.
// 'once' = la réduction ne s'applique qu'au premier paiement (1re facture d'abonnement,
// ou le paiement unique Lifetime). Change en 'forever' si tu veux une remise récurrente
// tant que l'abonnement mensuel/annuel est actif.
async function createStripeCoupon(promo) {
  const params = { duration: 'once', name: 'Code promo' };
  if (promo.discountType === 'PERCENT') {
    params.percent_off = promo.discountValue;
  } else {
    params.amount_off = Math.round(promo.discountValue * 100); // en centimes
    params.currency = CURRENCY;
  }
  return stripe.coupons.create(params);
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const { billingCycle, promoCode } = JSON.parse(event.body || '{}');
    const authHeader = event.headers.authorization || event.headers.Authorization;

    if (!authHeader) {
      return { statusCode: 401, body: JSON.stringify({ error: 'Non authentifié' }) };
    }
    if (!PRICE_IDS[billingCycle]) {
      return { statusCode: 400, body: JSON.stringify({ error: 'billingCycle invalide' }) };
    }

    // Vérifie le token et récupère l'utilisateur
    const token = authHeader.replace('Bearer ', '');
    const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
    if (userErr || !userData?.user) {
      return { statusCode: 401, body: JSON.stringify({ error: 'Session invalide' }) };
    }
    const user = userData.user;

    // Code promo : revalidé côté serveur, indépendamment de ce que le front a affiché.
    // Si un code est fourni mais invalide/inapplicable, on bloque avec un message clair
    // plutôt que de facturer silencieusement le plein tarif.
    let coupon = null;
    if (promoCode) {
      const promoResult = await checkPromoCode(promoCode, billingCycle);
      if (!promoResult.valid) {
        return { statusCode: 400, body: JSON.stringify({ error: promoResult.reason }) };
      }
      coupon = await createStripeCoupon(promoResult);
    }

    // Récupère ou crée le customer Stripe, réutilisé s'il existe déjà
    const { data: sub } = await supabaseAdmin
      .from('subscriptions')
      .select('stripe_customer_id')
      .eq('user_id', user.id)
      .maybeSingle();

    let customerId = sub?.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        metadata: { supabase_user_id: user.id },
      });
      customerId = customer.id;
    }

    const isLifetime = billingCycle === 'LIFETIME';

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: isLifetime ? 'payment' : 'subscription',
      line_items: [{ price: PRICE_IDS[billingCycle], quantity: 1 }],
      // discounts et allow_promotion_codes sont mutuellement exclusifs : comme on applique
      // notre propre coupon dynamique, on ne passe PAS allow_promotion_codes ici.
      discounts: coupon ? [{ coupon: coupon.id }] : undefined,
      success_url: `${process.env.SITE_URL}/?checkout=success`,
      cancel_url: `${process.env.SITE_URL}/?checkout=cancelled`,
      client_reference_id: user.id,
      metadata: {
        supabase_user_id: user.id,
        billing_cycle: billingCycle,
        promo_code: promoCode || '',
      },
      subscription_data: isLifetime
        ? undefined
        : { metadata: { supabase_user_id: user.id, billing_cycle: billingCycle, promo_code: promoCode || '' } },
    });

    return { statusCode: 200, body: JSON.stringify({ url: session.url }) };
  } catch (err) {
    console.error('create-checkout-session error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Erreur serveur' }) };
  }
};
