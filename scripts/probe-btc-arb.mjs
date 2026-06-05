/**
 * probe-btc-arb.mjs — READ-ONLY. Measures depth/fee-adjusted mispricing in
 * current BTC prediction markets. No orders, no money, no DB writes. Pulls
 * markets from gamma + orderbooks via a DIRECT CLOB /book call (bypassing the
 * shared circuit-breakered apiFetch so a few 404s on closed/illiquid markets
 * don't block the whole survey). Runs the checks from src/btc-arb.js.
 *
 * Usage: node scripts/probe-btc-arb.mjs [--fee=0] [--cap=100] [--tol=0.03] [--list]
 */
import "dotenv/config";
import { fetchMarkets } from "../src/polymarket-api.js";
import {
  parseBtcMarket, groupFamilies, checkBinaryArb, checkBucketArb,
  checkCalendarMonotonicity, checkThresholdMonotonicity,
} from "../src/btc-arb.js";

const args = process.argv.slice(2);
const num = (n, d) => { const a = args.find(x => x.startsWith(`--${n}=`)); const v = a ? Number(a.split("=")[1]) : d; return Number.isFinite(v) ? v : d; };
const has = (n) => args.includes(`--${n}`);
const FEE = num("fee", 0);
const CAP = num("cap", 100);
const TOL = num("tol", 0.03);
const PROMISING_PROFIT = 20;
const PROMISING_VIOL = 0.03;

const CLOB = process.env.POLY_CLOB_URL || "https://clob.polymarket.com";
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const bestAsk = (asks) => (Array.isArray(asks) && asks.length) ? [...asks].sort((a, b) => a.price - b.price)[0] : null;

// Direct CLOB orderbook fetch. Returns { asks:[{price,size}] } or null. Does NOT
// go through the shared apiFetch breaker — a 404 here is "no book", not a fault.
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

async function main() {
  console.log("*** READ-ONLY BTC mispricing probe — no orders, no money. ***");
  console.log(`fee=${FEE} cap=$${CAP} tol=${TOL}\n`);

  const events = await fetchMarkets({ limit: 200 });
  const flat = [];
  for (const e of events) for (const m of (e.markets || [])) flat.push(m);
  const btc = flat.filter(m => /bitcoin|btc/i.test(m.question || ""));
  console.log(`Found ${btc.length} BTC markets (of ${flat.length} scanned).`);

  let booksOk = 0, booksFail = 0, unparsed = 0;
  const binaryGaps = [], bucketGaps = [], familyMarkets = [], found = [];

  for (const m of btc) {
    const tokens = Array.isArray(m.tokens) ? m.tokens : [];
    const parsed = parseBtcMarket(m.question || "");
    if (parsed.kind === "unknown") unparsed++;

    // fetch each outcome's book (direct, gentle)
    const books = [];
    for (const tk of tokens) {
      const b = await getBook(tk.token_id);
      if (b) booksOk++; else booksFail++;
      books.push({ outcome: tk.outcome, asks: b ? b.asks : null });
      await sleep(120);
    }
    const withBook = books.filter(b => b.asks && b.asks.length);
    found.push({
      q: (m.question || "").slice(0, 40),
      kind: parsed.kind,
      toks: tokens.length,
      books_ok: `${withBook.length}/${tokens.length}`,
      best: withBook.map(b => `${b.outcome}:${bestAsk(b.asks)?.price ?? "—"}`).join(" ") || "(no book)",
    });

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

  console.log("\n── BTC markets found (discovery + book availability) ──");
  if (found.length) console.table(found);
  else console.log("(none)");

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

  console.log(`\nBooks: ${booksOk} fetched, ${booksFail} failed (404/no-book). Unparsed titles: ${unparsed}.`);

  // verdict — honest about whether we could measure at all
  const abProfit = [...binaryGaps, ...bucketGaps].reduce((s, g) => s + g.profitUsd, 0);
  if (booksOk === 0) {
    console.log(`\nVERDICT: INVALID — fetched 0 orderbooks. Either these ${btc.length} markets are`);
    console.log("closed/illiquid (no book) or discovery found the wrong markets. NOT a 'no edge' result.");
    console.log("See the markets table above to decide whether discovery needs broadening.");
    return;
  }
  const promising = [...binaryGaps, ...bucketGaps].some(g => g.profitUsd >= PROMISING_PROFIT)
    || cal.some(v => v.magnitude >= PROMISING_VIOL) || thr.some(v => v.magnitude >= PROMISING_VIOL);
  console.log(`\nVERDICT (over ${booksOk} books fetched): A/B riskless profit now=$${abProfit.toFixed(2)}, ${cal.length + thr.length} consistency violations.`);
  console.log(promising
    ? ">> PROMISING — run a few more times today; if it recurs, graduate to Phase 2 (persistence sampler)."
    : ">> NO snapshot edge across the books we could read — re-run a few times before concluding.");
  console.log("\nReminder: A/B are strict riskless. C/D are relative-value SIGNALS — confirm contract");
  console.log("semantics (touch-by-date vs at-date) before treating a violation as a true arb.");
}

main().catch(e => { console.error("probe failed:", e); process.exit(1); });
