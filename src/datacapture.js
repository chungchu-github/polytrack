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
 * Two tables grow at very different rates and serve different downstream
 * needs, so they get separate windows:
 *
 *   - market_snapshots: 1 row per (token, scan) ≈ 60 markets × 2 tokens × 60
 *     scans/h ≈ 7.2k rows/h ≈ 175k/day. Backtest + momentum need a longer
 *     window (default 30d → ~5M rows, fine for a small VPS).
 *
 *   - positions_history: 1 row per (wallet, position, scan). With 14 active
 *     wallets × ~200 cids × 60 scans/h that's 168k rows/h ≈ 4M/day —
 *     accumulating to >50M in a couple weeks. The 90-day default caused a
 *     production OOM crash loop on 2026-04-27 because hydrateFromDB tried
 *     to .all() millions of rows. Default tightened to 7d (consensus
 *     recency window is 7d so this is the longest we actually need for
 *     signal detection; backtest replay can read history if asked).
 *
 * Backwards-compat: passing a bare number defaults BOTH tables to that
 * window (preserves old call sites). Passing an object lets callers
 * override per-table.
 *
 * Returns {markets, positions} delete counts.
 */
export function pruneOldSnapshots(opts = {}) {
  // Legacy form — pruneOldSnapshots(90) → both tables 90d.
  if (typeof opts === "number") {
    opts = { marketDays: opts, positionDays: opts };
  }
  const { marketDays = 30, positionDays = 7 } = opts;
  const now = Date.now();
  const marketCutoff   = now - marketDays   * 24 * 60 * 60 * 1000;
  const positionCutoff = now - positionDays * 24 * 60 * 60 * 1000;
  const markets   = deleteOldMarketSnapshots(marketCutoff);
  const positions = deleteOldPositionHistory(positionCutoff);
  if (markets > 0 || positions > 0) {
    log.db(`Snapshot prune: ${markets} market rows (>${marketDays}d), ${positions} position rows (>${positionDays}d)`);
  }
  return { markets, positions };
}
