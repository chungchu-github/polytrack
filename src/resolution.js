/**
 * Signal Resolution Checker
 * ─────────────────────────
 * Periodically checks whether markets referenced by past signals have resolved,
 * then records the outcome so we can compute historical signal accuracy.
 */

import { getUnresolvedSignals, resolveSignal, getSignalAccuracy } from "./db.js";
import { fetchMarkets } from "./polymarket-api.js";
import log from "./logger.js";

/**
 * Check all unresolved signals against current market data.
 * A market is "resolved" when one of its outcome prices is 1.00 (or 0.00 for the other).
 *
 * @param {Array} markets - Current market/event data (from fetchMarkets or state.markets)
 * @returns {{ checked: number, resolved: number }}
 */
export async function checkResolutions(markets) {
  const unresolved = getUnresolvedSignals();
  if (unresolved.length === 0) return { checked: 0, resolved: 0 };

  // Build a lookup: conditionId -> resolved direction (YES/NO) or null
  const resolutionMap = new Map();
  for (const event of markets) {
    for (const m of (event.markets || [])) {
      if (!m.conditionId) continue;
      const resolved = getResolvedDirection(m);
      if (resolved) resolutionMap.set(m.conditionId, resolved);
    }
  }

  let resolvedCount = 0;
  for (const signal of unresolved) {
    const outcome = resolutionMap.get(signal.condition_id);
    if (outcome) {
      resolveSignal(signal.id, outcome);
      resolvedCount++;
      const correct = outcome === signal.direction ? "CORRECT" : "WRONG";
      log.info(`Signal #${signal.id} resolved: predicted ${signal.direction}, outcome ${outcome} — ${correct}`);
    }
  }

  if (resolvedCount > 0) {
    const acc = getSignalAccuracy();
    log.info(`Signal accuracy: ${acc.correct}/${acc.total} (${acc.accuracy}%)`);
  }

  return { checked: unresolved.length, resolved: resolvedCount };
}

/**
 * Determine if a market has resolved by checking outcome prices.
 * Returns "YES" or "NO" if resolved, null if still open.
 */
function getResolvedDirection(market) {
  // outcomePrices is typically a JSON string like "[0.95, 0.05]" or an array
  let prices = market.outcomePrices;
  if (typeof prices === "string") {
    try { prices = JSON.parse(prices); } catch { return null; }
  }
  if (!Array.isArray(prices) || prices.length < 2) return null;

  const p0 = Number(prices[0]);
  const p1 = Number(prices[1]);

  // Market is resolved when one outcome hits 1.00 (or very close)
  if (p0 >= 0.99 && p1 <= 0.01) return "YES";
  if (p1 >= 0.99 && p0 <= 0.01) return "NO";

  // Also check via tokens if available
  if (market.tokens && Array.isArray(market.tokens)) {
    for (const t of market.tokens) {
      const price = Number(t.price || 0);
      const outcome = String(t.outcome || "").toUpperCase();
      if (price >= 0.99 && (outcome === "YES" || outcome === "NO")) return outcome;
    }
  }

  return null;
}

export { getSignalAccuracy };
