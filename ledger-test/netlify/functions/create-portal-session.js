// netlify/functions/create-portal-session.js
//
// Ouvre le portail client Stripe (factures, changement de formule, résiliation).

const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
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

    const { data: sub, error: subErr } = await supabaseAdmin
      .from('subscriptions')
      .select('stripe_customer_id')
      .eq('user_id', userData.user.id)
      .maybeSingle();

    if (subErr || !sub?.stripe_customer_id) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Aucun abonnement Stripe trouvé' }) };
    }

    const portalSession = await stripe.billingPortal.sessions.create({
      customer: sub.stripe_customer_id,
      return_url: `${process.env.SITE_URL}/?from=portal`,
    });

    return { statusCode: 200, body: JSON.stringify({ url: portalSession.url }) };
  } catch (err) {
    console.error('create-portal-session error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Erreur serveur' }) };
  }
};
