/**
 * Backtest engine (F3).
 *
 * Deterministic replay of historical market/position data through a strategy
 * to estimate PnL, win rate, Sharpe, and max drawdown. Pure pipeline — does
 * not share Express/Socket.IO runtime with the live scanner.
 *
 * Usage:
 *   const result = await runBacktest({
 *     dateStart, dateEnd, strategy: "consensus",
 *     strategyConfig: {...}, sizeUsdc: 100, initialCash: 10000,
 *     stepMinutes: 60,
 *   });
 *   // result: { metrics, trades }
 */
import { HistoryReader } from "./history.js";
import { SimulatedPortfolio, simulateFill } from "./simulate.js";
import { ConsensusStrategy } from "../strategies/consensus.js";
import { MomentumStrategy } from "../strategies/momentum.js";
import { MeanRevStrategy } from "../strategies/meanrev.js";
import { ArbitrageStrategy } from "../strategies/arbitrage.js";
import { getDB } from "../db.js";

const REGISTRY = {
  consensus: ConsensusStrategy,
  momentum:  MomentumStrategy,
  meanrev:   MeanRevStrategy,
  arbitrage: ArbitrageStrategy,
};

export function instantiateStrategy(name, config = {}) {
  const Cls = REGISTRY[name];
  if (!Cls) throw new Error(`Unknown strategy: ${name}`);
  return new Cls(config);
}

/**
 * @returns {Promise<{ metrics, trades }>}
 */
export async function runBacktest(opts) {
  const {
    dateStart, dateEnd,
    strategy,
    strategyConfig = {},
    walletAddresses,            // optional — defaults to all with history
    sizeUsdc = 100,
    slippagePct = 2,
    initialCash = 10000,
    stepMinutes = 60,
  } = opts;

  if (!(dateStart < dateEnd)) throw new Error("dateStart must be before dateEnd");
  const history = new HistoryReader();
  const strat = instantiateStrategy(strategy, strategyConfig);
  const portfolio = new SimulatedPortfolio(initialCash);

  const wallets = walletAddresses && walletAddresses.length
    ? walletAddresses
    : history.listWallets(dateStart, dateEnd);

  const stepMs = stepMinutes * 60 * 1000;
  const tradedKeys = new Set();
  const firstSeenCid = new Set();

  for (let t = dateStart; t <= dateEnd; t += stepMs) {
    const marketsCtx = history.getMarketsAt(dateStart, t);
    const walletsCtx = history.getWalletsAt(wallets, t);
    let signals = [];
    try {
      signals = strat.detect({ wallets: walletsCtx, markets: marketsCtx, history, now: t }) || [];
    } catch { /* skip step on strategy error */ }

    // Build latest-snapshot map for revalue + fills
    const snapByCid = new Map();
    for (const evt of marketsCtx) {
      for (const m of evt.markets) {
        const firstToken = m.tokens[0]?.token_id;
        if (!firstToken) continue;
        const snap = history.getMarketAt(firstToken, t);
        if (snap) snapByCid.set(m.conditionId, snap);
      }
    }

    for (const sig of signals) {
      const key = `${sig.conditionId}::${sig.direction}`;
      if (tradedKeys.has(key)) continue;
      const snap = snapByCid.get(sig.conditionId);
      if (!snap) continue;
      if (portfolio.cash < sizeUsdc) break;
      const fill = simulateFill({ signal: { ...sig, strategy }, snapshot: snap, sizeUsdc, slippagePct });
      if (fill.status === "NO_FILL") continue;
      portfolio.record(fill);
      tradedKeys.add(key);
      firstSeenCid.add(sig.conditionId);
    }

    portfolio.revalue(t, snapByCid);
  }

  // Apply resolutions from the signals table (resolved_direction + resolved_at)
  const db = getDB();
  const resolutions = new Map();
  if (firstSeenCid.size > 0) {
    const placeholders = [...firstSeenCid].map(() => "?").join(",");
    const rows = db.prepare(
      `SELECT DISTINCT condition_id, resolved_direction
         FROM signals
        WHERE condition_id IN (${placeholders})
          AND resolved_direction IS NOT NULL
          AND resolved_at >= ? AND resolved_at <= ?`
    ).all(...firstSeenCid, dateStart, dateEnd + 30 * 86400e3);
    for (const r of rows) resolutions.set(r.condition_id, r.resolved_direction);
  }
  portfolio.settleResolved(resolutions);
  // Record final equity point after settlement so totalPnL reflects realized PnL
  portfolio.revalue(dateEnd, new Map());

  return {
    metrics: portfolio.computeMetrics(),
    trades: portfolio.trades,
    equityCurve: portfolio.equityCurve,
  };
}
