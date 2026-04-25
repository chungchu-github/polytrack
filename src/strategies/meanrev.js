/**
 * MeanRevStrategy — detects statistically extreme deviations from a rolling
 * mean and emits a signal in the expected reversion direction.
 *
 * z = (currentMid - rollingMean) / rollingStd
 *   z > +threshold → current price is "too high" → signal NO (revert down)
 *   z < -threshold → current price is "too low"  → signal YES (revert up)
 */
import { BaseStrategy } from "./base.js";
import { isSentinelSnap } from "./util.js";

export class MeanRevStrategy extends BaseStrategy {
  defaults() {
    return {
      enabled: false,
      lookbackDays: 7,
      zScoreThreshold: 2.0,
      minSamples: 20,
    };
  }
  get name() { return "meanrev"; }

  detect({ markets, history, now = Date.now() }) {
    const cfg = this.config;
    const since = now - cfg.lookbackDays * 86400 * 1000;
    const signals = [];

    for (const evt of markets || []) {
      for (const m of evt.markets || []) {
        if (!m.conditionId) continue;
        const snaps = history.getMarketSnapshots(m.conditionId, since, now);
        if (snaps.length < cfg.minSamples) continue;

        const tokenId = snaps[0].token_id;
        // Sentinel snapshots have mid stuck at 0.5; mixed in with one real
        // observation they collapse the rolling std and yield massive
        // false z-scores. Filter them out before computing mean/variance.
        const series = snaps
          .filter(s => s.token_id === tokenId && s.mid_price != null && !isSentinelSnap(s))
          .map(s => s.mid_price);
        if (series.length < cfg.minSamples) continue;

        const mean = series.reduce((a, b) => a + b, 0) / series.length;
        const variance = series.reduce((a, b) => a + (b - mean) ** 2, 0) / series.length;
        const std = Math.sqrt(variance);
        if (!(std > 0)) continue;

        const current = series[series.length - 1];
        const z = (current - mean) / std;
        if (Math.abs(z) < cfg.zScoreThreshold) continue;

        const direction = z > 0 ? "NO" : "YES"; // revert toward mean
        const strength = Math.min(100, Math.round(40 + Math.abs(z) * 15));

        signals.push({
          conditionId: m.conditionId,
          title: m.question || evt.title || "",
          direction,
          status: "NEW",
          strength,
          zScore: Math.round(z * 100) / 100,
          rollingMean: Math.round(mean * 10000) / 10000,
          currentPrice: current,
          samples: series.length,
        });
      }
    }
    return signals;
  }
}
