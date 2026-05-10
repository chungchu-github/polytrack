/**
 * Backtest antidegen dry-run signals: pull each signal's market state from
 * Polymarket gamma API, compare fade-direction outcome vs entry, print
 * hit rate + simulated PnL.
 *
 * Usage:  node scripts/backtest-antidegen.js [minStrength] [hoursBack]
 * Defaults: minStrength=60, hoursBack=48
 *
 * PnL model (per $1 of fade-direction shares):
 *   - fade entry cost  = 1 - current_price   (DEGEN was on origDir @ current_price,
 *                                              so fade side cost ≈ 1 - that)
 *   - settled win      = +(1 - fadeEntry)    (fadePxNow = 1)
 *   - settled loss     = -fadeEntry          (fadePxNow = 0)
 *   - open (mark-to-mkt) = (currentFadePrice - fadeEntry)
 */
import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.POLYTRACK_DB || path.resolve(__dirname, "../data/polytrack.db");
const GAMMA = "https://gamma-api.polymarket.com/markets";

const minStrength = Number(process.argv[2] ?? 60);
const hoursBack   = Number(process.argv[3] ?? 48);

const db = new Database(DB_PATH, { readonly: true });
const cutoff = Date.now() - hoursBack * 3600 * 1000;
const rows = db.prepare(`
  SELECT condition_id, direction, current_price, market_title, strength, created_at
  FROM dry_run_signals
  WHERE strategy='antidegen' AND strength >= ? AND created_at > ?
  ORDER BY created_at DESC
`).all(minStrength, cutoff);

console.log(`Loaded ${rows.length} signals (strength≥${minStrength}, last ${hoursBack}h)\n`);
if (!rows.length) process.exit(0);

// Two-pass fetch: gamma's `closed` filter defaults to false, so settled markets
// are silently dropped unless we ask for them explicitly. Query each chunk twice
// (closed=false + closed=true) and merge. Repeated query-param syntax verified
// against live API (and matches src/polymarket-api.js:271).
async function fetchAll(cids) {
  const byCid = new Map();
  for (let i = 0; i < cids.length; i += 50) {
    const chunk = cids.slice(i, i + 50);
    const qs = chunk.map(c => `condition_ids=${encodeURIComponent(c)}`).join("&");
    for (const closed of ["false", "true"]) {
      const r = await fetch(`${GAMMA}?${qs}&closed=${closed}&limit=${chunk.length}`);
      const j = await r.json();
      if (!Array.isArray(j)) continue;
      for (const m of j) if (m?.conditionId) byCid.set(m.conditionId, m);
    }
  }
  return byCid;
}

const cids = [...new Set(rows.map(r => r.condition_id))];
const byCid = await fetchAll(cids);
console.log(`Fetched ${byCid.size}/${cids.length} markets from gamma\n`);

let settled = { win: 0, loss: 0, pnl: 0, count: 0 };
let open    = { pnl: 0, count: 0 };
let missing = 0, purged = 0;

const lines = [];
for (const r of rows) {
  const m = byCid.get(r.condition_id);
  if (!m) { missing++; continue; }

  const outcomes = safeParseArr(m.outcomes);             // e.g. ["Yes","No"]
  const prices   = safeParseArr(m.outcomePrices).map(Number);
  if (!outcomes.length || !prices.length) { missing++; continue; }

  // Detect purged settlement (very old closed markets get ["0","0"])
  if (m.closed && prices[0] === 0 && prices[1] === 0) { purged++; continue; }

  const fadeIdx = outcomes.findIndex(o => String(o).toUpperCase() === r.direction);
  if (fadeIdx < 0) { missing++; continue; }

  const fadePxNow = prices[fadeIdx];
  const fadeEntry = 1 - r.current_price;
  const pnl = fadePxNow - fadeEntry;
  const status = m.closed ? (fadePxNow > 0.5 ? "WIN " : "LOSS") : "OPEN";

  if (m.closed) {
    settled.count++;
    settled.pnl += pnl;
    if (fadePxNow > 0.5) settled.win++; else settled.loss++;
  } else {
    open.count++;
    open.pnl += pnl;
  }

  lines.push({
    status, dir: r.direction, str: r.strength,
    entry: fadeEntry.toFixed(3), now: fadePxNow.toFixed(3),
    pnl: (pnl >= 0 ? "+" : "") + pnl.toFixed(3),
    title: (r.market_title || "").slice(0, 50),
  });
}

console.log("status  dir  str  entry  now    pnl     title");
console.log("------  ---  ---  -----  -----  ------  -----");
for (const l of lines) {
  console.log(`${l.status.padEnd(6)}  ${l.dir.padEnd(3)}  ${String(l.str).padEnd(3)}  ${l.entry}  ${l.now}  ${l.pnl.padEnd(6)}  ${l.title}`);
}

console.log("\n──── SUMMARY ────");
console.log(`Settled:  ${settled.count}  win=${settled.win}  loss=${settled.loss}  hitRate=${settled.count ? (settled.win/settled.count*100).toFixed(1) : "—"}%  totalPnL=${settled.pnl.toFixed(3)}  avgPnL=${settled.count ? (settled.pnl/settled.count).toFixed(3) : "—"}`);
console.log(`Open  :  ${open.count}  mark-to-mkt PnL=${open.pnl.toFixed(3)}  avgPnL=${open.count ? (open.pnl/open.count).toFixed(3) : "—"}`);
console.log(`Missing/purged: ${missing}/${purged}`);

const totalCount = settled.count + open.count;
const totalPnL   = settled.pnl + open.pnl;
console.log(`\nCombined (${totalCount}): totalPnL=${totalPnL.toFixed(3)}  avgPnL/signal=${totalCount ? (totalPnL/totalCount).toFixed(3) : "—"}`);
console.log(`\n→ avgPnL > 0 means fade is profitable. > 0.05 means clearly profitable.`);
console.log(`→ avgPnL < -0.05 means fade is losing — keep dryRun, tighten gates.`);

function safeParseArr(s) {
  if (Array.isArray(s)) return s;
  try { const v = JSON.parse(s ?? "[]"); return Array.isArray(v) ? v : []; }
  catch { return []; }
}
