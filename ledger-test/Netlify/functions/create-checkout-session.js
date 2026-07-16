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

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const { billingCycle } = JSON.parse(event.body || '{}');
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
      success_url: `${process.env.SITE_URL}/?checkout=success`,
      cancel_url: `${process.env.SITE_URL}/?checkout=cancelled`,
      client_reference_id: user.id,
      metadata: { supabase_user_id: user.id, billing_cycle: billingCycle },
      subscription_data: isLifetime
        ? undefined
        : { metadata: { supabase_user_id: user.id, billing_cycle: billingCycle } },
    });

    return { statusCode: 200, body: JSON.stringify({ url: session.url }) };
  } catch (err) {
    console.error('create-checkout-session error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Erreur serveur' }) };
  }
};
