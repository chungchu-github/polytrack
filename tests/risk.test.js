import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  dailyRealizedLoss, marketExposure, totalExposure,
  lastMarketTradeTs, checkRiskLimits, getRiskSnapshot, resolveRiskLimits,
} from "../src/risk.js";

// Defaults (must match env fallbacks in src/risk.js)
const DAILY_LIMIT  = 200;
const MARKET_LIMIT = 300;
const TOTAL_LIMIT  = 1000;
const COOLDOWN_MS  = 30 * 60_000;

// Default state has v1ReadyPct=100 so existing tests aren't blocked by the
// V1 gate; tests for the gate itself construct state explicitly.
function mkState(autoTrades) {
  return { autoTrades, v1ReadyPct: 100 };
}

describe("risk — daily realized loss", () => {
  it("sums negative pnl within 24h window", () => {
    const now = Date.now();
    const state = mkState([
      { executedAt: now,              status: "FILLED", pnl: -50 },
      { executedAt: now,              status: "FILLED", pnl: -30 },
      { executedAt: now,              status: "FILLED", pnl:  20 }, // profit ignored
      { executedAt: now - 48*3600e3,  status: "FILLED", pnl: -999 }, // outside window
    ]);
    assert.equal(dailyRealizedLoss(state), 80);
  });

  it("counts errors as $1 of risk consumed", () => {
    const state = mkState([
      { executedAt: Date.now(), status: "ERROR" },
      { executedAt: Date.now(), status: "ERROR" },
    ]);
    assert.equal(dailyRealizedLoss(state), 2);
  });
});

describe("risk — exposure", () => {
  it("sums size of FILLED+PARTIAL per market", () => {
    const state = mkState([
      { conditionId: "A", status: "FILLED",  size: 100 },
      { conditionId: "A", status: "PARTIAL", size: 50 },
      { conditionId: "A", status: "ERROR",   size: 999 }, // ignored
      { conditionId: "B", status: "FILLED",  size: 200 },
    ]);
    assert.equal(marketExposure(state, "A"), 150);
    assert.equal(marketExposure(state, "B"), 200);
    assert.equal(totalExposure(state), 350);
  });
});

describe("risk — checkRiskLimits", () => {
  it("permits a clean trade", () => {
    const r = checkRiskLimits(mkState([]), "X", 50);
    assert.equal(r.ok, true);
  });

  it("rejects when daily loss limit hit", () => {
    const state = mkState([
      { executedAt: Date.now(), status: "FILLED", pnl: -(DAILY_LIMIT + 1) },
    ]);
    const r = checkRiskLimits(state, "X", 10);
    assert.equal(r.ok, false);
    assert.match(r.reason, /Daily loss/);
  });

  it("rejects when market exposure would exceed cap", () => {
    const state = mkState([
      { conditionId: "X", status: "FILLED", size: MARKET_LIMIT, executedAt: Date.now() - COOLDOWN_MS - 1000 },
    ]);
    const r = checkRiskLimits(state, "X", 1);
    assert.equal(r.ok, false);
    assert.match(r.reason, /Market exposure/);
  });

  it("rejects when total exposure would exceed cap", () => {
    const state = mkState([
      { conditionId: "A", status: "FILLED", size: TOTAL_LIMIT, executedAt: Date.now() - COOLDOWN_MS - 1000 },
    ]);
    const r = checkRiskLimits(state, "B", 1);
    assert.equal(r.ok, false);
    assert.match(r.reason, /Total exposure/);
  });

  it("enforces per-market cooldown", () => {
    const state = mkState([
      { conditionId: "X", status: "FILLED", size: 10, executedAt: Date.now() - 60_000 },
    ]);
    const r = checkRiskLimits(state, "X", 10);
    assert.equal(r.ok, false);
    assert.match(r.reason, /cooldown/i);
  });

  it("allows trade after cooldown expires", () => {
    const state = mkState([
      { conditionId: "X", status: "FILLED", size: 10, executedAt: Date.now() - COOLDOWN_MS - 1000 },
    ]);
    const r = checkRiskLimits(state, "X", 10);
    assert.equal(r.ok, true);
  });
});

describe("risk — snapshot", () => {
  it("returns numeric snapshot with limits", () => {
    const snap = getRiskSnapshot(mkState([]));
    assert.equal(typeof snap.dailyLoss, "number");
    assert.equal(snap.dailyLossLimit, DAILY_LIMIT);
    assert.equal(snap.totalLimit, TOTAL_LIMIT);
    assert.equal(snap.marketLimit, MARKET_LIMIT);
    assert.equal(snap.cooldownMin, 30);
  });
});

describe("risk — V3 live-test cap", () => {
  it("no-op when cfg.liveTestCapUsdc is 0 or undefined", () => {
    const state = mkState([
      { conditionId: "X", executedAt: Date.now(), status: "FILLED", size: 5 },
    ]);
    assert.equal(checkRiskLimits(state, "Y", 5).ok, true);
    assert.equal(checkRiskLimits(state, "Y", 5, { liveTestCapUsdc: 0 }).ok, true);
  });

  it("blocks candidate trade that would exceed the cap", () => {
    const state = mkState([
      { conditionId: "X", executedAt: Date.now(), status: "FILLED", size: 8 },
    ]);
    const r = checkRiskLimits(state, "Y", 5, { liveTestCapUsdc: 10 });
    assert.equal(r.ok, false);
    assert.match(r.reason, /V3 live-test cap/);
    assert.match(r.reason, /13\.00/); // 8 + 5
  });

  it("allows candidate trade that stays within the cap", () => {
    const state = mkState([
      { conditionId: "X", executedAt: Date.now(), status: "FILLED", size: 3 },
    ]);
    const r = checkRiskLimits(state, "Y", 5, { liveTestCapUsdc: 10 });
    assert.equal(r.ok, true);
  });

  it("counts both FILLED and PARTIAL fills against the cap", () => {
    const state = mkState([
      { conditionId: "X", executedAt: Date.now(), status: "PARTIAL", size: 7 },
    ]);
    const r = checkRiskLimits(state, "Y", 4, { liveTestCapUsdc: 10 });
    assert.equal(r.ok, false);
  });

  it("getRiskSnapshot surfaces liveTestCapUsdc + liveTestUsed", () => {
    const state = mkState([
      { conditionId: "X", executedAt: Date.now(), status: "FILLED", size: 4 },
      { conditionId: "X", executedAt: Date.now(), status: "ERROR",  size: 99 }, // ignored
    ]);
    const snap = getRiskSnapshot(state, { liveTestCapUsdc: 10 });
    assert.equal(snap.liveTestCapUsdc, 10);
    assert.equal(snap.liveTestUsed, 4);
  });
});

describe("risk — lastMarketTradeTs", () => {
  it("returns 0 for untouched market", () => {
    assert.equal(lastMarketTradeTs(mkState([]), "X"), 0);
  });
  it("returns max executedAt across all statuses", () => {
    const now = Date.now();
    const state = mkState([
      { conditionId: "X", executedAt: now - 10_000, status: "ERROR" },
      { conditionId: "X", executedAt: now,          status: "FILLED" },
      { conditionId: "Y", executedAt: now + 1,      status: "FILLED" },
    ]);
    assert.equal(lastMarketTradeTs(state, "X"), now);
  });
});

// ── Config precedence (audit P2-2) ──────────────────────────────────────────

describe("risk — resolveRiskLimits config precedence", () => {
  it("config value wins over env fallback", () => {
    const limits = resolveRiskLimits({ maxDailyLossUsdc: 50 });
    assert.equal(limits.dailyLossLimit, 50);
  });
  it("falls through to env when cfg missing", () => {
    const limits = resolveRiskLimits({});
    assert.equal(limits.dailyLossLimit, 200);   // env or hardcoded fallback
  });
  it("ignores invalid cfg values (negative / non-numeric)", () => {
    const limits = resolveRiskLimits({
      maxDailyLossUsdc: -5, maxMarketExposureUsdc: "junk",
    });
    assert.equal(limits.dailyLossLimit, 200);
    assert.equal(limits.marketExposure, 300);
  });
  it("0 cooldown is honored (operator opt-out)", () => {
    const limits = resolveRiskLimits({ marketCooldownMin: 0 });
    assert.equal(limits.marketCooldownMs, 0);
  });
});

// ── V1 Gate (audit P0-2) ────────────────────────────────────────────────────

describe("risk — V1 Gate enforcement", () => {
  it("blocks when v1ReadyPct < 100 and no bypass", () => {
    const state = { autoTrades: [], v1ReadyPct: 30 };
    const r = checkRiskLimits(state, "CID-A", 50);
    assert.equal(r.ok, false);
    assert.match(r.reason, /V1 Gate 30/);
  });

  it("bypasses gate when liveTestCapUsdc > 0 (V3 small-amount mode)", () => {
    const state = { autoTrades: [], v1ReadyPct: 30 };
    const r = checkRiskLimits(state, "CID-A", 5, { liveTestCapUsdc: 60 });
    assert.equal(r.ok, true);
  });

  it("bypasses gate when env BYPASS_V1_GATE=true", () => {
    const state = { autoTrades: [], v1ReadyPct: 0 };
    process.env.BYPASS_V1_GATE = "true";
    try {
      const r = checkRiskLimits(state, "CID-A", 50);
      assert.equal(r.ok, true);
    } finally {
      delete process.env.BYPASS_V1_GATE;
    }
  });

  it("passes when v1ReadyPct >= 100", () => {
    const state = { autoTrades: [], v1ReadyPct: 100 };
    const r = checkRiskLimits(state, "CID-A", 50);
    assert.equal(r.ok, true);
  });
});

// ── killSwitch integration ──────────────────────────────────────────────────

describe("risk — killSwitch refusal", () => {
  it("refuses every auto-trade when killSwitch.active", () => {
    const state = {
      autoTrades: [],
      v1ReadyPct: 100,
      killSwitch: { active: true, reason: "lifetime PnL $-40 <= -$30" },
    };
    const r = checkRiskLimits(state, "CID-A", 5);
    assert.equal(r.ok, false);
    assert.match(r.reason, /killSwitch/);
  });

  it("does not refuse when killSwitch.active=false", () => {
    const state = {
      autoTrades: [],
      v1ReadyPct: 100,
      killSwitch: { active: false, reason: null },
    };
    const r = checkRiskLimits(state, "CID-A", 5);
    assert.equal(r.ok, true);
  });
});
