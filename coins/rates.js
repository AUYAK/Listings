// Курсы НБРБ: RUB/EUR/USD → BYN, кэш на сутки. Используется каталогом (gdenashel в RUB, Numista в EUR).
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

module.exports = { bynRate, toByn };
