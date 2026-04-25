/**
 * killSwitch — autonomous auto-trade circuit breaker.
 *
 * Evaluates three failure conditions on the live trade ledger and trips
 * `state.killSwitch.active = true` when any one fires. Once tripped, the
 * risk gate (`checkRiskLimits`) refuses every auto-trade until the
 * operator manually clears via `POST /killswitch/clear`. Manual `POST
 * /trade` still works — killSwitch is about UNATTENDED losing, not
 * blocking the operator's own decisions.
 *
 * Conditions (any → trip):
 *   1. lifetime PnL <= −maxLifetimeLossUsdc      (default −$30)
 *   2. peak-to-trough drawdown >= maxDrawdownPct (default 25%)
 *   3. rolling Sharpe over rollingWindowDays <= minRollingSharpe
 *      (default 28d Sharpe < −0.5)
 *
 * The first two need only realized PnL on settled trades. Sharpe needs
 * at least 5 settled trades inside the window — below that, we skip the
 * Sharpe check (insufficient signal).
 *
 * Pure helpers exported for testing — no DB, no clock, no I/O.
 */

const DEFAULTS = {
  enabled:               true,
  maxLifetimeLossUsdc:   30,    // trip if cumulative realized PnL ≤ −$30
  maxDrawdownPct:        0.25,  // trip if peak-to-trough drawdown ≥ 25%
  minRollingSharpe:     -0.5,   // trip if rolling-window Sharpe ≤ −0.5
  rollingWindowDays:     28,
  minSamplesForSharpe:    5,    // skip Sharpe check below this many settled trades
};

/**
 * Trades reaching the killSwitch evaluator must have:
 *   - status: "FILLED" | "PARTIAL" | other
 *   - pnl:    number (settled realized PnL — null/undefined for unsettled)
 *   - exitedAt OR settledAt: number (ms timestamp; required for windowing)
 *
 * Convention here: a "settled" trade is one with `Number.isFinite(pnl)`,
 * regardless of whether it came from auto-exit or market resolution.
 */
function isSettled(t) {
  return t && Number.isFinite(Number(t.pnl));
}

/** Sum of realized PnL across all settled trades. */
export function lifetimeRealizedPnl(trades) {
  if (!Array.isArray(trades)) return 0;
  let sum = 0;
  for (const t of trades) {
    if (!isSettled(t)) continue;
    sum += Number(t.pnl);
  }
  return Math.round(sum * 100) / 100;
}

/**
 * Peak-to-trough drawdown of the cumulative realized-PnL curve.
 * Returns a positive fraction (e.g. 0.25 for 25% drawdown). 0 when no
 * settled trades or curve never declined from a positive peak.
 *
 * "Peak" is reset to the initial cash baseline + max-cum-pnl-so-far.
 * For a small-amount validation run we don't want a baseline drift to
 * paper over real losses, so we measure relative to the INITIAL state
 * (cumPnl=0) rather than relative to a peak that includes pure paper gain.
 */
export function maxDrawdownFromTrades(trades = [], baselineUsdc = null) {
  const settled = trades.filter(isSettled).sort((a, b) => {
    const ta = Number(a.exitedAt || a.settledAt || 0);
    const tb = Number(b.exitedAt || b.settledAt || 0);
    return ta - tb;
  });
  if (settled.length === 0) return 0;

  const baseline = Number(baselineUsdc) || 0;
  let cum = 0;
  let peak = 0;            // peak of cumulative PnL (allows negative)
  let maxDd = 0;
  for (const t of settled) {
    cum += Number(t.pnl);
    if (cum > peak) peak = cum;
    // Drawdown is only well-defined relative to a positive equity peak.
    // Without a baseline (operator hasn't told us their initial budget), we
    // can't divide raw dollar losses by anything meaningful — lifetimePnl
    // is the right metric in that case, and we leave drawdown=0 here.
    const equityPeak = baseline + peak;
    if (equityPeak > 0) {
      const equityNow = baseline + cum;
      const dd = (equityPeak - equityNow) / equityPeak;
      if (dd > maxDd) maxDd = dd;
    }
  }
  return Math.round(maxDd * 10000) / 10000;
}

/**
 * Rolling Sharpe over `windowDays`. Computed on per-trade realized PnL
 * (not daily bucketed) — appropriate for low-frequency strategies where
 * trade count = sample count. Uses sample stdev (n−1).
 *
 * Returns null when fewer than `minSamples` settled trades fall inside
 * the window — caller should treat null as "insufficient data, do not trip".
 */
export function rollingSharpe(trades = [], { windowDays = 28, now = Date.now(), minSamples = 5 } = {}) {
  const cutoff = now - windowDays * 24 * 60 * 60 * 1000;
  const inWindow = trades
    .filter(t => isSettled(t) && Number(t.exitedAt || t.settledAt || 0) >= cutoff)
    .map(t => Number(t.pnl));
  if (inWindow.length < minSamples) return null;
  const mean = inWindow.reduce((a, b) => a + b, 0) / inWindow.length;
  const variance = inWindow.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, inWindow.length - 1);
  const std = Math.sqrt(variance);
  if (std === 0) return mean > 0 ? Infinity : (mean < 0 ? -Infinity : 0);
  return Math.round((mean / std) * 100) / 100;
}

/**
 * Pure decision: should we trip the killSwitch given current state?
 *
 * Returns:
 *   { trip: false, metrics }                   — all conditions OK
 *   { trip: true, reason: "...", metrics }     — first failing condition
 *
 * Caller is expected to set state.killSwitch.active and persist; this
 * function does NOT mutate.
 */
export function evaluateKillSwitch(trades, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  if (!cfg.enabled) return { trip: false, metrics: null };

  const lifetimePnl = lifetimeRealizedPnl(trades);
  const drawdown    = maxDrawdownFromTrades(trades, cfg.baselineUsdc);
  const sharpe      = rollingSharpe(trades, {
    windowDays: cfg.rollingWindowDays,
    now: cfg.now,
    minSamples: cfg.minSamplesForSharpe,
  });

  const metrics = { lifetimePnl, drawdown, sharpe };

  // Lifetime loss is the primary "stop bleeding" guard — checked first.
  if (lifetimePnl <= -Math.abs(cfg.maxLifetimeLossUsdc)) {
    return {
      trip: true,
      reason: `lifetime PnL $${lifetimePnl} <= -$${Math.abs(cfg.maxLifetimeLossUsdc)}`,
      metrics,
    };
  }

  // Drawdown — protects against round-tripping a winning streak.
  if (drawdown >= cfg.maxDrawdownPct) {
    return {
      trip: true,
      reason: `drawdown ${(drawdown * 100).toFixed(1)}% >= ${(cfg.maxDrawdownPct * 100).toFixed(1)}%`,
      metrics,
    };
  }

  // Sharpe — only trips when we have enough samples; null = skip.
  if (sharpe != null && sharpe <= cfg.minRollingSharpe) {
    return {
      trip: true,
      reason: `${cfg.rollingWindowDays}d Sharpe ${sharpe} <= ${cfg.minRollingSharpe}`,
      metrics,
    };
  }

  return { trip: false, metrics };
}

export const KILLSWITCH_DEFAULTS = DEFAULTS;
