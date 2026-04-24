/**
 * StrategyEngine — orchestrates multiple signal strategies.
 *
 * Holds strategies keyed by name; `detectAll(ctx)` runs enabled strategies
 * and tags each returned signal with `strategy: <name>`. Provides a unified
 * traded-flag map keyed `${strategy}::${conditionId}::${direction}` so
 * concurrency locks work across strategies. ConsensusStrategy still owns its
 * internal SignalStore lifecycle; other strategies are stateless per-scan.
 */
import { ConsensusStrategy } from "./consensus.js";
import { MomentumStrategy } from "./momentum.js";
import { MeanRevStrategy } from "./meanrev.js";
import { ArbitrageStrategy } from "./arbitrage.js";

export class StrategyEngine {
  /**
   * @param {object} configByName  e.g. { consensus: {...}, momentum: {...} }
   */
  constructor(configByName = {}) {
    this.strategies = new Map();
    this.register(new ConsensusStrategy(configByName.consensus || {}));
    this.register(new MomentumStrategy(configByName.momentum || {}));
    this.register(new MeanRevStrategy(configByName.meanrev || {}));
    this.register(new ArbitrageStrategy(configByName.arbitrage || {}));
    this.traded = new Set();
  }

  register(strategy) { this.strategies.set(strategy.name, strategy); }
  get(name) { return this.strategies.get(name); }

  /**
   * Run every enabled strategy's detect(). Returns combined signal array.
   */
  detectAll(ctx) {
    const out = [];
    for (const s of this.strategies.values()) {
      if (s.config && s.config.enabled === false) continue;
      try {
        const sigs = s.detect(ctx) || [];
        for (const sig of sigs) out.push({ ...sig, strategy: s.name });
      } catch (e) {
        // Never let one strategy failure break the scan
        ctx.log?.warn?.(`Strategy ${s.name} detect failed: ${e.message}`);
      }
    }
    return out;
  }

  // ── Concurrency-lock API (per-strategy key) ────────────────────────────────
  _key(strategy, cid, dir) { return `${strategy}::${cid}::${dir}`; }

  markTraded(strategy, cid, dir) {
    this.traded.add(this._key(strategy, cid, dir));
    // Mirror into consensus' SignalStore for backward compat
    if (strategy === "consensus") this.get("consensus").markTraded(cid, dir);
  }
  unmarkTraded(strategy, cid, dir) {
    this.traded.delete(this._key(strategy, cid, dir));
    if (strategy === "consensus") this.get("consensus").unmarkTraded(cid, dir);
  }
  isTraded(strategy, cid, dir) {
    return this.traded.has(this._key(strategy, cid, dir));
  }
}
