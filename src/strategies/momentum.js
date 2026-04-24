/**
 * MomentumStrategy — detects sustained price moves on a single market.
 *
 * For each token: pulls last `lookbackHours` of mid-price snapshots, checks
 * total price delta exceeds `minPriceMovePct`, and confirms monotonic trend
 * (≥ 60% of steps in same direction). Emits YES/NO signal in direction of
 * trend. Requires F0.5 data capture to have accumulated ≥2 snapshots.
 */
import { BaseStrategy } from "./base.js";

export class MomentumStrategy extends BaseStrategy {
  defaults() {
    return {
      enabled: false,
      lookbackHours: 4,
      minPriceMovePct: 8,     // require ≥8% absolute price change
      minVolume24h: 5000,     // skip low-liquidity markets
      monotonicity: 0.6,      // fraction of steps aligned with net direction
    };
  }
  get name() { return "momentum"; }

  detect({ markets, history, now = Date.now() }) {
    const cfg = this.config;
    const since = now - cfg.lookbackHours * 3600 * 1000;
    const signals = [];

    for (const evt of markets || []) {
      for (const m of evt.markets || []) {
        if (!m.conditionId) continue;
        const snaps = history.getMarketSnapshots(m.conditionId, since, now);
        if (snaps.length < 2) continue;

        // Use the primary token (first snapshot's token_id) for trend
        const tokenId = snaps[0].token_id;
        const series = snaps.filter(s => s.token_id === tokenId && s.mid_price != null);
        if (series.length < 2) continue;

        const firstVol = Number(series[series.length - 1].volume_24h) || Number(snaps[0].volume_24h) || 0;
        if (firstVol < cfg.minVolume24h) continue;

        const p0 = series[0].mid_price;
        const pN = series[series.length - 1].mid_price;
        if (!(p0 > 0)) continue;

        const pctMove = ((pN - p0) / p0) * 100;
        if (Math.abs(pctMove) < cfg.minPriceMovePct) continue;

        // Monotonicity check: fraction of adjacent-step deltas sharing sign
        let aligned = 0, total = 0;
        const sign = Math.sign(pN - p0);
        for (let i = 1; i < series.length; i++) {
          const d = series[i].mid_price - series[i - 1].mid_price;
          if (d === 0) continue;
          total++;
          if (Math.sign(d) === sign) aligned++;
        }
        if (total === 0 || aligned / total < cfg.monotonicity) continue;

        const direction = pctMove > 0 ? "YES" : "NO";
        const strength = Math.min(100, Math.round(40 + Math.abs(pctMove) * 3));

        signals.push({
          conditionId: m.conditionId,
          title: m.question || evt.title || "",
          direction,
          status: "NEW",
          strength,
          priceMovePct: Math.round(pctMove * 100) / 100,
          lookbackHours: cfg.lookbackHours,
          samples: series.length,
        });
      }
    }
    return signals;
  }
}
