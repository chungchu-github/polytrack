/**
 * F3 Backtest engine tests.
 *
 * Uses real DB (test sqlite file), seeds market_snapshots + positions_history
 * + signals.resolved_direction, then runs the backtest pipeline end-to-end.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { unlinkSync } from "fs";

import {
  initDB, closeDB, getDB,
  insertMarketSnapshot, insertPositionSnapshot,
  insertBacktest, completeBacktest, getBacktest,
} from "../src/db.js";
import { SimulatedPortfolio, simulateFill } from "../src/backtest/simulate.js";
import { HistoryReader } from "../src/backtest/history.js";
import { runBacktest } from "../src/backtest/engine.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_DB = resolve(__dirname, "..", "data", "test-backtest.db");

before(() => { initDB(TEST_DB); });
after(() => { closeDB(); try { unlinkSync(TEST_DB); } catch {} });

// ── Unit: simulateFill ──────────────────────────────────────────────────────
describe("simulateFill", () => {
  it("fills at best_ask * (1 + slippage)", () => {
    const fill = simulateFill({
      signal: { conditionId: "c", direction: "YES", strategy: "consensus" },
      snapshot: { best_ask: 0.5, ask_depth: 100, timestamp: 1000 },
      sizeUsdc: 10, slippagePct: 2,
    });
    assert.equal(fill.status, "FILLED");
    assert.ok(Math.abs(fill.fillPrice - 0.51) < 1e-9);
    assert.ok(fill.shares > 0 && fill.shares < 100);
  });

  it("marks PARTIAL when depth insufficient", () => {
    const fill = simulateFill({
      signal: { conditionId: "c", direction: "YES" },
      snapshot: { best_ask: 0.5, ask_depth: 1, timestamp: 1000 },
      sizeUsdc: 1000, slippagePct: 0,
    });
    assert.equal(fill.status, "PARTIAL");
    assert.equal(fill.shares, 1);
  });

  it("returns NO_FILL when no ask available", () => {
    const fill = simulateFill({
      signal: { conditionId: "c", direction: "YES" },
      snapshot: { best_ask: null, ask_depth: 0 },
      sizeUsdc: 10,
    });
    assert.equal(fill.status, "NO_FILL");
  });
});

// ── Unit: SimulatedPortfolio ────────────────────────────────────────────────
describe("SimulatedPortfolio", () => {
  it("accumulates positions and settles on YES resolution", () => {
    const p = new SimulatedPortfolio(1000);
    p.record({ status: "FILLED", conditionId: "c1", direction: "YES",
               shares: 100, fillPrice: 0.5, filledUsdc: 50,
               timestamp: 1000, strategy: "consensus" });
    assert.equal(p.cash, 950);
    assert.equal(p.positions.size, 1);

    p.settleResolved(new Map([["c1", "YES"]]));
    assert.equal(p.positions.size, 0);
    const m = p.computeMetrics();
    assert.equal(m.wins, 1);
    assert.equal(m.losses, 0);
    assert.ok(m.totalPnL > 0);
  });

  it("realizes loss when resolution goes against the position", () => {
    const p = new SimulatedPortfolio(1000);
    p.record({ status: "FILLED", conditionId: "c1", direction: "YES",
               shares: 100, fillPrice: 0.5, filledUsdc: 50, timestamp: 1000 });
    p.settleResolved(new Map([["c1", "NO"]]));
    const m = p.computeMetrics();
    assert.equal(m.losses, 1);
    assert.ok(m.totalPnL < 0);
  });

  it("tracks equity curve for drawdown calc", () => {
    const p = new SimulatedPortfolio(1000);
    p.revalue(1000, new Map());
    p.revalue(2000, new Map());
    const m = p.computeMetrics();
    assert.equal(m.maxDrawdownPct, 0);
  });
});

// ── Integration: runBacktest (momentum on seeded snapshots) ──────────────────
describe("runBacktest (momentum)", () => {
  it("detects trend, fills, settles, and computes metrics", async () => {
    const db = getDB();
    db.exec("DELETE FROM market_snapshots; DELETE FROM positions_history; DELETE FROM signals;");

    const base = Date.now() - 10 * 86400e3;
    const end  = Date.now();

    // Seed a rising price series for tokA (conditionId c1)
    for (let i = 0; i < 24; i++) {
      insertMarketSnapshot({
        conditionId: "c1", tokenId: "tokA",
        timestamp: base + i * 3600_000,
        midPrice: 0.30 + i * 0.02, bestBid: 0.29 + i * 0.02, bestAsk: 0.31 + i * 0.02,
        bidDepth: 500, askDepth: 500, volume24h: 50000,
      });
    }

    // Seed a resolved YES outcome for c1 so wins get recorded
    db.prepare(`
      INSERT INTO signals (condition_id, direction, strength, status, first_seen,
        last_confirmed, resolved_direction, resolved_at, strategy)
      VALUES ('c1', 'YES', 80, 'CONFIRMED', ?, ?, 'YES', ?, 'momentum')
    `).run(base, base, end - 3600_000);

    const result = await runBacktest({
      dateStart: base,
      dateEnd: end,
      strategy: "momentum",
      strategyConfig: { enabled: true, lookbackHours: 6, minPriceMovePct: 5, minVolume24h: 1000, monotonicity: 0.5 },
      sizeUsdc: 100,
      initialCash: 1000,
      stepMinutes: 180,
    });

    assert.ok(result.metrics.tradeCount >= 1, "expected at least 1 momentum trade");
    assert.ok(result.metrics.settlements >= 1, "expected settlement on resolved market");
    assert.ok(result.metrics.totalPnL > 0, "expected positive PnL (YES resolution)");
    assert.ok(result.equityCurve.length > 0);
  });

  it("rejects when dateStart >= dateEnd", async () => {
    await assert.rejects(
      () => runBacktest({ dateStart: 2000, dateEnd: 1000, strategy: "momentum" }),
      /dateStart must be before dateEnd/
    );
  });
});

// ── Backtest persistence (V6: equity_json) ──────────────────────────────────
describe("backtest persistence", () => {
  it("stores and restores equityCurve through completeBacktest/getBacktest", () => {
    const id = insertBacktest({
      name: "eq-test", dateStart: 1000, dateEnd: 2000, strategy: "consensus",
      config: { sizeUsdc: 100 },
    });
    const curve = [{ t: 1000, equity: 1000 }, { t: 1500, equity: 1050 }, { t: 2000, equity: 1120 }];
    completeBacktest(id, {
      metrics: { totalPnL: 120 },
      trades: [],
      equityCurve: curve,
    });
    const bt = getBacktest(id);
    assert.ok(bt);
    assert.equal(bt.status, "DONE");
    assert.deepEqual(bt.equityCurve, curve);
    assert.equal(bt.metrics.totalPnL, 120);
  });

  it("getBacktest returns empty equityCurve when none persisted", () => {
    const id = insertBacktest({
      name: "eq-empty", dateStart: 1, dateEnd: 2, strategy: "consensus", config: {},
    });
    const bt = getBacktest(id);
    assert.deepEqual(bt.equityCurve, []);
  });
});

// ── HistoryReader ────────────────────────────────────────────────────────────
describe("HistoryReader", () => {
  it("rebuilds markets from snapshots", () => {
    const db = getDB();
    db.exec("DELETE FROM market_snapshots;");
    insertMarketSnapshot({ conditionId: "cX", tokenId: "tX1", timestamp: 1000, midPrice: 0.5 });
    insertMarketSnapshot({ conditionId: "cX", tokenId: "tX2", timestamp: 1000, midPrice: 0.5 });
    const h = new HistoryReader();
    const markets = h.getMarketsAt(0, 2000);
    assert.equal(markets.length, 1);
    assert.equal(markets[0].markets[0].tokens.length, 2);
  });
});
