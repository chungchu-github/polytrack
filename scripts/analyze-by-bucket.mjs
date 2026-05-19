/**
 * Bucket antidegen signals by market "time to resolve" and compute
 * mark-to-market PnL per bucket. Goal: find out if fade-DEGEN works on
 * long-horizon (political) markets but loses on same-day (sports) markets,
 * as suggested by the first $30 of live trades.
 *
 * Data source: dry_run_signals — the observation-week dataset (~80 signals
 * at strength ≥ 60). For each signal we fetch the current market state
 * from Polymarket gamma and compute the fade-direction PnL.
 *
 * Buckets (by signal-created → market-end gap):
 *   same-day   ≤ 24h
 *   short      24h < x ≤ 7d
 *   long       7d  < x ≤ 30d
 *   xlong      > 30d  (election, year-out futures, etc)
 *
 * Each row reported: bucket, n, hit_rate, avg_pnl_per_dollar, total_pnl.
 *
 * Run: node scripts/analyze-by-bucket.mjs
 */

import Database from "better-sqlite3";

const GAMMA = "https://gamma-api.polymarket.com/markets";

const db = new Database("./data/polytrack.db", { readonly: true });

// Pull all antidegen signals with strength >= 60 from the past 14 days.
// Wider window than backtest-antidegen.js (48h) so we have enough samples
// per bucket for the comparison to be meaningful.
const rows = db
  .prepare(`
    SELECT condition_id, direction, current_price, market_title, strength,
           created_at
    FROM dry_run_signals
    WHERE strategy = 'antidegen'
      AND strength >= 60
      AND created_at > strftime('%s','now') * 1000 - 14 * 86400 * 1000
  `)
  .all();
db.close();

console.log(`Loaded ${rows.length} signals (strength≥60, last 14d)`);
if (rows.length === 0) {
  console.log("No data. Exit.");
  process.exit(0);
}

// De-dup by (condition_id, direction) — same signal can re-fire across scans.
const uniq = new Map();
for (const r of rows) {
  const k = `${r.condition_id}|${r.direction}`;
  if (!uniq.has(k)) uniq.set(k, r);
}
const signals = [...uniq.values()];
console.log(`Deduplicated to ${signals.length} unique (cid, dir) pairs.`);

// Fetch market state in chunks. gamma takes repeated `condition_ids=` params.
async function fetchAll(cids) {
  const byCid = new Map();
  for (let i = 0; i < cids.length; i += 50) {
    const chunk = cids.slice(i, i + 50);
    const qs = chunk.map((c) => `condition_ids=${encodeURIComponent(c)}`).join("&");
    for (const closed of ["false", "true"]) {
      const r = await fetch(`${GAMMA}?${qs}&closed=${closed}&limit=${chunk.length}`);
      const j = await r.json();
      if (Array.isArray(j)) {
        for (const m of j) if (m?.conditionId) byCid.set(m.conditionId, m);
      }
    }
  }
  return byCid;
}

const cids = [...new Set(signals.map((s) => s.condition_id))];
console.log(`Fetching ${cids.length} markets from gamma…`);
const markets = await fetchAll(cids);
console.log(`Got ${markets.size}/${cids.length} markets.`);

// Categorise: time-to-resolve at signal-create time.
function bucketFor(signal, market) {
  const endIso = market.endDate || market.endDateIso || market.end_date_iso;
  if (!endIso) return "unknown";
  const endMs = new Date(endIso).getTime();
  if (!Number.isFinite(endMs)) return "unknown";
  const gapHours = (endMs - signal.created_at) / 3600_000;
  if (gapHours < 0)      return "already_ended";   // signal fired after resolution
  if (gapHours <= 24)    return "same_day";
  if (gapHours <= 24*7)  return "short";
  if (gapHours <= 24*30) return "long";
  return "xlong";
}

// PnL semantics: signal.direction is the FADE direction (what we'd buy).
// fade entry cost = signal.current_price (we buy the fade outcome at that
// implied price). Current PnL per $1 invested:
//   pnl_per_dollar = (current_price_of_fade / entry_price_of_fade) - 1
// We use current_price as recorded at signal time as a proxy for entry —
// matches the existing backtest semantics in scripts/backtest-antidegen.js.
function computePnlPerDollar(signal, market) {
  const outcomes = JSON.parse(market.outcomes || "[]");
  const prices   = JSON.parse(market.outcomePrices || "[0,0]");
  const fadeIdx  = outcomes.findIndex((o) => String(o).toUpperCase() === signal.direction);
  if (fadeIdx < 0) return null;
  const fadePxNow = Number(prices[fadeIdx]);
  if (!Number.isFinite(fadePxNow) || fadePxNow < 0) return null;

  // Use recorded current_price as entry. Backtest convention.
  const entry = signal.current_price;
  if (!(entry > 0 && entry < 1)) return null;
  return { pnlPerDollar: (fadePxNow / entry) - 1, entry, fadePxNow, closed: market.closed };
}

// Accumulate per-bucket stats.
const buckets = new Map();
function ensure(b) {
  if (!buckets.has(b)) buckets.set(b, { n: 0, hits: 0, sumPnlPerD: 0, totalPnlOn5: 0, settled: 0, settledHits: 0, settledPnlOn5: 0 });
  return buckets.get(b);
}

for (const s of signals) {
  const m = markets.get(s.condition_id);
  if (!m) { ensure("market_not_found").n++; continue; }

  const b = bucketFor(s, m);
  const pnl = computePnlPerDollar(s, m);
  if (!pnl) { ensure(b).n++; continue; }

  const stat = ensure(b);
  stat.n++;
  if (pnl.pnlPerDollar > 0) stat.hits++;
  stat.sumPnlPerD += pnl.pnlPerDollar;
  stat.totalPnlOn5 += pnl.pnlPerDollar * 5;  // simulate $5 trades like live

  if (pnl.closed) {
    stat.settled++;
    if (pnl.pnlPerDollar > 0) stat.settledHits++;
    stat.settledPnlOn5 += pnl.pnlPerDollar * 5;
  }
}

// Render.
const order = ["same_day", "short", "long", "xlong", "already_ended", "unknown", "market_not_found"];
const table = [];
for (const b of order) {
  if (!buckets.has(b)) continue;
  const s = buckets.get(b);
  table.push({
    bucket: b,
    n: s.n,
    hit_rate: s.n ? `${(100 * s.hits / s.n).toFixed(1)}%` : "—",
    avg_pnl_per_$: s.n ? (s.sumPnlPerD / s.n).toFixed(3) : "—",
    "pnl_on_$5×n": s.totalPnlOn5.toFixed(2),
    settled_n: s.settled,
    settled_hit_rate: s.settled ? `${(100 * s.settledHits / s.settled).toFixed(1)}%` : "—",
    "settled_pnl_$5": s.settledPnlOn5.toFixed(2),
  });
}
console.table(table);

// Grand total (all buckets that produced PnL).
const grand = [...buckets.values()].reduce(
  (a, s) => ({
    n: a.n + s.n,
    hits: a.hits + s.hits,
    totalPnlOn5: a.totalPnlOn5 + s.totalPnlOn5,
    settled: a.settled + s.settled,
    settledHits: a.settledHits + s.settledHits,
    settledPnlOn5: a.settledPnlOn5 + s.settledPnlOn5,
  }),
  { n: 0, hits: 0, totalPnlOn5: 0, settled: 0, settledHits: 0, settledPnlOn5: 0 },
);
console.log("---");
console.log(`Grand:  n=${grand.n}  hit=${(100*grand.hits/grand.n).toFixed(1)}%  pnl_on_$5×n=${grand.totalPnlOn5.toFixed(2)}`);
console.log(`Settled:n=${grand.settled}  hit=${grand.settled?(100*grand.settledHits/grand.settled).toFixed(1):"—"}%  pnl_$5=${grand.settledPnlOn5.toFixed(2)}`);
console.log("");
console.log("Reading the table:");
console.log("  - same_day  = signals on markets that resolved within 24h of firing");
console.log("                (mostly today's sports — strategy lost $25 here in live)");
console.log("  - long/xlong= weeks-to-months-out markets (politics, season-long)");
console.log("                — if antidegen has structural edge anywhere, here");
console.log("  - hit_rate  = % signals where the fade outcome moved up from entry");
console.log("  - settled_* = subset where market is RESOLVED (no more uncertainty)");
