/**
 * ArbitrageStrategy — detects when YES_bid + NO_bid sum is < 1.0 by a
 * meaningful margin (binary market pricing edge). A trader can buy both
 * sides and lock in the difference as risk-free profit.
 *
 * Requires the latest market_snapshot for both outcome tokens on the same
 * market. Emits direction "YES" (convention: caller would mirror on NO).
 *
 * Liquidity gate (critical): Polymarket's CLOB returns sentinel pricing
 * (bid=0.01, ask=0.99, mid=0.5) for outcomes with no real orderbook —
 * common on long-tail / far-future markets. Computing edge from those
 * sentinels yields edgePct ≈ 98% on every illiquid market, flooding the
 * dashboard with strength-100 signals that aren't tradeable. The fix is
 * to require BOTH outcomes to have real bid > minLiquidBid AND tight
 * spread (ask−bid ≤ maxSpread) before computing the edge.
 */
import { BaseStrategy } from "./base.js";
import { isSentinelSnap } from "./util.js";

export class ArbitrageStrategy extends BaseStrategy {
  defaults() {
    return {
      enabled: false,
      minEdgePct: 1.5,
      // Sentinel-rejection gates. Tunable via config but the defaults
      // are what catches Polymarket's 0.01/0.99 placeholder.
      minLiquidBid: 0.02,   // bids ≤ this look like sentinel/no-book
      maxSpread:    0.10,   // bid-ask wider than this = no real liquidity
    };
  }
  get name() { return "arbitrage"; }

  /** Snapshot has real, tradeable liquidity (not Polymarket's placeholder)? */
  static hasRealLiquidity(snap, { minLiquidBid, maxSpread }) {
    return !isSentinelSnap(snap, { minLiquidBid, maxSpread });
  }

  detect({ markets, history, now = Date.now() }) {
    const cfg = this.config;
    const signals = [];
    const windowStart = now - 60 * 60 * 1000; // last hour

    for (const evt of markets || []) {
      for (const m of evt.markets || []) {
        if (!m.conditionId) continue;
        const tokens = Array.isArray(m.tokens) ? m.tokens : [];
        if (tokens.length < 2) continue;

        const latestByToken = {};
        const snaps = history.getMarketSnapshots(m.conditionId, windowStart, now);
        for (const s of snaps) {
          const prev = latestByToken[s.token_id];
          if (!prev || s.timestamp > prev.timestamp) latestByToken[s.token_id] = s;
        }

        const tokenSnaps = tokens
          .map(t => latestByToken[t.token_id || t.tokenId || t])
          .filter(Boolean);
        if (tokenSnaps.length < 2) continue;

        // Both sides must have real liquidity. One placeholder side is
        // enough to disqualify — we can't actually buy the other leg.
        const allLiquid = tokenSnaps.every(s =>
          ArbitrageStrategy.hasRealLiquidity(s, cfg)
        );
        if (!allLiquid) continue;

        const sum = tokenSnaps[0].best_bid + tokenSnaps[1].best_bid;
        const edgePct = (1 - sum) * 100;
        if (edgePct < cfg.minEdgePct) continue;

        const strength = Math.min(100, Math.round(50 + edgePct * 20));
        signals.push({
          conditionId: m.conditionId,
          title: m.question || evt.title || "",
          direction: "YES",
          status: "NEW",
          strength,
          edgePct: Math.round(edgePct * 100) / 100,
          bidSum: Math.round(sum * 10000) / 10000,
        });
      }
    }
    return signals;
  }
}
