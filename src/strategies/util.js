/**
 * Shared snapshot-quality helpers.
 *
 * Polymarket's CLOB returns sentinel pricing for outcomes with no real
 * orderbook — typically `bid=0.01, ask=0.99, mid=0.50`. Computing prices,
 * z-scores, or arbitrage edge from those snapshots produces false signals
 * because the values are placeholders, not market consensus.
 *
 * Every strategy that reads `market_snapshots` should pre-filter through
 * `isSentinelSnap` before feeding the series into math. The arbitrage
 * detector wraps a stricter version (also requires a tradeable spread)
 * because both legs must clear before computing edge.
 */

/**
 * True when a snapshot looks like Polymarket's no-orderbook placeholder:
 *   - bid below `minLiquidBid` (0.02 default catches the 0.01 sentinel + zero/null)
 *   - ask above `1 - minLiquidBid` (catches 0.99 sentinel)
 *   - bid-ask spread wider than `maxSpread` (catches no-real-book cases)
 *
 * Conservative by design — better to skip a real-but-thin market than to
 * fire on placeholder data and trade based on a phantom price.
 *
 * @param {object} snap   { best_bid, best_ask, ... }
 * @param {object} [opts] { minLiquidBid?: number, maxSpread?: number }
 */
export function isSentinelSnap(snap, opts = {}) {
  const { minLiquidBid = 0.02, maxSpread = 0.10 } = opts;
  if (!snap) return true;
  // null/undefined first — Number(null)=0 would silently slip past the bid gate
  if (snap.best_bid == null || snap.best_ask == null) return true;
  const bid = Number(snap.best_bid);
  const ask = Number(snap.best_ask);
  if (!Number.isFinite(bid) || bid <= minLiquidBid) return true;
  if (!Number.isFinite(ask) || ask >= 1 - minLiquidBid) return true;
  if (ask - bid > maxSpread) return true;
  return false;
}
