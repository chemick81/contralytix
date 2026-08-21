// netlify/functions/ecb-fx-rate.js
//
// Fournit le taux de change EUR/devise à une date donnée, à partir des données
// publiques de la Banque Centrale Européenne (série de référence quotidienne).
// Modèle identique à nasdaq-earnings.js : proxy serveur pour éviter le CORS côté navigateur.
//
// La BCE ne publie pas d'API par date arbitraire : on récupère le fichier des 90
// derniers jours (mis à jour chaque jour ouvré ~16h CET) et on prend la valeur la
// plus récente à la date demandée ou avant (la BCE ne publie pas le week-end/jours
// fériés — on retombe donc sur le dernier taux publié, ce qui est l'usage standard).
// Pour une date de plus de 90 jours, il faudra basculer sur eurofxref-hist.xml
// (historique complet, fichier plus lourd) — non fait ici pour rester simple.

const ECB_HIST90_URL = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist-90d.xml';

exports.handler = async (event) => {
  const date = (event.queryStringParameters && event.queryStringParameters.date) || new Date().toISOString().slice(0, 10);
  const currency = ((event.queryStringParameters && event.queryStringParameters.currency) || 'USD').toUpperCase();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Paramètre date invalide (format attendu : YYYY-MM-DD)' }) };
  }

  try {
    const res = await fetch(ECB_HIST90_URL);
    if (!res.ok) {
      return { statusCode: res.status, body: JSON.stringify({ error: `BCE a répondu ${res.status}` }) };
    }
    const xml = await res.text();

    // Parsing minimaliste par regex plutôt qu'un vrai parseur XML (pas de dépendance à
    // ajouter juste pour ça) — chaque jour est un bloc <Cube time="YYYY-MM-DD">...</Cube>
    // contenant des <Cube currency="USD" rate="1.0821"/> pour chaque devise.
    const dayBlocks = [...xml.matchAll(/<Cube time="(\d{4}-\d{2}-\d{2})">([\s\S]*?)<\/Cube>/g)]
      .map(m => ({ date: m[1], body: m[2] }))
      .sort((a, b) => b.date.localeCompare(a.date)); // plus récent d'abord

    // Le jour demandé, ou le dernier jour publié avant (week-end / jour férié BCE).
    const dayBlock = dayBlocks.find(d => d.date <= date);
    if (!dayBlock) {
      return { statusCode: 404, body: JSON.stringify({ error: 'Aucune donnée BCE disponible pour cette période (>90 jours ?)' }) };
    }

    if (currency === 'EUR') {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' },
        body: JSON.stringify({ date, resolvedDate: dayBlock.date, currency, rateToEur: 1 }),
      };
    }

    const rateMatch = dayBlock.body.match(new RegExp(`<Cube currency="${currency}" rate="([\\d.]+)"`));
    if (!rateMatch) {
      return { statusCode: 404, body: JSON.stringify({ error: `Devise ${currency} non trouvée dans la série BCE.` }) };
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' },
      body: JSON.stringify({
        date,               // date demandée
        resolvedDate: dayBlock.date, // date réellement utilisée (peut différer si week-end/férié)
        currency,
        rateToEur: Number(rateMatch[1]), // 1 EUR = rateToEur <currency> → montant_devise / rateToEur = montant_EUR
      }),
    };
  } catch (err) {
    console.error('ecb-fx-rate error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Erreur serveur lors de la requête vers la BCE' }) };
  }
};