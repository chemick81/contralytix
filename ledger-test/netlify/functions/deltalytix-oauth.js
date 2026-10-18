// netlify/functions/deltalytix-oauth.js — « Se connecter avec Deltalytix » (OAuth 2.0 + PKCE).
//
//   1. GET + en-tête Authorization (jeton Supabase) → { authUrl } : page d'autorisation Deltalytix.
//      Le `state` contient, CHIFFRÉS, l'utilisateur, une expiration (10 min) et le code_verifier PKCE :
//      rien n'est stocké avant le retour.
//   2. GET ?code=…&state=… (retour de Deltalytix dans la petite fenêtre) → échange du code contre les
//      jetons, enregistrement CHIFFRÉ dans broker_connections, puis page qui prévient l'onglet
//      Contralytix (postMessage, même origine uniquement) et se ferme.
// Voir _deltalytix-lib.js pour la configuration (variables d'environnement).

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const L = require('./_deltalytix-lib');

const STATE_TTL_MS = 10 * 60 * 1000;
function json(status, body) {
  return { statusCode: status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(body) };
}

function resultPage(event, payload) {
  const origin = (() => { try { return new URL(L.redirectUri(event)).origin; } catch (e) { return ''; } })();
  const data = JSON.stringify({ type: 'contralytix-deltalytix', ...payload }).replace(/</g, '\\u003c');
  const msg = payload.ok
    ? 'Deltalytix est connecté. Retourne sur Contralytix : cette fenêtre va se fermer.'
    : 'La connexion à Deltalytix n’a pas abouti. Retourne sur Contralytix pour réessayer.';
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' },
    body: `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Contralytix · Deltalytix</title></head>
<body style="margin:0;font-family:system-ui,sans-serif;background:#0B0F14;color:#E8EDF2;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px;text-align:center;">
<p style="max-width:360px;line-height:1.5;">${msg}</p>
<script>(function(){var d=${data};try{if(window.opener&&${JSON.stringify(origin)}){window.opener.postMessage(d,${JSON.stringify(origin)});setTimeout(function(){window.close();},300);}}catch(e){}})();</script>
</body></html>`,
  };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return json(405, { error: 'Méthode non autorisée' });
  const q = event.queryStringParameters || {};
  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  // ---- 2. Retour de Deltalytix ----
  if (q.code || q.error || q.state) {
    if (!L.configured()) return resultPage(event, { ok: false, error: 'not_configured' });
    if (q.error) return resultPage(event, { ok: false, error: q.error === 'access_denied' ? 'denied' : (q.error === 'invalid_scope' ? 'scope_refused' : 'oauth_error') });
    let st;
    try { st = JSON.parse(L.decrypt(Buffer.from(String(q.state || ''), 'base64url').toString('utf8'))); } catch (e) { st = null; }
    if (!st || !st.u || !st.v || !(st.exp > Date.now())) return resultPage(event, { ok: false, error: 'expired' });
    try {
      const tokens = await L.tokenRequest({ grant_type: 'authorization_code', code: String(q.code || ''), redirect_uri: L.redirectUri(event), code_verifier: st.v });
      // Compte Deltalytix réellement autorisé (18/10/2026) : la fenêtre Deltalytix utilise le compte déjà
      // ouvert dans le navigateur, qui peut être celui d'une autre personne. Un même compte Deltalytix
      // ne peut être relié qu'à UN compte Contralytix : sinon un utilisateur verrait les comptes,
      // soldes et trades d'un autre. L'e-mail Deltalytix (unique chez eux) sert d'identifiant.
      let email = null;
      for (let i = 0; i < 2 && !email; i++) {
        try { const me = await L.dltx(tokens.access_token, '/me', Date.now() + 6000); email = me && me.email ? String(me.email).trim() : null; } catch (e) { /* nouvel essai */ }
      }
      if (!email) {
        await Promise.all([L.revokeToken(tokens.refresh_token), L.revokeToken(tokens.access_token)]);
        return resultPage(event, { ok: false, error: 'identity_unknown' });
      }
      const esc = email.replace(/([%_\\])/g, '\\$1');
      const { data: others, error: oErr } = await db.from('broker_connections').select('user_id')
        .eq('provider', L.PROVIDER).ilike('account_email', esc).neq('user_id', st.u).limit(1);
      if (oErr && !/relation|does not exist/i.test(oErr.message)) return resultPage(event, { ok: false, error: 'db_error' });
      if (others && others.length) {
        await Promise.all([L.revokeToken(tokens.refresh_token), L.revokeToken(tokens.access_token)]);
        return resultPage(event, { ok: false, error: 'already_linked', email });
      }
      const now = new Date().toISOString();
      const { error } = await db.from('broker_connections').upsert({
        user_id: st.u, provider: L.PROVIDER, token_enc: L.packTokens(tokens), token_hint: 'oauth',
        account_email: email, last_error: null, created_at: now, updated_at: now,
      }, { onConflict: 'user_id,provider' });
      if (error) return resultPage(event, { ok: false, error: /relation|does not exist/i.test(error.message) ? 'migration_missing' : 'db_error' });
      return resultPage(event, { ok: true });
    } catch (e) {
      console.error('Deltalytix OAuth :', e.code || '', e.message);
      return resultPage(event, { ok: false, error: e.code === 'token_invalid' ? 'exchange_refused' : 'deltalytix_error' });
    }
  }

  // ---- 1. Démarrage ----
  if (!L.configured()) return json(501, { error: 'not_configured' });
  const user = await L.supabaseUser(db, event);
  if (!user) return json(401, { error: 'Session invalide, reconnecte-toi.' });
  const verifier = L.b64url(crypto.randomBytes(48));
  const challenge = L.b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = Buffer.from(L.encrypt(JSON.stringify({ u: user.id, v: verifier, exp: Date.now() + STATE_TTL_MS })), 'utf8').toString('base64url');
  const url = new URL(`${L.BASE_URL}/oauth/authorize`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', L.CLIENT_ID);
  url.searchParams.set('redirect_uri', L.redirectUri(event));
  url.searchParams.set('scope', L.SCOPES);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return json(200, { authUrl: url.toString() });
};
