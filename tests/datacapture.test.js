/**
 * F0.5 Data Capture Layer tests
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { unlinkSync } from "fs";

import {
  initDB, closeDB, getDB,
  insertMarketSnapshot, insertPositionSnapshot,
  getMarketSnapshots, getPositionHistory,
  deleteOldMarketSnapshots, deleteOldPositionHistory,
} from "../src/db.js";
import { captureWalletPositions, pruneOldSnapshots, captureMarketSnapshot } from "../src/datacapture.js";
import { normaliseMarket, parseJsonArray } from "../src/polymarket-api.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_DB = resolve(__dirname, "..", "data", "test-datacapture.db");

before(() => { initDB(TEST_DB); });
after(() => { closeDB(); try { unlinkSync(TEST_DB); } catch {} });

beforeEach(() => {
  const db = getDB();
  db.exec("DELETE FROM market_snapshots; DELETE FROM positions_history;");
});

describe("market_snapshots schema", () => {
  it("creates table with correct columns", () => {
    const cols = getDB().prepare("PRAGMA table_info(market_snapshots)").all().map(c => c.name);
    for (const c of ["condition_id","token_id","timestamp","mid_price","best_bid","best_ask","bid_depth","ask_depth","volume_24h"]) {
      assert.ok(cols.includes(c), `missing column ${c}`);
    }
  });

  it("inserts and reads back snapshots in timestamp order", () => {
    const cid = "0xabc";
    const base = Date.now() - 10_000;
    for (let i = 0; i < 5; i++) {
      insertMarketSnapshot({
        conditionId: cid, tokenId: "tok1", timestamp: base + i * 1000,
        midPrice: 0.5 + i * 0.01, bestBid: 0.49, bestAsk: 0.51,
        bidDepth: 100, askDepth: 120, volume24h: 5000,
      });
    }
    const rows = getMarketSnapshots(cid);
    assert.equal(rows.length, 5);
    for (let i = 1; i < rows.length; i++) {
      assert.ok(rows[i].timestamp > rows[i - 1].timestamp);
    }
    assert.equal(rows[0].mid_price, 0.5);
  });

  it("filters by time window", () => {
    const cid = "0xdef";
    insertMarketSnapshot({ conditionId: cid, tokenId: "t", timestamp: 1000, midPrice: 0.4 });
    insertMarketSnapshot({ conditionId: cid, tokenId: "t", timestamp: 5000, midPrice: 0.5 });
    insertMarketSnapshot({ conditionId: cid, tokenId: "t", timestamp: 9000, midPrice: 0.6 });
    const win = getMarketSnapshots(cid, 2000, 7000);
    assert.equal(win.length, 1);
    assert.equal(win[0].mid_price, 0.5);
  });
});

describe("positions_history schema", () => {
  it("creates table with correct columns", () => {
    const cols = getDB().prepare("PRAGMA table_info(positions_history)").all().map(c => c.name);
    for (const c of ["wallet_address","condition_id","outcome","size","avg_price","current_value","pnl","snapshot_at"]) {
      assert.ok(cols.includes(c), `missing column ${c}`);
    }
  });

  it("inserts and reads back per-wallet history", () => {
    const addr = "0xwallet";
    insertPositionSnapshot({
      walletAddress: addr, conditionId: "0xm1", outcome: "YES",
      size: 100, avgPrice: 0.5, currentValue: 60, pnl: 10,
      snapshotAt: 1000,
    });
    insertPositionSnapshot({
      walletAddress: addr, conditionId: "0xm2", outcome: "NO",
      size: 50, avgPrice: 0.3, currentValue: 20, pnl: 5,
      snapshotAt: 2000,
    });
    const rows = getPositionHistory(addr);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].condition_id, "0xm1");
    assert.equal(rows[1].outcome, "NO");
  });
});

describe("captureWalletPositions", () => {
  it("snapshots open positions from loaded wallets, skipping zero size", () => {
    const state = { wallets: new Map() };
    state.wallets.set("0xaaa", {
      positions: [
        { conditionId: "0xm1", outcome: "YES", size: 100, avgPrice: 0.4, currentValue: 50, cashPnl: 10 },
        { conditionId: "0xm2", outcome: "NO",  size: 0,   avgPrice: 0.5 }, // skipped
        { conditionId: null,   outcome: "YES", size: 10 }, // skipped (no cid)
      ],
    });
    state.wallets.set("0xbbb", {
      positions: [
        { conditionId: "0xm1", outcome: "YES", size: 20, avgPrice: 0.45, currentValue: 9 },
      ],
    });
    const inserted = captureWalletPositions(state);
    assert.equal(inserted, 2);
    assert.equal(getPositionHistory("0xaaa").length, 1);
    assert.equal(getPositionHistory("0xbbb").length, 1);
  });

  it("tolerates wallets with no positions array", () => {
    const state = { wallets: new Map([["0xzzz", { /* no positions */ }]]) };
    assert.equal(captureWalletPositions(state), 0);
  });
});

describe("pruneOldSnapshots", () => {
  it("deletes rows older than cutoff and keeps recent ones", () => {
    const oldTs = Date.now() - 100 * 24 * 60 * 60 * 1000; // 100 days ago
    const recentTs = Date.now() - 10 * 24 * 60 * 60 * 1000; // 10 days ago
    insertMarketSnapshot({ conditionId: "c", tokenId: "t", timestamp: oldTs, midPrice: 0.5 });
    insertMarketSnapshot({ conditionId: "c", tokenId: "t", timestamp: recentTs, midPrice: 0.6 });
    insertPositionSnapshot({ walletAddress: "w", conditionId: "c", size: 1, snapshotAt: oldTs });
    insertPositionSnapshot({ walletAddress: "w", conditionId: "c", size: 1, snapshotAt: recentTs });

    const res = pruneOldSnapshots(90);
    assert.equal(res.markets, 1);
    assert.equal(res.positions, 1);
    assert.equal(getMarketSnapshots("c").length, 1);
    assert.equal(getPositionHistory("w").length, 1);
  });
});

describe("delete helpers", () => {
  it("deleteOldMarketSnapshots / deleteOldPositionHistory return affected count", () => {
    insertMarketSnapshot({ conditionId: "c", tokenId: "t", timestamp: 100, midPrice: 0.1 });
    insertMarketSnapshot({ conditionId: "c", tokenId: "t", timestamp: 200, midPrice: 0.2 });
    assert.equal(deleteOldMarketSnapshots(150), 1);

    insertPositionSnapshot({ walletAddress: "w", conditionId: "c", size: 1, snapshotAt: 100 });
    insertPositionSnapshot({ walletAddress: "w", conditionId: "c", size: 1, snapshotAt: 200 });
    assert.equal(deleteOldPositionHistory(150), 1);
  });
});

// ── Gamma API shape adapter (2026-04 regression — tokens field deprecated) ──

describe("parseJsonArray", () => {
  it("handles arrays, JSON strings, and garbage", () => {
    assert.deepEqual(parseJsonArray(["a", "b"]), ["a", "b"]);
    assert.deepEqual(parseJsonArray('["a","b"]'), ["a", "b"]);
    assert.deepEqual(parseJsonArray("not-json"), []);
    assert.deepEqual(parseJsonArray(null), []);
    assert.deepEqual(parseJsonArray(undefined), []);
    assert.deepEqual(parseJsonArray(42), []);
    assert.deepEqual(parseJsonArray("{\"not\":\"array\"}"), []);
  });
});

describe("normaliseMarket (Gamma new-format adapter)", () => {
  it("rebuilds tokens[] from clobTokenIds + outcomes + outcomePrices (JSON strings)", () => {
    const m = normaliseMarket({
      id: 42,
      conditionId: "0xabc",
      question: "Will X?",
      clobTokenIds:  '["11111111111111111111", "22222222222222222222"]',
      outcomes:      '["Yes", "No"]',
      outcomePrices: '["0.73", "0.27"]',
      negRisk: true,
      active: true,
      acceptingOrders: true,
      orderMinSize: 5,
      orderPriceMinTickSize: 0.001,
      lastTradePrice: 0.73,
    });
    assert.equal(m.tokens.length, 2);
    assert.equal(m.tokens[0].token_id, "11111111111111111111");
    assert.equal(m.tokens[0].outcome, "Yes");
    assert.ok(Math.abs(m.tokens[0].price - 0.73) < 1e-9);
    assert.equal(m.tokens[1].outcome, "No");
    assert.equal(m.negRisk, true);
    assert.equal(m.minOrderSize, 5);
    assert.equal(m.tickSize, 0.001);
    assert.equal(m.active, true);
    assert.deepEqual(m.outcomes, ["Yes", "No"]);
  });

  it("falls back to lastTradePrice when outcomePrices missing", () => {
    const m = normaliseMarket({
      clobTokenIds: '["t1"]',
      outcomes: '["Yes"]',
      lastTradePrice: 0.5,
    });
    assert.equal(m.tokens[0].price, 0.5);
  });

  it("preserves legacy tokens[] when server still provides them (defensive)", () => {
    const legacy = [{ token_id: "t1", outcome: "Yes", price: 0.4 }];
    const m = normaliseMarket({ tokens: legacy, clobTokenIds: '[]' });
    assert.deepEqual(m.tokens, legacy);
  });

  it("flags active=false when acceptingOrders=false even if active=true", () => {
    const m = normaliseMarket({ active: true, acceptingOrders: false });
    assert.equal(m.active, false);
  });

  it("returns zero-token market gracefully when Gamma returns empty arrays", () => {
    const m = normaliseMarket({ clobTokenIds: '[]', outcomes: '[]' });
    assert.equal(m.tokens.length, 0);
    assert.deepEqual(m.outcomes, []);
  });
});

describe("captureMarketSnapshot — new Gamma shape round-trip", () => {
  it("inserts market_snapshots when fed a normaliseMarket output (no real tokens field)", async () => {
    // Simulate a "fetchMarkets-shaped" event exactly as runScan sees it:
    const normalised = normaliseMarket({
      id: 1, conditionId: "cap_new_c1", question: "Q?",
      clobTokenIds: '["aaaa1111", "bbbb2222"]',
      outcomes: '["Yes", "No"]',
      outcomePrices: '["0.6", "0.4"]',
      orderMinSize: 5, orderPriceMinTickSize: 0.01,
    });
    const events = [{
      id: "ev1", title: "Test event", volume: 12345,
      markets: [normalised],
    }];

    const result = await captureMarketSnapshot(events);

    // We expect 2 tokens' worth of rows attempted. Book fetch will fail against
    // fake token_ids (no real Polymarket market) — but we're testing the
    // iteration wiring: result.failed must equal total tokens.
    assert.equal(result.inserted + result.failed, 2,
      `expected 2 token iterations, got inserted=${result.inserted} failed=${result.failed}`);
  });

  it("no-ops gracefully when event list is empty", async () => {
    const result = await captureMarketSnapshot([]);
    assert.deepEqual(result, { inserted: 0, failed: 0 });
  });
});
