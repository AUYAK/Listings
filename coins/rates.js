// Курсы НБРБ: RUB/EUR/USD → BYN, кэш на сутки. Используется каталогом (gdenashel в RUB, Numista в EUR).
// Там же — цены драгметаллов (слитки НБРБ): BYN за грамм золота и серебра для нижней планки по металлу.
const RATE_TTL_MS = 24 * 3600e3;
const rates = new Map();

async function bynRate(currency) {
  if (currency === 'BYN') return 1;
  const c = rates.get(currency);
  if (c && Date.now() - c.at < RATE_TTL_MS) return c.rate;
  const res = await fetch(`https://api.nbrb.by/exrates/rates/${currency}?parammode=2`, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`NBRB ${res.status} for ${currency}`);
  const d = await res.json();
  const rate = d.Cur_OfficialRate / (d.Cur_Scale || 1); // RUB: Cur_Scale = 100
  rates.set(currency, { at: Date.now(), rate });
  return rate;
}

async function toByn(amount, currency) {
  return amount * (await bynRate(currency));
}

// Слитки НБРБ: MetalID 0 — золото, 1 — серебро, 2 — платина; берём цену выкупа банком слитка 10 г с сертификатом
// (CertificateRubles) — самая низкая из публикуемых, то есть честная нижняя планка. Возвращает { gold, silver } BYN/г.
// Если API недоступен — значения из .env (COINS_GOLD_BYN_PER_G, COINS_SILVER_BYN_PER_G), иначе null.
let metalCache = null;
async function metalPrices() {
  if (metalCache && Date.now() - metalCache.at < RATE_TTL_MS) return metalCache.prices;
  const fallback = {
    gold: parseFloat(process.env.COINS_GOLD_BYN_PER_G || '') || null,
    silver: parseFloat(process.env.COINS_SILVER_BYN_PER_G || '') || null,
  };
  try {
    const res = await fetch('https://api.nbrb.by/ingots/prices', { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`NBRB ingots ${res.status}`);
    const rows = await res.json();
    const perGram = (metalId) => {
      const r = rows.find((x) => x.MetalID === metalId && Number(x.Nominal) === 10) || rows.find((x) => x.MetalID === metalId);
      const price = r && (r.CertificateRubles ?? r.BanksRubles);
      return price > 0 ? Math.round((price / Number(r.Nominal)) * 100) / 100 : null;
    };
    const prices = { gold: perGram(0) || fallback.gold, silver: perGram(1) || fallback.silver };
    metalCache = { at: Date.now(), prices };
    return prices;
  } catch (err) {
    if (fallback.gold || fallback.silver) return fallback;
    throw err;
  }
}

module.exports = { bynRate, toByn, metalPrices };
