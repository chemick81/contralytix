// netlify/functions/gemini-synthesis.js
//
// Proxy serveur vers l'API Gemini. La clé API reste côté serveur
// (variable d'environnement Netlify GEMINI_API_KEY) et n'est donc
// jamais exposée dans le code source ni le bundle envoyé au navigateur.

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Méthode non autorisée' }) };
  }

  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    return { statusCode: 500, body: JSON.stringify({ error: 'GEMINI_API_KEY non configurée sur Netlify (Site configuration > Environment variables).' }) };
  }

  let prompt;
  try {
    const body = JSON.parse(event.body || '{}');
    prompt = body.prompt;
  } catch (err) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Corps de requête JSON invalide' }) };
  }

  if (!prompt || typeof prompt !== 'string') {
    return { statusCode: 400, body: JSON.stringify({ error: 'Le champ "prompt" est requis' }) };
  }

  // En cas de surcharge (erreurs 503/429 "high demand"), on retente une fois
  // sur le même modèle, puis on bascule sur un modèle de repli si besoin.
  const MODELS = ['gemini-3.5-flash', 'gemini-2.5-flash'];
  const MAX_ATTEMPTS_PER_MODEL = 2;
  const RETRY_DELAY_MS = 1000;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const isOverloaded = (status, message) =>
    status === 503 || status === 429 || /overload|high demand|unavailable/i.test(message || '');

  let lastError = 'Erreur API Gemini';

  for (const model of MODELS) {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_MODEL; attempt++) {
      try {
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
        });

        const data = await res.json();

        if (res.ok) {
          const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || null;
          return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text, model }),
          };
        }

        lastError = data.error?.message || 'Erreur API Gemini';

        if (isOverloaded(res.status, lastError) && attempt < MAX_ATTEMPTS_PER_MODEL) {
          await sleep(RETRY_DELAY_MS);
          continue; // retente sur le même modèle
        }
        if (isOverloaded(res.status, lastError)) {
          break; // passe au modèle de repli suivant
        }
        // Erreur non liée à la surcharge (ex: clé invalide) : inutile d'insister
        return { statusCode: res.status, body: JSON.stringify({ error: lastError }) };
      } catch (err) {
        console.error('gemini-synthesis error:', err);
        lastError = 'Erreur serveur lors de la requête vers Gemini';
      }
    }
  }

  return { statusCode: 503, body: JSON.stringify({ error: lastError }) };
};
