/**
 * Wallet Scoring Engine
 * ─────────────────────
 * Computes performance metrics from actual PnL data, not arbitrary price thresholds.
 *
 * Score = winRate(0.25) + sharpe(0.25) + pnlPercentile(0.25) + timing(0.15) + consistency(0.10)
 *
 * Tier gates:
 *   ELITE: score > 70 AND >= 20 closed positions AND positive total PnL
 *   PRO:   score > 45 AND >= 10 closed positions
 *   BASIC: everything else
 */

// ── Per-Market PnL Calculation ───────────────────────────────────────────────

/**
 * Group trades by conditionId and compute realized PnL per market.
 * Returns an array of market-level performance records.
 */
export function computeMarketPnL(trades) {
  if (!Array.isArray(trades) || trades.length === 0) return [];

  // Group by conditionId + outcome
  const groups = new Map();
  for (const t of trades) {
    const key = `${t.conditionId}::${t.outcome || t.outcomeIndex}`;
    if (!groups.has(key)) {
      groups.set(key, {
        conditionId: t.conditionId,
        title: t.title || "",
        outcome: t.outcome || `index-${t.outcomeIndex}`,
        buys: [],
        sells: [],
        lastTradeTs: 0,
      });
    }
    const g = groups.get(key);
    if (t.side === "BUY") g.buys.push(t);
    else if (t.side === "SELL") g.sells.push(t);
    g.lastTradeTs = Math.max(g.lastTradeTs, t.timestamp || 0);
  }

  const results = [];
  for (const [, g] of groups) {
    const totalBought = g.buys.reduce((s, t) => s + (t.usdcSize || t.size * t.price || 0), 0);
    const totalSold   = g.sells.reduce((s, t) => s + (t.usdcSize || t.size * t.price || 0), 0);
    const totalBuyQty = g.buys.reduce((s, t) => s + (t.size || 0), 0);
    const totalSellQty = g.sells.reduce((s, t) => s + (t.size || 0), 0);

    const avgBuyPrice  = totalBuyQty > 0 ? totalBought / totalBuyQty : 0;
    const avgSellPrice = totalSellQty > 0 ? totalSold / totalSellQty : 0;

    // A position is "closed" if there have been sells (even partial)
    const isClosed = g.sells.length > 0;
    const realizedPnL = totalSold - totalBought;
    const costBasis = totalBought;

    results.push({
      conditionId: g.conditionId,
      title: g.title,
      outcome: g.outcome,
      totalBought,
      totalSold,
      costBasis,
      realizedPnL,
      roi: costBasis > 0 ? (realizedPnL / costBasis) * 100 : 0,
      avgBuyPrice,
      avgSellPrice,
      buyCount: g.buys.length,
      sellCount: g.sells.length,
      isClosed,
      lastTradeTs: g.lastTradeTs,
    });
  }

  return results;
}

// ── Metric Calculators ───────────────────────────────────────────────────────

/**
 * Win rate: percentage of closed positions with positive PnL
 */
export function calcWinRate(marketPnLs) {
  const closed = marketPnLs.filter(m => m.isClosed);
  if (closed.length === 0) return 0;
  const wins = closed.filter(m => m.realizedPnL > 0).length;
  return (wins / closed.length) * 100;
}

/**
 * Sharpe ratio: mean return / std deviation of returns
 * Uses per-market ROI as returns. Higher = more consistent risk-adjusted performance.
 */
export function calcSharpe(marketPnLs) {
  const closed = marketPnLs.filter(m => m.isClosed && m.costBasis > 0);
  if (closed.length < 3) return 0; // need minimum data points

  const returns = closed.map(m => m.roi / 100); // as decimal
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + Math.pow(r - mean, 2), 0) / returns.length;
  const stdDev = Math.sqrt(variance);

  if (stdDev === 0) return mean > 0 ? 3 : 0; // perfect consistency
  return mean / stdDev;
}

/**
 * Max drawdown: largest peak-to-trough decline in cumulative PnL
 * Returns as a positive percentage (e.g., 25 means 25% drawdown)
 */
export function calcMaxDrawdown(marketPnLs) {
  // Sort by last trade timestamp for chronological order
  const sorted = [...marketPnLs]
    .filter(m => m.isClosed)
    .sort((a, b) => a.lastTradeTs - b.lastTradeTs);

  if (sorted.length === 0) return 0;

  let cumPnL = 0;
  let peak = 0;
  let maxDD = 0;

  for (const m of sorted) {
    cumPnL += m.realizedPnL;
    if (cumPnL > peak) peak = cumPnL;
    const dd = peak > 0 ? ((peak - cumPnL) / peak) * 100 : 0;
    if (dd > maxDD) maxDD = dd;
  }

  return Math.round(maxDD * 10) / 10;
}

/**
 * Timing score: how early did the wallet buy relative to final resolution?
 * Measures average buy price — lower buy prices in prediction markets = earlier/better timing.
 * Normalized to 0-100 where 100 = perfect timing (bought at ~0).
 */
export function calcTimingScore(marketPnLs) {
  const withBuys = marketPnLs.filter(m => m.avgBuyPrice > 0 && m.buyCount > 0);
  if (withBuys.length === 0) return 50;

  // Weight by cost basis so bigger positions matter more
  let weightedSum = 0;
  let totalWeight = 0;
  for (const m of withBuys) {
    const weight = m.costBasis || 1;
    // Lower avg buy price = better timing. Score = (1 - avgBuyPrice) * 100
    weightedSum += (1 - Math.min(m.avgBuyPrice, 1)) * 100 * weight;
    totalWeight += weight;
  }

  return totalWeight > 0 ? Math.round(weightedSum / totalWeight) : 50;
}

/**
 * Consistency: penalizes one-hit wonders, rewards wallets that perform across many markets.
 * Returns 0-100 where 100 = highly consistent across many markets.
 */
export function calcConsistency(marketPnLs) {
  const closed = marketPnLs.filter(m => m.isClosed);
  if (closed.length === 0) return 0;

  // Factor 1: number of markets (log-scaled, caps at ~20)
  const marketCount = Math.min(closed.length, 30);
  const breadth = Math.min((Math.log2(marketCount + 1) / Math.log2(31)) * 100, 100);

  // Factor 2: what % of markets are profitable?
  const profitableRatio = closed.filter(m => m.realizedPnL > 0).length / closed.length;

  // Factor 3: low variance in returns = more consistent
  const returns = closed.map(m => m.costBasis > 0 ? m.realizedPnL / m.costBasis : 0);
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + Math.pow(r - mean, 2), 0) / returns.length;
  const cv = mean !== 0 ? Math.sqrt(variance) / Math.abs(mean) : 10; // coefficient of variation
  const stability = Math.max(0, 100 - cv * 20); // lower CV = higher stability

  return Math.round(breadth * 0.3 + profitableRatio * 100 * 0.4 + stability * 0.3);
}

// ── Composite Score ──────────────────────────────────────────────────────────

/**
 * Apply recency weighting: trades older than halfLifeDays count less.
 * Returns filtered trades with a `weight` field.
 */
export function applyRecencyWeight(trades, halfLifeDays = 30) {
  const now = Date.now() / 1000;
  const halfLife = halfLifeDays * 86400;

  return trades.map(t => {
    const age = now - (t.timestamp || 0);
    const weight = Math.pow(0.5, age / halfLife);
    return { ...t, _recencyWeight: weight };
  });
}

/**
 * Normalize a raw metric value to 0-100 scale
 */
function normalize(value, min, max) {
  if (max === min) return 50;
  return Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100));
}

/**
 * Map Sharpe ratio to a percentile score (0-100) using a piecewise curve.
 * Avoids the problem where 3 consecutive wins inflate Sharpe linearly to ~100.
 *
 * Breakpoints (based on typical prediction market trader distributions):
 *   Sharpe <= -1   →  0
 *   Sharpe  0      → 25
 *   Sharpe  0.5    → 50
 *   Sharpe  1.0    → 70
 *   Sharpe  1.5    → 85
 *   Sharpe  2.0    → 93
 *   Sharpe >= 3.0  → 100
 */
function sharpeToPercentile(sharpe) {
  const breakpoints = [
    [-1,  0],
    [ 0, 25],
    [0.5, 50],
    [1.0, 70],
    [1.5, 85],
    [2.0, 93],
    [3.0, 100],
  ];
  if (sharpe <= breakpoints[0][0]) return breakpoints[0][1];
  if (sharpe >= breakpoints[breakpoints.length - 1][0]) return breakpoints[breakpoints.length - 1][1];

  for (let i = 1; i < breakpoints.length; i++) {
    const [x0, y0] = breakpoints[i - 1];
    const [x1, y1] = breakpoints[i];
    if (sharpe <= x1) {
      const t = (sharpe - x0) / (x1 - x0);
      return Math.round(y0 + t * (y1 - y0));
    }
  }
  return 50;
}

/**
 * Main scoring function. Takes raw trades and positions, returns full score breakdown.
 */
export function scoreWallet(trades, positions = []) {
  if (!Array.isArray(trades) || trades.length === 0) {
    return {
      score: 0, tier: "BASIC", winRate: 0, sharpe: 0, maxDrawdown: 0,
      timing: 0, consistency: 0, totalPnL: 0, totalVolume: 0, totalROI: 0,
      closedPositions: 0, openPositions: 0, marketPnLs: [],
    };
  }

  const marketPnLs = computeMarketPnL(trades);
  const closedCount = marketPnLs.filter(m => m.isClosed).length;
  const totalPnL = marketPnLs.reduce((s, m) => s + m.realizedPnL, 0);
  const totalVolume = marketPnLs.reduce((s, m) => s + m.totalBought, 0);

  // Raw metrics
  const winRate     = calcWinRate(marketPnLs);
  const sharpe      = calcSharpe(marketPnLs);
  const maxDrawdown = calcMaxDrawdown(marketPnLs);
  const timing      = calcTimingScore(marketPnLs);
  const consistency = calcConsistency(marketPnLs);

  // Normalize sharpe to 0-100 using percentile-based mapping
  // Typical prediction market Sharpe ranges: <0 = bad, 0.5 = decent, 1.0 = good, 2.0+ = exceptional
  const sharpeNorm = sharpeToPercentile(sharpe);

  // PnL percentile: normalize total ROI
  const totalROI = totalVolume > 0 ? (totalPnL / totalVolume) * 100 : 0;
  const pnlNorm = normalize(totalROI, -50, 100);

  // Composite score
  const score = Math.round(
    winRate     * 0.25 +
    sharpeNorm  * 0.25 +
    pnlNorm     * 0.25 +
    timing      * 0.15 +
    consistency * 0.10
  );

  const clampedScore = Math.max(0, Math.min(100, score));

  // Tier assignment with hardened gates
  let tier;
  if (
    clampedScore > 70 &&
    closedCount >= 20 &&
    totalPnL > 500 &&                                    // minimum $500 profit (was $0)
    totalVolume > 0 && (totalPnL / totalVolume) > 0.02   // minimum 2% ROI
  ) {
    tier = "ELITE";
  } else if (clampedScore > 45 && closedCount >= 10) {
    tier = "PRO";
  } else {
    tier = "BASIC";
  }

  return {
    score: clampedScore,
    tier,
    winRate:     Math.round(winRate * 10) / 10,
    sharpe:      Math.round(sharpe * 100) / 100,
    maxDrawdown,
    timing,
    consistency,
    totalPnL:    Math.round(totalPnL * 100) / 100,
    totalVolume: Math.round(totalVolume * 100) / 100,
    totalROI:    Math.round(totalROI * 10) / 10,
    closedPositions: closedCount,
    openPositions:   marketPnLs.filter(m => !m.isClosed).length,
    marketPnLs,
  };
}
