import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { unlinkSync } from "fs";

import {
  initDB, closeDB, getDB, upsertWallet, getAllWallets, getWalletByAddress,
  insertSignal, getActiveSignals, findSignal,
  insertTrade, getRecentTrades,
  startScan, completeScan, getLastScan, getStats,
  resolveSignal, getSignalAccuracy,
  insertMarketSnapshot, insertPositionSnapshot, getDataCaptureStats,
  insertWalletTier, getWalletTierAt,
  getTradesPnlByStrategy, getWalletDegradationCandidates,
  vacuumDB,
  blacklistWallet, unblacklistWallet, getBlacklistedWallets,
  recordImportRejection, getRecentImportRejections, clearStaleImportRejections,
} from "../src/db.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_DB = resolve(__dirname, "..", "data", "test.db");

// Clean up before/after
before(() => { initDB(TEST_DB); });
after(() => { closeDB(); try { unlinkSync(TEST_DB); } catch {} });

// ── Wallets ──────────────────────────────────────────────────────────────────

describe("wallets", () => {
  it("upserts and retrieves a wallet", () => {
    upsertWallet({
      addr: "0xaaaa000000000000000000000000000000000001",
      score: 75, tier: "ELITE", winRate: 68.5, roi: 42.3,
      sharpe: 1.8, maxDrawdown: 12, timing: 80, consistency: 65,
      totalPnL: 5000, volume: 12000, closedPositions: 25, openPositions: 3,
      trades: 100,
    });

    const all = getAllWallets();
    assert.ok(all.length >= 1);

    const w = getWalletByAddress("0xaaaa000000000000000000000000000000000001");
    assert.ok(w);
    assert.equal(w.score, 75);
    assert.equal(w.tier, "ELITE");
    assert.equal(w.total_pnl, 5000);
  });

  it("updates existing wallet on conflict", () => {
    upsertWallet({
      addr: "0xaaaa000000000000000000000000000000000001",
      score: 80, tier: "ELITE", winRate: 72, roi: 50,
      sharpe: 2.0, maxDrawdown: 10, timing: 85, consistency: 70,
      totalPnL: 6000, volume: 14000, closedPositions: 30, openPositions: 2,
      trades: 120,
    });

    const w = getWalletByAddress("0xaaaa000000000000000000000000000000000001");
    assert.equal(w.score, 80);
    assert.equal(w.total_pnl, 6000);
  });
});

// ── Signals ──────────────────────────────────────────────────────────────────

describe("signals", () => {
  it("inserts and retrieves active signals", () => {
    const id = insertSignal({
      conditionId: "0xcond1",
      title: "Will BTC reach $100K?",
      direction: "YES",
      strength: 85,
      walletCount: 4,
      totalSize: 15000,
      status: "NEW",
    });

    assert.ok(id > 0);

    const active = getActiveSignals();
    assert.ok(active.length >= 1);
    assert.equal(active[0].condition_id, "0xcond1");
    assert.equal(active[0].direction, "YES");
    assert.equal(active[0].strength, 85);
  });

  it("finds signal by conditionId + direction", () => {
    const found = findSignal("0xcond1", "YES");
    assert.ok(found);
    assert.equal(found.market_title, "Will BTC reach $100K?");

    const notFound = findSignal("0xcond1", "NO");
    assert.equal(notFound, undefined);
  });
});

// ── Signal accuracy (F2 per-strategy filter) ────────────────────────────────

describe("getSignalAccuracy(strategy?)", () => {
  it("filters by strategy when provided, falls back to all when omitted", () => {
    const db = getDB();
    db.exec("DELETE FROM signals");

    // momentum: 2 signals, 1 correct
    const m1 = insertSignal({ conditionId: "accM1", title: "m1", direction: "YES",
      strength: 60, walletCount: 2, totalSize: 100, status: "CONFIRMED", strategy: "momentum" });
    resolveSignal(m1, "YES"); // correct
    const m2 = insertSignal({ conditionId: "accM2", title: "m2", direction: "YES",
      strength: 60, walletCount: 2, totalSize: 100, status: "CONFIRMED", strategy: "momentum" });
    resolveSignal(m2, "NO");  // wrong

    // consensus: 1 correct
    const c1 = insertSignal({ conditionId: "accC1", title: "c1", direction: "NO",
      strength: 70, walletCount: 3, totalSize: 200, status: "CONFIRMED", strategy: "consensus" });
    resolveSignal(c1, "NO");  // correct

    const all = getSignalAccuracy();
    assert.equal(all.total, 3);
    assert.equal(all.correct, 2);

    const mom = getSignalAccuracy("momentum");
    assert.equal(mom.total, 2);
    assert.equal(mom.correct, 1);
    assert.equal(mom.accuracy, 50);

    const con = getSignalAccuracy("consensus");
    assert.equal(con.total, 1);
    assert.equal(con.correct, 1);
    assert.equal(con.accuracy, 100);

    const arb = getSignalAccuracy("arbitrage");
    assert.equal(arb.total, 0);
    assert.equal(arb.accuracy, null);
  });
});

// ── Trades ───────────────────────────────────────────────────────────────────

describe("trades", () => {
  it("inserts and retrieves trades", () => {
    const id = insertTrade({
      conditionId: "0xcond1",
      direction: "YES",
      tokenId: "12345",
      size: 100,
      midPrice: 0.65,
      limitPrice: 0.66,
      orderId: "order-abc",
      status: "FILLED",
      title: "Will BTC reach $100K?",
      executedAt: Date.now(),
    });

    assert.ok(id > 0);

    const trades = getRecentTrades(10);
    assert.ok(trades.length >= 1);
    assert.equal(trades[0].status, "FILLED");
    assert.equal(trades[0].size_usdc, 100);
  });
});

// ── Scans ────────────────────────────────────────────────────────────────────

describe("scans", () => {
  it("tracks scan lifecycle", () => {
    const scanId = startScan();
    assert.ok(scanId > 0);

    completeScan(scanId, {
      walletsScanned: 15,
      signalsFound: 3,
      tradesExecuted: 1,
      durationMs: 4500,
    });

    const last = getLastScan();
    assert.ok(last);
    assert.equal(last.wallets_scanned, 15);
    assert.equal(last.signals_found, 3);
    assert.equal(last.duration_ms, 4500);
  });
});

// ── Data Capture Stats (V1 observability) ────────────────────────────────────

describe("getDataCaptureStats (V1 gate)", () => {
  it("reports zeros when no snapshots have been captured", () => {
    const db = getDB();
    db.exec("DELETE FROM market_snapshots; DELETE FROM positions_history;");
    const s = getDataCaptureStats();
    assert.equal(s.marketSnapshots.total, 0);
    assert.equal(s.marketSnapshots.uniqueMarkets, 0);
    assert.equal(s.positionHistory.total, 0);
    assert.equal(s.daysCovered, 0);
    assert.equal(s.v1ReadyPct, 0);
    assert.equal(s.healthy, false);
  });

  it("counts snapshots, unique markets, oldest timestamp, daysCovered", () => {
    const db = getDB();
    db.exec("DELETE FROM market_snapshots; DELETE FROM positions_history;");

    const now = Date.now();
    const DAY = 86_400_000;

    // Seed 3 snapshots across 2 markets, with oldest ~15 days ago.
    // The two newer snapshots must be strictly inside the 24h window (not
    // on the boundary) so getDataCaptureStats' last24h count is stable.
    insertMarketSnapshot({ conditionId: "cap_c1", tokenId: "t1", timestamp: now - 15 * DAY,       midPrice: 0.5 });
    insertMarketSnapshot({ conditionId: "cap_c1", tokenId: "t1", timestamp: now - 12 * 3600_000,  midPrice: 0.6 });
    insertMarketSnapshot({ conditionId: "cap_c2", tokenId: "t2", timestamp: now - 60_000,         midPrice: 0.4 });
    insertPositionSnapshot({ walletAddress: "0xaaa", conditionId: "cap_c1", size: 10, snapshotAt: now - 12 * 3600_000 });

    const s = getDataCaptureStats();
    assert.equal(s.marketSnapshots.total, 3);
    assert.equal(s.marketSnapshots.uniqueMarkets, 2);
    assert.equal(s.marketSnapshots.last24h, 2);
    assert.equal(s.positionHistory.total, 1);
    assert.ok(s.daysCovered >= 14 && s.daysCovered <= 16, `daysCovered ${s.daysCovered}`);
    assert.ok(s.v1ReadyPct > 40 && s.v1ReadyPct < 60, `pct ${s.v1ReadyPct}`);
    assert.equal(s.healthy, true, "last snapshot is 60s old — should be healthy");
  });

  it("flags healthy=false when most-recent snapshot is > 2h old", () => {
    const db = getDB();
    db.exec("DELETE FROM market_snapshots;");
    insertMarketSnapshot({ conditionId: "cap_c3", tokenId: "t3", timestamp: Date.now() - 3 * 3600_000, midPrice: 0.5 });
    const s = getDataCaptureStats();
    assert.equal(s.healthy, false);
  });
});

// ── Wallet Tier History (V7 — N1 survivorship fix) ──────────────────────────

describe("wallet_tier_history (V7)", () => {
  const ADDR = "0xtier0000000000000000000000000000000000";

  it("insertWalletTier writes a row on first observation", () => {
    const wrote = insertWalletTier({ address: ADDR, tier: "BASIC", score: 20, scoredAt: 1000 });
    assert.equal(wrote, true);
    assert.equal(getWalletTierAt(ADDR, 1000), "BASIC");
  });

  it("insertWalletTier is a no-op when tier is unchanged", () => {
    const wrote = insertWalletTier({ address: ADDR, tier: "BASIC", score: 22, scoredAt: 2000 });
    assert.equal(wrote, false);
  });

  it("insertWalletTier records new row on tier transition", () => {
    const wrote = insertWalletTier({ address: ADDR, tier: "ELITE", score: 80, scoredAt: 3000 });
    assert.equal(wrote, true);
  });

  it("getWalletTierAt returns the most recent row at-or-before t", () => {
    assert.equal(getWalletTierAt(ADDR, 500),  null,    "no row before first insert");
    assert.equal(getWalletTierAt(ADDR, 1500), "BASIC", "t=1500 sees BASIC (from t=1000)");
    assert.equal(getWalletTierAt(ADDR, 3500), "ELITE", "t=3500 sees ELITE (from t=3000)");
    assert.equal(getWalletTierAt(ADDR, 2999), "BASIC", "boundary: t=2999 still BASIC");
  });

  it("upsertWallet hooks into tier_history automatically", () => {
    const newAddr = "0xhook0000000000000000000000000000000000";
    upsertWallet({
      addr: newAddr, score: 10, tier: "BASIC", winRate: 0, roi: 0, sharpe: 0,
      maxDrawdown: 0, timing: 0, consistency: 0, totalPnL: 0, volume: 0,
      closedPositions: 0, openPositions: 0, trades: 0,
    });
    assert.equal(getWalletTierAt(newAddr, Date.now() + 1000), "BASIC");
  });
});

// ── F2 — PnL by Strategy ────────────────────────────────────────────────────

describe("getTradesPnlByStrategy (F2)", () => {
  it("aggregates realized PnL, wins, losses, and open exposure per strategy", () => {
    const db = getDB();
    db.exec("DELETE FROM trades; DELETE FROM signals;");

    // Two signals for two strategies
    const sigWin = db.prepare(
      `INSERT INTO signals (condition_id, direction, strength, status, first_seen,
        last_confirmed, resolved_direction, resolved_at, strategy)
        VALUES ('cA', 'YES', 80, 'CONFIRMED', 1, 1, 'YES', 2, 'momentum')`
    ).run().lastInsertRowid;

    const sigLoss = db.prepare(
      `INSERT INTO signals (condition_id, direction, strength, status, first_seen,
        last_confirmed, resolved_direction, resolved_at, strategy)
        VALUES ('cB', 'YES', 80, 'CONFIRMED', 1, 1, 'NO', 2, 'meanrev')`
    ).run().lastInsertRowid;

    const sigOpen = db.prepare(
      `INSERT INTO signals (condition_id, direction, strength, status, first_seen,
        last_confirmed, strategy)
        VALUES ('cC', 'YES', 80, 'CONFIRMED', 1, 1, 'momentum')`
    ).run().lastInsertRowid;

    // Fills at 0.5 each, $100 each
    const stmt = db.prepare(
      `INSERT INTO trades (signal_id, condition_id, direction, size_usdc,
        limit_price, status, created_at)
        VALUES (?, ?, 'YES', 100, 0.5, 'FILLED', ?)`
    );
    stmt.run(sigWin,  "cA", 1000);
    stmt.run(sigLoss, "cB", 1000);
    stmt.run(sigOpen, "cC", 1000);

    // Unfilled — must be ignored for PnL but counted in tradeCount
    db.prepare(
      `INSERT INTO trades (signal_id, condition_id, direction, size_usdc,
        limit_price, status, created_at)
        VALUES (?, 'cA', 'YES', 100, 0.5, 'PENDING', 1001)`
    ).run(sigWin);

    const rows = getTradesPnlByStrategy();
    const byStrategy = Object.fromEntries(rows.map(r => [r.strategy, r]));

    // momentum: 1 win (+$100 at 0.5 fill) + 1 open ($100 exposure) + 1 pending
    assert.equal(byStrategy.momentum.tradeCount,       3);
    assert.equal(byStrategy.momentum.filledCount,      2);
    assert.equal(byStrategy.momentum.wins,             1);
    assert.equal(byStrategy.momentum.losses,           0);
    assert.equal(byStrategy.momentum.realizedPnl,      100);   // $100 * (1/0.5 − 1) = $100
    assert.equal(byStrategy.momentum.openExposureUsdc, 100);

    // meanrev: 1 loss → −$100
    assert.equal(byStrategy.meanrev.wins,              0);
    assert.equal(byStrategy.meanrev.losses,            1);
    assert.equal(byStrategy.meanrev.realizedPnl,       -100);
    assert.equal(byStrategy.meanrev.winRate,           0);
  });

  it("buckets trades with no signal_id under 'manual'", () => {
    const db = getDB();
    db.exec("DELETE FROM trades;");
    db.prepare(
      `INSERT INTO trades (condition_id, direction, size_usdc, limit_price,
        status, created_at) VALUES ('cM', 'YES', 50, 0.4, 'FILLED', 1)`
    ).run();
    const rows = getTradesPnlByStrategy();
    const manual = rows.find(r => r.strategy === "manual");
    assert.ok(manual, "expected a 'manual' bucket");
    assert.equal(manual.tradeCount, 1);
  });
});

// ── Wallet Degradation Detection ────────────────────────────────────────────

describe("getWalletDegradationCandidates", () => {
  const GOOD   = "0xgoodelite0000000000000000000000000000000";
  const STALE  = "0xstaleelite000000000000000000000000000000";
  const PROWAL = "0xpro00000000000000000000000000000000000000";

  it("flags ELITE wallets with negative trailing PnL, ignores profitable ones", () => {
    const db = getDB();
    db.exec("DELETE FROM wallets; DELETE FROM positions_history;");

    // Seed 3 wallets at different tiers
    upsertWallet({
      addr: GOOD, score: 80, tier: "ELITE", winRate: 70, roi: 30,
      sharpe: 2, maxDrawdown: 10, timing: 80, consistency: 75,
      totalPnL: 10000, volume: 50000, closedPositions: 30, openPositions: 2, trades: 50,
    });
    upsertWallet({
      addr: STALE, score: 72, tier: "ELITE", winRate: 55, roi: 25,
      sharpe: 1.5, maxDrawdown: 15, timing: 75, consistency: 60,
      totalPnL: 8000, volume: 40000, closedPositions: 25, openPositions: 3, trades: 45,
    });
    upsertWallet({
      addr: PROWAL, score: 55, tier: "PRO", winRate: 52, roi: 15,
      sharpe: 1, maxDrawdown: 20, timing: 60, consistency: 50,
      totalPnL: -500, volume: 10000, closedPositions: 15, openPositions: 1, trades: 20,
    });

    const now = Date.now();
    const within = now - 10 * 24 * 3600_000; // 10d ago, inside 30d window
    const outside = now - 60 * 24 * 3600_000; // 60d ago, outside window

    // GOOD: +$500 trailing inside window
    insertPositionSnapshot({
      walletAddress: GOOD, conditionId: "c1", outcome: "YES", size: 1000,
      avgPrice: 0.4, currentValue: 500, pnl: 500, snapshotAt: within,
    });
    // STALE: −$1200 trailing inside window
    insertPositionSnapshot({
      walletAddress: STALE, conditionId: "c2", outcome: "YES", size: 1000,
      avgPrice: 0.6, currentValue: 400, pnl: -1200, snapshotAt: within,
    });
    // STALE also had a PROFITABLE position 60d ago — must NOT rescue their status
    insertPositionSnapshot({
      walletAddress: STALE, conditionId: "c3", outcome: "YES", size: 500,
      avgPrice: 0.3, currentValue: 450, pnl: 300, snapshotAt: outside,
    });
    // PRO wallet is losing but should be ignored (not ELITE)
    insertPositionSnapshot({
      walletAddress: PROWAL, conditionId: "c4", outcome: "YES", size: 100,
      avgPrice: 0.5, currentValue: 30, pnl: -70, snapshotAt: within,
    });

    const result = getWalletDegradationCandidates({ windowDays: 30 });

    assert.equal(result.length, 1, "exactly one degraded ELITE wallet");
    assert.equal(result[0].address,     STALE);
    assert.equal(result[0].tier,        "ELITE");
    assert.equal(result[0].trailingPnl, -1200);
    assert.equal(result[0].windowDays,  30);
  });

  it("picks the latest snapshot per (wallet, market) inside the window", () => {
    const db = getDB();
    db.prepare("DELETE FROM positions_history WHERE wallet_address = ?").run(STALE);

    const now = Date.now();
    const older = now - 20 * 24 * 3600_000;
    const newer = now - 5  * 24 * 3600_000;

    // Same market c2 observed twice in window — expect the NEWER pnl to count
    insertPositionSnapshot({
      walletAddress: STALE, conditionId: "c2", outcome: "YES", size: 1000,
      avgPrice: 0.5, currentValue: 600, pnl: 100, snapshotAt: older,   // old: +100
    });
    insertPositionSnapshot({
      walletAddress: STALE, conditionId: "c2", outcome: "YES", size: 1000,
      avgPrice: 0.5, currentValue: 300, pnl: -200, snapshotAt: newer,  // new: −200
    });

    const result = getWalletDegradationCandidates({ windowDays: 30 });
    const stale = result.find(r => r.address === STALE);
    assert.ok(stale, "STALE wallet should appear");
    assert.equal(stale.trailingPnl, -200, "must use latest snapshot, not sum or avg");
  });

  it("returns empty array when positions_history is empty", () => {
    const db = getDB();
    db.exec("DELETE FROM positions_history;");
    const result = getWalletDegradationCandidates({ windowDays: 30 });
    assert.equal(result.length, 0);
  });
});

// ── N3 — VACUUM ──────────────────────────────────────────────────────────────

describe("vacuumDB", () => {
  it("completes and returns sensible byte/duration metrics", () => {
    // Seed + delete churn so there's something to reclaim
    const db = getDB();
    db.exec("DELETE FROM market_snapshots;");
    for (let i = 0; i < 200; i++) {
      insertMarketSnapshot({
        conditionId: "cvac",
        tokenId: `t${i}`,
        timestamp: 1000 + i,
        midPrice: 0.5, bestBid: 0.49, bestAsk: 0.51,
        bidDepth: 100, askDepth: 100, volume24h: 1000,
      });
    }
    db.exec("DELETE FROM market_snapshots WHERE condition_id = 'cvac';");

    const r = vacuumDB();
    assert.ok(r.bytesBefore > 0,      "bytesBefore positive");
    assert.ok(r.bytesAfter  > 0,      "bytesAfter positive");
    assert.ok(r.durationMs  >= 0,     "durationMs non-negative");
    assert.equal(typeof r.freedBytes, "number", "freedBytes is a number");
  });

  it("leaves the DB usable for subsequent queries", () => {
    insertMarketSnapshot({
      conditionId: "cafter", tokenId: "tA", timestamp: 9999, midPrice: 0.5,
    });
    const stats = getDataCaptureStats();
    assert.ok(stats.marketSnapshots.total >= 1, "can read after VACUUM");
  });
});

// ── Stats ────────────────────────────────────────────────────────────────────

describe("getStats", () => {
  it("returns aggregate stats", () => {
    const stats = getStats();
    assert.ok(stats.walletCount >= 1);
    assert.ok(stats.eliteCount >= 1);
    assert.ok(stats.signalCount >= 1);
    assert.ok(stats.tradeCount >= 1);
    assert.ok(stats.scanCount >= 1);
    assert.ok(stats.lastScan);
  });
});

// ── Wallet soft-delete (blacklist round-trip) ───────────────────────────────

describe("wallet blacklist", () => {
  const ADDR = "0xblack000000000000000000000000000000000000";

  it("blacklistWallet flips the flag; getAllWallets / getBlacklistedWallets reflect it", async () => {
    upsertWallet({
      addr: ADDR, score: 80, tier: "ELITE", winRate: 60, roi: 25,
      sharpe: 1.5, maxDrawdown: 10, timing: 70, consistency: 60,
      totalPnL: 1500, volume: 50000, closedPositions: 25, openPositions: 1, trades: 30,
    });
    // Live before blacklist
    const liveBefore = getAllWallets().some(w => w.address === ADDR);
    assert.equal(liveBefore, true);

    const changed = blacklistWallet(ADDR);
    assert.equal(changed, 1);

    // Removed from live list
    assert.equal(getAllWallets().some(w => w.address === ADDR), false);

    // Visible in blacklist list
    const trash = getBlacklistedWallets();
    const found = trash.find(w => w.address === ADDR);
    assert.ok(found, "blacklisted wallet should appear in trash");
    assert.equal(found.tier,  "ELITE");
    assert.equal(found.score, 80);
  });

  it("unblacklistWallet restores it back to the live list", () => {
    const changed = unblacklistWallet(ADDR);
    assert.equal(changed, 1);
    assert.equal(getAllWallets().some(w => w.address === ADDR), true);
    assert.equal(getBlacklistedWallets().some(w => w.address === ADDR), false);
  });

  it("blacklistWallet returns 0 changes for unknown address", () => {
    const changed = blacklistWallet("0xnope000000000000000000000000000000000000");
    assert.equal(changed, 0);
  });
});

// ── Auto-import rejection cache (V11) ────────────────────────────────────────

describe("import_rejections cache", () => {
  const A = "0xCAFE000000000000000000000000000000000001"; // upper-cased on input
  const B = "0xcafe000000000000000000000000000000000002";
  const HOUR = 3600_000;

  before(() => {
    getDB().exec("DELETE FROM import_rejections");
  });

  it("records a rejection (lowercased) and finds it within TTL", () => {
    const changes = recordImportRejection(A, "pnl 50 < 100");
    assert.equal(changes, 1);

    const set = getRecentImportRejections(24 * HOUR);
    assert.equal(set.has(A.toLowerCase()), true);
    assert.equal(set.has(A), false, "stored lowercase, not as-input");
  });

  it("upserts on conflict (last reason wins)", () => {
    recordImportRejection(A, "first");
    const changes = recordImportRejection(A, "second");
    assert.equal(changes, 1);
    const row = getDB().prepare(
      "SELECT reason FROM import_rejections WHERE address = ?"
    ).get(A.toLowerCase());
    assert.equal(row.reason, "second");
  });

  it("excludes rows older than ttlMs", () => {
    recordImportRejection(B, "stale");
    // Backdate to 30 days ago
    const STALE = Date.now() - 30 * 24 * HOUR;
    getDB().prepare(
      "UPDATE import_rejections SET rejected_at = ? WHERE address = ?"
    ).run(STALE, B);

    const set7d = getRecentImportRejections(7 * 24 * HOUR);
    assert.equal(set7d.has(B), false);

    const set60d = getRecentImportRejections(60 * 24 * HOUR);
    assert.equal(set60d.has(B), true);
  });

  it("returns empty Set for ttlMs <= 0 or non-finite", () => {
    assert.equal(getRecentImportRejections(0).size, 0);
    assert.equal(getRecentImportRejections(-1).size, 0);
    assert.equal(getRecentImportRejections(NaN).size, 0);
  });

  it("clearStaleImportRejections drops only old rows", () => {
    // A is fresh, B was backdated 30 days
    const removed = clearStaleImportRejections(7 * 24 * HOUR);
    assert.ok(removed >= 1, "should drop B");
    const remaining = getRecentImportRejections(60 * 24 * HOUR);
    assert.equal(remaining.has(A.toLowerCase()), true);
    assert.equal(remaining.has(B), false);
  });

  it("recordImportRejection returns 0 for empty/falsy address", () => {
    assert.equal(recordImportRejection("", "x"), 0);
    assert.equal(recordImportRejection(null, "x"), 0);
  });
});

