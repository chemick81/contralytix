// netlify/functions/_deltalytix-lib.js — outils partagés de la connexion Deltalytix (OAuth).
// Utilisé par deltalytix-oauth.js (connexion) et deltalytix.js (comptes, synchro du radar).
//
// Variables d'environnement Netlify :
//   DELTALYTIX_CLIENT_ID, DELTALYTIX_CLIENT_SECRET  application OAuth créée dans Deltalytix
//   DELTALYTIX_TOKEN_KEY     secret de chiffrement des jetons (au moins 32 caractères aléatoires)
//   DELTALYTIX_BASE_URL      optionnel, défaut https://beta.deltalytix.app
//   DELTALYTIX_REDIRECT_URI  optionnel, défaut https://<site>/api/deltalytix-oauth (doit être
//                            déclarée à l'identique dans l'application OAuth Deltalytix)
//   DELTALYTIX_SCOPES        optionnel, portées demandées (défaut ci-dessous). Chacune doit être
//                            cochée dans l'application OAuth Deltalytix, sinon la connexion est refusée.

const crypto = require('crypto');

const BASE_URL = (process.env.DELTALYTIX_BASE_URL || 'https://beta.deltalytix.app').replace(/\/+$/, '');
const API_BASE = `${BASE_URL}/api/v1`;
const CLIENT_ID = process.env.DELTALYTIX_CLIENT_ID || '';
const CLIENT_SECRET = process.env.DELTALYTIX_CLIENT_SECRET || '';
const KEY_SECRET = process.env.DELTALYTIX_TOKEN_KEY || '';
const PROVIDER = 'deltalytix';
// connections:read : date de dernière synchro de chaque connexion broker (alerte « synchro en retard »).
const SCOPES = process.env.DELTALYTIX_SCOPES || 'profile:read accounts:read trades:read metrics:read connections:read';

function configured() { return !!(CLIENT_ID && CLIENT_SECRET && KEY_SECRET.length >= 16); }
function redirectUri(event) {
  if (process.env.DELTALYTIX_REDIRECT_URI) return process.env.DELTALYTIX_REDIRECT_URI;
  const host = (event && event.headers && (event.headers['x-forwarded-host'] || event.headers.host)) || '';
  return `https://${host}/api/deltalytix-oauth`;
}

// ---------- chiffrement (AES-256-GCM) ----------
function key() { return crypto.createHash('sha256').update(KEY_SECRET).digest(); }
function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return 'v1:' + Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
}
function decrypt(blob) {
  const raw = Buffer.from(String(blob).replace(/^v1:/, ''), 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', key(), raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
}
const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

class DltxError extends Error { constructor(code, msg) { super(msg || code); this.code = code; } }

// ---------- appels API (jeton d'accès OAuth) ----------
async function dltx(token, path, deadline) {
  const remaining = deadline - Date.now();
  if (remaining < 500) throw new DltxError('timeout');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.min(remaining, 7000));
  let res;
  try {
    res = await fetch(`${API_BASE}${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal: ctrl.signal });
  } catch (e) {
    throw new DltxError(e.name === 'AbortError' ? 'timeout' : 'unreachable');
  } finally { clearTimeout(timer); }
  if (res.status === 403) {
    // Portée manquante (jeton obtenu avant l'ajout d'une portée) : distinct d'un jeton invalide.
    const body = await res.json().catch(() => ({}));
    if (body && body.error === 'insufficient_scope') throw new DltxError('insufficient_scope');
    throw new DltxError('token_invalid');
  }
  if (res.status === 401) throw new DltxError('token_invalid');
  if (!res.ok) throw new DltxError('api_error', `HTTP ${res.status}`);
  return res.json();
}

// ---------- jetons OAuth ----------
async function tokenRequest(params) {
  const body = new URLSearchParams({ ...params, client_id: CLIENT_ID, client_secret: CLIENT_SECRET }).toString();
  let res;
  try {
    res = await fetch(`${BASE_URL}/api/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body });
  } catch (e) { throw new DltxError('unreachable'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    if (res.status === 400 || res.status === 401) throw new DltxError('token_invalid', data.error_description || data.error || `HTTP ${res.status}`);
    throw new DltxError('api_error', `HTTP ${res.status}`);
  }
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token || params.refresh_token || null,
    expires_at: Date.now() + (Number(data.expires_in) || 3600) * 1000,
  };
}
// Révocation chez Deltalytix (à la déconnexion). Best-effort : répond toujours 200 côté Deltalytix.
async function revokeToken(token) {
  if (!token) return;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  try {
    await fetch(`${BASE_URL}/api/oauth/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ token, client_id: CLIENT_ID, client_secret: CLIENT_SECRET }).toString(),
      signal: ctrl.signal,
    });
  } catch (e) { /* best-effort */ } finally { clearTimeout(timer); }
}
function packTokens(t) { return encrypt(JSON.stringify(t)); }
function unpackTokens(blob) {
  try { const t = JSON.parse(decrypt(blob)); return t && t.access_token ? t : null; } catch (e) { return null; }
}

// Jeton d'accès valide pour l'utilisateur (renouvelé et réenregistré s'il expire bientôt).
async function accessTokenFor(db, userId) {
  const { data: conn, error } = await db.from('broker_connections').select('token_enc')
    .eq('user_id', userId).eq('provider', PROVIDER).maybeSingle();
  if (error) throw new DltxError(/relation|does not exist/i.test(error.message) ? 'migration_missing' : 'db_error', error.message);
  if (!conn) throw new DltxError('not_connected');
  const t = unpackTokens(conn.token_enc);
  if (!t) throw new DltxError('token_invalid');
  if (t.expires_at && t.expires_at - Date.now() > 120000) return t.access_token;
  if (!t.refresh_token) throw new DltxError('token_invalid');
  const fresh = await tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh_token });
  await db.from('broker_connections').update({ token_enc: packTokens(fresh), updated_at: new Date().toISOString() })
    .eq('user_id', userId).eq('provider', PROVIDER);
  return fresh.access_token;
}

async function supabaseUser(db, event) {
  const authHeader = event.headers.authorization || event.headers.Authorization;
  if (!authHeader) return null;
  try {
    const { data, error } = await db.auth.getUser(authHeader.replace('Bearer ', ''));
    return error || !data?.user ? null : data.user;
  } catch (e) { return null; }
}

module.exports = {
  BASE_URL, CLIENT_ID, PROVIDER, SCOPES, DltxError,
  configured, redirectUri, encrypt, decrypt, b64url, dltx, tokenRequest, revokeToken, packTokens, unpackTokens, accessTokenFor, supabaseUser,
};
