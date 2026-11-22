// netlify/functions/catalogue-check.js
//
// Catalogue prop firm (22/11/2026) : bouton « MAJ » du bloc admin « Contrôle des sources ».
// Relit les deux comparateurs publics et compare leurs valeurs avec la table propfirm_programs :
//   - PropFirm Factory : https://factory.trade-with-me.fr/api/account-types/ (JSON public) ;
//   - MaPropFirm       : https://mapropfirm.fr/funded-data.csv (CSV public, règles en financé).
// LECTURE SEULE : rien n'est écrit en base. La page officielle de la prop firm fait foi ; l'admin
// vérifie chaque écart et le marque « vérifié » depuis l'app (catMarkVerified dans index.html).
// La détection de changement des pages officielles n'est pas faite ici : Apex refuse les robots et
// le centre d'aide Bulenox se charge en JavaScript.
//
// POST /api/catalogue-check   En-tête Authorization: Bearer <jeton Supabase> d'un ADMIN.
// Variables d'environnement : SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (déjà utilisées ailleurs).

const { createClient } = require('@supabase/supabase-js');

const FACTORY_URL = 'https://factory.trade-with-me.fr/api/account-types/?page_size=1000&page=1';
const MAPROPFIRM_URL = 'https://mapropfirm.fr/funded-data.csv';
const TIMEOUT_MS = 7000;

function json(status, body) {
  return { statusCode: status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(body) };
}

// Prop firm du catalogue → motif du nom chez les comparateurs.
const FIRMS = {
  pf_mr7w3bng0con9v: /apex/i,
  pf_mr7w2dj0v72mkk: /bulenox/i,
  pf_muvft69oler236: /funded futures family/i,
  pf_mrcjtp9vzcfa1d: /funded ?next/i,
  pf_mr7w0mwdh1c04l: /lucid/i,
  pf_mr7w2ry0nrfyyd: /take ?profit|tpt/i,
  pf_mr7wm64d4f6yv7: /tradeday/i,
};
// Nom du compte chez le comparateur → programme du catalogue (null = pas d'équivalent).
function programOf(firmId, name) {
  const n = String(name || '');
  switch (firmId) {
    case 'pf_mr7w3bng0con9v': return /legacy/i.test(n) ? null : /intraday/i.test(n) ? 'Intraday' : /eod/i.test(n) ? 'EOD' : null;
    case 'pf_mr7w2dj0v72mkk': return /fast ?track/i.test(n) ? 'Fast Track' : /momentum/i.test(n) ? 'Momentum' : /master|qualification/i.test(n) ? 'Master' : null;
    case 'pf_mr7w0mwdh1c04l': return /lucid ?pro/i.test(n) ? 'LucidPro' : /lucid ?flex/i.test(n) ? 'LucidFlex' : null;
    case 'pf_mr7w2ry0nrfyyd': return /pro\+|live/i.test(n) ? null : 'PRO';
    case 'pf_mr7wm64d4f6yv7': return /quick ?pay/i.test(n) ? 'Quick Pay' : /fast ?pass/i.test(n) ? 'Fast Pass' : null;
    case 'pf_mrcjtp9vzcfa1d': return /rapid ?pro/i.test(n) ? 'Rapid Pro' : /flex/i.test(n) ? 'Flex' : /legacy/i.test(n) ? 'Legacy' : null;
    case 'pf_muvft69oler236': return /elite/i.test(n) ? 'Elite' : /classic/i.test(n) ? 'Classic' : null;
  }
  return null;
}
const num = (v) => { if (v === null || v === undefined || v === '') return null; const x = Number(String(v).replace(/[^0-9.\-]/g, '')); return Number.isFinite(x) ? x : null; };
const sizeOf = (v) => { const s = String(v || '').toLowerCase(); const x = num(s); if (x === null) return null; return /k/.test(s) && x < 1000 ? x * 1000 : x; };
const firmOf = (name) => Object.keys(FIRMS).find((id) => FIRMS[id].test(String(name || ''))) || null;

async function get(url, type) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': 'Contralytix catalogue check (contact: contralytix.fr)', Accept: type === 'json' ? 'application/json' : 'text/csv,text/plain' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return type === 'json' ? await res.json() : await res.text();
  } finally { clearTimeout(t); }
}

// CSV avec champs entre guillemets (virgules et guillemets doublés).
function parseCsv(text) {
  const rows = []; let row = []; let cur = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; }
    else cur += ch;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  const head = rows.shift() || [];
  return rows.filter((r) => r.length > 3).map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), r[i]])));
}

// Valeurs du catalogue ramenées aux mêmes grandeurs que les comparateurs.
function ours(p) {
  const R = p.rules || {};
  const coh = (R.consistency || []).find((x) => x) || 0;
  return {
    minDays: num(R.minDays) || 0,
    dayMin: R.dayType === 'winning' ? num(R.dayMin) : null,
    consistency: coh,
    minPayout: num(R.minPayout),
    buffer: num(R.buffer) || 0,
    minRequestProfit: num(R.minRequestProfit),
    capFirst: Array.isArray(R.caps) && R.caps.length ? num(R.caps[0]) : null,
    split: R.split ? Math.round(R.split * 100) : null,
  };
}
const LABELS = { minDays: 'Jours min', dayMin: 'Profit min par jour', consistency: 'Cohérence (%)', minPayout: 'Retrait min', buffer: 'Buffer', minRequestProfit: 'Profit min pour demander', capFirst: '1er plafond', split: 'Split (%)' };

function fromFactory(a) {
  const R = a.rules || {};
  const pe = R.payout_eligibility || {};
  const size = num(a.account_size);
  const none = pe.day_mode === 'none';
  return {
    size,
    v: {
      minDays: none ? 0 : num(pe.min_days),
      dayMin: pe.day_mode === 'winning' ? num(pe.winning_day_min_pnl_usd) : null,
      consistency: pe.consistency_max_best_day_pct === undefined ? null : (num(pe.consistency_max_best_day_pct) || 0),
      minPayout: num(pe.min_withdrawal_usd),
      minRequestProfit: num(pe.min_balance_before_payout_usd) !== null && size ? num(pe.min_balance_before_payout_usd) - size : null,
    },
  };
}
function fromMapropfirm(r) {
  const size = sizeOf(r.account_size);
  const bal = num(r.rule_balance_min);
  const buf = num(r.rule_buffer);
  return {
    size,
    v: {
      minDays: r.rule_qualifying_days_min === '' ? 0 : num(r.rule_qualifying_days_min),
      dayMin: num(r.rule_qualifying_day_min_profit),
      consistency: r.rule_consistency_pct === '' ? null : (num(r.rule_consistency_pct) || 0),
      minPayout: num(r.rule_payout_min) || null,
      buffer: buf ? buf : (bal && size ? bal - size : (buf === 0 ? 0 : null)),
      capFirst: num(r.rule_cap_first) || null,
      split: num(r.rule_split_pct),
    },
  };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Méthode non autorisée' });
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return json(500, { error: 'Configuration serveur incomplète.' });
  const admin = createClient(url, key);

  const auth = event.headers.authorization || event.headers.Authorization || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  if (!token) return json(401, { error: 'Non authentifié' });
  const { data: u, error: uErr } = await admin.auth.getUser(token);
  if (uErr || !u || !u.user) return json(401, { error: 'Session invalide' });
  const { data: prof } = await admin.from('profiles').select('role').eq('id', u.user.id).maybeSingle();
  if (!prof || prof.role !== 'ADMIN') return json(403, { error: 'Réservé aux administrateurs' });

  const { data: programs, error: pErr } = await admin.from('propfirm_programs').select('id, propfirm_id, program, phase, size, rules').eq('active', true).eq('phase', 'PA');
  if (pErr) return json(500, { error: 'Lecture du catalogue impossible.' });

  const [fac, mp] = await Promise.allSettled([get(FACTORY_URL, 'json'), get(MAPROPFIRM_URL, 'csv')]);
  const sources = [];
  const ext = []; // { src, firmId, program, size, v }
  if (fac.status === 'fulfilled') {
    const list = Array.isArray(fac.value) ? fac.value : (fac.value && fac.value.results) || [];
    let n = 0;
    list.forEach((a) => {
      const firmId = firmOf(a.prop_firm_name);
      const program = firmId && programOf(firmId, a.name);
      if (!program) return;
      const x = fromFactory(a); n++;
      ext.push({ src: 'PropFirm Factory', firmId, program, size: x.size, v: x.v });
    });
    sources.push('PropFirm Factory : ' + n + ' comptes lus');
  } else sources.push('PropFirm Factory injoignable');
  if (mp.status === 'fulfilled') {
    let n = 0;
    parseCsv(mp.value).forEach((r) => {
      const firmId = firmOf(r.propfirm);
      const program = firmId && programOf(firmId, r.account_type);
      if (!program) return;
      const x = fromMapropfirm(r); n++;
      ext.push({ src: 'MaPropFirm', firmId, program, size: x.size, v: x.v });
    });
    sources.push('MaPropFirm : ' + n + ' comptes lus');
  } else sources.push('MaPropFirm injoignable');

  // Une même valeur peut apparaître plusieurs fois (variantes Trailing / EOD d'un même programme) : dédoublonnée.
  const groups = new Map(); // clé firm|program|champ|source|valeurs → tailles
  let compared = 0;
  programs.forEach((p) => {
    const mine = ours(p);
    const size = Number(p.size);
    const seen = new Set();
    ext.filter((e) => e.firmId === p.propfirm_id && e.program === p.program && e.size === size).forEach((e) => {
      Object.keys(e.v).forEach((field) => {
        const theirs = e.v[field];
        const me = mine[field];
        if (theirs === null || theirs === undefined || me === null || me === undefined) return;
        const k1 = field + '|' + e.src + '|' + theirs;
        if (seen.has(k1)) return;
        seen.add(k1);
        compared++;
        if (Math.abs(theirs - me) < 0.5) return;
        const k = [p.propfirm_id, p.program, field, e.src, me, theirs].join('|');
        if (!groups.has(k)) groups.set(k, { firmId: p.propfirm_id, program: p.program, field, src: e.src, me, theirs, sizes: [] });
        groups.get(k).sizes.push(size);
      });
    });
  });
  const firmName = { pf_mr7w3bng0con9v: 'Apex Trader Funding', pf_mr7w2dj0v72mkk: 'Bulenox', pf_muvft69oler236: 'Funded Futures Family', pf_mrcjtp9vzcfa1d: 'FundedNext', pf_mr7w0mwdh1c04l: 'Lucid Trading', pf_mr7w2ry0nrfyyd: 'Take Profit Trader', pf_mr7wm64d4f6yv7: 'TradeDay' };
  const fmt = (v) => Math.round(v).toLocaleString('fr-FR').replace(/ | /g, ' ');
  const diffs = [...groups.values()].map((g) => ({
    firmId: g.firmId, program: g.program, field: g.field, source: g.src,
    title: (firmName[g.firmId] || g.firmId) + ' · ' + g.program + ' · ' + g.sizes.sort((a, b) => a - b).map((s) => Math.round(s / 1000) + 'K').join(', '),
    note: LABELS[g.field] + ' : catalogue ' + fmt(g.me) + ', ' + g.src + ' ' + fmt(g.theirs) + '. Vérifie la page officielle.',
  })).sort((a, b) => a.title.localeCompare(b.title, 'fr'));

  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  const at = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(d).replace(' ', ' à ');
  return json(200, { at: at || (p2(d.getDate()) + '/' + p2(d.getMonth() + 1) + '/' + d.getFullYear()), compared, diffs, sources: sources.join(' · ') });
};
