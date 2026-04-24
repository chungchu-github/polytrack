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

const DAILY_LOSS_LIMIT   = Number(process.env.MAX_DAILY_LOSS_USDC       || 200);
const MARKET_EXPOSURE    = Number(process.env.MAX_MARKET_EXPOSURE_USDC  || 300);
const TOTAL_EXPOSURE     = Number(process.env.MAX_TOTAL_EXPOSURE_USDC   || 1000);
const MARKET_COOLDOWN_MS = Number(process.env.MARKET_COOLDOWN_MIN || 30) * 60_000;

const DAY_MS = 24 * 60 * 60 * 1000;

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
  // V3 live-test hard cap: cumulative FILLED/PARTIAL auto-trade USDC must
  // stay ≤ liveTestCapUsdc. This is a belt-and-suspenders guard for the
  // small-amount end-to-end validation window. 0 = disabled.
  const liveCap = Number(cfg.liveTestCapUsdc || 0);
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
  if (loss >= DAILY_LOSS_LIMIT) {
    return { ok: false, reason: `Daily loss $${loss.toFixed(2)} >= limit $${DAILY_LOSS_LIMIT}` };
  }

  const marketExp = marketExposure(state, conditionId);
  if (marketExp + sizeUsdc > MARKET_EXPOSURE) {
    return { ok: false, reason: `Market exposure $${(marketExp + sizeUsdc).toFixed(2)} > limit $${MARKET_EXPOSURE}` };
  }

  const totalExp = totalExposure(state);
  if (totalExp + sizeUsdc > TOTAL_EXPOSURE) {
    return { ok: false, reason: `Total exposure $${(totalExp + sizeUsdc).toFixed(2)} > limit $${TOTAL_EXPOSURE}` };
  }

  const lastTs = lastMarketTradeTs(state, conditionId);
  if (lastTs > 0 && Date.now() - lastTs < MARKET_COOLDOWN_MS) {
    const remainMin = Math.ceil((MARKET_COOLDOWN_MS - (Date.now() - lastTs)) / 60_000);
    return { ok: false, reason: `Market cooldown — ${remainMin} min remaining` };
  }

  return { ok: true };
}

export function getRiskSnapshot(state, cfg = {}) {
  const liveCap = Number(cfg.liveTestCapUsdc || 0);
  return {
    dailyLoss:       Math.round(dailyRealizedLoss(state) * 100) / 100,
    dailyLossLimit:  DAILY_LOSS_LIMIT,
    totalExposure:   Math.round(totalExposure(state) * 100) / 100,
    totalLimit:      TOTAL_EXPOSURE,
    marketLimit:     MARKET_EXPOSURE,
    cooldownMin:     MARKET_COOLDOWN_MS / 60_000,
    liveTestCapUsdc: liveCap,
    liveTestUsed:    liveCap > 0 ? Math.round(lifetimeAutoTradeUsdc(state) * 100) / 100 : 0,
  };
}
