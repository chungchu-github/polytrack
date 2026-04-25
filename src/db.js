/**
 * SQLite Database Layer
 * ─────────────────────
 * Persistent storage for wallets, positions, signals, trades, and scan logs.
 * Uses better-sqlite3 (synchronous, zero-config).
 */

import Database from "better-sqlite3";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { mkdirSync, statSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, "..", "data");

let db;

// ── Initialize ───────────────────────────────────────────────────────────────

export function initDB(dbPath) {
  const fullPath = dbPath || resolve(DATA_DIR, "polytrack.db");

  // Ensure data directory exists
  mkdirSync(dirname(fullPath), { recursive: true });

  db = new Database(fullPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  migrate();
  migrateV2();
  migrateV3();
  migrateV4();
  migrateV5();
  migrateV6();
  migrateV7();
  return db;
}

export function getDB() {
  if (!db) throw new Error("Database not initialized — call initDB() first");
  return db;
}

export function closeDB() {
  if (db) { db.close(); db = null; }
}

// ── Schema Migration ─────────────────────────────────────────────────────────

function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS wallets (
      address         TEXT PRIMARY KEY,
      score           INTEGER DEFAULT 0,
      tier            TEXT DEFAULT 'BASIC',
      win_rate        REAL DEFAULT 0,
      roi             REAL DEFAULT 0,
      sharpe          REAL DEFAULT 0,
      max_drawdown    REAL DEFAULT 0,
      timing_score    REAL DEFAULT 0,
      consistency     REAL DEFAULT 0,
      total_pnl       REAL DEFAULT 0,
      total_volume    REAL DEFAULT 0,
      closed_positions INTEGER DEFAULT 0,
      open_positions  INTEGER DEFAULT 0,
      trade_count     INTEGER DEFAULT 0,
      first_seen      INTEGER NOT NULL,
      last_scored     INTEGER NOT NULL,
      blacklisted     INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS positions (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      wallet_address  TEXT NOT NULL,
      condition_id    TEXT NOT NULL,
      market_title    TEXT,
      outcome         TEXT,
      size            REAL DEFAULT 0,
      avg_price       REAL DEFAULT 0,
      cost_basis      REAL DEFAULT 0,
      current_value   REAL DEFAULT 0,
      pnl             REAL DEFAULT 0,
      first_seen      INTEGER NOT NULL,
      last_updated    INTEGER NOT NULL,
      status          TEXT DEFAULT 'OPEN',
      UNIQUE(wallet_address, condition_id, outcome)
    );

    CREATE TABLE IF NOT EXISTS signals (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      condition_id    TEXT NOT NULL,
      market_title    TEXT,
      direction       TEXT NOT NULL,
      strength        INTEGER DEFAULT 0,
      wallet_count    INTEGER DEFAULT 0,
      total_size      REAL DEFAULT 0,
      status          TEXT DEFAULT 'NEW',
      first_seen      INTEGER NOT NULL,
      last_confirmed  INTEGER NOT NULL,
      expired_at      INTEGER,
      traded          INTEGER DEFAULT 0,
      resolved_direction TEXT,
      resolved_at     INTEGER
    );

    CREATE TABLE IF NOT EXISTS trades (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      signal_id       INTEGER,
      condition_id    TEXT,
      direction       TEXT,
      token_id        TEXT,
      size_usdc       REAL DEFAULT 0,
      mid_price       REAL,
      limit_price     REAL,
      order_id        TEXT,
      status          TEXT DEFAULT 'PENDING',
      error_message   TEXT,
      tx_hash         TEXT,
      wallet_count    INTEGER,
      strength        INTEGER,
      title           TEXT,
      created_at      INTEGER NOT NULL,
      filled_at       INTEGER,
      FOREIGN KEY(signal_id) REFERENCES signals(id)
    );

    CREATE TABLE IF NOT EXISTS scans (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at      INTEGER NOT NULL,
      completed_at    INTEGER,
      wallets_scanned INTEGER DEFAULT 0,
      signals_found   INTEGER DEFAULT 0,
      trades_executed INTEGER DEFAULT 0,
      duration_ms     INTEGER,
      error           TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_positions_wallet ON positions(wallet_address);
    CREATE INDEX IF NOT EXISTS idx_positions_condition ON positions(condition_id);
    CREATE INDEX IF NOT EXISTS idx_signals_condition ON signals(condition_id, direction);
    CREATE INDEX IF NOT EXISTS idx_signals_status ON signals(status);
    CREATE INDEX IF NOT EXISTS idx_trades_signal ON trades(signal_id);
    CREATE INDEX IF NOT EXISTS idx_trades_created ON trades(created_at);
    CREATE INDEX IF NOT EXISTS idx_scans_started ON scans(started_at);
  `);
}

// ── Schema Migration v2 (additive — safe on fresh or existing DBs) ──────────
function migrateV2() {
  const cols = db.prepare("PRAGMA table_info(signals)").all().map(c => c.name);
  if (!cols.includes("resolved_direction")) {
    db.exec("ALTER TABLE signals ADD COLUMN resolved_direction TEXT");
  }
  if (!cols.includes("resolved_at")) {
    db.exec("ALTER TABLE signals ADD COLUMN resolved_at INTEGER");
  }
}

// ── Schema Migration v3 — F0.5 Data Capture Layer ───────────────────────────
function migrateV3() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS market_snapshots (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      condition_id  TEXT NOT NULL,
      token_id      TEXT NOT NULL,
      timestamp     INTEGER NOT NULL,
      mid_price     REAL,
      best_bid      REAL,
      best_ask      REAL,
      bid_depth     REAL,
      ask_depth     REAL,
      volume_24h    REAL
    );
    CREATE INDEX IF NOT EXISTS idx_market_snapshots_cid_ts
      ON market_snapshots(condition_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_market_snapshots_token_ts
      ON market_snapshots(token_id, timestamp);

    CREATE TABLE IF NOT EXISTS positions_history (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      wallet_address  TEXT NOT NULL,
      condition_id    TEXT NOT NULL,
      outcome         TEXT,
      size            REAL,
      avg_price       REAL,
      current_value   REAL,
      pnl             REAL,
      snapshot_at     INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_pos_hist_wallet_ts
      ON positions_history(wallet_address, snapshot_at);
    CREATE INDEX IF NOT EXISTS idx_pos_hist_cond_ts
      ON positions_history(condition_id, snapshot_at);
  `);
}

// ── Schema Migration v4 — F2 Strategy attribution on signals ────────────────
function migrateV4() {
  const cols = db.prepare("PRAGMA table_info(signals)").all().map(c => c.name);
  if (!cols.includes("strategy")) {
    db.exec("ALTER TABLE signals ADD COLUMN strategy TEXT DEFAULT 'consensus'");
    db.exec("CREATE INDEX IF NOT EXISTS idx_signals_strategy ON signals(strategy)");
  }
}

// ── Schema Migration v5 — F3 Backtest results ───────────────────────────────
function migrateV5() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS backtests (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      name         TEXT,
      date_start   INTEGER NOT NULL,
      date_end     INTEGER NOT NULL,
      strategy     TEXT NOT NULL,
      config_json  TEXT,
      metrics_json TEXT,
      trades_json  TEXT,
      status       TEXT DEFAULT 'RUNNING',
      error        TEXT,
      created_at   INTEGER NOT NULL,
      completed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_backtests_created ON backtests(created_at);
  `);
}

// ── Schema Migration v6 — F3 persist equity curve alongside backtests ───────
function migrateV6() {
  const cols = db.prepare("PRAGMA table_info(backtests)").all().map(c => c.name);
  if (!cols.includes("equity_json")) {
    db.exec("ALTER TABLE backtests ADD COLUMN equity_json TEXT");
  }
}

// ── Schema Migration v7 — N1 wallet tier history (survivorship fix) ─────────
// Records each tier transition so backtests can query "what tier was wallet X
// at time t" instead of treating every historical wallet as ELITE. On first
// install we backfill one row per existing wallet from the current tier +
// last_scored_at, so backtests over pre-V7 data still behave reasonably.
function migrateV7() {
  const existed = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='wallet_tier_history'"
  ).get();

  db.exec(`
    CREATE TABLE IF NOT EXISTS wallet_tier_history (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      wallet_address  TEXT NOT NULL,
      tier            TEXT NOT NULL,
      score           INTEGER,
      scored_at       INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_wallet_tier_history_addr_at
      ON wallet_tier_history(wallet_address, scored_at);
  `);

  if (existed) return;
  // Fresh table — backfill current tiers so pre-V7 snapshots aren't left
  // tier-less. Uses `last_scored` as the "known from" timestamp.
  const rows = db.prepare(
    "SELECT address, tier, score, last_scored FROM wallets WHERE last_scored IS NOT NULL"
  ).all();
  const ins = db.prepare(
    "INSERT INTO wallet_tier_history (wallet_address, tier, score, scored_at) VALUES (?, ?, ?, ?)"
  );
  const tx = db.transaction((list) => {
    for (const r of list) ins.run(r.address, r.tier || "BASIC", r.score || 0, r.last_scored);
  });
  tx(rows);
}

export function insertBacktest(row) {
  const r = db.prepare(`
    INSERT INTO backtests (name, date_start, date_end, strategy, config_json,
      status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.name || null, row.dateStart, row.dateEnd, row.strategy,
    JSON.stringify(row.config || {}),
    row.status || "RUNNING", Date.now()
  );
  return r.lastInsertRowid;
}

export function completeBacktest(id, { metrics, trades, equityCurve, status = "DONE", error = null }) {
  db.prepare(`
    UPDATE backtests
       SET metrics_json = ?, trades_json = ?, equity_json = ?, status = ?, error = ?, completed_at = ?
     WHERE id = ?
  `).run(
    JSON.stringify(metrics || {}),
    JSON.stringify(trades || []),
    JSON.stringify(equityCurve || []),
    status, error, Date.now(), id
  );
}

export function getBacktest(id) {
  const row = db.prepare("SELECT * FROM backtests WHERE id = ?").get(id);
  if (!row) return null;
  return {
    ...row,
    config:       safeJSON(row.config_json),
    metrics:      safeJSON(row.metrics_json),
    trades:       safeJSON(row.trades_json) || [],
    equityCurve:  safeJSON(row.equity_json) || [],
  };
}

export function listBacktests(limit = 50) {
  return db.prepare(
    "SELECT id, name, date_start, date_end, strategy, status, created_at, completed_at, error FROM backtests ORDER BY created_at DESC LIMIT ?"
  ).all(limit);
}

export function deleteBacktest(id) {
  return db.prepare("DELETE FROM backtests WHERE id = ?").run(id).changes;
}

function safeJSON(s) { try { return s ? JSON.parse(s) : null; } catch { return null; } }

// ── Data Capture Queries ─────────────────────────────────────────────────────

export function insertMarketSnapshot(snap) {
  db.prepare(`
    INSERT INTO market_snapshots
      (condition_id, token_id, timestamp, mid_price, best_bid, best_ask,
       bid_depth, ask_depth, volume_24h)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    snap.conditionId, snap.tokenId, snap.timestamp || Date.now(),
    snap.midPrice ?? null, snap.bestBid ?? null, snap.bestAsk ?? null,
    snap.bidDepth ?? null, snap.askDepth ?? null, snap.volume24h ?? null
  );
}

export function insertPositionSnapshot(pos) {
  db.prepare(`
    INSERT INTO positions_history
      (wallet_address, condition_id, outcome, size, avg_price,
       current_value, pnl, snapshot_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    pos.walletAddress, pos.conditionId, pos.outcome ?? null,
    pos.size ?? null, pos.avgPrice ?? null,
    pos.currentValue ?? null, pos.pnl ?? null,
    pos.snapshotAt || Date.now()
  );
}

export function getMarketSnapshots(conditionId, sinceMs = 0, untilMs = Date.now()) {
  return db.prepare(
    `SELECT * FROM market_snapshots
     WHERE condition_id = ? AND timestamp >= ? AND timestamp <= ?
     ORDER BY timestamp ASC`
  ).all(conditionId, sinceMs, untilMs);
}

export function getPositionHistory(walletAddress, sinceMs = 0, untilMs = Date.now()) {
  return db.prepare(
    `SELECT * FROM positions_history
     WHERE wallet_address = ? AND snapshot_at >= ? AND snapshot_at <= ?
     ORDER BY snapshot_at ASC`
  ).all(walletAddress, sinceMs, untilMs);
}

export function deleteOldMarketSnapshots(cutoffMs) {
  return db.prepare("DELETE FROM market_snapshots WHERE timestamp < ?").run(cutoffMs).changes;
}

export function deleteOldPositionHistory(cutoffMs) {
  return db.prepare("DELETE FROM positions_history WHERE snapshot_at < ?").run(cutoffMs).changes;
}

/**
 * Reclaim disk space by rebuilding the database file. SQLite's DELETE marks
 * pages as free but doesn't shrink the file — over months of daily pruning,
 * the file can grow several-fold past the live data size. VACUUM rewrites
 * the whole DB into a fresh file, which also defragments B-tree pages.
 *
 * Caveats:
 * - Briefly locks the DB for writes while it runs.
 * - Requires roughly 2× the DB size in free disk space during execution.
 * - Safe under WAL mode (SQLite handles the mode switch internally).
 *
 * @returns {{ bytesBefore: number, bytesAfter: number, freedBytes: number, durationMs: number }}
 */
export function vacuumDB() {
  const dbPath = db.name;
  const bytesBefore = statSync(dbPath).size;
  const t0 = Date.now();
  db.exec("VACUUM");
  const durationMs = Date.now() - t0;
  const bytesAfter = statSync(dbPath).size;
  return {
    bytesBefore,
    bytesAfter,
    freedBytes: bytesBefore - bytesAfter,
    durationMs,
  };
}

/**
 * Aggregate stats for the F0.5 data-capture layer. Used by /health + the
 * Dashboard V1 progress card so we can see whether the 30-day backtest
 * runway is accruing as expected.
 *
 * Returns null-safe numbers (0) when tables are empty.
 */
export function getDataCaptureStats() {
  const now = Date.now();
  const DAY = 86_400_000;

  const marketTotal      = db.prepare("SELECT COUNT(*) c FROM market_snapshots").get().c;
  const marketLast24h    = db.prepare(
    "SELECT COUNT(*) c FROM market_snapshots WHERE timestamp >= ?"
  ).get(now - DAY).c;
  const marketUniqueCids = db.prepare(
    "SELECT COUNT(DISTINCT condition_id) c FROM market_snapshots"
  ).get().c;
  const marketOldest     = db.prepare(
    "SELECT MIN(timestamp) ts FROM market_snapshots"
  ).get().ts;
  const marketNewest     = db.prepare(
    "SELECT MAX(timestamp) ts FROM market_snapshots"
  ).get().ts;

  const positionTotal   = db.prepare("SELECT COUNT(*) c FROM positions_history").get().c;
  const positionLast24h = db.prepare(
    "SELECT COUNT(*) c FROM positions_history WHERE snapshot_at >= ?"
  ).get(now - DAY).c;
  const positionOldest  = db.prepare(
    "SELECT MIN(snapshot_at) ts FROM positions_history"
  ).get().ts;

  const daysCovered = marketOldest
    ? Math.max(0, Math.floor((now - marketOldest) / DAY))
    : 0;

  // "Healthy" = at least one market snapshot in the last 2 hours. Captures
  // only run once per scan, so an hour-long gap is common; 2h flags real stalls.
  const healthy = marketNewest != null && (now - marketNewest) < 2 * 3600_000;

  return {
    marketSnapshots: {
      total:         marketTotal,
      last24h:       marketLast24h,
      uniqueMarkets: marketUniqueCids,
      oldest:        marketOldest,
      newest:        marketNewest,
    },
    positionHistory: {
      total:   positionTotal,
      last24h: positionLast24h,
      oldest:  positionOldest,
    },
    daysCovered,
    v1TargetDays: 30,
    v1ReadyPct: Math.min(100, Math.round((daysCovered / 30) * 100)),
    healthy,
  };
}

// ── Wallet Queries ───────────────────────────────────────────────────────────

const upsertWalletStmt = () => db.prepare(`
  INSERT INTO wallets (address, score, tier, win_rate, roi, sharpe, max_drawdown,
    timing_score, consistency, total_pnl, total_volume, closed_positions,
    open_positions, trade_count, first_seen, last_scored)
  VALUES (@address, @score, @tier, @win_rate, @roi, @sharpe, @max_drawdown,
    @timing_score, @consistency, @total_pnl, @total_volume, @closed_positions,
    @open_positions, @trade_count, @first_seen, @last_scored)
  ON CONFLICT(address) DO UPDATE SET
    score=@score, tier=@tier, win_rate=@win_rate, roi=@roi, sharpe=@sharpe,
    max_drawdown=@max_drawdown, timing_score=@timing_score, consistency=@consistency,
    total_pnl=@total_pnl, total_volume=@total_volume, closed_positions=@closed_positions,
    open_positions=@open_positions, trade_count=@trade_count, last_scored=@last_scored
`);

export function upsertWallet(wallet) {
  const now = Date.now();
  const tier = wallet.tier || "BASIC";
  upsertWalletStmt().run({
    address:          wallet.addr,
    score:            wallet.score || 0,
    tier,
    win_rate:         wallet.winRate || 0,
    roi:              wallet.roi || 0,
    sharpe:           wallet.sharpe || 0,
    max_drawdown:     wallet.maxDrawdown || 0,
    timing_score:     wallet.timing || 0,
    consistency:      wallet.consistency || 0,
    total_pnl:        wallet.totalPnL || 0,
    total_volume:     wallet.volume || 0,
    closed_positions: wallet.closedPositions || 0,
    open_positions:   wallet.openPositions || 0,
    trade_count:      wallet.trades || 0,
    first_seen:       now,
    last_scored:      now,
  });
  // N1 survivorship fix: record tier transition (no-op when tier unchanged)
  insertWalletTier({ address: wallet.addr, tier, score: wallet.score || 0, scoredAt: now });
}

// ── Wallet Tier History (N1 survivorship fix) ────────────────────────────────

/**
 * Append a tier observation, but only if it differs from this wallet's most
 * recent tier — keeps the table small (tier transitions, not a row per scan).
 * @returns {boolean} true if a row was written
 */
export function insertWalletTier({ address, tier, score = 0, scoredAt }) {
  if (!address || !tier || !scoredAt) return false;
  const last = db.prepare(
    "SELECT tier FROM wallet_tier_history WHERE wallet_address = ? ORDER BY scored_at DESC LIMIT 1"
  ).get(address);
  if (last && last.tier === tier) return false;
  db.prepare(
    "INSERT INTO wallet_tier_history (wallet_address, tier, score, scored_at) VALUES (?, ?, ?, ?)"
  ).run(address, tier, score, scoredAt);
  return true;
}

/**
 * Return the wallet's tier as observed at or before `t`. Falls back to null
 * when no history exists (callers decide the default — we use "ELITE" in the
 * backtest reader to preserve pre-V7 behaviour on backfilled data).
 */
export function getWalletTierAt(address, t) {
  const row = db.prepare(
    "SELECT tier FROM wallet_tier_history WHERE wallet_address = ? AND scored_at <= ? ORDER BY scored_at DESC LIMIT 1"
  ).get(address, t);
  return row ? row.tier : null;
}

/**
 * Identify "stale ELITE" wallets — currently classified ELITE but whose
 * positions_history shows negative cumulative PnL over a trailing window.
 * These are demotion candidates: wallets that earned their tier with older
 * performance but recently stopped being smart money.
 *
 * Uses the most recent position_history.pnl row per (wallet, condition_id)
 * inside the window as the trailing PnL signal (rows are snapshots of the
 * wallet's view of each open/closed position at capture time, so "latest
 * row inside window" ≈ "how that position stood during the window").
 *
 * Returns rows sorted worst-first so a caller can surface the top N.
 */
export function getWalletDegradationCandidates({
  windowDays   = 30,
  minPnLUsd    = 0,         // flag when trailing PnL < this
} = {}) {
  const since = Date.now() - windowDays * 24 * 60 * 60 * 1000;
  return db.prepare(`
    SELECT
      w.address,
      w.tier,
      w.score,
      w.last_scored,
      COALESCE(trailing.pnl, 0) AS trailing_pnl,
      COALESCE(trailing.snapshots, 0) AS trailing_snapshots
    FROM wallets w
    LEFT JOIN (
      SELECT
        wallet_address,
        SUM(latest_pnl) AS pnl,
        COUNT(*) AS snapshots
      FROM (
        SELECT
          wallet_address,
          condition_id,
          pnl AS latest_pnl,
          ROW_NUMBER() OVER (
            PARTITION BY wallet_address, condition_id
            ORDER BY snapshot_at DESC
          ) AS rn
        FROM positions_history
        WHERE snapshot_at >= ?
      )
      WHERE rn = 1
      GROUP BY wallet_address
    ) trailing ON trailing.wallet_address = w.address
    WHERE w.tier = 'ELITE'
      AND w.blacklisted = 0
      AND COALESCE(trailing.snapshots, 0) > 0
      AND COALESCE(trailing.pnl, 0) < ?
    ORDER BY trailing.pnl ASC
  `).all(since, minPnLUsd).map(r => ({
    address:          r.address,
    tier:             r.tier,
    score:            r.score,
    lastScored:       r.last_scored,
    trailingPnl:      Math.round((r.trailing_pnl || 0) * 100) / 100,
    trailingSnapshots: r.trailing_snapshots,
    windowDays,
  }));
}

export function getAllWallets() {
  return db.prepare("SELECT * FROM wallets WHERE blacklisted = 0 ORDER BY score DESC").all();
}

export function getWalletByAddress(addr) {
  return db.prepare("SELECT * FROM wallets WHERE address = ?").get(addr);
}

export function blacklistWallet(addr) {
  db.prepare("UPDATE wallets SET blacklisted = 1 WHERE address = ?").run(addr);
}

// ── Signal Queries ───────────────────────────────────────────────────────────

export function insertSignal(signal) {
  const now = Date.now();
  const result = db.prepare(`
    INSERT INTO signals (condition_id, market_title, direction, strength,
      wallet_count, total_size, status, first_seen, last_confirmed, strategy)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    signal.conditionId, signal.title, signal.direction, signal.strength || 0,
    signal.walletCount || 0, signal.totalSize || 0, signal.status || "NEW",
    now, now, signal.strategy || "consensus"
  );
  return result.lastInsertRowid;
}

export function updateSignal(id, updates) {
  const fields = [];
  const values = [];
  for (const [key, val] of Object.entries(updates)) {
    fields.push(`${key} = ?`);
    values.push(val);
  }
  values.push(id);
  db.prepare(`UPDATE signals SET ${fields.join(", ")} WHERE id = ?`).run(...values);
}

export function getActiveSignals() {
  return db.prepare("SELECT * FROM signals WHERE status IN ('NEW', 'CONFIRMED') ORDER BY strength DESC").all();
}

export function findSignal(conditionId, direction) {
  return db.prepare("SELECT * FROM signals WHERE condition_id = ? AND direction = ? AND status IN ('NEW', 'CONFIRMED')").get(conditionId, direction);
}

export function getUnresolvedSignals() {
  return db.prepare(
    "SELECT * FROM signals WHERE resolved_direction IS NULL AND status IN ('CONFIRMED', 'STALE', 'EXPIRED') AND traded = 1"
  ).all();
}

export function resolveSignal(id, resolvedDirection) {
  db.prepare(
    "UPDATE signals SET resolved_direction = ?, resolved_at = ? WHERE id = ?"
  ).run(resolvedDirection, Date.now(), id);
}

export function getSignalAccuracy(strategy) {
  const base = "SELECT COUNT(*) as count FROM signals WHERE resolved_direction IS NOT NULL";
  const filter = strategy ? " AND strategy = ?" : "";
  const args = strategy ? [strategy] : [];
  const total = db.prepare(base + filter).get(...args).count;
  const correct = db.prepare(
    base + " AND resolved_direction = direction" + filter
  ).get(...args).count;
  return { total, correct, accuracy: total > 0 ? Math.round((correct / total) * 1000) / 10 : null };
}

/**
 * F2 — aggregate realized PnL, open exposure, and trade counts by strategy.
 * Joins trades → signals via signal_id so each FILLED trade inherits the
 * strategy that produced its parent signal.
 *
 * PnL model (binary outcome, FOK fills):
 *   win  → (size_usdc / limit_price) − size_usdc  = size * (1/limit − 1)
 *   loss → −size_usdc
 *   unresolved → counted as open_exposure_usdc (not PnL)
 *
 * Trades with no signal_id (manual /trade calls) fall into the "manual"
 * bucket so they stay visible rather than silently dropped.
 */
export function getTradesPnlByStrategy() {
  return db.prepare(`
    SELECT
      COALESCE(s.strategy, 'manual') AS strategy,
      COUNT(t.id) AS trade_count,
      SUM(CASE WHEN t.status = 'FILLED' THEN 1 ELSE 0 END) AS filled_count,
      SUM(CASE
            WHEN t.status = 'FILLED'
             AND s.resolved_direction = t.direction
             AND t.limit_price > 0
            THEN t.size_usdc * (1.0 / t.limit_price - 1.0)
            WHEN t.status = 'FILLED'
             AND s.resolved_direction IS NOT NULL
             AND s.resolved_direction <> t.direction
            THEN -t.size_usdc
            ELSE 0
          END) AS realized_pnl,
      SUM(CASE
            WHEN t.status = 'FILLED' AND s.resolved_direction IS NULL
            THEN t.size_usdc
            ELSE 0
          END) AS open_exposure_usdc,
      SUM(CASE
            WHEN t.status = 'FILLED' AND s.resolved_direction = t.direction THEN 1 ELSE 0
          END) AS wins,
      SUM(CASE
            WHEN t.status = 'FILLED' AND s.resolved_direction IS NOT NULL
             AND s.resolved_direction <> t.direction THEN 1 ELSE 0
          END) AS losses
    FROM trades t
    LEFT JOIN signals s ON t.signal_id = s.id
    GROUP BY strategy
    ORDER BY trade_count DESC
  `).all().map(r => ({
    strategy:           r.strategy,
    tradeCount:         r.trade_count,
    filledCount:        r.filled_count,
    realizedPnl:        Math.round((r.realized_pnl || 0) * 100) / 100,
    openExposureUsdc:   Math.round((r.open_exposure_usdc || 0) * 100) / 100,
    wins:               r.wins,
    losses:             r.losses,
    resolvedCount:      r.wins + r.losses,
    winRate:            (r.wins + r.losses) > 0
      ? Math.round((r.wins / (r.wins + r.losses)) * 1000) / 10
      : null,
  }));
}

// ── Trade Queries ────────────────────────────────────────────────────────────

export function insertTrade(trade) {
  const result = db.prepare(`
    INSERT INTO trades (signal_id, condition_id, direction, token_id,
      size_usdc, mid_price, limit_price, order_id, status, error_message,
      tx_hash, wallet_count, strength, title, created_at, filled_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    trade.signalId || null,
    trade.conditionId,
    trade.direction,
    trade.tokenId || null,
    trade.size || 0,
    trade.midPrice || null,
    trade.limitPrice || null,
    trade.orderId || null,
    trade.status || "PENDING",
    trade.error || null,
    trade.txHash || null,
    trade.walletCount || null,
    trade.strength || null,
    trade.title || null,
    trade.executedAt || Date.now(),
    trade.filledAt || null
  );
  return result.lastInsertRowid;
}

export function getRecentTrades(limit = 100) {
  return db.prepare("SELECT * FROM trades ORDER BY created_at DESC LIMIT ?").all(limit);
}

export function updateTradeStatus(id, status, filledAt) {
  db.prepare("UPDATE trades SET status = ?, filled_at = ? WHERE id = ?").run(status, filledAt, id);
}

export function getStalePendingTrades(maxAgeMs = 5 * 60_000) {
  const cutoff = Date.now() - maxAgeMs;
  return db.prepare(
    "SELECT * FROM trades WHERE status IN ('SUBMITTED','PENDING','UNKNOWN') AND created_at < ? AND order_id IS NOT NULL"
  ).all(cutoff);
}

// ── Scan Queries ─────────────────────────────────────────────────────────────

export function startScan() {
  const result = db.prepare("INSERT INTO scans (started_at) VALUES (?)").run(Date.now());
  return result.lastInsertRowid;
}

export function completeScan(id, stats) {
  db.prepare(`
    UPDATE scans SET completed_at = ?, wallets_scanned = ?, signals_found = ?,
      trades_executed = ?, duration_ms = ?, error = ?
    WHERE id = ?
  `).run(
    Date.now(),
    stats.walletsScanned || 0,
    stats.signalsFound || 0,
    stats.tradesExecuted || 0,
    stats.durationMs || 0,
    stats.error || null,
    id
  );
}

export function getLastScan() {
  return db.prepare("SELECT * FROM scans ORDER BY started_at DESC LIMIT 1").get();
}

export function getRecentScans(limit = 20) {
  return db.prepare("SELECT * FROM scans ORDER BY started_at DESC LIMIT ?").all(limit);
}

// ── Stats ────────────────────────────────────────────────────────────────────

export function getStats() {
  const walletCount = db.prepare("SELECT COUNT(*) as count FROM wallets WHERE blacklisted = 0").get().count;
  const eliteCount = db.prepare("SELECT COUNT(*) as count FROM wallets WHERE tier = 'ELITE' AND blacklisted = 0").get().count;
  const signalCount = db.prepare("SELECT COUNT(*) as count FROM signals WHERE status IN ('NEW', 'CONFIRMED')").get().count;
  const tradeCount = db.prepare("SELECT COUNT(*) as count FROM trades").get().count;
  const scanCount = db.prepare("SELECT COUNT(*) as count FROM scans").get().count;
  const lastScan = getLastScan();

  return { walletCount, eliteCount, signalCount, tradeCount, scanCount, lastScan };
}
