/**
 * probe-btc-arb.mjs — READ-ONLY. Measures depth/fee-adjusted mispricing in
 * current BTC prediction markets. No orders, no money, no DB writes. Pulls
 * markets + orderbooks from gamma/CLOB and runs the checks from src/btc-arb.js.
 *
 * Usage: node scripts/probe-btc-arb.mjs [--fee=0] [--cap=100] [--tol=0.03]
 */
import "dotenv/config";
import { fetchMarkets, fetchOrderBook } from "../src/polymarket-api.js";
import {
  parseBtcMarket, groupFamilies, checkBinaryArb, checkBucketArb,
  checkCalendarMonotonicity, checkThresholdMonotonicity,
} from "../src/btc-arb.js";

const args = process.argv.slice(2);
const num = (n, d) => { const a = args.find(x => x.startsWith(`--${n}=`)); const v = a ? Number(a.split("=")[1]) : d; return Number.isFinite(v) ? v : d; };
const FEE = num("fee", 0);
const CAP = num("cap", 100);
const TOL = num("tol", 0.03);
const PROMISING_PROFIT = 20;  // A/B gate: depth-adjusted profit USD
const PROMISING_VIOL = 0.03;  // C/D gate: violation magnitude

const bestAsk = (asks) => (Array.isArray(asks) && asks.length) ? [...asks].sort((a, b) => a.price - b.price)[0] : null;

async function main() {
  console.log("*** READ-ONLY BTC mispricing probe — no orders, no money. ***");
  console.log(`fee=${FEE} cap=$${CAP} tol=${TOL}\n`);

  const events = await fetchMarkets({ limit: 200 });
  const flat = [];
  for (const e of events) for (const m of (e.markets || [])) flat.push(m);
  const btc = flat.filter(m => /bitcoin|btc/i.test(m.question || ""));
  console.log(`Found ${btc.length} BTC markets (of ${flat.length} scanned).`);

  let unparsed = 0, noBook = 0;
  const binaryGaps = [], bucketGaps = [], familyMarkets = [];

  for (const m of btc) {
    const tokens = Array.isArray(m.tokens) ? m.tokens : [];
    if (tokens.length < 2) { noBook++; continue; }
    const parsed = parseBtcMarket(m.question || "");
    if (parsed.kind === "unknown") unparsed++;

    let books;
    try {
      books = [];
      for (const tk of tokens) {
        const b = await fetchOrderBook(tk.token_id);
        books.push({ outcome: tk.outcome, asks: (b && b.asks) || [] });
      }
    } catch { noBook++; continue; }

    if (tokens.length === 2) {
      const yes = books.find(b => /yes/i.test(b.outcome)) || books[0];
      const no  = books.find(b => /no/i.test(b.outcome))  || books[1];
      const bin = checkBinaryArb({ yesAsks: yes.asks, noAsks: no.asks, fee: FEE, capUsd: CAP });
      if (bin.profitUsd > 0) binaryGaps.push({ q: (m.question || "").slice(0, 44), ...bin });
      const ya = bestAsk(yes.asks);
      if (parsed.kind === "threshold" && parsed.targetUsd != null && parsed.dateMs != null && ya) {
        familyMarkets.push({ ...parsed, conditionId: m.conditionId, question: m.question, prob: ya.price });
      }
    } else {
      // multi-outcome bucket: one share of each outcome should cost < $1
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

  console.log(`\nSkipped: ${unparsed} unparsed titles, ${noBook} no-orderbook/<2-token.`);

  const abProfit = [...binaryGaps, ...bucketGaps].reduce((s, g) => s + g.profitUsd, 0);
  const promising = [...binaryGaps, ...bucketGaps].some(g => g.profitUsd >= PROMISING_PROFIT)
    || cal.some(v => v.magnitude >= PROMISING_VIOL) || thr.some(v => v.magnitude >= PROMISING_VIOL);
  console.log(`\nVERDICT: A/B riskless profit now=$${abProfit.toFixed(2)}, ${cal.length + thr.length} consistency violations.`);
  console.log(promising
    ? ">> PROMISING — run a few more times today; if it recurs, graduate to Phase 2 (persistence sampler)."
    : ">> NO snapshot edge — if this holds across several runs, the BTC-arb direction is not worth building.");
  console.log("\nReminder: A/B are strict riskless. C/D are relative-value SIGNALS — confirm contract");
  console.log("semantics (touch-by-date vs at-date) before treating a violation as a true arb.");
}

main().catch(e => { console.error("probe failed:", e); process.exit(1); });
