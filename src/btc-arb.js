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
 * Parse a BTC market title into { kind, side, targetUsd, dateMs }.
 *   kind: "threshold" | "direction" | "unknown"
 *   side: "up" (reach/hit/above) | "down" (dip/drop/below/under) | null
 *   targetUsd: number (k/m suffixes expanded) | null
 *   dateMs: epoch ms of the resolve date | null
 */
export function parseBtcMarket(title) {
  const t = String(title || "");
  if (/up or down/i.test(t)) return { kind: "direction", side: null, targetUsd: null, dateMs: parseDate(t) };
  const m = t.match(/\$\s?([\d,]+(?:\.\d+)?)\s?(k|m)?\b/i);
  if (m) {
    let v = Number(m[1].replace(/,/g, ""));
    const unit = (m[2] || "").toLowerCase();
    if (unit === "k") v *= 1e3;
    else if (unit === "m") v *= 1e6;
    if (Number.isFinite(v) && v > 0) {
      // Downside ("dip/drop/fall to", "below/under $X") = P(BTC <= target);
      // upside ("reach/hit/above", default) = P(BTC >= target). They obey
      // OPPOSITE monotonicity in target — mixing them flags false violations.
      const side = /\b(dip|drop|fall|below|under)\b/i.test(t) ? "down" : "up";
      return { kind: "threshold", side, targetUsd: v, dateMs: parseDate(t) };
    }
  }
  return { kind: "unknown", side: null, targetUsd: null, dateMs: null };
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
    const side = m.side || "up";
    const calKey = `${side}::${m.targetUsd}`;   // same side+target, vary date
    if (!calendar.has(calKey)) calendar.set(calKey, []);
    calendar.get(calKey).push(m);
    const thrKey = `${side}::${m.dateMs}`;       // same side+date, vary target
    if (!threshold.has(thrKey)) threshold.set(thrKey, []);
    threshold.get(thrKey).push(m);
  }
  return { calendar, threshold };
}

/**
 * P(by earlier date) must be <= P(by later date) for the same (side, target):
 * more time = more chances to have reached/dipped. Same rule for up and down.
 */
export function checkCalendarMonotonicity(calendar, tol = 0) {
  const violations = [];
  for (const [, list] of calendar) {
    const sorted = [...list].sort((a, b) => a.dateMs - b.dateMs);
    for (let i = 1; i < sorted.length; i++) {
      const earlier = sorted[i - 1], later = sorted[i];
      if (earlier.prob > later.prob + tol) {
        violations.push({ targetUsd: earlier.targetUsd, side: earlier.side, earlier, later, magnitude: earlier.prob - later.prob });
      }
    }
  }
  return violations;
}

/**
 * Same-date strike monotonicity, side-aware (families never mix up/down):
 *   up   — P(reach $low)  >= P(reach $high)   → violation if it rises with target
 *   down — P(dip to $low) <= P(dip to $high)  → violation if it falls with target
 */
export function checkThresholdMonotonicity(threshold, tol = 0) {
  const violations = [];
  for (const [, list] of threshold) {
    const side = list[0]?.side || "up";
    const sorted = [...list].sort((a, b) => a.targetUsd - b.targetUsd);
    for (let i = 1; i < sorted.length; i++) {
      const lower = sorted[i - 1], higher = sorted[i];
      const bad = side === "down"
        ? (lower.prob > higher.prob + tol)   // down: prob should rise with target
        : (lower.prob < higher.prob - tol);  // up:   prob should fall with target
      if (bad) violations.push({ side, dateKey: String(lower.dateMs), lower, higher, magnitude: Math.abs(higher.prob - lower.prob) });
    }
  }
  return violations;
}
