// netlify/functions/ai-key.js
//
// Gestion de la clé IA personnelle (Profil → Connexions → « Ma clé IA »), 01/11/2026.
// POST /api/ai-key, en-tête Authorization: Bearer <jeton Supabase> obligatoire.
//   { action: 'status' }                                  → statut (jamais la clé)
//   { action: 'save', provider, key, model? }             → teste la clé chez le fournisseur, puis l'enregistre chiffrée
//   { action: 'test' }                                     → reteste la clé enregistrée
//   { action: 'engines', engines: { coach:'site'|'mine', … } } → moteur choisi par module
//   { action: 'delete' }                                   → efface la clé
// La clé reçue n'est jamais journalisée ni renvoyée ; seul un indice (« sk-…a1f3 ») est affiché ensuite.

const A = require('./_ai-lib');

const TEST_PROMPT = 'Réponds uniquement par le mot OK.';
const ENGINE_MODULES = Object.keys(A.MODULES);

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return A.json(405, { error: 'Méthode non autorisée' });
  const db = A.db();
  const user = await A.userFromEvent(db, event);
  if (!user) return A.json(401, { error: 'Session invalide, reconnecte-toi.' });

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch (e) { return A.json(400, { error: 'Requête invalide' }); }
  const action = body.action;
  const deadline = Date.now() + 8500;

  try {
    if (action === 'status') {
      return A.json(200, A.publicStatus(await A.loadUserKey(db, user.id)));
    }

    if (action === 'delete') {
      const { error } = await db.from('user_ai_keys').delete().eq('user_id', user.id);
      if (error) throw Object.assign(new Error(error.message), { code: 'db_error' });
      return A.json(200, { connected: false });
    }

    if (action === 'engines') {
      const row = await A.loadUserKey(db, user.id);
      if (!row) return A.json(409, { error: A.userMessage('no_key'), code: 'no_key' });
      const engines = { ...(row.engines || {}) };
      Object.entries(body.engines || {}).forEach(([m, v]) => { if (ENGINE_MODULES.includes(m) && (v === 'site' || v === 'mine')) engines[m] = v; });
      const { error } = await db.from('user_ai_keys').update({ engines, updated_at: new Date().toISOString() }).eq('user_id', user.id);
      if (error) throw Object.assign(new Error(error.message), { code: 'db_error' });
      return A.json(200, A.publicStatus({ ...row, engines }));
    }

    if (action === 'save' || action === 'test') {
      let provider, key, model, row = null;
      if (action === 'save') {
        provider = String(body.provider || '').toLowerCase();
        key = String(body.key || '').trim();
        model = body.model ? String(body.model).trim().slice(0, 120) : null;
        if (!A.PROVIDERS[provider]) return A.json(400, { error: 'Fournisseur inconnu.', code: 'bad_provider' });
        if (key.length < 12 || key.length > 400 || /\s/.test(key)) return A.json(400, { error: 'Cette clé ne semble pas complète : copie-la à nouveau depuis la console du fournisseur.', code: 'bad_format' });
      } else {
        row = await A.loadUserKey(db, user.id);
        if (!row) return A.json(409, { error: A.userMessage('no_key'), code: 'no_key' });
        provider = row.provider; model = row.model; key = A.decrypt(row.key_enc);
      }
      const name = A.PROVIDERS[provider].name;
      try {
        await A.callProvider(provider, key, { prompt: TEST_PROMPT, model, maxTokens: 16, deadline });
      } catch (e) {
        if (row) await db.from('user_ai_keys').update({ last_error: e.code || 'provider_error', updated_at: new Date().toISOString() }).eq('user_id', user.id);
        A.safeLog(`ai-key test ${provider}:`, e, [key]);
        return A.json(422, { error: A.userMessage(e.code, name), code: e.code || 'provider_error' });
      }
      const now = new Date().toISOString();
      if (action === 'save') {
        const prev = await A.loadUserKey(db, user.id).catch(() => null);
        const rec = { user_id: user.id, provider, key_enc: A.encrypt(key), key_hint: A.keyHint(key), model, engines: (prev && prev.engines) || {}, verified_at: now, last_error: null, updated_at: now };
        const { error } = await db.from('user_ai_keys').upsert(rec, { onConflict: 'user_id' });
        if (error) throw Object.assign(new Error(error.message), { code: /relation|does not exist/i.test(error.message) ? 'migration_missing' : 'db_error' });
        return A.json(200, A.publicStatus(rec));
      }
      await db.from('user_ai_keys').update({ verified_at: now, last_error: null, updated_at: now }).eq('user_id', user.id);
      return A.json(200, A.publicStatus({ ...row, verified_at: now, last_error: null }));
    }

    return A.json(400, { error: 'Action inconnue' });
  } catch (e) {
    A.safeLog('ai-key:', e, [body && body.key]);
    const code = e.code || 'error';
    return A.json(code === 'migration_missing' || code === 'not_configured' ? 503 : 500, { error: A.userMessage(code), code });
  }
};
