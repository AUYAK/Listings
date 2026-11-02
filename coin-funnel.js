// Почему лоты не дошли до уведомления: node coin-funnel.js [--days 7] [--top 20]
// 1) воронка по шагам; 2) причины отсева по каждому серебряному лоту; 3) проданные ниже ориентира без уведомления
// (что мы пропустили и почему); 4) состояние каталога.
require('dotenv').config();
const { pool } = require('./store');
const { BARGAIN_PCT, BARGAIN_BYN, BARGAIN_MIN_BYN, isBargain } = require('./coins/market');

const arg = (name, def) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : def; };
const days = parseInt(arg('--days', '7'), 10);
const top = parseInt(arg('--top', '20'), 10);
const AUCTION_NOTIFY_HOURS = parseFloat(process.env.COINS_AUCTION_NOTIFY_HOURS || '12');

const fmt = (n) => n == null ? '—' : `${Math.round(Number(n))} р.`;
const when = (d) => d ? new Date(d).toISOString().slice(0, 16).replace('T', ' ') : '—';
const pct = (n, total) => total ? ` (${Math.round((n / total) * 100)}%)` : '';

// Причина, по которой лот не был (или не будет) отправлен — в порядке проверок монитора
function reasonFor(a) {
  const p = a.parsed || {};
  const flags = p.flags || [];
  if (!p.isSilver) return 'не серебро';
  if (flags.includes('копия')) return 'копия';
  if (flags.includes('несколько монет')) return 'подборка / несколько монет';
  if (!a.detail_fetched_at) return 'страница лота не дочитана (только карточка списка)';
  if (!a.grade) return 'нет состояния (продавец не указал, из заголовка не разобрать)';
  if (a.est_reference == null) return 'нет ориентира (нет каталога на тип+состояние, в нашей базе < 3 похожих)';
  const price = Number(a.current_price);
  const ref = Number(a.est_reference);
  if (price < 2) return 'цена < 2 р. (ставок ещё нет)';
  if (price >= ref) return 'выше ориентира';
  if (!isBargain({ price, reference: ref })) {
    const gain = Math.round(ref - price);
    return `ниже ориентира, но не дотянул до порога (−${Math.round(((ref - price) / ref) * 100)}%, ${gain} р.)`;
  }
  if (a.notified_at) return 'уведомлён';
  if (a.outcome) return 'выгодно по оценке, но торги закончились без уведомления';
  if (a.sale_type === 'auction') {
    const hoursLeft = a.ends_at ? (new Date(a.ends_at) - Date.now()) / 3600e3 : null;
    if (hoursLeft != null && hoursLeft > AUCTION_NOTIFY_HOURS) return `выгодно, аукцион ещё идёт (уведомим за ${AUCTION_NOTIFY_HOURS} ч до конца)`;
    return 'выгодно, аукцион в окне уведомления, ждёт следующего цикла';
  }
  return 'выгодно, ждёт следующего цикла';
}

function bucket(reason) {
  return reason.replace(/\s*\(.*$/, ''); // без скобок — для группировки
}

async function main() {
  console.log(`Порог: выгода ≥ ${BARGAIN_BYN} р., либо ≤ −${BARGAIN_PCT}% и ≥ ${BARGAIN_MIN_BYN} р.; аукционы — за ${AUCTION_NOTIFY_HOURS} ч до конца. Окно: ${days} дн.\n`);

  const { rows } = await pool.query(
    `SELECT l.id, l.url, l.title, l.monitor_key, l.first_seen, a.*
     FROM listings.listings l JOIN listings.coin_lots a ON a.listing_id = l.id
     WHERE l.first_seen >= NOW() - ($1 || ' days')::interval
     ORDER BY l.first_seen`, [String(days)]);
  for (const r of rows) if (typeof r.parsed === 'string') r.parsed = JSON.parse(r.parsed);

  for (const key of [...new Set(rows.map((r) => r.monitor_key))]) {
    const lots = rows.filter((r) => r.monitor_key === key);
    const silver = lots.filter((r) => r.parsed && r.parsed.isSilver);
    const notified = lots.filter((r) => r.notified_at).length;
    console.log(`== ${key}: лотов ${lots.length}, серебро ${silver.length}, уведомлений ${notified} (≈ ${(notified / days).toFixed(1)} в день)`);

    const counts = new Map();
    for (const r of silver) { const b = bucket(reasonFor(r)); counts.set(b, (counts.get(b) || 0) + 1); }
    console.log('  Причины по серебру:');
    for (const [b, n] of [...counts].sort((x, y) => y[1] - x[1])) console.log(`    ${String(n).padStart(4)}${pct(n, silver.length).padEnd(7)} ${b}`);

    // Насколько не дотянули: распределение отклонения среди лотов с ориентиром
    const withRef = silver.filter((r) => r.est_reference != null && Number(r.current_price) >= 2);
    if (withRef.length) {
      const bins = [[-100, -50], [-50, -30], [-30, -15], [-15, 0], [0, 30], [30, 1e9]];
      const line = bins.map(([lo, hi]) => {
        const n = withRef.filter((r) => r.deviation_pct >= lo && r.deviation_pct < hi).length;
        return `${lo <= -100 ? '<' : lo}…${hi >= 1e9 ? '>' : hi}%: ${n}`;
      }).join(' · ');
      console.log(`  Отклонение от ориентира (${withRef.length} лотов с ориентиром): ${line}`);
    }

    // Состояния: где нет ориентира
    const byGrade = new Map();
    for (const r of silver) {
      const g = r.grade || '—';
      const e = byGrade.get(g) || { n: 0, ref: 0 };
      e.n++; if (r.est_reference != null) e.ref++;
      byGrade.set(g, e);
    }
    console.log('  Состояние → лотов / с ориентиром: ' + [...byGrade].sort((x, y) => y[1].n - x[1].n).map(([g, e]) => `${g} ${e.n}/${e.ref}`).join(', '));
    console.log();
  }

  // Что пропустили: проданные (итог известен) ниже ориентира, без уведомления
  const sold = rows.filter((r) => r.outcome === 'sold' && r.final_price != null && r.parsed && r.parsed.isSilver && !r.notified_at && r.est_reference != null)
    .map((r) => ({ ...r, gain: Number(r.est_reference) - Number(r.final_price) }))
    .filter((r) => r.gain > 0)
    .sort((a, b) => b.gain - a.gain);
  console.log(`== Проданы ниже ориентира без нашего уведомления: ${sold.length} лотов, топ-${top} по упущенной разнице`);
  for (const r of sold.slice(0, top)) {
    console.log(`  ${r.url}`);
    console.log(`     итог ${fmt(r.final_price)} (${r.final_bids ?? '?'} ставок) · ориентир ${fmt(r.est_reference)} (${r.est_catalog_src || 'наша база'}) · +${Math.round(r.gain)} р. · ${r.grade || '—'} · ${r.sale_type} · закончился ${when(r.ended_at)}`);
    console.log(`     причина на момент оценки: ${reasonFor({ ...r, notified_at: null, outcome: null, ends_at: null })}`);
  }

  // Проданные дорого без ориентира — там, где каталога не хватает
  const noRef = rows.filter((r) => r.outcome === 'sold' && r.final_price != null && r.parsed && r.parsed.isSilver && r.est_reference == null)
    .sort((a, b) => Number(b.final_price) - Number(a.final_price));
  console.log(`\n== Проданы без ориентира (каталог не покрыл): ${noRef.length} лотов, топ-${Math.min(top, 10)} по цене`);
  for (const r of noRef.slice(0, 10)) {
    const p = r.parsed;
    console.log(`  ${fmt(r.final_price)} · ${r.grade || 'без состояния'} · ${[p.denomination, p.year, p.mintmaster || p.mint, p.ruler].filter(Boolean).join(' ')} · ${r.url}`);
  }

  const cat = await pool.query(`SELECT source, count(*)::int AS types, max(fetched_at) AS updated FROM listings.coin_catalog GROUP BY source`);
  const sales = await pool.query(`SELECT count(*)::int AS n, count(price)::int AS priced, min(sold_on) AS from_d, max(sold_on) AS to_d FROM listings.coin_sales`);
  console.log('\n== Каталог:');
  for (const r of cat.rows) console.log(`  ${r.source}: ${r.types} типов/вариантов, обновлён ${when(r.updated)}`);
  const s = sales.rows[0];
  console.log(`  проходов gdenashel: ${s.n}, с ценой ${s.priced}${s.from_d ? `, ${when(s.from_d).slice(0, 10)} … ${when(s.to_d).slice(0, 10)}` : ''}`);
}

main().catch((err) => { console.error(err.message); process.exitCode = 1; }).finally(() => pool.end());
