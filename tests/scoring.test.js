import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeMarketPnL, calcWinRate, calcSharpe, calcTimingScore,
  calcConsistency, scoreWallet,
} from "../src/scoring.js";

// ── Test Data ────────────────────────────────────────────────────────────────

function makeTrades(markets) {
  const trades = [];
  for (const m of markets) {
    for (const t of m.trades) {
      trades.push({
        conditionId: m.conditionId,
        title: m.title,
        outcome: m.outcome || "Yes",
        outcomeIndex: 0,
        side: t.side,
        price: t.price,
        size: t.size,
        usdcSize: t.price * t.size,
        timestamp: t.ts || Date.now() / 1000,
      });
    }
  }
  return trades;
}

// ── computeMarketPnL ─────────────────────────────────────────────────────────

describe("computeMarketPnL", () => {
  it("groups trades by conditionId and computes PnL", () => {
    const trades = makeTrades([{
      conditionId: "market-1",
      title: "Test Market",
      trades: [
        { side: "BUY", price: 0.30, size: 100 },
        { side: "SELL", price: 0.70, size: 100 },
      ],
    }]);

    const results = computeMarketPnL(trades);
    assert.equal(results.length, 1);
    assert.equal(results[0].isClosed, true);
    assert.ok(results[0].realizedPnL > 0, "Should be profitable");
    // Bought at 0.30 * 100 = $30, sold at 0.70 * 100 = $70, PnL = $40
    assert.ok(Math.abs(results[0].realizedPnL - 40) < 0.01);
  });

  it("handles buy-only positions as open", () => {
    const trades = makeTrades([{
      conditionId: "market-2",
      title: "Open Position",
      trades: [
        { side: "BUY", price: 0.40, size: 50 },
      ],
    }]);

    const results = computeMarketPnL(trades);
    assert.equal(results[0].isClosed, false);
    assert.equal(results[0].realizedPnL, -20); // spent $20, received $0
  });

  it("handles empty trades", () => {
    assert.deepEqual(computeMarketPnL([]), []);
    assert.deepEqual(computeMarketPnL(null), []);
  });
});

// ── calcWinRate ──────────────────────────────────────────────────────────────

describe("calcWinRate", () => {
  it("computes win rate from closed positions with positive PnL", () => {
    const pnls = [
      { isClosed: true, realizedPnL: 10 },
      { isClosed: true, realizedPnL: -5 },
      { isClosed: true, realizedPnL: 20 },
      { isClosed: false, realizedPnL: -100 }, // open, ignored
    ];
    // 2 wins out of 3 closed = 66.67%
    assert.ok(Math.abs(calcWinRate(pnls) - 66.67) < 1);
  });

  it("returns 0 for no closed positions", () => {
    assert.equal(calcWinRate([{ isClosed: false, realizedPnL: 100 }]), 0);
  });
});

// ── calcSharpe ───────────────────────────────────────────────────────────────

describe("calcSharpe", () => {
  it("returns positive sharpe for consistently profitable trades", () => {
    const pnls = Array.from({ length: 10 }, () => ({
      isClosed: true, costBasis: 100, roi: 20,
    }));
    const sharpe = calcSharpe(pnls);
    assert.ok(sharpe > 0, `Expected positive sharpe, got ${sharpe}`);
  });

  it("returns 0 for insufficient data", () => {
    assert.equal(calcSharpe([{ isClosed: true, costBasis: 100, roi: 20 }]), 0);
  });
});

// ── scoreWallet (integration) ────────────────────────────────────────────────

describe("scoreWallet", () => {
  it("rates a losing wallet as BASIC", () => {
    const trades = makeTrades([
      { conditionId: "m1", title: "Losing Market", trades: [
        { side: "BUY", price: 0.80, size: 100 },
        { side: "SELL", price: 0.20, size: 100 },
      ]},
    ]);

    const result = scoreWallet(trades);
    assert.equal(result.tier, "BASIC");
    assert.ok(result.totalPnL < 0);
  });

  it("requires minimum closed positions for ELITE", () => {
    // Very profitable but only 2 closed positions — should NOT be ELITE
    const trades = makeTrades([
      { conditionId: "m1", title: "Win 1", trades: [
        { side: "BUY", price: 0.10, size: 100 },
        { side: "SELL", price: 0.90, size: 100 },
      ]},
      { conditionId: "m2", title: "Win 2", trades: [
        { side: "BUY", price: 0.10, size: 100 },
        { side: "SELL", price: 0.90, size: 100 },
      ]},
    ]);

    const result = scoreWallet(trades);
    assert.notEqual(result.tier, "ELITE", "Should not be ELITE with only 2 closed positions");
  });

  it("handles empty input gracefully", () => {
    const result = scoreWallet([]);
    assert.equal(result.tier, "BASIC");
    assert.equal(result.score, 0);
  });
});
