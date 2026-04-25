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
  // Helpers — every snap must carry a tight ask now or it gets rejected as
  // "no real liquidity". askFor wraps a bid into a realistic snapshot.
  const liquid = (token_id, bid, ts) => ({
    condition_id: "c1",
    token_id,
    timestamp: ts,
    best_bid: bid,
    best_ask: bid + 0.02,         // 2¢ spread = real orderbook
  });

  it("emits signal when YES bid + NO bid sum < 1 - edge", () => {
    const now = Date.now();
    const history = fakeHistory({
      marketSnaps: { c1: [
        liquid("tokA", 0.45, now - 1000),
        liquid("tokB", 0.50, now - 500),
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
        liquid("tokA", 0.50, now),
        liquid("tokB", 0.49, now),
      ]},
    });
    const strat = new ArbitrageStrategy({ minEdgePct: 1.5 });
    assert.equal(strat.detect({ markets: mkMarkets("c1", ["tokA", "tokB"]), history, now }).length, 0);
  });

  // ── Placeholder/sentinel rejection (the bug that produced 45 false-
  //    positive strength=100 signals on illiquid long-tail markets) ────────
  it("rejects Polymarket's 0.01/0.99 placeholder (no real orderbook)", () => {
    const now = Date.now();
    const history = fakeHistory({
      marketSnaps: { c1: [
        // Both sides at sentinel pricing — would naively yield edge ≈ 98%
        { condition_id: "c1", token_id: "tokA", timestamp: now,
          best_bid: 0.01, best_ask: 0.99 },
        { condition_id: "c1", token_id: "tokB", timestamp: now,
          best_bid: 0.01, best_ask: 0.99 },
      ]},
    });
    const strat = new ArbitrageStrategy({ minEdgePct: 1.5 });
    assert.equal(strat.detect({ markets: mkMarkets("c1", ["tokA", "tokB"]), history, now }).length, 0);
  });

  it("rejects when only ONE side is illiquid (other leg untradeable)", () => {
    const now = Date.now();
    const history = fakeHistory({
      marketSnaps: { c1: [
        liquid("tokA", 0.45, now),                          // real
        { condition_id: "c1", token_id: "tokB", timestamp: now,
          best_bid: 0.01, best_ask: 0.99 },                 // sentinel
      ]},
    });
    const strat = new ArbitrageStrategy({ minEdgePct: 1.5 });
    assert.equal(strat.detect({ markets: mkMarkets("c1", ["tokA", "tokB"]), history, now }).length, 0);
  });

  it("rejects wide spreads (no real orderbook even if bid > 0.02)", () => {
    const now = Date.now();
    const history = fakeHistory({
      marketSnaps: { c1: [
        // bid 0.10, ask 0.90 — looks like a price but spread = 0.80,
        // nothing tradeable in between.
        { condition_id: "c1", token_id: "tokA", timestamp: now,
          best_bid: 0.10, best_ask: 0.90 },
        { condition_id: "c1", token_id: "tokB", timestamp: now,
          best_bid: 0.10, best_ask: 0.90 },
      ]},
    });
    const strat = new ArbitrageStrategy({ minEdgePct: 1.5 });
    assert.equal(strat.detect({ markets: mkMarkets("c1", ["tokA", "tokB"]), history, now }).length, 0);
  });

  it("rejects missing/null ask (incomplete snapshot)", () => {
    const now = Date.now();
    const history = fakeHistory({
      marketSnaps: { c1: [
        { condition_id: "c1", token_id: "tokA", timestamp: now,
          best_bid: 0.45, best_ask: null },
        { condition_id: "c1", token_id: "tokB", timestamp: now,
          best_bid: 0.50, best_ask: 0.52 },
      ]},
    });
    const strat = new ArbitrageStrategy({ minEdgePct: 1.5 });
    assert.equal(strat.detect({ markets: mkMarkets("c1", ["tokA", "tokB"]), history, now }).length, 0);
  });

  it("hasRealLiquidity unit checks", () => {
    const opts = { minLiquidBid: 0.02, maxSpread: 0.10 };
    const f = ArbitrageStrategy.hasRealLiquidity;
    assert.equal(f({ best_bid: 0.45, best_ask: 0.47 }, opts), true);
    assert.equal(f({ best_bid: 0.01, best_ask: 0.99 }, opts), false);   // sentinel
    assert.equal(f({ best_bid: 0,    best_ask: 0.50 }, opts), false);   // zero bid
    assert.equal(f({ best_bid: 0.45, best_ask: 0.99 }, opts), false);   // ask sentinel
    assert.equal(f({ best_bid: 0.10, best_ask: 0.90 }, opts), false);   // wide spread
    assert.equal(f({ best_bid: null, best_ask: 0.5  }, opts), false);
    assert.equal(f(null, opts), false);
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
        { condition_id: "c1", token_id: "tokA", timestamp: now, best_bid: 0.40, best_ask: 0.42 },
        { condition_id: "c1", token_id: "tokB", timestamp: now, best_bid: 0.40, best_ask: 0.42 },
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

  // ── P0 #3 — cross-strategy conflict guard ─────────────────────────────────
  describe("hasOpposingTrade", () => {
    it("returns null when nothing has been traded", () => {
      const eng = new StrategyEngine();
      assert.equal(eng.hasOpposingTrade("c1", "YES"), null);
    });

    it("returns the opposing trade when a different strategy already went the other way", () => {
      const eng = new StrategyEngine();
      eng.markTraded("momentum", "c1", "YES");
      const opp = eng.hasOpposingTrade("c1", "NO");
      assert.ok(opp);
      assert.equal(opp.strategy,  "momentum");
      assert.equal(opp.direction, "YES");
    });

    it("returns null for same direction (not a conflict — same-direction is handled by isTraded)", () => {
      const eng = new StrategyEngine();
      eng.markTraded("momentum", "c1", "YES");
      assert.equal(eng.hasOpposingTrade("c1", "YES"), null);
    });

    it("returns null for a different market entirely", () => {
      const eng = new StrategyEngine();
      eng.markTraded("momentum", "c1", "YES");
      assert.equal(eng.hasOpposingTrade("c2", "NO"), null);
    });

    it("ignores after unmarkTraded", () => {
      const eng = new StrategyEngine();
      eng.markTraded("momentum", "c1", "YES");
      eng.unmarkTraded("momentum", "c1", "YES");
      assert.equal(eng.hasOpposingTrade("c1", "NO"), null);
    });

    it("works when the prior trade came from a different strategy", () => {
      const eng = new StrategyEngine();
      eng.markTraded("consensus", "c1", "YES");
      const opp = eng.hasOpposingTrade("c1", "NO");
      assert.equal(opp.strategy,  "consensus");
      assert.equal(opp.direction, "YES");
    });
  });

  describe("hasAnyTrade", () => {
    it("matches across strategies and directions", () => {
      const eng = new StrategyEngine();
      assert.equal(eng.hasAnyTrade("c1"), false);
      eng.markTraded("meanrev", "c1", "NO");
      assert.equal(eng.hasAnyTrade("c1"), true);
      assert.equal(eng.hasAnyTrade("c2"), false);
    });
  });
});
