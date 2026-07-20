// netlify/functions/ai-synthesis.js
//
// Proxy serveur vers l'API Groq. La clé API reste côté serveur (variable
// d'environnement Netlify GROQ_API_KEY) et n'est donc jamais exposée dans le
// code source ni le bundle envoyé au navigateur.
//
// Pourquoi Groq plutôt que Gemini : Groq tourne sur du matériel dédié (LPU)
// et son niveau gratuit (aucune carte bancaire requise, ~30 req/min et
// ~1000 req/jour au 07/2026) est nettement plus fiable que le niveau
// gratuit de Gemini, qui renvoie très souvent des erreurs "high demand".
//
// Si l'utilisateur fournit sa propre clé Groq (repli quand la clé du site
// échoue), elle est utilisée à la place — voir index.html, champ
// "Clé API Groq personnelle".

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Méthode non autorisée' }) };
  }

  let prompt, userApiKey;
  try {
    const body = JSON.parse(event.body || '{}');
    prompt = body.prompt;
    userApiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
  } catch (err) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Corps de requête JSON invalide' }) };
  }

  if (!prompt || typeof prompt !== 'string') {
    return { statusCode: 400, body: JSON.stringify({ error: 'Le champ "prompt" est requis' }) };
  }

  // Si le client fournit sa propre clé (repli quand la clé du site échoue), on
  // l'utilise à sa place. Sinon on retombe sur la clé configurée sur Netlify.
  const key = userApiKey || process.env.GROQ_API_KEY;
  if (!key) {
    return { statusCode: 500, body: JSON.stringify({ error: 'GROQ_API_KEY non configurée sur Netlify (Site configuration > Environment variables), et aucune clé personnelle fournie.' }) };
  }

  // Le niveau gratuit de Groq est déjà très fiable, mais on garde un repli sur
  // un second modèle par sécurité en cas de limite de débit ponctuelle (429).
  const MODELS = ['llama-3.3-70b-versatile', 'openai/gpt-oss-120b'];
  const MAX_ATTEMPTS_PER_MODEL = 2;
  const BASE_RETRY_DELAY_MS = 900;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const isOverloaded = (status, message) =>
    status === 503 || status === 429 || /overload|high demand|unavailable|rate limit/i.test(message || '');

  let lastError = 'Erreur API Groq';
  let lastWasOverload = false;

  for (const model of MODELS) {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_MODEL; attempt++) {
      try {
        const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${key}`,
          },
          body: JSON.stringify({
            model,
            messages: [{ role: 'user', content: prompt }],
          }),
        });

        const data = await res.json();

        if (res.ok) {
          const text = data.choices?.[0]?.message?.content?.trim() || null;
          return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text, model }),
          };
        }

        lastError = data.error?.message || 'Erreur API Groq';
        lastWasOverload = isOverloaded(res.status, lastError);

        if (lastWasOverload && attempt < MAX_ATTEMPTS_PER_MODEL) {
          await sleep(BASE_RETRY_DELAY_MS * attempt); // 900ms, puis 1800ms
          continue; // retente sur le même modèle
        }
        if (lastWasOverload) {
          break; // passe au modèle de repli suivant
        }
        // Erreur non liée à la surcharge (ex: clé invalide) : inutile d'insister
        return { statusCode: res.status, body: JSON.stringify({ error: lastError, overloaded: false }) };
      } catch (err) {
        console.error('ai-synthesis error:', err);
        lastError = 'Erreur serveur lors de la requête vers Groq';
      }
    }
  }

  return { statusCode: 503, body: JSON.stringify({ error: lastError, overloaded: lastWasOverload }) };
};
