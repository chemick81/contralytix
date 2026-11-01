// netlify/functions/ai.js
//
// Point d'entrée unique des textes IA (01/11/2026) : Coach rentabilité, brief météo, assistant (chatbot).
// Remplace l'appel direct à gemini-synthesis.js / ai-synthesis.js, qui n'exigeaient aucune session.
//
// POST /api/ai   { module: 'coach' | 'meteo' | 'chat', prompt: string, engine?: 'site' | 'mine' }
// En-tête Authorization: Bearer <jeton Supabase> obligatoire.
//   - engine 'site' (défaut) : l'IA Contralytix. Sur les modules Premium (coach, meteo), réservée aux
//     comptes Premium / Beta / Admin.
//   - engine 'mine' : la clé personnelle de l'utilisateur (déchiffrée le temps de l'appel), ouverte à
//     tous les plans, Free compris (décision du 01/11/2026).
// Pas de bascule silencieuse d'un moteur à l'autre : en cas d'échec, le navigateur propose de réessayer.
// Réponse : { text, engine, provider, model }  ·  erreur : { error, code, hasKey }

const A = require('./_ai-lib');

const MAX_PROMPT = 40000;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return A.json(405, { error: 'Méthode non autorisée' });
  const db = A.db();
  const user = await A.userFromEvent(db, event);
  if (!user) return A.json(401, { error: 'Session invalide, reconnecte-toi.', code: 'unauthorized' });

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch (e) { return A.json(400, { error: 'Requête invalide' }); }
  const module = String(body.module || '');
  const prompt = typeof body.prompt === 'string' ? body.prompt : '';
  const engine = body.engine === 'mine' ? 'mine' : 'site';
  const M = A.MODULES[module];
  if (!M || M.vision) return A.json(400, { error: 'Module inconnu', code: 'bad_module' });
  if (!prompt.trim()) return A.json(400, { error: 'Le texte de la demande est vide.', code: 'empty' });
  if (prompt.length > MAX_PROMPT) return A.json(413, { error: 'Demande trop longue.', code: 'too_long' });

  const deadline = Date.now() + 9000;
  let row = null, key = null;
  try {
    row = await A.loadUserKey(db, user.id).catch((e) => { if (e.code === 'migration_missing' && engine === 'site') return null; throw e; });
    const hasKey = !!row;

    if (engine === 'site' && M.premium && !user.isPremium) {
      return A.json(403, { error: A.userMessage('premium_only'), code: 'premium_only', hasKey });
    }
    if (engine === 'mine' && !row) return A.json(409, { error: A.userMessage('no_key'), code: 'no_key', hasKey: false });

    const q = await A.checkQuota(db, user, engine);
    if (!q.ok) return A.json(429, { error: A.userMessage('quota'), code: 'quota', hasKey, limit: q.limit });

    // Brief météo (01/11/2026) : recherche web (Gemini) pour s'appuyer sur l'actualité du jour, au lieu de
    // Groq qui n'a pas accès à internet et inventait des niveaux de prix. Autres fournisseurs : pas de web,
    // la consigne leur interdit alors tout chiffre de marché et le navigateur affiche un avertissement.
    const wantsWeb = module === 'meteo';
    let out;
    if (engine === 'mine') {
      key = A.decrypt(row.key_enc);
      const web = wantsWeb && row.provider === 'gemini';
      out = await A.callProvider(row.provider, key, { prompt: prompt + A.moduleRules(module, web), model: row.model, deadline, search: web });
      out.provider = row.provider;
    } else {
      out = await A.callSite({ prompt: prompt + A.moduleRules(module, wantsWeb), deadline, search: wantsWeb });
      out.provider = 'contralytix';
    }
    await A.logUsage(db, user, module, engine, true);
    if (engine === 'mine' && row.last_error) await db.from('user_ai_keys').update({ last_error: null }).eq('user_id', user.id);
    return A.json(200, { text: out.text, engine, provider: out.provider, model: out.model, web: !!out.web, sources: out.sources || [] });
  } catch (e) {
    A.safeLog(`ai ${module}/${engine}:`, e, [key, process.env.GEMINI_API_KEY, process.env.GROQ_API_KEY]);
    const code = e.code || 'error';
    try { await A.logUsage(db, user, module, engine, false); } catch (_) { /* */ }
    if (engine === 'mine' && row && ['invalid_key', 'no_credit', 'bad_model'].includes(code)) {
      await db.from('user_ai_keys').update({ last_error: code }).eq('user_id', user.id);
    }
    const name = engine === 'mine' && row ? (A.PROVIDERS[row.provider] || {}).name : null;
    const status = { invalid_key: 422, no_credit: 422, bad_model: 422, rate_limited: 429, overloaded: 503, timeout: 504, migration_missing: 503, not_configured: 503 }[code] || 502;
    return A.json(status, { error: A.userMessage(code, name), code, overloaded: code === 'overloaded', hasKey: !!row });
  }
};
