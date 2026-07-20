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

  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    });

    const data = await res.json();
    if (!res.ok) {
      return { statusCode: res.status, body: JSON.stringify({ error: data.error?.message || 'Erreur API Gemini' }) };
    }

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || null;
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    };
  } catch (err) {
    console.error('gemini-synthesis error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Erreur serveur lors de la requête vers Gemini' }) };
  }
};
