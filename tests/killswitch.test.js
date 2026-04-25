import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateKillSwitch,
  lifetimeRealizedPnl,
  maxDrawdownFromTrades,
  rollingSharpe,
} from "../src/killswitch.js";

const DAY = 24 * 60 * 60 * 1000;

// Helper: build a settled trade with timestamp days-ago and given pnl.
function settled(daysAgo, pnl, now = Date.now()) {
  return {
    status: "FILLED",
    pnl,
    exitedAt: now - daysAgo * DAY,
  };
}

describe("lifetimeRealizedPnl", () => {
  it("sums settled pnl across trades", () => {
    const trades = [settled(5, 10), settled(3, -4), settled(1, 2)];
    assert.equal(lifetimeRealizedPnl(trades), 8);
  });
  it("ignores unsettled trades (pnl null/undefined)", () => {
    const trades = [
      settled(1, 10),
      { status: "FILLED", pnl: null, exitedAt: Date.now() },
      { status: "FILLED", exitedAt: Date.now() },             // no pnl key
    ];
    assert.equal(lifetimeRealizedPnl(trades), 10);
  });
  it("returns 0 on empty/null input", () => {
    assert.equal(lifetimeRealizedPnl([]), 0);
    assert.equal(lifetimeRealizedPnl(null), 0);
  });
});

describe("maxDrawdownFromTrades", () => {
  it("computes peak-to-trough drawdown on cumulative PnL with positive baseline", () => {
    // Cumulative path with baseline 100: 100 → 110 → 105 → 120 → 90
    // Equity peak = 120, trough after = 90 → drawdown = 30/120 = 0.25
    const trades = [
      settled(4,  10),   // cum 10  (equity 110, peak 110)
      settled(3,  -5),   // cum 5   (equity 105)
      settled(2,  15),   // cum 20  (equity 120, peak 120)
      settled(1, -30),   // cum -10 (equity 90, dd = 30/120 = 0.25)
    ];
    const dd = maxDrawdownFromTrades(trades, 100);
    assert.ok(Math.abs(dd - 0.25) < 1e-4);
  });
  it("returns 0 for empty trades", () => {
    assert.equal(maxDrawdownFromTrades([]), 0);
  });
  it("returns 0 drawdown without baseline (lifetimePnl is the right metric there)", () => {
    // Without a baseline, raw dollar losses can't be normalised meaningfully.
    // Drawdown stays 0; the killSwitch's lifetime-loss check catches it instead.
    const trades = [settled(2, -10), settled(1, -10)];
    const dd = maxDrawdownFromTrades(trades);
    assert.equal(dd, 0);
  });
});

describe("rollingSharpe", () => {
  const now = Date.now();
  it("returns null when fewer than minSamples in window", () => {
    const trades = [settled(1, 5, now), settled(2, 3, now)];
    assert.equal(rollingSharpe(trades, { now, minSamples: 5 }), null);
  });
  it("returns null when older trades fall outside window", () => {
    // 5 trades, but 4 of them are 60 days old, only 1 is recent
    const trades = [
      settled(60, 1, now), settled(60, 2, now), settled(60, 3, now),
      settled(60, 4, now), settled(1,  5, now),
    ];
    assert.equal(rollingSharpe(trades, { now, windowDays: 28, minSamples: 5 }), null);
  });
  it("computes Sharpe = mean/std on per-trade pnl in window", () => {
    // 5 trades inside 28d window: pnl [4, 6, 5, 7, 3] → mean=5, sample-stdev≈1.58
    // Sharpe ≈ 5/1.58 ≈ 3.16
    const trades = [
      settled(1, 4, now), settled(2, 6, now), settled(3, 5, now),
      settled(4, 7, now), settled(5, 3, now),
    ];
    const s = rollingSharpe(trades, { now, windowDays: 28, minSamples: 5 });
    assert.ok(s != null);
    assert.ok(s > 2 && s < 4, `expected Sharpe ~3.16 got ${s}`);
  });
});

describe("evaluateKillSwitch", () => {
  const now = Date.now();
  const baseCfg = {
    enabled: true,
    maxLifetimeLossUsdc: 30,
    maxDrawdownPct: 0.25,
    minRollingSharpe: -0.5,
    rollingWindowDays: 28,
    minSamplesForSharpe: 5,
    now,
  };

  it("does not trip with no trades", () => {
    const v = evaluateKillSwitch([], baseCfg);
    assert.equal(v.trip, false);
  });

  it("trips on lifetime loss past threshold", () => {
    const trades = [settled(2, -20, now), settled(1, -15, now)]; // sum -35
    const v = evaluateKillSwitch(trades, baseCfg);
    assert.equal(v.trip, true);
    assert.match(v.reason, /lifetime PnL/);
    assert.equal(v.metrics.lifetimePnl, -35);
  });

  it("trips on drawdown >= threshold", () => {
    // Baseline 100; equity goes 100 → 140 → 100 → drawdown = 40/140 ≈ 28.6%
    const trades = [settled(3, 40, now), settled(2, -40, now)];
    const v = evaluateKillSwitch(trades, { ...baseCfg, baselineUsdc: 100 });
    assert.equal(v.trip, true);
    assert.match(v.reason, /drawdown/);
  });

  it("trips on rolling Sharpe <= threshold (with enough samples)", () => {
    // 6 trades, all small losses → mean negative, std small → very negative Sharpe
    const trades = [
      settled(5, -2, now), settled(4, -3, now), settled(3, -2, now),
      settled(2, -3, now), settled(1, -2, now), settled(1, -3, now),
    ];
    const v = evaluateKillSwitch(trades, baseCfg);
    assert.equal(v.trip, true);
    // Lifetime PnL = -15 (above -30 threshold), no baseline so drawdown=0,
    // Sharpe ≈ -4.6 → only Sharpe trips.
    assert.match(v.reason, /Sharpe/);
  });

  it("does not trip when disabled", () => {
    const trades = [settled(1, -100, now)];
    const v = evaluateKillSwitch(trades, { ...baseCfg, enabled: false });
    assert.equal(v.trip, false);
  });

  it("does not trip when only paper losses but settled PnL fine", () => {
    // 4 settled wins; 1 still-open (no pnl key) — should not influence anything
    const trades = [
      settled(4, 5, now), settled(3, 5, now), settled(2, 5, now),
      settled(1, 5, now),
      { status: "FILLED", exitedAt: null },           // unsettled
    ];
    const v = evaluateKillSwitch(trades, baseCfg);
    assert.equal(v.trip, false);
    assert.equal(v.metrics.lifetimePnl, 20);
  });
});
