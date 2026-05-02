/**
 * Data Capture Layer (F0.5)
 * ─────────────────────────
 * Persists periodic market & wallet-position snapshots so downstream features
 * (F2 momentum/mean-reversion strategies, F3 backtest engine) have a replayable
 * historical time-series.
 *
 * Integration points:
 *   - Called at the end of each runScan() in src/server.js
 *   - pruneOldSnapshots() runs on a daily cron to keep DB size bounded
 */

import {
  insertMarketSnapshot, insertPositionSnapshot,
  deleteOldMarketSnapshots, deleteOldPositionHistory,
} from "./db.js";
import { fetchOrderBook, fetchOrderBooks } from "./polymarket-api.js";
import { loadConfig } from "./config.js";
import { getDiskUsage } from "./disk.js";
import log from "./logger.js";

const BATCH_BOOKS_MAX = 500;

/**
 * Capture order-book snapshots for every token across the provided market
 * events. Computes mid price, best bid/ask, and top-5 depth.
 *
 * @param {Array} events  markets array as returned by fetchMarkets()
 * @returns {Promise<{inserted:number, failed:number}>}
 */
export async function captureMarketSnapshot(events = []) {
  const now = Date.now();
  let inserted = 0;
  let failed = 0;

  // 1. Flatten (tokenId, conditionId, volume24h) triples so we can batch-fetch
  //    all orderbooks in one /books call instead of N serial /book calls.
  const jobs = [];
  for (const evt of events || []) {
    const volume24h = Number(evt.volume) || null;
    for (const m of evt.markets || []) {
      const tokens = Array.isArray(m.tokens) ? m.tokens : [];
      for (const tok of tokens) {
        const tokenId = tok?.token_id || tok?.tokenId || tok;
        if (!tokenId || !m.conditionId) continue;
        jobs.push({ tokenId: String(tokenId), conditionId: m.conditionId, volume24h });
      }
    }
  }
  if (jobs.length === 0) return { inserted: 0, failed: 0 };

  // 2. Batch-fetch books. Chunk at BATCH_BOOKS_MAX (500) per request.
  const byToken = new Map();
  for (let i = 0; i < jobs.length; i += BATCH_BOOKS_MAX) {
    const chunk = jobs.slice(i, i + BATCH_BOOKS_MAX);
    const tokenIds = chunk.map(j => j.tokenId);
    const booksMap = await fetchOrderBooks(tokenIds);
    if (booksMap) {
      for (const [tid, book] of booksMap) byToken.set(tid, book);
    } else {
      // Batch request failed entirely — fall back to per-token fetches.
      for (const { tokenId } of chunk) {
        const book = await fetchOrderBook(tokenId);
        if (book) byToken.set(tokenId, book);
      }
    }
  }

  // 3. Persist snapshots.
  for (const { tokenId, conditionId, volume24h } of jobs) {
    const book = byToken.get(tokenId);
    if (!book) { failed++; continue; }
    try {
      const bestBid = book.bids.length ? book.bids[0].price : null;
      const bestAsk = book.asks.length ? book.asks[0].price : null;
      const midPrice = (bestBid != null && bestAsk != null)
        ? Math.round(((bestBid + bestAsk) / 2) * 10000) / 10000
        : null;
      const bidDepth = book.bids.slice(0, 5).reduce((s, b) => s + (b.size || 0), 0);
      const askDepth = book.asks.slice(0, 5).reduce((s, a) => s + (a.size || 0), 0);
      insertMarketSnapshot({
        conditionId,
        tokenId,
        timestamp: now,
        midPrice, bestBid, bestAsk,
        bidDepth, askDepth,
        volume24h,
      });
      inserted++;
    } catch (e) {
      failed++;
      log.warn(`captureMarketSnapshot persist failed for ${tokenId.slice(0, 10)}…: ${e.message}`);
    }
  }

  if (inserted > 0 || failed > 0) {
    log.db(`Market snapshot: ${inserted} inserted, ${failed} failed (1 batch for ${jobs.length} tokens)`);
  }
  // Return byToken so the scan loop can pre-filter strategies' market set
  // by current orderbook liquidity (PR liquid-filter).
  return { inserted, failed, byToken };
}

/**
 * Snapshot every tracked wallet's current open positions. Positions come from
 * the wallet objects already loaded during the scan (wallet.positions is the
 * raw Polymarket Data API response shape).
 *
 * @param {object} state  shared runtime state
 * @returns {number}      number of rows inserted
 */
export function captureWalletPositions(state) {
  const now = Date.now();
  let inserted = 0;

  for (const [addr, wallet] of state.wallets) {
    const positions = Array.isArray(wallet?.positions) ? wallet.positions : [];
    for (const p of positions) {
      const conditionId = p.conditionId || p.condition_id;
      if (!conditionId) continue;
      const size = Number(p.size ?? p.sizeUsd ?? 0);
      if (!(size > 0)) continue;
      insertPositionSnapshot({
        walletAddress: addr,
        conditionId,
        outcome: p.outcome || null,
        size,
        avgPrice: Number(p.avgPrice ?? p.avg_price ?? 0) || null,
        currentValue: Number(p.currentValue ?? p.current_value ?? 0) || null,
        pnl: Number(p.cashPnl ?? p.pnl ?? 0) || null,
        snapshotAt: now,
      });
      inserted++;
    }
  }

  if (inserted > 0) log.db(`Position snapshot: ${inserted} rows across ${state.wallets.size} wallets`);
  return inserted;
}

/**
 * Prune snapshot rows older than the per-table retention window.
 *
 * Reads windows from runtime config (cfg.retention.{market,position}Days)
 * with hard defaults if config is missing/invalid. The 6h cron passes no
 * args; ad-hoc callers can override via opts (back-compat preserved).
 *
 * Emergency-aggressive mode: when disk usage on the DB partition exceeds
 * `cfg.retention.emergencyDiskUsedFrac` (default 0.85), retention falls
 * back to `emergencyPositionHours` / `emergencyMarketHours` (much shorter)
 * regardless of the configured days. This is a safety net so an
 * unexpected accumulation burst can't fill the disk and lock writes
 * (production crash 2026-05-02).
 *
 * Returns {markets, positions, mode} where mode = "normal" | "emergency".
 */
export function pruneOldSnapshots(opts = {}) {
  // Legacy form — pruneOldSnapshots(90) → both tables 90d. Skips emergency check.
  if (typeof opts === "number") {
    opts = { marketDays: opts, positionDays: opts, _bypassEmergency: true };
  }
  const cfg = (() => {
    try { return loadConfig().retention || {}; } catch { return {}; }
  })();
  const positionDays = pickFinite(opts.positionDays, cfg.positionDays, 1);
  const marketDays   = pickFinite(opts.marketDays,   cfg.marketDays,   7);

  // Emergency check — 6h-cron invocation (opts empty) consults disk; legacy
  // bare-number callers bypass so unit tests stay deterministic.
  // Tests can also pass opts._forceUsedFrac to drive the gate directly.
  let mode = "normal";
  let positionHours = positionDays * 24;
  let marketHours   = marketDays * 24;
  if (!opts._bypassEmergency) {
    const usedFrac = Number.isFinite(opts._forceUsedFrac)
      ? opts._forceUsedFrac
      : (getDiskUsage("./data")?.usedFrac ?? 0);
    const trip  = pickFinite(cfg.emergencyDiskUsedFrac, 0.85);
    if (usedFrac >= trip) {
      mode = "emergency";
      positionHours = pickFinite(cfg.emergencyPositionHours, 6);
      marketHours   = pickFinite(cfg.emergencyMarketHours,   24);
      log.warn(
        `Snapshot prune: EMERGENCY mode (disk ${(usedFrac * 100).toFixed(1)}% used) — ` +
        `forcing ${positionHours}h positions / ${marketHours}h markets`
      );
    }
  }

  const now = Date.now();
  const positionCutoff = now - positionHours * 60 * 60 * 1000;
  const marketCutoff   = now - marketHours   * 60 * 60 * 1000;
  const markets   = deleteOldMarketSnapshots(marketCutoff);
  const positions = deleteOldPositionHistory(positionCutoff);
  if (markets > 0 || positions > 0) {
    const winLabel = mode === "emergency"
      ? `${positionHours}h pos / ${marketHours}h markets`
      : `${positionDays}d pos / ${marketDays}d markets`;
    log.db(`Snapshot prune [${mode}]: ${markets} market rows, ${positions} position rows (${winLabel})`);
  }
  return { markets, positions, mode };
}

function pickFinite(...vals) {
  for (const v of vals) {
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return 0;
}
