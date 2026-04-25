/**
 * ConsensusStrategy — wraps the existing SignalStore (ELITE-wallet consensus
 * with NEW→CONFIRMED→STALE→EXPIRED lifecycle + B8 opposing suppression).
 *
 * Behaviour is preserved from pre-F2 `src/signals.js`. The only change is that
 * signals emitted through this strategy are tagged `strategy: "consensus"`.
 */
import { BaseStrategy } from "./base.js";
import { SignalStore } from "../signals.js";

export class ConsensusStrategy extends BaseStrategy {
  defaults() {
    return {
      enabled: true,
      recencyDays: 7,
      minPositionSize: 10,
      // V1-accumulation override (PR consensus-entry-edge): 3→2 while
      // ELITE pool grows. Raise back to 3 once eliteCount >= 5 stably.
      minWallets: 2,
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
