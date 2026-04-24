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
