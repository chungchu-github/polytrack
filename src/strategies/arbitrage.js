/**
 * ArbitrageStrategy — detects when YES_bid + NO_bid sum is < 1.0 by a
 * meaningful margin (binary market pricing edge). A trader can buy both
 * sides and lock in the difference as risk-free profit.
 *
 * Requires the latest market_snapshot for both outcome tokens on the same
 * market. Emits direction "YES" (convention: caller would mirror on NO).
 */
import { BaseStrategy } from "./base.js";

export class ArbitrageStrategy extends BaseStrategy {
  defaults() {
    return {
      enabled: false,
      minEdgePct: 1.5,
    };
  }
  get name() { return "arbitrage"; }

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

        const bids = tokens
          .map(t => latestByToken[t.token_id || t.tokenId || t])
          .filter(s => s && s.best_bid != null)
          .map(s => s.best_bid);
        if (bids.length < 2) continue;

        const sum = bids[0] + bids[1];
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
