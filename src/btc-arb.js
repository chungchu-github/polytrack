/**
 * btc-arb.js — pure helpers for the read-only BTC mispricing probe
 * (scripts/probe-btc-arb.mjs). No I/O, no money. Spec:
 * docs/superpowers/specs/2026-06-05-btc-arb-probe-design.md
 */

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
