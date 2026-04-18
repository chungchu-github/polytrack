/**
 * Trade simulation for F3 backtest.
 *
 * simulateFill() produces a deterministic, non-networked fill from the nearest
 * market_snapshot. We assume the strategy's signal direction is executed at
 * best_ask + small slippage (buying). Partial fills aren't modelled — size is
 * clamped to available top-5 ask depth.
 *
 * SimulatedPortfolio tracks cash, open positions (by conditionId+direction),
 * realized PnL, trade log, and equity curve. Resolution is applied from the
 * `signals` table's `resolved_direction` field (caller supplies).
 */

export function simulateFill({ signal, snapshot, sizeUsdc, slippagePct = 2 }) {
  if (!snapshot || snapshot.best_ask == null) {
    return { status: "NO_FILL", reason: "no ask price" };
  }
  const price = snapshot.best_ask * (1 + slippagePct / 100);
  const askDepth = snapshot.ask_depth || 0;
  const maxShares = askDepth > 0 ? askDepth : Infinity;
  const desiredShares = sizeUsdc / price;
  const shares = Math.min(desiredShares, maxShares);
  if (shares <= 0) return { status: "NO_FILL", reason: "no depth" };
  const filledUsdc = shares * price;

  return {
    status: shares < desiredShares - 1e-9 ? "PARTIAL" : "FILLED",
    conditionId: signal.conditionId,
    direction: signal.direction,
    shares,
    fillPrice: price,
    filledUsdc,
    timestamp: snapshot.timestamp,
    strategy: signal.strategy,
  };
}

export class SimulatedPortfolio {
  constructor(initialCashUsdc = 10000) {
    this.initialCash = initialCashUsdc;
    this.cash = initialCashUsdc;
    this.positions = new Map(); // key: cid::dir -> { shares, costBasis, strategy }
    this.trades = [];
    this.equityCurve = [];     // [{ t, equity }]
    this.realizedPnL = 0;
  }

  _key(cid, dir) { return `${cid}::${dir}`; }

  record(fill) {
    if (!fill || fill.status === "NO_FILL") return;
    this.cash -= fill.filledUsdc;
    const k = this._key(fill.conditionId, fill.direction);
    const cur = this.positions.get(k) || { shares: 0, costBasis: 0, strategy: fill.strategy };
    cur.shares += fill.shares;
    cur.costBasis += fill.filledUsdc;
    this.positions.set(k, cur);
    this.trades.push({ ...fill, cashAfter: this.cash });
  }

  /**
   * Mark all open positions to the latest available mid-price (if snapshots
   * missing, preserve last known value). Snapshots is the map condition_id→snap.
   */
  revalue(t, snapshotsByCid) {
    // Equity = remaining cash + mark-to-market value of open positions.
    // realizedPnL is already baked into `cash` via settlement payouts.
    let equity = this.cash;
    for (const [k, pos] of this.positions) {
      const cid = k.split("::")[0];
      const snap = snapshotsByCid.get(cid);
      const mid = snap?.mid_price;
      if (mid != null) equity += pos.shares * mid;
      else equity += pos.costBasis; // fallback — assume no move
    }
    this.equityCurve.push({ t, equity });
  }

  /**
   * Settle positions once their market resolves. `resolutions` is a
   * Map<conditionId, resolvedDirection ("YES"|"NO"|null)>.
   * YES shares pay $1 if YES wins, $0 otherwise; NO shares mirror.
   */
  settleResolved(resolutions) {
    for (const [k, pos] of [...this.positions]) {
      const [cid, dir] = k.split("::");
      const res = resolutions.get(cid);
      if (!res) continue;
      const payout = (res === dir) ? pos.shares * 1.0 : 0;
      this.cash += payout;
      const pnl = payout - pos.costBasis;
      this.realizedPnL += pnl;
      this.trades.push({
        kind: "SETTLEMENT", conditionId: cid, direction: dir,
        resolved: res, shares: pos.shares, costBasis: pos.costBasis,
        payout, pnl, strategy: pos.strategy,
      });
      this.positions.delete(k);
    }
  }

  computeMetrics() {
    const settlements = this.trades.filter(t => t.kind === "SETTLEMENT");
    const wins = settlements.filter(t => t.pnl > 0).length;
    const losses = settlements.filter(t => t.pnl <= 0).length;
    const winRate = settlements.length
      ? Math.round((wins / settlements.length) * 1000) / 10
      : 0;

    // Max drawdown over equity curve
    let peak = this.initialCash;
    let maxDD = 0;
    for (const pt of this.equityCurve) {
      if (pt.equity > peak) peak = pt.equity;
      const dd = peak > 0 ? (peak - pt.equity) / peak : 0;
      if (dd > maxDD) maxDD = dd;
    }

    // Sharpe (simple): mean/std of equity deltas, annualized assumption omitted
    let sharpe = 0;
    if (this.equityCurve.length > 2) {
      const deltas = [];
      for (let i = 1; i < this.equityCurve.length; i++) {
        deltas.push(this.equityCurve[i].equity - this.equityCurve[i - 1].equity);
      }
      const mean = deltas.reduce((a, b) => a + b, 0) / deltas.length;
      const variance = deltas.reduce((a, b) => a + (b - mean) ** 2, 0) / deltas.length;
      const std = Math.sqrt(variance);
      sharpe = std > 0 ? Math.round((mean / std) * 100) / 100 : 0;
    }

    const finalEquity = this.equityCurve.length
      ? this.equityCurve[this.equityCurve.length - 1].equity
      : this.cash + this.realizedPnL;

    return {
      initialCash: this.initialCash,
      finalEquity: Math.round(finalEquity * 100) / 100,
      totalPnL: Math.round((finalEquity - this.initialCash) * 100) / 100,
      realizedPnL: Math.round(this.realizedPnL * 100) / 100,
      tradeCount: this.trades.filter(t => !t.kind).length,
      settlements: settlements.length,
      wins, losses, winRate,
      maxDrawdownPct: Math.round(maxDD * 1000) / 10,
      sharpe,
      openPositions: this.positions.size,
      cash: Math.round(this.cash * 100) / 100,
    };
  }
}
