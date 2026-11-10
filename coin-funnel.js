// Почему лоты не дошли до уведомления: node coin-funnel.js [--days 7] [--top 20] [--pro 1000]
// 1) воронка по шагам; 2) причины отсева по каждому серебряному лоту; 3) проданные ниже ориентира без уведомления
// (что мы пропустили и почему); 4) мониторы сбора цен; 5) слабы по корзинам грейда; 6) перекупщики: дешёвые победы
// игроков с рейтингом ≥ --pro и их перевыставления (окно лучше брать шире: --days 30); 7) состояние каталога.
require('dotenv').config();
const { pool } = require('./store');
const { BARGAIN_PCT, BARGAIN_BYN, BARGAIN_MIN_BYN, SLAB_MIN_BYN, QUIET_HOURS, QUIET_MAX_BIDS, isBargain, median } = require('./coins/market');
const { MONITORS } = require('./config');
const { notifyBlocker } = require('./coins/parse');

const arg = (name, def) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : def; };
const days = parseInt(arg('--days', '7'), 10);
const top = parseInt(arg('--top', '20'), 10);
const pro = parseInt(arg('--pro', '1000'), 10);
const AUCTION_NOTIFY_HOURS = parseFloat(process.env.COINS_AUCTION_NOTIFY_HOURS || '12');
const collectOnly = new Set(MONITORS.filter((m) => m.notify === false).map((m) => m.key));

const fmt = (n) => n == null ? '—' : `${Math.round(Number(n))} р.`;
const when = (d) => d ? new Date(d).toISOString().slice(0, 16).replace('T', ' ') : '—';
const pct = (n, total) => total ? ` (${Math.round((n / total) * 100)}%)` : '';

// Причина, по которой лот не был (или не будет) отправлен — в порядке проверок монитора
function reasonFor(a) {
  const p = a.parsed || {};
  const flags = p.flags || [];
  const slab = p.slab || null;
  if (!(p.isPrecious || p.isSilver || p.isGold)) return 'не серебро и не золото';
  const blocker = notifyBlocker({ ...p, flags }, a.sale_type);
  if (blocker) return blocker;
  if (!a.detail_fetched_at) return 'страница лота не дочитана (только карточка списка)';
  if (slab && slab.details) return 'слаб details (чистка или повреждения)';
  if (!a.grade && !(slab && slab.bucket) && !p.weight) return 'нет состояния (продавец не указал, из заголовка не разобрать)';
  if (a.est_reference == null) return slab && slab.bucket ? `слаб ${slab.bucket}: нет ориентира (в архиве и нашей базе нет слабов этой корзины)` : 'нет ориентира (нет каталога на тип+состояние, в нашей базе < 3 похожих)';
  const price = Number(a.current_price);
  const ref = Number(a.est_reference);
  if (slab && ref < SLAB_MIN_BYN) return `слаб дешёвой монеты (ориентир < ${SLAB_MIN_BYN} р.)`;
  if (a.reserve === 'not_met') return 'минимальная цена продавца не пройдена';
  if (price < 2) return 'цена < 2 р. (ставок ещё нет; такие лоты ловит проверка тихих лотов)';
  if (price >= ref) return 'выше ориентира';
  if (!isBargain({ price, reference: ref })) {
    const gain = Math.round(ref - price);
    return `ниже ориентира, но не дотянул до порога (−${Math.round(((ref - price) / ref) * 100)}%, ${gain} р.)`;
  }
  if (a.sent) return 'уведомление отправлено';
  if (a.notified_at) return 'выгодно по текущей оценке, но при рассмотрении не прошло (оценка или цена с тех пор изменились)';
  if (a.outcome) return 'выгодно по оценке, но торги закончились без уведомления';
  if (a.sale_type === 'auction') {
    const hoursLeft = a.ends_at ? (new Date(a.ends_at) - Date.now()) / 3600e3 : null;
    if (hoursLeft != null && hoursLeft > AUCTION_NOTIFY_HOURS) return `выгодно, аукцион ещё идёт (уведомим за ${AUCTION_NOTIFY_HOURS} ч до конца, тихий лот — за ${QUIET_HOURS} ч)`;
    return 'выгодно, аукцион в окне уведомления, ждёт следующего цикла';
  }
  return 'выгодно, ждёт следующего цикла';
}

// Мониторы сбора цен: сколько лотов и итогов накопилось (уведомлений у них нет, причины отсева не нужны)
function printCollectOnly(key, lots) {
  const sold = lots.filter((r) => r.outcome === 'sold' && r.final_price != null);
  const withGrade = sold.filter((r) => r.grade || (r.parsed && r.parsed.slab && r.parsed.slab.bucket));
  console.log(`== ${key} (сбор цен): лотов ${lots.length}, продано с итогом ${sold.length}, из них с состоянием ${withGrade.length}, медиана итога ${fmt(median(sold.map((r) => Number(r.final_price))))}\n`);
}

// Слабы по корзинам грейда: сколько выставлено, сколько продано и почём
function printSlabs(rows) {
  const slabs = rows.filter((r) => r.parsed && r.parsed.slab);
  if (!slabs.length) return;
  const by = new Map();
  for (const r of slabs) {
    const k = r.parsed.slab.bucket || (r.parsed.slab.details ? 'details' : 'без грейда');
    const e = by.get(k) || { n: 0, sold: [], auction: 0, bids: 0 };
    e.n++;
    if (/auction/.test(r.sale_type || '')) e.auction++;
    if ((r.bids || 0) > 0) e.bids++;
    if (r.outcome === 'sold' && r.final_price != null) e.sold.push(Number(r.final_price));
    by.set(k, e);
  }
  console.log(`\n== Слабы: ${slabs.length} лотов (только аукционы уведомляются, ориентир — слабы той же корзины, дешевле ${SLAB_MIN_BYN} р. не интересны)`);
  for (const [k, e] of [...by].sort((a, b) => b[1].n - a[1].n)) {
    console.log(`  ${k.padEnd(10)} лотов ${String(e.n).padStart(4)}, аукционов ${e.auction}, со ставками ${e.bids}, продано ${e.sold.length}${e.sold.length ? `, медиана ${fmt(median(e.sold))}` : ''}`);
  }
}

// Перекупщики: дешёвые победы игроков с рейтингом ≥ pro и их последующие лоты того же типа (номинал, год, буквы)
async function printPros() {
  const wins = await pool.query(
    `SELECT l.url, l.title, a.final_price, a.final_bids, a.est_reference, a.winner, u.rating, a.ended_at
     FROM listings.coin_lots a JOIN listings.listings l ON l.id = a.listing_id JOIN listings.ayby_users u ON u.user_id = a.winner_id
     WHERE a.outcome = 'sold' AND a.ended_at >= NOW() - ($1 || ' days')::interval AND u.rating >= $2
       AND a.est_reference IS NOT NULL AND a.final_price <= a.est_reference * (1 - $3::numeric / 100)
     ORDER BY a.est_reference - a.final_price DESC LIMIT $4`, [String(days), pro, BARGAIN_PCT, top]);
  console.log(`\n== Дешёвые победы игроков с рейтингом ≥ ${pro} (итог ниже ориентира на ≥ ${BARGAIN_PCT}%): ${wins.rows.length}`);
  for (const r of wins.rows) {
    console.log(`  ${fmt(r.final_price)} при ориентире ${fmt(r.est_reference)} · ставок: ${r.final_bids ?? '?'} · ${r.winner} (${r.rating}) · ${when(r.ended_at)} · ${r.title}`);
    console.log(`     ${r.url}`);
  }
  const relist = await pool.query(
    `SELECT b_l.title AS bought_title, b.final_price AS bought, b.winner, u.rating, s_l.url, s_l.title,
            COALESCE(s.final_price, s.current_price) AS resale, s.outcome, s.sale_type, s_l.first_seen
     FROM listings.coin_lots b
     JOIN listings.listings b_l ON b_l.id = b.listing_id
     JOIN listings.coin_lots s ON s.seller_id = b.winner_id AND s.listing_id <> b.listing_id
     JOIN listings.listings s_l ON s_l.id = s.listing_id
     LEFT JOIN listings.ayby_users u ON u.user_id = b.winner_id
     WHERE b.outcome = 'sold' AND b.winner_id IS NOT NULL AND b.ended_at >= NOW() - ($1 || ' days')::interval
       AND s_l.first_seen > b.ended_at
       AND b.parsed->>'denomKop' IS NOT NULL AND b.parsed->>'denomKop' = s.parsed->>'denomKop'
       AND b.parsed->>'year' = s.parsed->>'year'
       AND COALESCE(b.parsed->>'mintmaster', '') = COALESCE(s.parsed->>'mintmaster', '')
     ORDER BY s_l.first_seen DESC LIMIT $2`, [String(days), top]);
  console.log(`\n== Перевыставления: победитель потом выставил монету того же типа (вероятно, ту же): ${relist.rows.length}`);
  for (const r of relist.rows) {
    const markup = Number(r.bought) > 0 && r.resale != null ? ` (${Math.round((Number(r.resale) / Number(r.bought) - 1) * 100)}%)` : '';
    console.log(`  ${r.winner}${r.rating != null ? ` (${r.rating})` : ''}: купил за ${fmt(r.bought)} → ${r.outcome === 'sold' ? 'продал' : 'выставил'} за ${fmt(r.resale)}${markup} · ${r.sale_type || '?'} · ${when(r.first_seen)}`);
    console.log(`     купил: ${r.bought_title}`);
    console.log(`     продаёт: ${r.title} ${r.url}`);
  }
}

function bucket(reason) {
  return reason.replace(/\s*\(.*$/, ''); // без скобок — для группировки
}

async function main() {
  console.log(`Порог: выгода ≥ ${BARGAIN_BYN} р., либо ≤ −${BARGAIN_PCT}% и ≥ ${BARGAIN_MIN_BYN} р.; аукционы — за ${AUCTION_NOTIFY_HOURS} ч до конца; `
    + `тихие лоты (≤ ${QUIET_MAX_BIDS} ставки) — за ${QUIET_HOURS} ч. Окно: ${days} дн.\n`);

  // notified_at в coin_lots = «рассмотрен, больше не трогаем» (в том числе отклонён); реально отправленные — в listing_notifications
  const { rows } = await pool.query(
    `SELECT l.id, l.url, l.title, l.monitor_key, l.first_seen, a.*,
            EXISTS (SELECT 1 FROM listings.listing_notifications n WHERE n.listing_id = l.id) AS sent
     FROM listings.listings l JOIN listings.coin_lots a ON a.listing_id = l.id
     WHERE l.first_seen >= NOW() - ($1 || ' days')::interval
     ORDER BY l.first_seen`, [String(days)]);
  for (const r of rows) if (typeof r.parsed === 'string') r.parsed = JSON.parse(r.parsed);

  for (const key of [...new Set(rows.map((r) => r.monitor_key))]) {
    const lots = rows.filter((r) => r.monitor_key === key);
    if (collectOnly.has(key)) { printCollectOnly(key, lots); continue; }
    const silver = lots.filter((r) => r.parsed && (r.parsed.isPrecious || r.parsed.isSilver || r.parsed.isGold));
    const sent = lots.filter((r) => r.sent).length;
    const considered = lots.filter((r) => r.notified_at).length;
    console.log(`== ${key}: лотов ${lots.length}, серебро+золото ${silver.length}, уведомлений отправлено ${sent} (≈ ${(sent / days).toFixed(1)} в день), рассмотрено и закрыто ${considered}`);

    const counts = new Map();
    for (const r of silver) { const b = bucket(reasonFor(r)); counts.set(b, (counts.get(b) || 0) + 1); }
    console.log('  Причины по серебру и золоту:');
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
  const sold = rows.filter((r) => r.outcome === 'sold' && r.final_price != null && r.parsed && (r.parsed.isPrecious || r.parsed.isSilver) && !r.sent && r.est_reference != null)
    .map((r) => ({ ...r, gain: Number(r.est_reference) - Number(r.final_price) }))
    .filter((r) => r.gain > 0)
    .sort((a, b) => b.gain - a.gain);
  console.log(`== Проданы ниже ориентира без нашего уведомления: ${sold.length} лотов, топ-${top} по упущенной разнице`);
  for (const r of sold.slice(0, top)) {
    console.log(`  ${r.url}`);
    console.log(`     итог ${fmt(r.final_price)} (${r.final_bids ?? '?'} ставок) · ориентир ${fmt(r.est_reference)} (${r.est_catalog_src || 'наша база'}) · +${Math.round(r.gain)} р. · ${r.grade || '—'} · ${r.sale_type} · закончился ${when(r.ended_at)}`);
    console.log(`     причина на момент оценки: ${reasonFor({ ...r, sent: false, notified_at: null, outcome: null, ends_at: null })}`);
  }

  // Проданные дорого без ориентира — там, где каталога не хватает
  const noRef = rows.filter((r) => r.outcome === 'sold' && r.final_price != null && r.parsed && (r.parsed.isPrecious || r.parsed.isSilver) && r.est_reference == null)
    .sort((a, b) => Number(b.final_price) - Number(a.final_price));
  console.log(`\n== Проданы без ориентира (каталог не покрыл): ${noRef.length} лотов, топ-${Math.min(top, 10)} по цене`);
  for (const r of noRef.slice(0, 10)) {
    const p = r.parsed;
    console.log(`  ${fmt(r.final_price)} · ${r.grade || 'без состояния'} · ${[p.denomination, p.year, p.mintmaster || p.mint, p.ruler].filter(Boolean).join(' ')} · ${r.url}`);
  }

  printSlabs(rows);
  await printPros().catch((err) => console.log(`\n== Перекупщики: нет данных (${err.message}; нужна миграция 015)`));

  const cat = await pool.query(`SELECT source, count(*)::int AS types, max(fetched_at) AS updated FROM listings.coin_catalog GROUP BY source`);
  const sales = await pool.query(`SELECT count(*)::int AS n, count(price)::int AS priced, min(sold_on) AS from_d, max(sold_on) AS to_d FROM listings.coin_sales`);
  console.log('\n== Каталог:');
  for (const r of cat.rows) console.log(`  ${r.source}: ${r.types} типов/вариантов, обновлён ${when(r.updated)}`);
  const s = sales.rows[0];
  console.log(`  проходов gdenashel: ${s.n}, с ценой ${s.priced}${s.from_d ? `, ${when(s.from_d).slice(0, 10)} … ${when(s.to_d).slice(0, 10)}` : ''}`);
}

main().catch((err) => { console.error(err.message); process.exitCode = 1; }).finally(() => pool.end());
