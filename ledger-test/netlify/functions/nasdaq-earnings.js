// netlify/functions/nasdaq-earnings.js
//
// Proxy serveur vers l'API JSON interne de nasdaq.com/market-activity/earnings.
// Nécessaire car un appel direct depuis le navigateur échoue (CORS + protection
// anti-bot côté Nasdaq qui exige des headers spécifiques).

exports.handler = async (event) => {
  const date = (event.queryStringParameters && event.queryStringParameters.date) || new Date().toISOString().slice(0, 10);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Paramètre date invalide (format attendu : YYYY-MM-DD)' }) };
  }

  try {
    const res = await fetch(`https://api.nasdaq.com/api/calendar/earnings?date=${date}`, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Referer': 'https://www.nasdaq.com/market-activity/earnings',
        'Origin': 'https://www.nasdaq.com',
      },
    });

    if (!res.ok) {
      return { statusCode: res.status, body: JSON.stringify({ error: `Nasdaq a répondu ${res.status}` }) };
    }

    const data = await res.json();
    const rows = (data && data.data && Array.isArray(data.data.rows)) ? data.data.rows : [];

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=900' },
      body: JSON.stringify({ date, rows }),
    };
  } catch (err) {
    console.error('nasdaq-earnings error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Erreur serveur lors de la requête vers Nasdaq' }) };
  }
};
