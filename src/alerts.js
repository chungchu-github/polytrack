/**
 * Alerts
 * ──────
 * Non-blocking webhook notifications for operationally-significant events:
 *   - Trade executed (FILLED / PARTIAL / SIMULATED)
 *   - Trade failed (ERROR)
 *   - Circuit breaker tripped (auto-copy disabled after N consecutive failures)
 *   - Daily PnL roll-up
 *   - Scan errors
 *
 * Delivery target: Discord or Slack incoming webhook (same JSON shape works
 * for both — `{ content }` for Discord, `{ text }` for Slack; we send both
 * so either service renders the message).
 *
 * Transport failures are logged but never thrown — alerts must never crash
 * the main trade/scan loop.
 */

import { loadConfig } from "./config.js";
import { pino } from "pino";

const log = pino({ name: "alerts", level: process.env.LOG_LEVEL || "info" });

/** Send a plain-text message to the configured webhook. No-ops if unconfigured. */
async function post(message) {
  const { webhookUrl } = loadConfig();
  if (!webhookUrl) return;
  try {
    const body = JSON.stringify({ content: message, text: message });
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      log.warn({ status: res.status }, "webhook non-2xx");
    }
  } catch (e) {
    log.warn({ err: e.message }, "webhook delivery failed");
  }
}

// ── Event helpers ────────────────────────────────────────────────────────────

export function alertTradeExecuted(trade) {
  const emoji = trade.status === "FILLED" ? "✅"
              : trade.status === "PARTIAL" ? "🟡"
              : trade.status === "SIMULATED" ? "🧪"
              : "⚠️";
  const price = trade.limitPrice != null ? trade.limitPrice.toFixed(3) : "?";
  return post(
    `${emoji} **Trade ${trade.status}** — ${trade.direction} $${trade.size} @ ${price}\n` +
    `${trade.title || trade.conditionId?.slice(0, 16)}`
  );
}

export function alertTradeFailed(trade, error) {
  return post(
    `❌ **Trade FAILED** — ${trade.direction} $${trade.size}\n` +
    `${trade.title || trade.conditionId?.slice(0, 16)}\n` +
    `Error: ${error}`
  );
}

export function alertBreakerTripped(failureStreak, threshold) {
  return post(
    `🛑 **Circuit breaker tripped** — auto-copy disabled after ${failureStreak} consecutive failures ` +
    `(threshold: ${threshold}). Investigate before re-enabling.`
  );
}

export function alertRiskBlocked(signal, reason) {
  return post(
    `🚫 **Risk blocked trade** — ${signal.direction} ${signal.title?.slice(0, 60) || signal.conditionId?.slice(0, 16)}\n` +
    `Reason: ${reason}`
  );
}

export function alertDailyPnL(summary) {
  const { totalPnL = 0, tradeCount = 0, winRate = 0 } = summary;
  const emoji = totalPnL > 0 ? "📈" : totalPnL < 0 ? "📉" : "➖";
  return post(
    `${emoji} **Daily PnL** — $${totalPnL.toFixed(2)} across ${tradeCount} trades ` +
    `(win rate ${winRate.toFixed(1)}%)`
  );
}

export function alertScanError(error) {
  return post(`⚠️ **Scan error** — ${error}`);
}

export function alertStartup(mode, version) {
  return post(`🚀 **Polytrack started** — v${version} · mode: ${mode}`);
}
