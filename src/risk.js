/**
 * Risk Management
 * ───────────────
 * Pre-trade checks that gate auto-copy execution based on:
 *   - Daily realized loss limit
 *   - Per-market exposure cap
 *   - Total portfolio exposure cap
 *   - Per-market cooldown (prevents rapid-fire same-market trades)
 *
 * All limits are read from env at module load. A trade is permitted only if
 * every relevant check returns { ok: true }.
 */

// Module-load env defaults — kept as a fallback when neither runtime config
// nor an explicit cfg argument supplies a value. Precedence (audit P2-2):
//   cfg arg  >  env  >  hardcoded
const ENV_DAILY_LOSS    = Number(process.env.MAX_DAILY_LOSS_USDC       || 200);
const ENV_MARKET_EXP    = Number(process.env.MAX_MARKET_EXPOSURE_USDC  || 300);
const ENV_TOTAL_EXP     = Number(process.env.MAX_TOTAL_EXPOSURE_USDC   || 1000);
const ENV_COOLDOWN_MS   = Number(process.env.MARKET_COOLDOWN_MIN || 30) * 60_000;

/** Pick numeric value from cfg first, env second, hardcoded last. */
function pickLimit(cfgVal, envVal, fallback) {
  const c = Number(cfgVal);
  if (Number.isFinite(c) && c > 0) return c;
  const e = Number(envVal);
  if (Number.isFinite(e) && e > 0) return e;
  return fallback;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Resolve current limits from config — exported for /health snapshots and tests.
 * Live config wins; env is the deployment-time fallback; hardcoded is the
 * last-resort safety net (so a wholly empty config doesn't leave us with
 * no caps at all).
 */
export function resolveRiskLimits(cfg = {}) {
  return {
    dailyLossLimit:  pickLimit(cfg.maxDailyLossUsdc,      ENV_DAILY_LOSS,  200),
    marketExposure:  pickLimit(cfg.maxMarketExposureUsdc, ENV_MARKET_EXP,  300),
    totalExposure:   pickLimit(cfg.maxTotalExposureUsdc,  ENV_TOTAL_EXP,   1000),
    marketCooldownMs: (() => {
      const c = Number(cfg.marketCooldownMin);
      if (Number.isFinite(c) && c >= 0) return c * 60_000;
      return ENV_COOLDOWN_MS;
    })(),
  };
}

/**
 * Sum of realized PnL for trades marked as losing in the last 24h.
 * A trade counts toward daily loss when its status is FILLED/PARTIAL with negative pnl,
 * or when it's ERROR (the nonce/gas cost is lost).
 */
export function dailyRealizedLoss(state) {
  const cutoff = Date.now() - DAY_MS;
  let loss = 0;
  for (const t of state.autoTrades) {
    if ((t.executedAt || 0) < cutoff) continue;
    if (typeof t.pnl === "number" && t.pnl < 0) loss += Math.abs(t.pnl);
    // Errored trades forfeit no USDC directly, but count each as $1 of "risk consumed"
    // so a cascade of failures still trips the breaker.
    else if (t.status === "ERROR") loss += 1;
  }
  return loss;
}

/**
 * Current open exposure in a given market (sum of FILLED/PARTIAL size on open positions).
 * Uses autoTrades history as the authoritative ledger — does not query Polymarket.
 */
export function marketExposure(state, conditionId) {
  let exposure = 0;
  for (const t of state.autoTrades) {
    if (t.conditionId !== conditionId) continue;
    if (t.status === "FILLED" || t.status === "PARTIAL") exposure += t.size || 0;
  }
  return exposure;
}

/**
 * Total open exposure across all markets.
 */
export function totalExposure(state) {
  let total = 0;
  for (const t of state.autoTrades) {
    if (t.status === "FILLED" || t.status === "PARTIAL") total += t.size || 0;
  }
  return total;
}

/**
 * V3 live-test cap — cumulative filled USDC across every auto-copy trade
 * ever executed (no day-bucket reset). Used as a hard ceiling while the
 * operator is running the small-amount end-to-end validation; prevents a
 * silent bug from blowing past the $5–$10 budget.
 */
export function lifetimeAutoTradeUsdc(state) {
  let total = 0;
  for (const t of state.autoTrades || []) {
    if (t.status === "FILLED" || t.status === "PARTIAL") total += t.size || 0;
  }
  return total;
}

/**
 * Timestamp of the most recent trade attempt on a given market (any direction, any status).
 * Returns 0 if no prior trade.
 */
export function lastMarketTradeTs(state, conditionId) {
  let last = 0;
  for (const t of state.autoTrades) {
    if (t.conditionId !== conditionId) continue;
    if ((t.executedAt || 0) > last) last = t.executedAt;
  }
  return last;
}

/**
 * Main gate. Returns { ok, reason } — if ok=false, caller must skip the trade.
 *
 * @param {object} state      Runtime state (autoTrades ledger)
 * @param {string} conditionId Market conditionId
 * @param {number} sizeUsdc   Size of the candidate trade
 * @param {object} [cfg]      Optional runtime config overrides (V3 liveTest cap, etc.)
 */
export function checkRiskLimits(state, conditionId, sizeUsdc, cfg = {}) {
  const limits = resolveRiskLimits(cfg);

  // killSwitch: set by autonomous evaluator when rolling-Sharpe / lifetime-PnL
  // / drawdown crosses pre-set thresholds. Until operator manually clears
  // (POST /killswitch/clear), no auto-trade can execute. Manual /trade still
  // works — operator override is intentional.
  if (state.killSwitch?.active) {
    return { ok: false, reason: `killSwitch active: ${state.killSwitch.reason}` };
  }

  // V1 Gate (audit P0-2): block auto-trades until 30-day data accumulation
  // is complete, UNLESS one of two opt-out conditions is set:
  //   1. liveTestCapUsdc > 0  → operator is explicitly in V3 small-amount
  //      validation mode (cumulative cap below already enforced)
  //   2. env BYPASS_V1_GATE=true  → emergency / advanced operator escape
  // Without an opt-out, the dashboard's progress bar is now also a hard gate.
  const v1Pct = Number(state.v1ReadyPct ?? 0);
  const liveCap = Number(cfg.liveTestCapUsdc || 0);
  const envBypass = String(process.env.BYPASS_V1_GATE || "").toLowerCase() === "true";
  if (v1Pct < 100 && liveCap <= 0 && !envBypass) {
    return {
      ok: false,
      reason: `V1 Gate ${v1Pct}% / 100% — set liveTestCapUsdc > 0 (small-amount validation) or BYPASS_V1_GATE=true to override`,
    };
  }

  // V3 live-test hard cap: cumulative FILLED/PARTIAL auto-trade USDC must
  // stay ≤ liveTestCapUsdc. This is a belt-and-suspenders guard for the
  // small-amount end-to-end validation window. 0 = disabled.
  if (liveCap > 0) {
    const lifetime = lifetimeAutoTradeUsdc(state);
    if (lifetime + sizeUsdc > liveCap) {
      return {
        ok: false,
        reason: `V3 live-test cap: $${(lifetime + sizeUsdc).toFixed(2)} would exceed $${liveCap}`,
      };
    }
  }

  const loss = dailyRealizedLoss(state);
  if (loss >= limits.dailyLossLimit) {
    return { ok: false, reason: `Daily loss $${loss.toFixed(2)} >= limit $${limits.dailyLossLimit}` };
  }

  const marketExp = marketExposure(state, conditionId);
  if (marketExp + sizeUsdc > limits.marketExposure) {
    return { ok: false, reason: `Market exposure $${(marketExp + sizeUsdc).toFixed(2)} > limit $${limits.marketExposure}` };
  }

  const totalExp = totalExposure(state);
  if (totalExp + sizeUsdc > limits.totalExposure) {
    return { ok: false, reason: `Total exposure $${(totalExp + sizeUsdc).toFixed(2)} > limit $${limits.totalExposure}` };
  }

  const lastTs = lastMarketTradeTs(state, conditionId);
  if (lastTs > 0 && Date.now() - lastTs < limits.marketCooldownMs) {
    const remainMin = Math.ceil((limits.marketCooldownMs - (Date.now() - lastTs)) / 60_000);
    return { ok: false, reason: `Market cooldown — ${remainMin} min remaining` };
  }

  return { ok: true };
}

export function getRiskSnapshot(state, cfg = {}) {
  const liveCap = Number(cfg.liveTestCapUsdc || 0);
  const limits = resolveRiskLimits(cfg);
  return {
    dailyLoss:       Math.round(dailyRealizedLoss(state) * 100) / 100,
    dailyLossLimit:  limits.dailyLossLimit,
    totalExposure:   Math.round(totalExposure(state) * 100) / 100,
    totalLimit:      limits.totalExposure,
    marketLimit:     limits.marketExposure,
    cooldownMin:     limits.marketCooldownMs / 60_000,
    liveTestCapUsdc: liveCap,
    liveTestUsed:    liveCap > 0 ? Math.round(lifetimeAutoTradeUsdc(state) * 100) / 100 : 0,
  };
}
