/**
 * probe-btc-arb.mjs — READ-ONLY. Measures depth/fee-adjusted mispricing in
 * current BTC prediction markets. No orders, no money, no DB writes.
 *
 * Discovery:
 *   default  — BTC markets within the top-200 events by 24h volume (fast).
 *   --all    — ALL active BTC markets, paginated straight from gamma /markets
 *              (slower; definitively surfaces low-volume / short-term markets).
 *
 * Orderbooks via a DIRECT CLOB /book call (bypasses the shared circuit breaker
 * so 404s on closed/illiquid markets don't block the survey). Checks: src/btc-arb.js.
 *
 * Usage: node scripts/probe-btc-arb.mjs [--all] [--fee=0] [--cap=100] [--tol=0.03] [--max=80]
 */
import "dotenv/config";
import { fetchMarkets, normaliseMarket } from "../src/polymarket-api.js";
import {
  parseBtcMarket, groupFamilies, checkBinaryArb, checkBucketArb,
  checkCalendarMonotonicity, checkThresholdMonotonicity,
} from "../src/btc-arb.js";

const args = process.argv.slice(2);
const num = (n, d) => { const a = args.find(x => x.startsWith(`--${n}=`)); const v = a ? Number(a.split("=")[1]) : d; return Number.isFinite(v) ? v : d; };
const has = (n) => args.includes(`--${n}`);
const ALL = has("all");
const FEE = num("fee", 0);
const CAP = num("cap", 100);
const TOL = num("tol", 0.03);
const MAX_PROBE = num("max", 80);
const PROMISING_PROFIT = 20;
const PROMISING_VIOL = 0.03;

const GAMMA = "https://gamma-api.polymarket.com/markets";
const CLOB = process.env.POLY_CLOB_URL || "https://clob.polymarket.com";
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const bestAsk = (asks) => (Array.isArray(asks) && asks.length) ? [...asks].sort((a, b) => a.price - b.price)[0] : null;
const isBtc = (m) => /bitcoin|btc/i.test(m.question || "");

async function getBook(tokenId) {
  try {
    const r = await fetch(`${CLOB}/book?token_id=${tokenId}`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const j = await r.json();
    const asks = (Array.isArray(j.asks) ? j.asks : [])
      .map(a => ({ price: Number(a.price), size: Number(a.size) }))
      .filter(a => Number.isFinite(a.price) && Number.isFinite(a.size) && a.size > 0);
    return { asks };
  } catch { return null; }
}

async function discoverViaEvents() {
  const events = await fetchMarkets({ limit: 200 });
  const flat = [];
  for (const e of events) for (const m of (e.markets || [])) flat.push(m);
  return { markets: flat.filter(isBtc), scanned: flat.length, mode: "top-200 events by 24h volume" };
}

async function discoverAll() {
  const out = []; let scanned = 0;
  const PAGE = 100;            // gamma caps page size at ~100 regardless of limit
  for (let page = 0; page < 80; page++) {   // up to 8000 active markets
    let arr;
    try {
      const r = await fetch(`${GAMMA}?active=true&closed=false&limit=${PAGE}&offset=${page * PAGE}`, { signal: AbortSignal.timeout(15000) });
      arr = await r.json();
    } catch { break; }
    if (!Array.isArray(arr) || arr.length === 0) break;   // genuine end
    scanned += arr.length;
    for (const m of arr) if (isBtc(m)) out.push(normaliseMarket(m));
    if (arr.length < PAGE) break;                          // short last page
    await sleep(120);
  }
  return { markets: out, scanned, mode: `ALL active markets (gamma /markets, paginated x${PAGE})` };
}

async function main() {
  console.log("*** READ-ONLY BTC mispricing probe — no orders, no money. ***");
  console.log(`mode=${ALL ? "--all" : "events"} fee=${FEE} cap=$${CAP} tol=${TOL}\n`);

  const disc = ALL ? await discoverAll() : await discoverViaEvents();
  const btc = disc.markets;
  console.log(`Discovery: ${disc.mode}. Found ${btc.length} BTC markets (of ${disc.scanned} scanned).`);

  // Discovery table FIRST — titles + kind answer "are there short-term markets?"
  // ("direction" = up/down; look also for hourly/daily/today/time-of-day titles.)
  console.log("\n── BTC markets discovered (titles answer the short-term question) ──");
  console.table(btc.slice(0, 60).map(m => {
    const p = parseBtcMarket(m.question || "");
    return { q: (m.question || "").slice(0, 50), kind: p.kind, toks: (m.tokens || []).length };
  }));
  if (btc.length > 60) console.log(`(+${btc.length - 60} more not shown)`);

  const probeSet = btc.slice(0, MAX_PROBE);
  if (btc.length > MAX_PROBE) console.log(`\nDeep-probing first ${MAX_PROBE} of ${btc.length} for books + arb.`);

  let booksOk = 0, booksFail = 0;
  const binaryGaps = [], bucketGaps = [], familyMarkets = [];

  for (const m of probeSet) {
    const tokens = Array.isArray(m.tokens) ? m.tokens : [];
    if (tokens.length < 2) continue;
    const parsed = parseBtcMarket(m.question || "");
    const books = [];
    for (const tk of tokens) {
      const b = await getBook(tk.token_id);
      if (b) booksOk++; else booksFail++;
      books.push({ outcome: tk.outcome, asks: b ? b.asks : null });
      await sleep(120);
    }
    const withBook = books.filter(b => b.asks && b.asks.length);

    if (tokens.length === 2 && withBook.length === 2) {
      const yes = books.find(b => /yes/i.test(b.outcome)) || books[0];
      const no  = books.find(b => /no/i.test(b.outcome))  || books[1];
      const bin = checkBinaryArb({ yesAsks: yes.asks, noAsks: no.asks, fee: FEE, capUsd: CAP });
      if (bin.profitUsd > 0) binaryGaps.push({ q: (m.question || "").slice(0, 44), ...bin });
      const ya = bestAsk(yes.asks);
      if (parsed.kind === "threshold" && parsed.targetUsd != null && parsed.dateMs != null && ya) {
        familyMarkets.push({ ...parsed, conditionId: m.conditionId, question: m.question, prob: ya.price });
      }
    } else if (tokens.length >= 3 && withBook.length === tokens.length) {
      const legsBest = books.map(b => bestAsk(b.asks));
      if (legsBest.every(Boolean)) {
        const buck = checkBucketArb({ legsBest, fee: FEE });
        if (buck.profitUsd > 0) bucketGaps.push({ q: (m.question || "").slice(0, 44), legs: tokens.length, ...buck });
      }
    }
  }

  console.log(`\n── A: binary riskless (YES+NO ask < $${(1 - FEE).toFixed(2)}) ──`);
  console.log(binaryGaps.length ? "" : "none.");
  if (binaryGaps.length) console.table(binaryGaps.map(g => ({ market: g.q, gap: g.gap.toFixed(3), exec_usd: g.executableUsd.toFixed(0), profit_usd: g.profitUsd.toFixed(2) })));

  console.log(`\n── B: multi-outcome bucket riskless (Σ asks < $${(1 - FEE).toFixed(2)}) ──`);
  console.log(bucketGaps.length ? "" : "none.");
  if (bucketGaps.length) console.table(bucketGaps.map(g => ({ market: g.q, legs: g.legs, gap: g.gap.toFixed(3), shares: g.executableShares.toFixed(0), profit_usd: g.profitUsd.toFixed(2) })));

  const fam = groupFamilies(familyMarkets);
  const cal = checkCalendarMonotonicity(fam.calendar, TOL);
  const thr = checkThresholdMonotonicity(fam.threshold, TOL);
  console.log(`\n── C: calendar monotonicity violations (>${TOL}) ──`);
  console.log(cal.length ? "" : "none.");
  if (cal.length) console.table(cal.map(v => ({ target: v.targetUsd, mag: v.magnitude.toFixed(3), earlier: v.earlier.question?.slice(0, 28), later: v.later.question?.slice(0, 28) })));
  console.log(`\n── D: threshold monotonicity violations (>${TOL}) ──`);
  console.log(thr.length ? "" : "none.");
  if (thr.length) console.table(thr.map(v => ({ date: new Date(Number(v.dateKey)).toISOString().slice(0, 10), mag: v.magnitude.toFixed(3), low: v.lower.question?.slice(0, 28), high: v.higher.question?.slice(0, 28) })));

  console.log(`\nBooks: ${booksOk} fetched, ${booksFail} failed (404/no-book).`);

  const abProfit = [...binaryGaps, ...bucketGaps].reduce((s, g) => s + g.profitUsd, 0);
  if (booksOk === 0) {
    console.log(`\nVERDICT: INVALID — fetched 0 orderbooks across ${probeSet.length} markets probed. NOT a 'no edge' result.`);
    return;
  }
  const promising = [...binaryGaps, ...bucketGaps].some(g => g.profitUsd >= PROMISING_PROFIT)
    || cal.some(v => v.magnitude >= PROMISING_VIOL) || thr.some(v => v.magnitude >= PROMISING_VIOL);
  console.log(`\nVERDICT (over ${booksOk} books fetched): A/B riskless profit now=$${abProfit.toFixed(2)}, ${cal.length + thr.length} consistency violations.`);
  console.log(promising
    ? ">> PROMISING — run a few more times today; if it recurs, graduate to Phase 2 (persistence sampler)."
    : ">> NO snapshot edge across the books we could read.");
  console.log("\nReminder: A/B are strict riskless. C/D are relative-value SIGNALS — confirm contract");
  console.log("semantics (touch-by-date vs at-date) before treating a violation as a true arb.");
}

main().catch(e => { console.error("probe failed:", e); process.exit(1); });
