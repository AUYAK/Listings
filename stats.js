// Сводка по рынку для команды /stats: сколько появилось и ушло по группам моделей за период,
// медиана цены новых объявлений и тренд к предыдущему такому же периоду.

const store = require('./store');
const market = require('./market');

const PERIODS = [
  { days: 7, label: '7 дней' },
  { days: 30, label: '30 дней' },
  { days: 90, label: '90 дней' },
  { days: 0, label: 'всё время' },
];
const MAX_GROUPS = 18;
const MIN_TREND_SAMPLES = 3;
const DAY = 86400e3;

const fmt = (n) => `${Math.round(n).toLocaleString('ru')} р.`;
const d1 = (n) => n.toFixed(1).replace('.', ',');
const dateStr = (t) => new Date(t).toLocaleDateString('ru-BY', { day: '2-digit', month: '2-digit' });

// The group a listing is reported under: line + chip (Apple Silicon) or line + year / Intel.
// It is the first group key without screen/memory refinements.
function baseGroup(d) {
  const g = market.groupKeys(d).find((k) => k.key.split('|').length === 2);
  return g ? { key: g.key, label: g.label.replace(/^MacBook\s*/, '') || 'MacBook' } : { key: 'other', label: 'прочее' };
}

function trendStr(cur, prev) {
  if (cur == null || prev == null || !prev) return '';
  const pct = Math.round(((cur - prev) / prev) * 100);
  if (Math.abs(pct) < 2) return ' ─';
  return pct > 0 ? ` ▲${pct}%` : ` ▼${-pct}%`;
}

function summarize(items, from, to, prevFrom, prevTo) {
  const inWin = (t, a, b) => t != null && t >= a && t < b;
  const appeared = items.filter((r) => !r.seeded && inWin(r.firstSeen, from, to));
  const gone = items.filter((r) => inWin(r.goneAt, from, to));
  const prevAppeared = items.filter((r) => !r.seeded && inWin(r.firstSeen, prevFrom, prevTo));
  const goneDays = gone.filter((r) => !r.seeded).map((r) => (r.goneAt - r.firstSeen) / DAY);
  const cur = appeared.length >= MIN_TREND_SAMPLES ? market.median(appeared.map((r) => r.price)) : (appeared.length ? market.median(appeared.map((r) => r.price)) : null);
  const prev = prevAppeared.length >= MIN_TREND_SAMPLES ? market.median(prevAppeared.map((r) => r.price)) : null;
  return {
    appeared: appeared.length,
    gone: gone.length,
    goneMedianDays: goneDays.length ? market.median(goneDays) : null,
    price: cur,
    trend: appeared.length >= MIN_TREND_SAMPLES ? trendStr(cur, prev) : '',
  };
}

async function buildStats(monitor, days) {
  const rows = await store.getMarketRows(monitor.key);
  const now = Date.now();
  const firstSeenMin = Math.min(...rows.map((r) => new Date(r.first_seen).getTime()));
  const seedCut = firstSeenMin + 2 * 3600e3;

  const items = rows
    .filter((r) => r.price_byn != null && parseFloat(r.price_byn) >= market.MIN_PRICE_BYN)
    .map((r) => {
      const d = market.describe(r.title, {
        chip: r.chip, ramGb: r.ram_gb, ssdGb: r.ssd_gb, condition: r.condition, year: r.year,
        screenIn: r.screen_in != null ? parseFloat(r.screen_in) : null,
      });
      const firstSeen = new Date(r.first_seen).getTime();
      return {
        group: baseGroup(d),
        isNew: d.condition === 'new',
        price: parseFloat(r.price_byn),
        firstSeen,
        seeded: firstSeen < seedCut,
        goneAt: r.gone_at ? new Date(r.gone_at).getTime() : null,
        active: r.status !== 'inactive',
      };
    });

  // Window and the comparison window for the trend
  let from, to = now, prevFrom, prevTo, periodTitle;
  if (days > 0) {
    from = now - days * DAY; prevFrom = from - days * DAY; prevTo = from;
    periodTitle = `${PERIODS.find((p) => p.days === days).label} (${dateStr(from)}–${dateStr(to)})`;
  } else {
    from = firstSeenMin; const mid = (firstSeenMin + now) / 2;
    prevFrom = firstSeenMin; prevTo = mid;
    periodTitle = `всё время (с ${dateStr(firstSeenMin)})`;
  }
  // For "all time" the trend compares the second half of the data with the first half
  const trendFrom = days > 0 ? from : (firstSeenMin + now) / 2;

  const used = items.filter((r) => !r.isNew);
  const fresh = items.filter((r) => r.isNew);
  const total = summarize(used, from, to, prevFrom, prevTo);
  const totalNew = summarize(fresh, from, to, prevFrom, prevTo);
  const activeNow = used.filter((r) => r.active).length;

  const byGroup = new Map();
  for (const r of used) {
    if (!byGroup.has(r.group.key)) byGroup.set(r.group.key, { label: r.group.label, items: [] });
    byGroup.get(r.group.key).items.push(r);
  }
  const groups = [...byGroup.values()]
    .map((g) => ({ label: g.label, ...summarize(g.items, from, to, prevFrom, prevTo), trendOnly: summarize(g.items, trendFrom, to, prevFrom, prevTo).trend }))
    .filter((g) => g.appeared || g.gone)
    .sort((a, b) => (b.appeared + b.gone) - (a.appeared + a.gone));

  const lines = [];
  lines.push(`📈 <b>${monitor.emoji || ''} ${monitor.name} · ${periodTitle}</b>`);
  lines.push(`Появилось ${total.appeared} · ушло ${total.gone} · сейчас в продаже ${activeNow}`);
  if (total.goneMedianDays != null) lines.push(`Б/у уходят в среднем за ~${d1(total.goneMedianDays)} дн.`);
  lines.push('');
  for (const g of groups.slice(0, MAX_GROUPS)) {
    const price = g.price != null ? ` · ${fmt(g.price)}${days > 0 ? g.trend : g.trendOnly}` : '';
    const speed = g.goneMedianDays != null && g.gone >= 2 ? ` (~${d1(g.goneMedianDays)} дн.)` : '';
    lines.push(`<b>${g.label}</b>  +${g.appeared} / −${g.gone}${speed}${price}`);
  }
  if (groups.length > MAX_GROUPS) {
    const rest = groups.slice(MAX_GROUPS);
    lines.push(`… ещё ${rest.length} групп: +${rest.reduce((s, g) => s + g.appeared, 0)} / −${rest.reduce((s, g) => s + g.gone, 0)}`);
  }
  if (!groups.length) lines.push('За этот период нет данных.');
  if (totalNew.appeared || totalNew.gone) {
    lines.push('');
    lines.push(`🆕 Новые (не в таблице): +${totalNew.appeared} / −${totalNew.gone}${totalNew.price != null ? ` · ${fmt(totalNew.price)}` : ''}`);
  }
  lines.push('');
  const noPrev = days > 0 && prevTo <= firstSeenMin + DAY; // monitoring started inside the comparison window
  lines.push(`<i>+появилось / −ушло (медиана дней до ухода) · медиана цены новых объявлений · тренд к ${days > 0 ? 'предыдущему периоду' : 'первой половине периода'}.${noPrev ? ` Тренд появится, когда накопятся данные за предыдущие ${days} дней (сбор идёт с ${dateStr(firstSeenMin)}).` : ''} Цены — запрос продавца, без торга.</i>`);

  return { text: lines.join('\n'), keyboard: buildKeyboard(monitor, days) };
}

function buildKeyboard(monitor, days) {
  return {
    inline_keyboard: [
      PERIODS.map((p) => ({ text: p.days === days ? `• ${p.label} •` : p.label, callback_data: `stats:${monitor.key}:${p.days}` })),
    ],
  };
}

module.exports = { buildStats, buildKeyboard, baseGroup, PERIODS };
