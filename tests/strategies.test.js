/**
 * F2 Strategy tests — verify each strategy's detect() against fixed fixtures.
 * No DB required: we inject a fake HistoryReader.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { MomentumStrategy } from "../src/strategies/momentum.js";
import { MeanRevStrategy } from "../src/strategies/meanrev.js";
import { ArbitrageStrategy } from "../src/strategies/arbitrage.js";
import { StrategyEngine } from "../src/strategies/engine.js";

// ── Fake history reader (pure in-memory) ─────────────────────────────────────
function fakeHistory({ marketSnaps = {}, latestByToken = {} } = {}) {
  return {
    getMarketSnapshots(cid) { return marketSnaps[cid] || []; },
    getMarketAt(tokenId)    { return latestByToken[tokenId] || null; },
    getWalletsAt()          { return []; },
    getMarketsAt()          { return []; },
    listWallets()           { return []; },
  };
}

function mkMarkets(cid, tokenIds = ["tokA", "tokB"]) {
  return [{
    title: "t", markets: [{
      conditionId: cid, question: "Q?",
      tokens: tokenIds.map(id => ({ token_id: id })),
    }],
  }];
}

// ── Momentum ─────────────────────────────────────────────────────────────────
describe("MomentumStrategy", () => {
  it("detects upward monotonic trend exceeding threshold → YES", () => {
    const now = Date.now();
    const snaps = [];
    for (let i = 0; i < 6; i++) {
      snaps.push({
        condition_id: "c1", token_id: "tokA",
        timestamp: now - (5 - i) * 600_000,
        mid_price: 0.40 + i * 0.03, volume_24h: 10000,
      });
    }
    const history = fakeHistory({ marketSnaps: { c1: snaps } });
    const strat = new MomentumStrategy({ lookbackHours: 4, minPriceMovePct: 8, minVolume24h: 5000 });
    const signals = strat.detect({ markets: mkMarkets("c1"), history, now });
    assert.equal(signals.length, 1);
    assert.equal(signals[0].direction, "YES");
    assert.ok(signals[0].priceMovePct > 8);
  });

  it("skips flat price movement", () => {
    const now = Date.now();
    const snaps = Array.from({ length: 5 }, (_, i) => ({
      condition_id: "c1", token_id: "tokA",
      timestamp: now - (4 - i) * 600_000,
      mid_price: 0.50, volume_24h: 10000,
    }));
    const history = fakeHistory({ marketSnaps: { c1: snaps } });
    const strat = new MomentumStrategy();
    assert.equal(strat.detect({ markets: mkMarkets("c1"), history, now }).length, 0);
  });

  it("rejects low-volume markets", () => {
    const now = Date.now();
    const snaps = Array.from({ length: 5 }, (_, i) => ({
      condition_id: "c1", token_id: "tokA",
      timestamp: now - (4 - i) * 600_000,
      mid_price: 0.40 + i * 0.05, volume_24h: 100,
    }));
    const history = fakeHistory({ marketSnaps: { c1: snaps } });
    const strat = new MomentumStrategy({ minVolume24h: 5000 });
    assert.equal(strat.detect({ markets: mkMarkets("c1"), history, now }).length, 0);
  });
});

// ── Mean Reversion ───────────────────────────────────────────────────────────
describe("MeanRevStrategy", () => {
  it("emits NO when current price is >2σ above mean", () => {
    const now = Date.now();
    const snaps = [];
    for (let i = 0; i < 30; i++) {
      snaps.push({
        condition_id: "c1", token_id: "tokA",
        timestamp: now - (29 - i) * 3600_000,
        mid_price: 0.50 + (Math.sin(i) * 0.01),
      });
    }
    // Spike final price way above
    snaps[snaps.length - 1].mid_price = 0.75;
    const history = fakeHistory({ marketSnaps: { c1: snaps } });
    const strat = new MeanRevStrategy({ lookbackDays: 7, zScoreThreshold: 2.0, minSamples: 20 });
    const signals = strat.detect({ markets: mkMarkets("c1"), history, now });
    assert.equal(signals.length, 1);
    assert.equal(signals[0].direction, "NO");
    assert.ok(signals[0].zScore > 2);
  });

  it("no signal when within threshold", () => {
    const now = Date.now();
    const snaps = Array.from({ length: 30 }, (_, i) => ({
      condition_id: "c1", token_id: "tokA",
      timestamp: now - (29 - i) * 3600_000,
      mid_price: 0.50 + Math.sin(i) * 0.01,
    }));
    const history = fakeHistory({ marketSnaps: { c1: snaps } });
    const strat = new MeanRevStrategy({ minSamples: 20, zScoreThreshold: 3.0 });
    assert.equal(strat.detect({ markets: mkMarkets("c1"), history, now }).length, 0);
  });
});

// ── Arbitrage ────────────────────────────────────────────────────────────────
describe("ArbitrageStrategy", () => {
  it("emits signal when YES bid + NO bid sum < 1 - edge", () => {
    const now = Date.now();
    const history = fakeHistory({
      marketSnaps: { c1: [
        { condition_id: "c1", token_id: "tokA", timestamp: now - 1000, best_bid: 0.45 },
        { condition_id: "c1", token_id: "tokB", timestamp: now - 500,  best_bid: 0.50 },
      ]},
    });
    const strat = new ArbitrageStrategy({ minEdgePct: 1.5 });
    const signals = strat.detect({ markets: mkMarkets("c1", ["tokA", "tokB"]), history, now });
    assert.equal(signals.length, 1);
    assert.ok(signals[0].edgePct >= 1.5);
  });

  it("no signal when bids sum ~1", () => {
    const now = Date.now();
    const history = fakeHistory({
      marketSnaps: { c1: [
        { condition_id: "c1", token_id: "tokA", timestamp: now, best_bid: 0.50 },
        { condition_id: "c1", token_id: "tokB", timestamp: now, best_bid: 0.49 },
      ]},
    });
    const strat = new ArbitrageStrategy({ minEdgePct: 1.5 });
    assert.equal(strat.detect({ markets: mkMarkets("c1", ["tokA", "tokB"]), history, now }).length, 0);
  });
});

// ── StrategyEngine ───────────────────────────────────────────────────────────
describe("StrategyEngine", () => {
  it("registers default strategies and enforces enabled flag", () => {
    const eng = new StrategyEngine({
      consensus: { enabled: false },
      momentum:  { enabled: false },
      meanrev:   { enabled: false },
      arbitrage: { enabled: false },
    });
    const signals = eng.detectAll({
      wallets: [], markets: [], history: fakeHistory(),
    });
    assert.equal(signals.length, 0);
  });

  it("tags signals with strategy name", () => {
    const now = Date.now();
    const history = fakeHistory({
      marketSnaps: { c1: [
        { condition_id: "c1", token_id: "tokA", timestamp: now, best_bid: 0.40 },
        { condition_id: "c1", token_id: "tokB", timestamp: now, best_bid: 0.40 },
      ]},
    });
    const eng = new StrategyEngine({
      consensus: { enabled: false },
      momentum:  { enabled: false },
      meanrev:   { enabled: false },
      arbitrage: { enabled: true, minEdgePct: 1.5 },
    });
    const sigs = eng.detectAll({
      wallets: [], markets: mkMarkets("c1", ["tokA", "tokB"]), history, now,
    });
    assert.ok(sigs.length >= 1);
    assert.equal(sigs[0].strategy, "arbitrage");
  });

  it("tracks traded flags independently per strategy", () => {
    const eng = new StrategyEngine();
    eng.markTraded("momentum", "c1", "YES");
    assert.ok(eng.isTraded("momentum", "c1", "YES"));
    assert.ok(!eng.isTraded("meanrev", "c1", "YES"));
    eng.unmarkTraded("momentum", "c1", "YES");
    assert.ok(!eng.isTraded("momentum", "c1", "YES"));
  });
});
