/**
 * ConsensusStrategy — wraps the existing SignalStore (ELITE-wallet follow
 * with NEW→CONFIRMED→STALE→EXPIRED lifecycle + B8 opposing suppression).
 *
 * 2026-05-02: switched to single-ELITE follow mode. The "consensus" name is
 * preserved (DB rows / config keys reference it) but the semantics are now
 * "any one ELITE wallet enters → fire signal, unless another ELITE opposes
 * the same market+direction." Pre-2026-05-02 behaviour was 2-of-N consensus
 * including PRO wallets; that bar was structurally unreachable on the
 * V1-accumulation watchlist.
 */
import { BaseStrategy } from "./base.js";
import { SignalStore } from "../signals.js";

export class ConsensusStrategy extends BaseStrategy {
  defaults() {
    return {
      enabled: true,
      recencyDays: 7,
      minPositionSize: 10,
      // Single-ELITE follow: 1 ELITE same-direction with no opposing ELITE.
      // Risk caps that compensate for the relaxed quorum:
      //   - ELITE gate tightened (scoring.js: score>75, closed≥30, $2000, 5% ROI)
      //   - maxEntryDrift 0.15 still blocks chasing past the smart-money entry
      //   - marketCooldownMin (config.js, 30) prevents rapid re-fires per market
      //   - killSwitch.maxLifetimeLossUsdc (config.js, 30) hard-stops on loss
      minWallets: 1,
      includeProInConsensus: false,
      sizeCapPerWallet: 10000,
      staleAfterScans: 3,
      expireAfterScans: 6,
      maxEntryDrift: 0.15,
    };
  }
  get name() { return "consensus"; }

  constructor(config = {}) {
    super(config);
    this.store = new SignalStore(this.config);
  }

  detect({ wallets, markets, history }) {
    return this.store.detect(wallets, markets, history);
  }

  // Expose store methods so StrategyEngine can delegate lifecycle concerns
  markTraded(cid, dir)   { this.store.markTraded(cid, dir); }
  unmarkTraded(cid, dir) { this.store.unmarkTraded(cid, dir); }
  isTraded(cid, dir)     { return this.store.isTraded(cid, dir); }
  getActive()            { return this.store.getActiveSignals(); }
}
