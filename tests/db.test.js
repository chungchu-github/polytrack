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
  getTradesPnlByStrategy,
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
