/**
 * BaseStrategy — abstract class for signal-detection strategies (F2).
 *
 * Concrete strategies override `name` + `detect(ctx)`:
 *   ctx = {
 *     wallets, markets,        // current scan inputs
 *     history: HistoryReader,  // reads market_snapshots / positions_history
 *     now: ms,                 // wall-clock time of detection
 *   }
 *
 * detect() returns Signal[] where each signal has:
 *   { conditionId, title, direction: "YES"|"NO", strength: 0..100,
 *     status: "NEW"|"CONFIRMED", walletCount?, totalSize?, extra... }
 * StrategyEngine tags `strategy: this.name` on every returned signal.
 */
export class BaseStrategy {
  constructor(config = {}) {
    this.config = { ...this.defaults(), ...config };
  }
  defaults() { return {}; }
  get name() { throw new Error("BaseStrategy.name must be overridden"); }
  detect(_ctx) { throw new Error("BaseStrategy.detect must be overridden"); }
}
