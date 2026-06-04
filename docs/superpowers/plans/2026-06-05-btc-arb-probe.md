# BTC Mispricing Probe (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a read-only probe that measures whether depth- and fee-adjusted mispricing (riskless A/B + consistency C/D) exists in current BTC short-term prediction markets, to decide if the strategy direction is worth pursuing.

**Architecture:** Pure helpers in `src/btc-arb.js` (unit-tested), a thin read-only runner `scripts/probe-btc-arb.mjs` that reuses existing `polymarket-api.js` fetchers and never touches the trade path. No money, no orders, no DB writes.

**Tech Stack:** Node ESM, `node --test`, existing `src/polymarket-api.js` (`fetchMarkets`, `fetchOrderBook`). The runner reads `m.tokens` (from `normaliseMarket`) directly — it does not import the trade path.

Spec: `docs/superpowers/specs/2026-06-05-btc-arb-probe-design.md`

---

### Task 1: `parseBtcMarket` — title → {kind, targetUsd, dateMs}

**Files:**
- Create: `src/btc-arb.js`
- Test: `tests/btc-arb.test.js`

- [ ] **Step 1: Write the failing test**

```js
// tests/btc-arb.test.js
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseBtcMarket } from "../src/btc-arb.js";

describe("parseBtcMarket", () => {
  it("parses a threshold market with full date", () => {
    const r = parseBtcMarket("Will Bitcoin reach $150,000 by December 31, 2026?");
    assert.equal(r.kind, "threshold");
    assert.equal(r.targetUsd, 150000);
    assert.equal(r.dateMs, Date.parse("December 31, 2026"));
  });
  it("expands $k and $m suffixes", () => {
    assert.equal(parseBtcMarket("BTC above $100k on Jul 31?").targetUsd, 100000);
    assert.equal(parseBtcMarket("Bitcoin to $1m this year?").targetUsd, 1000000);
    assert.equal(parseBtcMarket("Bitcoin above $2.5k?").targetUsd, 2500);
  });
  it("classifies up/down as direction", () => {
    assert.equal(parseBtcMarket("Bitcoin Up or Down — July 4, 8PM ET").kind, "direction");
  });
  it("returns unknown for non-threshold, non-direction", () => {
    assert.deepEqual(parseBtcMarket("Will the Lakers win?"), { kind: "unknown", targetUsd: null, dateMs: null });
  });
  it("threshold with no parseable date keeps targetUsd, dateMs null", () => {
    const r = parseBtcMarket("Will Bitcoin hit $200,000 eventually?");
    assert.equal(r.kind, "threshold");
    assert.equal(r.targetUsd, 200000);
    assert.equal(r.dateMs, null);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/btc-arb.test.js`
Expected: FAIL — `does not provide an export named 'parseBtcMarket'`.

- [ ] **Step 3: Write minimal implementation**

```js
// src/btc-arb.js

// Extract a "by/on/before <Month day, year?>" date phrase and parse it. ms or null.
function parseDate(t) {
  const m = t.match(/\b(?:by|on|before)\s+([A-Z][a-z]{2,}\.?\s+\d{1,2}(?:,?\s+\d{4})?)/);
  if (!m) return null;
  const ms = Date.parse(m[1]);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Parse a BTC market title into { kind, targetUsd, dateMs }.
 *   kind: "threshold" | "direction" | "unknown"
 *   targetUsd: number (k/m suffixes expanded) | null
 *   dateMs: epoch ms of the resolve date | null
 */
export function parseBtcMarket(title) {
  const t = String(title || "");
  if (/up or down/i.test(t)) return { kind: "direction", targetUsd: null, dateMs: parseDate(t) };
  const m = t.match(/\$\s?([\d,]+(?:\.\d+)?)\s?(k|m)?\b/i);
  if (m) {
    let v = Number(m[1].replace(/,/g, ""));
    const unit = (m[2] || "").toLowerCase();
    if (unit === "k") v *= 1e3;
    else if (unit === "m") v *= 1e6;
    if (Number.isFinite(v) && v > 0) return { kind: "threshold", targetUsd: v, dateMs: parseDate(t) };
  }
  return { kind: "unknown", targetUsd: null, dateMs: null };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/btc-arb.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/btc-arb.js tests/btc-arb.test.js
git commit -m "feat(btc-arb): parseBtcMarket title parser"
```

---

### Task 2: `checkBinaryArb` — YES+NO < $1−fee, depth-aware joint walk

**Files:**
- Modify: `src/btc-arb.js`
- Test: `tests/btc-arb.test.js`

- [ ] **Step 1: Write the failing test**

```js
// append to tests/btc-arb.test.js; add checkBinaryArb to the import from ../src/btc-arb.js
describe("checkBinaryArb", () => {
  it("locks profit when YES+NO asks sum < 1", () => {
    const r = checkBinaryArb({ yesAsks: [{ price: 0.45, size: 100 }], noAsks: [{ price: 0.45, size: 100 }], fee: 0, capUsd: 1000 });
    assert.ok(Math.abs(r.gap - 0.10) < 1e-9);
    assert.ok(Math.abs(r.executableUsd - 90) < 1e-9);  // 100 pairs * 0.90
    assert.ok(Math.abs(r.profitUsd - 10) < 1e-9);      // 100 pairs * 0.10
  });
  it("no arb when sum >= 1", () => {
    const r = checkBinaryArb({ yesAsks: [{ price: 0.6, size: 100 }], noAsks: [{ price: 0.6, size: 100 }] });
    assert.ok(r.gap < 0);
    assert.equal(r.executableUsd, 0);
    assert.equal(r.profitUsd, 0);
  });
  it("respects capUsd (partial fill)", () => {
    const r = checkBinaryArb({ yesAsks: [{ price: 0.4, size: 1000 }], noAsks: [{ price: 0.4, size: 1000 }], fee: 0, capUsd: 100 });
    assert.ok(Math.abs(r.executableUsd - 100) < 1e-9);
    assert.ok(Math.abs(r.profitUsd - 25) < 1e-9);      // 125 pairs * 0.20
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/btc-arb.test.js`
Expected: FAIL — `does not provide an export named 'checkBinaryArb'`.

- [ ] **Step 3: Write minimal implementation**

```js
// src/btc-arb.js — add
/**
 * Depth-aware binary arbitrage: pair cheapest YES with cheapest NO while their
 * combined price < 1 - fee. Returns touch gap, USD cost deployed, locked profit.
 */
export function checkBinaryArb({ yesAsks = [], noAsks = [], fee = 0, capUsd = 100 } = {}) {
  const ys = [...yesAsks].sort((a, b) => a.price - b.price);
  const ns = [...noAsks].sort((a, b) => a.price - b.price);
  const gap = (ys.length && ns.length) ? (1 - fee) - (ys[0].price + ns[0].price) : 0;
  let i = 0, j = 0, cost = 0, profit = 0;
  while (i < ys.length && j < ns.length) {
    const pair = ys[i].price + ns[j].price;
    if (pair >= 1 - fee) break;
    let take = Math.min(ys[i].size, ns[j].size);
    if (cost + take * pair > capUsd) take = (capUsd - cost) / pair;
    if (take <= 1e-9) break;
    cost += take * pair;
    profit += take * ((1 - fee) - pair);
    ys[i] = { price: ys[i].price, size: ys[i].size - take };
    ns[j] = { price: ns[j].price, size: ns[j].size - take };
    if (ys[i].size <= 1e-9) i++;
    if (ns[j].size <= 1e-9) j++;
    if (cost >= capUsd - 1e-9) break;
  }
  return { gap, executableUsd: cost, profitUsd: profit };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/btc-arb.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/btc-arb.js tests/btc-arb.test.js
git commit -m "feat(btc-arb): checkBinaryArb depth-aware joint walk"
```

---

### Task 3: `checkBucketArb` — multi-outcome sum < $1−fee (best-level, conservative)

**Files:**
- Modify: `src/btc-arb.js`
- Test: `tests/btc-arb.test.js`

- [ ] **Step 1: Write the failing test**

```js
// append to tests/btc-arb.test.js; add checkBucketArb to the import
describe("checkBucketArb", () => {
  it("locks profit when best asks sum < 1", () => {
    const r = checkBucketArb({ legsBest: [{ price: 0.30, size: 50 }, { price: 0.30, size: 80 }, { price: 0.30, size: 40 }], fee: 0 });
    assert.ok(Math.abs(r.gap - 0.10) < 1e-9);
    assert.equal(r.executableShares, 40);              // min leg depth
    assert.ok(Math.abs(r.profitUsd - 4) < 1e-9);       // 40 * 0.10
  });
  it("no arb when sum >= 1", () => {
    const r = checkBucketArb({ legsBest: [{ price: 0.5, size: 10 }, { price: 0.6, size: 10 }], fee: 0 });
    assert.ok(r.gap < 0);
    assert.equal(r.profitUsd, 0);
  });
  it("guards against <2 legs or non-positive prices", () => {
    assert.equal(checkBucketArb({ legsBest: [{ price: 0.3, size: 10 }] }).profitUsd, 0);
    assert.equal(checkBucketArb({ legsBest: [{ price: 0, size: 10 }, { price: 0.3, size: 10 }] }).profitUsd, 0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/btc-arb.test.js`
Expected: FAIL — `does not provide an export named 'checkBucketArb'`.

- [ ] **Step 3: Write minimal implementation**

```js
// src/btc-arb.js — add
/**
 * Multi-outcome (neg-risk bucket) arbitrage at the best-ask level (conservative;
 * deeper walk is a future refinement). legsBest = best ask {price,size} per
 * outcome. Profit if best asks sum to < 1 - fee.
 */
export function checkBucketArb({ legsBest = [], fee = 0 } = {}) {
  if (legsBest.length < 2 || legsBest.some((l) => !l || !(l.price > 0))) {
    return { gap: 0, executableShares: 0, profitUsd: 0 };
  }
  const sumBest = legsBest.reduce((s, l) => s + l.price, 0);
  const gap = (1 - fee) - sumBest;
  if (gap <= 0) return { gap, executableShares: 0, profitUsd: 0 };
  const executableShares = Math.min(...legsBest.map((l) => l.size));
  return { gap, executableShares, profitUsd: executableShares * gap };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/btc-arb.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/btc-arb.js tests/btc-arb.test.js
git commit -m "feat(btc-arb): checkBucketArb best-level sum check"
```

---

### Task 4: `groupFamilies` + calendar/threshold monotonicity

**Files:**
- Modify: `src/btc-arb.js`
- Test: `tests/btc-arb.test.js`

- [ ] **Step 1: Write the failing test**

```js
// append to tests/btc-arb.test.js; add groupFamilies, checkCalendarMonotonicity, checkThresholdMonotonicity to the import
describe("consistency checks", () => {
  const mk = (conditionId, targetUsd, dateMs, prob) => ({ kind: "threshold", conditionId, targetUsd, dateMs, prob, question: conditionId });

  it("calendar: flags P(by earlier) > P(by later) for same target", () => {
    const fam = groupFamilies([
      mk("a", 100000, Date.parse("2026-05-31"), 0.40),
      mk("b", 100000, Date.parse("2026-06-30"), 0.30),
    ]);
    const v = checkCalendarMonotonicity(fam.calendar, 0);
    assert.equal(v.length, 1);
    assert.ok(Math.abs(v[0].magnitude - 0.10) < 1e-9);
  });
  it("calendar: no violation when monotone increasing", () => {
    const fam = groupFamilies([
      mk("a", 100000, Date.parse("2026-05-31"), 0.30),
      mk("b", 100000, Date.parse("2026-06-30"), 0.40),
    ]);
    assert.equal(checkCalendarMonotonicity(fam.calendar, 0).length, 0);
  });
  it("threshold: flags P(>low) < P(>high) for same date", () => {
    const d = Date.parse("2026-06-30");
    const fam = groupFamilies([mk("a", 90000, d, 0.30), mk("b", 100000, d, 0.40)]);
    const v = checkThresholdMonotonicity(fam.threshold, 0);
    assert.equal(v.length, 1);
    assert.ok(Math.abs(v[0].magnitude - 0.10) < 1e-9);
  });
  it("ignores direction and date-less markets", () => {
    const fam = groupFamilies([
      { kind: "direction", conditionId: "x", targetUsd: null, dateMs: null, prob: 0.5 },
      mk("y", 100000, null, 0.3),
    ]);
    assert.equal(fam.calendar.size, 0);
    assert.equal(fam.threshold.size, 0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/btc-arb.test.js`
Expected: FAIL — `does not provide an export named 'groupFamilies'`.

- [ ] **Step 3: Write minimal implementation**

```js
// src/btc-arb.js — add
/**
 * Group parsed threshold markets (each { kind, conditionId, question, targetUsd,
 * dateMs, prob }) into families. Only markets with both targetUsd and dateMs join.
 *   calendar:  targetUsd -> [markets]  (vary date, same target)
 *   threshold: dateKey   -> [markets]  (vary target, same date)
 */
export function groupFamilies(markets) {
  const calendar = new Map();
  const threshold = new Map();
  for (const m of markets || []) {
    if (m.kind !== "threshold" || m.targetUsd == null || m.dateMs == null) continue;
    if (!calendar.has(m.targetUsd)) calendar.set(m.targetUsd, []);
    calendar.get(m.targetUsd).push(m);
    const dk = String(m.dateMs);
    if (!threshold.has(dk)) threshold.set(dk, []);
    threshold.get(dk).push(m);
  }
  return { calendar, threshold };
}

/** P(by earlier date) must be <= P(by later date) for the same target. */
export function checkCalendarMonotonicity(calendar, tol = 0) {
  const violations = [];
  for (const [targetUsd, list] of calendar) {
    const sorted = [...list].sort((a, b) => a.dateMs - b.dateMs);
    for (let i = 1; i < sorted.length; i++) {
      const earlier = sorted[i - 1], later = sorted[i];
      if (earlier.prob > later.prob + tol) {
        violations.push({ targetUsd, earlier, later, magnitude: earlier.prob - later.prob });
      }
    }
  }
  return violations;
}

/** P(> lower target) must be >= P(> higher target) for the same date. */
export function checkThresholdMonotonicity(threshold, tol = 0) {
  const violations = [];
  for (const [dateKey, list] of threshold) {
    const sorted = [...list].sort((a, b) => a.targetUsd - b.targetUsd);
    for (let i = 1; i < sorted.length; i++) {
      const lower = sorted[i - 1], higher = sorted[i];
      if (lower.prob < higher.prob - tol) {
        violations.push({ dateKey, lower, higher, magnitude: higher.prob - lower.prob });
      }
    }
  }
  return violations;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/btc-arb.test.js` then `npm test`
Expected: PASS (btc-arb suite + existing 392, no regressions).

- [ ] **Step 5: Commit**

```bash
git add src/btc-arb.js tests/btc-arb.test.js
git commit -m "feat(btc-arb): family grouping + monotonicity checks"
```

---

### Task 5: `scripts/probe-btc-arb.mjs` — read-only runner (I/O)

No unit test (live I/O, like `scripts/replay-order.mjs`); verified by `node --check` + a real VPS run.

**Files:**
- Create: `scripts/probe-btc-arb.mjs`

- [ ] **Step 1: Write the runner**

```js
// scripts/probe-btc-arb.mjs
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
```

- [ ] **Step 2: Verify it parses**

Run: `node --check scripts/probe-btc-arb.mjs`
Expected: no output (parses clean).

- [ ] **Step 3: Commit**

```bash
git add scripts/probe-btc-arb.mjs
git commit -m "feat(btc-arb): read-only probe runner (Phase 1 snapshot)"
```

- [ ] **Step 4: Live verification (on the VPS, after push + pull)**

```bash
cd ~/polytrack && git pull
node scripts/probe-btc-arb.mjs
```
Expected: prints the BTC market count, the A/B/C/D tables (likely "none" or small gaps), skipped counts, and a VERDICT line. Confirms it runs against live data without crashing. Paste output for interpretation.

---

## Notes for the implementer

- **DRY:** the checks are independent pure functions; the runner only orchestrates fetch → check → render.
- **YAGNI:** the Phase-2 persistence sampler is intentionally deferred — do NOT build it. Phase 1 is a go/no-go measurement. Bucket check uses best-level only (no deep walk) on purpose.
- **No money, ever:** the runner imports only read fetchers (`fetchMarkets`, `fetchOrderBook`). It must never import `executeCopyTrade`/`submitOrder` or write config/DB.
- **Probability proxy:** consistency checks use the YES best-ask as P(event). This slightly overstates P (ask > mid); acceptable for a first-pass signal, and noted in the output.
- **Bucket detection:** a multi-outcome market is identified by `m.tokens.length >= 3` (normaliseMarket builds one token per outcome). Each token's orderbook is fetched and the best asks summed.
```
