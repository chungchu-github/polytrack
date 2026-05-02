/**
 * State Management with DB Persistence
 * ─────────────────────────────────────
 * In-memory state backed by SQLite. Writes through to DB on every mutation.
 * On startup, hydrates from DB so state survives restarts.
 */

import { SignalStore } from "./signals.js";
import { StrategyEngine } from "./strategies/engine.js";
import { loadConfig } from "./config.js";
import * as db from "./db.js";

export function createState(config = {}) {
  const cfg = loadConfig();
  const engine = new StrategyEngine(cfg.strategies || {});
  // Keep signalStore alias pointing at the consensus strategy's SignalStore
  // so existing call sites (getSignals, markTraded) keep working.
  const consensus = engine.get("consensus");
  const signalStore = consensus?.store || new SignalStore({
    minWallets: config.minWallets || 1,
    recencyDays: config.recencyDays || 7,
    minPositionSize: config.minPositionSize || 10,
  });
  return {
    wallets: new Map(),
    markets: [],
    strategyEngine: engine,
    signalStore,
    signals: [],
    autoTrades: [],
    autoEnabled: false,
    lastScan: null,
    polyWs: null,
    scanning: false,
  };
}

// ── Hydrate from DB on startup ───────────────────────────────────────────────

export function hydrateFromDB(state) {
  // Restore wallets
  const rows = db.getAllWallets();

  // Pre-fetch latest positions per wallet in ONE query so collectTrackedConditionIds
  // works on the very first scan after restart (was returning 0 cids until
  // loadWallet repopulated each wallet — caused fromTrackedSource=0 in /health
  // for the first scan cycle, observed live 2026-04-26).
  //
  // Wrapped in try/catch — a hydrate failure must NOT prevent boot. If
  // positions_history is huge or query fails, we'd rather start with empty
  // positions than crash-loop pm2 (observed 2026-04-28 OOM).
  const addrs = rows.map(r => r.address);
  let positionsByAddr = new Map();
  try {
    positionsByAddr = db.getLatestPositionsForWallets(addrs, {
      // Default 6h window (helper enforces this internally too);
      // explicit here so the boot-time intent is documented.
      sinceMs: Date.now() - 6 * 60 * 60 * 1000,
    });
  } catch (e) {
    // Don't let DB issues block startup — first scan will populate via API.
    // eslint-disable-next-line no-console
    console.warn(`hydrate: getLatestPositionsForWallets failed (${e.message}); starting with empty positions`);
  }

  for (const row of rows) {
    state.wallets.set(row.address, {
      addr:            row.address,
      score:           row.score,
      tier:            row.tier,
      winRate:         row.win_rate,
      roi:             row.roi,
      sharpe:          row.sharpe,
      maxDrawdown:     row.max_drawdown,
      timing:          row.timing_score,
      consistency:     row.consistency,
      totalPnL:        row.total_pnl,
      volume:          row.total_volume,
      closedPositions: row.closed_positions,
      openPositions:   row.open_positions,
      trades:          row.trade_count,
      // Restored from positions_history (latest snap per cid+outcome
      // within last 24h); next scan's loadWallet refreshes from API.
      positions:       positionsByAddr.get(row.address) || [],
      recentTrades:    [],       // not yet hydrated — loaded on demand
      updatedAt:       row.last_scored,
    });
  }

  // Restore trades
  state.autoTrades = db.getRecentTrades(100).map(row => ({
    conditionId: row.condition_id,
    title:       row.title,
    direction:   row.direction,
    tokenId:     row.token_id,
    midPrice:    row.mid_price,
    limitPrice:  row.limit_price,
    size:        row.size_usdc,
    orderId:     row.order_id,
    status:      row.status,
    error:       row.error_message,
    txHash:      row.tx_hash,
    walletCount: row.wallet_count,
    strength:    row.strength,
    executedAt:  row.created_at,
  }));

  // Restore last scan time
  const lastScan = db.getLastScan();
  if (lastScan?.completed_at) {
    state.lastScan = new Date(lastScan.completed_at);
  }

  return state;
}

// ── State Helpers (write-through to DB) ──────────────────────────────────────

export function getWalletList(state) {
  return [...state.wallets.values()].sort((a, b) => b.score - a.score);
}

export function getEliteWallets(state) {
  return [...state.wallets.values()].filter(w => w.tier === "ELITE");
}

export function setWallet(state, wallet) {
  state.wallets.set(wallet.addr, wallet);
  db.upsertWallet(wallet);
}

/**
 * Soft-delete: drops the wallet from the in-memory map (so the next scan
 * loop won't waste API calls on it) and flips the DB blacklist flag.
 * V1 history (positions_history / wallet_tier_history) is preserved so
 * backtests can still see the wallet's past behaviour.
 *
 * Returns true if the address was tracked, false if it was unknown.
 */
export function removeWallet(state, addr) {
  const lc = (addr || "").toLowerCase();
  const had = state.wallets.delete(lc);
  db.blacklistWallet(lc);
  return had;
}

/**
 * Reverse a soft-delete. The wallet doesn't go back into state.wallets
 * here — the next scan loop will pick it up via the watch-list rebuild.
 * Returns true if a row was un-blacklisted, false if no such row.
 */
export function restoreWallet(_state, addr) {
  const lc = (addr || "").toLowerCase();
  const changes = db.unblacklistWallet(lc);
  return changes > 0;
}

export function addTrade(state, trade, maxHistory = 100) {
  state.autoTrades.unshift(trade);
  state.autoTrades = state.autoTrades.slice(0, maxHistory);
  db.insertTrade(trade);
}

export function getSignals(state) {
  // Prefer the combined multi-strategy signal list when available; fall back
  // to consensus-only for tests that don't drive through the engine.
  if (Array.isArray(state.signals) && state.signals.length > 0) return state.signals;
  return state.signalStore.getActiveSignals();
}

// ── Scan lifecycle helpers ───────────────────────────────────────────────────

export function beginScan() {
  return db.startScan();
}

export function endScan(scanId, stats) {
  db.completeScan(scanId, stats);
}
