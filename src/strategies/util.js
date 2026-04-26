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

/**
 * Same liquidity gate as isSentinelSnap, but tolerates orderbook shape
 * `{ bids: [{price,size}], asks: [{price,size}] }` returned by the live
 * Polymarket API. Used during the scan's pre-filter pass — we have fresh
 * orderbooks in memory before snapshots have been persisted.
 *
 * Why a separate function: callers in strategies read DB rows
 * (best_bid / best_ask), but the in-scan pre-filter sees raw API books.
 * Mapping every site is more error-prone than two tiny shapes.
 */
function bookHasRealLiquidity(book, opts = {}) {
  const { minLiquidBid = 0.02, maxSpread = 0.10 } = opts;
  if (!book || !Array.isArray(book.bids) || !Array.isArray(book.asks)) return false;
  const bid = book.bids.length ? Number(book.bids[0].price) : null;
  const ask = book.asks.length ? Number(book.asks[0].price) : null;
  if (bid == null || ask == null) return false;
  if (!Number.isFinite(bid) || bid <= minLiquidBid) return false;
  if (!Number.isFinite(ask) || ask >= 1 - minLiquidBid) return false;
  if (ask - bid > maxSpread) return false;
  return true;
}

/**
 * Filter events by `lastTradePrice` — the actual signal of "tradeable" on
 * Polymarket. This replaced the orderbook-based filter (filterLiquidMarkets
 * below) for non-arbitrage strategies after live diagnosis revealed
 * Polymarket's visible /book endpoint returns mostly noise: trades execute
 * at meaningful prices like 0.44 / 0.24 even when the orderbook shows
 * 0.01/0.99 placeholder. The hidden-liquidity matching path doesn't show
 * up in /book.
 *
 * Real signal of "this market trades right now":
 *   - lastTradePrice exists and is in (minLastTrade, 1 - minLastTrade)
 *   - i.e. not stuck at extremes (resolved-ish) and not null (never traded)
 *
 * For arbitrage we still need both-leg orderbook depth, so the original
 * orderbook-based filterLiquidMarkets stays exported for that use case.
 *
 * @param {Array} events    fetchMarkets() / fetchMarketsByConditionIds() output
 * @param {object} [opts]   { minLastTrade?: number, cap?: number }
 * @returns {{events: Array, stats: {fetched, liquid, used, dropped}}}
 */
export function filterByLastTradePrice(events, opts = {}) {
  const { minLastTrade = 0.02, cap = 30 } = opts;
  const fetched = (events || []).length;
  const liquid = [];
  const upper = 1 - minLastTrade;

  for (const evt of events || []) {
    let hasOneTradeable = false;
    for (const m of evt.markets || []) {
      const ltp = Number(m?.lastTradePrice);
      if (!Number.isFinite(ltp) || ltp <= 0) continue;
      if (ltp <= minLastTrade) continue;        // resolved-ish NO / dead
      if (ltp >= upper) continue;               // resolved-ish YES / dead
      hasOneTradeable = true;
      break;
    }
    if (hasOneTradeable) liquid.push(evt);
  }

  const used = liquid.slice(0, cap);
  return {
    events: used,
    stats: {
      fetched,
      liquid: liquid.length,
      used: used.length,
      dropped: fetched - liquid.length,
    },
  };
}

/**
 * Filter event list down to events whose outcome tokens have real, tradeable
 * liquidity right now. An event passes if AT LEAST ONE of its outcome tokens
 * has a non-sentinel orderbook in `byToken`. We don't require all outcomes
 * because a one-sided liquid market is still tradeable with momentum/meanrev
 * (single-leg). Arbitrage's `hasRealLiquidity` check enforces the stricter
 * "both legs liquid" rule downstream.
 *
 * Top-100-events from /events?order=volume_24hr is event-level: the volume
 * accumulated yesterday says nothing about whether outcome tokens have
 * orderbooks today. Polymarket returns sentinel pricing (0.01/0.99) for
 * dead outcomes, which produced 45 phantom strength=100 arbitrage signals
 * in production. This pre-filter prevents strategies from ever seeing
 * those events.
 *
 * NOTE (2026-04-26): superseded by filterByLastTradePrice for non-arbitrage
 * use. Live diagnosis showed Polymarket /book is misleading — trades execute
 * via hidden liquidity at meaningful prices while the visible book stays
 * 0.01/0.99. Keep this for arbitrage which still needs both-leg book depth.
 *
 * @param {Array} events     fetchMarkets() output (events with .markets[].tokens[])
 * @param {Map}   byToken    tokenId → orderbook from fetchOrderBooks()
 * @param {object} [opts]    { minLiquidBid?, maxSpread?, cap? }
 * @returns {{events: Array, stats: {fetched, liquid, dropped}}}
 */
export function filterLiquidMarkets(events, byToken, opts = {}) {
  const { cap = 30 } = opts;
  const fetched = (events || []).length;
  const liquid = [];

  for (const evt of events || []) {
    let hasOneLiquid = false;
    for (const m of evt.markets || []) {
      const tokens = Array.isArray(m.tokens) ? m.tokens : [];
      for (const tok of tokens) {
        const tokenId = String(tok?.token_id || tok?.tokenId || tok || "");
        if (!tokenId) continue;
        if (bookHasRealLiquidity(byToken?.get?.(tokenId), opts)) {
          hasOneLiquid = true;
          break;
        }
      }
      if (hasOneLiquid) break;
    }
    if (hasOneLiquid) liquid.push(evt);
  }

  // Sort already from upstream (volume_24hr desc). Just cap.
  const used = liquid.slice(0, cap);
  return {
    events: used,
    stats: {
      fetched,
      liquid: liquid.length,
      used: used.length,
      dropped: fetched - liquid.length,
    },
  };
}
