/**
 * Bucket antidegen dry-run signals by time-to-resolve and compute settled /
 * mark-to-market PnL per segment. Answers: does fading DEGENs have edge, and
 * WHERE (which time horizon / strength / DEGEN-count slice)?
 *
 * Data source: dry_run_signals. For each unique (cid, dir) we fetch current
 * market state from Polymarket gamma and compute the fade-direction PnL.
 *
 * Flags (all optional):
 *   --min-strength=N   only signals with strength >= N           (default 60)
 *   --all-strengths    shorthand for --min-strength=0  (see the full distribution;
 *                      needed for the minWallets:1 observation, where single-DEGEN
 *                      signals mostly score < 60 but are still recorded)
 *   --days=N           look-back window in days                  (default 14)
 *   --by-degen-count   split every segment into 1-DEGEN vs 2+-DEGEN, and print a
 *                      headline summary comparing the two (was minWallets:2 worth it?)
 *
 * Examples:
 *   node scripts/analyze-by-bucket.mjs
 *   node scripts/analyze-by-bucket.mjs --all-strengths --by-degen-count --days=21
 *
 * NOTE: only SETTLED markets give a real verdict. Far-future markets (WC,
 * politics) won't have resolved inside the window — read settled_n / settled_hit.
 */

import Database from "better-sqlite3";

const GAMMA = "https://gamma-api.polymarket.com/markets";

// ── flags ───────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const flagNum = (name, def) => {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  const v = a ? Number(a.split("=")[1]) : def;
  return Number.isFinite(v) ? v : def;
};
const hasFlag = (name) => args.includes(`--${name}`);
const minStrength = hasFlag("all-strengths") ? 0 : flagNum("min-strength", 60);
const days = flagNum("days", 14);
const byDegen = hasFlag("by-degen-count");

// ── load ──────────────────────────────────────────────────────────────────
const db = new Database("./data/polytrack.db", { readonly: true });
const rows = db
  .prepare(`
    SELECT condition_id, direction, current_price, market_title, strength,
           created_at, wallet_addrs
    FROM dry_run_signals
    WHERE strategy = 'antidegen'
      AND strength >= ?
      AND created_at > strftime('%s','now') * 1000 - ? * 86400 * 1000
  `)
  .all(minStrength, days);
db.close();

console.log(`Loaded ${rows.length} signals (strength>=${minStrength}, last ${days}d${byDegen ? ", split by DEGEN count" : ""})`);
if (rows.length === 0) {
  console.log("No data. Exit.");
  process.exit(0);
}

// De-dup by (condition_id, direction) — same signal re-fires across scans.
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
// `current_price` is recorded as the DEGEN's ORIGINAL-side price at signal
// time, so on a binary market the fade outcome's entry is (1 - current_price).
// Return per $1 invested in the fade:
//   pnl_per_dollar = (fade_outcome_price_now / fade_entry) - 1
// Matches scripts/backtest-antidegen.js (fadeEntry = 1 - current_price).
function computePnlPerDollar(signal, market) {
  const outcomes = JSON.parse(market.outcomes || "[]");
  const prices   = JSON.parse(market.outcomePrices || "[0,0]");
  const fadeIdx  = outcomes.findIndex((o) => String(o).toUpperCase() === signal.direction);
  if (fadeIdx < 0) return null;
  const fadePxNow = Number(prices[fadeIdx]);
  if (!Number.isFinite(fadePxNow) || fadePxNow < 0) return null;

  // Fade entry = opposite outcome's price = 1 - (DEGEN's origDir price).
  const entry = 1 - signal.current_price;
  if (!(entry > 0 && entry < 1)) return null;
  return { pnlPerDollar: (fadePxNow / entry) - 1, entry, fadePxNow, closed: market.closed };
}

// DEGEN-count of a signal, from the recorded comma-separated wallet_addrs.
function degenCount(signal) {
  if (!signal.wallet_addrs) return 0;
  return String(signal.wallet_addrs).split(",").map((s) => s.trim()).filter(Boolean).length;
}
const degenLabel = (signal) => (degenCount(signal) >= 2 ? "2+deg" : "1deg");

// ── accumulate ──────────────────────────────────────────────────────────────
const TIME_ORDER = ["same_day", "short", "long", "xlong", "already_ended", "unknown", "market_not_found"];
const blank = () => ({ n: 0, hits: 0, sumPnlPerD: 0, totalPnlOn5: 0, settled: 0, settledHits: 0, settledPnlOn5: 0 });
const ensure = (map, k) => (map.has(k) ? map.get(k) : (map.set(k, blank()), map.get(k)));
function add(stat, pnl) {
  stat.n++;
  if (pnl.pnlPerDollar > 0) stat.hits++;
  stat.sumPnlPerD += pnl.pnlPerDollar;
  stat.totalPnlOn5 += pnl.pnlPerDollar * 5;
  if (pnl.closed) {
    stat.settled++;
    if (pnl.pnlPerDollar > 0) stat.settledHits++;
    stat.settledPnlOn5 += pnl.pnlPerDollar * 5;
  }
}

const segments = new Map();     // segKey -> stat
const degenSummary = new Map(); // "1deg"/"2+deg" -> stat   (only when --by-degen-count)

for (const s of signals) {
  const m = markets.get(s.condition_id);
  const tb = m ? bucketFor(s, m) : "market_not_found";
  const segKey = byDegen ? `${degenLabel(s)} | ${tb}` : tb;
  const seg = ensure(segments, segKey);
  const dsum = byDegen ? ensure(degenSummary, degenLabel(s)) : null;
  const pnl = m ? computePnlPerDollar(s, m) : null;
  if (!pnl) { seg.n++; if (dsum) dsum.n++; continue; }
  add(seg, pnl);
  if (dsum) add(dsum, pnl);
}

// ── render ──────────────────────────────────────────────────────────────────
const fmtRow = (label, s) => ({
  segment:        label,
  n:              s.n,
  hit_rate:       s.n ? `${(100 * s.hits / s.n).toFixed(1)}%` : "—",
  "avg_pnl_$":    s.n ? (s.sumPnlPerD / s.n).toFixed(3) : "—",
  settled_n:      s.settled,
  settled_hit:    s.settled ? `${(100 * s.settledHits / s.settled).toFixed(1)}%` : "—",
  "settled_$5":   s.settledPnlOn5.toFixed(2),
});
const timeIdx = (tb) => { const i = TIME_ORDER.indexOf(tb); return i < 0 ? 99 : i; };
function sortKey(a, b) {
  if (byDegen) {
    const [da, ta] = a.split(" | ");
    const [dbk, tbk] = b.split(" | ");
    if (da !== dbk) return da < dbk ? -1 : 1;       // 1deg before 2+deg
    return timeIdx(ta) - timeIdx(tbk);
  }
  return timeIdx(a) - timeIdx(b);
}
console.table([...segments.keys()].sort(sortKey).map((k) => fmtRow(k, segments.get(k))));

const grand = [...segments.values()].reduce((a, s) => ({
  n: a.n + s.n, hits: a.hits + s.hits, totalPnlOn5: a.totalPnlOn5 + s.totalPnlOn5,
  settled: a.settled + s.settled, settledHits: a.settledHits + s.settledHits, settledPnlOn5: a.settledPnlOn5 + s.settledPnlOn5,
}), blank());
console.log("---");
console.log(`Grand:   n=${grand.n}  hit=${grand.n ? (100*grand.hits/grand.n).toFixed(1) : "—"}%  pnl_on_$5=${grand.totalPnlOn5.toFixed(2)}`);
console.log(`Settled: n=${grand.settled}  hit=${grand.settled ? (100*grand.settledHits/grand.settled).toFixed(1) : "—"}%  pnl_$5=${grand.settledPnlOn5.toFixed(2)}`);

if (byDegen) {
  console.log("\n── DEGEN-count summary (the headline: fade 1 vs 2+ degens) ──");
  console.table(["1deg", "2+deg"].filter((k) => degenSummary.has(k)).map((k) => fmtRow(k, degenSummary.get(k))));
  console.log("If 2+deg's settled_hit is meaningfully higher than 1deg's, the minWallets:2");
  console.log("raise was justified. If they're similar, minWallets:1 gives more signal for free.");
}

console.log("\nReading it:");
console.log("  - settled_n / settled_hit are the ONLY real verdict — open markets are mark-to-market noise.");
console.log("  - same_day = today's sports (resolve fast → settle in-window); long/xlong = politics/futures");
console.log("    (resolve far out → rarely settle in-window, so their settled_n stays low for a while).");
console.log("  - decision rule: a slice with settled_n>=10 AND settled_hit>=55% is a real edge candidate.");
