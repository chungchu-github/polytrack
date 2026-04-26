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
  // Real-orderbook bid/ask around the mid (1¢ inside on each side)
  // so isSentinelSnap returns false and the snapshot is kept.
  const realPrice = (mid) => ({ best_bid: mid - 0.01, best_ask: mid + 0.01 });

  it("detects upward monotonic trend exceeding threshold → YES", () => {
    const now = Date.now();
    const snaps = [];
    for (let i = 0; i < 6; i++) {
      const mid = 0.40 + i * 0.03;
      snaps.push({
        condition_id: "c1", token_id: "tokA",
        timestamp: now - (5 - i) * 600_000,
        mid_price: mid, volume_24h: 10000, ...realPrice(mid),
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
      mid_price: 0.50, volume_24h: 10000, ...realPrice(0.50),
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
      mid_price: 0.40 + i * 0.05, volume_24h: 100, ...realPrice(0.40 + i * 0.05),
    }));
    const history = fakeHistory({ marketSnaps: { c1: snaps } });
    const strat = new MomentumStrategy({ minVolume24h: 5000 });
    assert.equal(strat.detect({ markets: mkMarkets("c1"), history, now }).length, 0);
  });

  // ── Sentinel rejection (preventive — see fix/strategies-shared-sentinel) ──
  it("ignores sentinel snapshots: real bid jumping in after sentinels does NOT fire phantom momentum", () => {
    const now = Date.now();
    // 5 sentinel snaps (mid=0.5) then 1 real snap at 0.30. Without the
    // sentinel filter, this would look like a -40% move → strength 100.
    const snaps = [];
    for (let i = 0; i < 5; i++) {
      snaps.push({
        condition_id: "c1", token_id: "tokA",
        timestamp: now - (5 - i) * 600_000,
        mid_price: 0.5, volume_24h: 10000,
        best_bid: 0.01, best_ask: 0.99,   // ← sentinel
      });
    }
    snaps.push({
      condition_id: "c1", token_id: "tokA", timestamp: now,
      mid_price: 0.30, volume_24h: 10000,
      best_bid: 0.29, best_ask: 0.31,     // first real snap
    });
    const history = fakeHistory({ marketSnaps: { c1: snaps } });
    const strat = new MomentumStrategy({ lookbackHours: 4, minPriceMovePct: 8, minVolume24h: 5000 });
    // Only 1 real snap → series.length < 2 → no signal
    assert.equal(strat.detect({ markets: mkMarkets("c1"), history, now }).length, 0);
  });
});

// ── Mean Reversion ───────────────────────────────────────────────────────────
describe("MeanRevStrategy", () => {
  const realPrice = (mid) => ({ best_bid: mid - 0.01, best_ask: mid + 0.01 });

  it("emits NO when current price is >2σ above mean", () => {
    const now = Date.now();
    const snaps = [];
    for (let i = 0; i < 30; i++) {
      const mid = 0.50 + (Math.sin(i) * 0.01);
      snaps.push({
        condition_id: "c1", token_id: "tokA",
        timestamp: now - (29 - i) * 3600_000,
        mid_price: mid, ...realPrice(mid),
      });
    }
    // Spike final price way above
    snaps[snaps.length - 1].mid_price = 0.75;
    Object.assign(snaps[snaps.length - 1], realPrice(0.75));
    const history = fakeHistory({ marketSnaps: { c1: snaps } });
    const strat = new MeanRevStrategy({ lookbackDays: 7, zScoreThreshold: 2.0, minSamples: 20 });
    const signals = strat.detect({ markets: mkMarkets("c1"), history, now });
    assert.equal(signals.length, 1);
    assert.equal(signals[0].direction, "NO");
    assert.ok(signals[0].zScore > 2);
  });

  it("no signal when within threshold", () => {
    const now = Date.now();
    const snaps = Array.from({ length: 30 }, (_, i) => {
      const mid = 0.50 + Math.sin(i) * 0.01;
      return {
        condition_id: "c1", token_id: "tokA",
        timestamp: now - (29 - i) * 3600_000,
        mid_price: mid, ...realPrice(mid),
      };
    });
    const history = fakeHistory({ marketSnaps: { c1: snaps } });
    const strat = new MeanRevStrategy({ minSamples: 20, zScoreThreshold: 3.0 });
    assert.equal(strat.detect({ markets: mkMarkets("c1"), history, now }).length, 0);
  });

  // ── Sentinel rejection ──────────────────────────────────────────────────
  it("rejects when only sentinel snaps exist (no real samples to mean-revert against)", () => {
    const now = Date.now();
    // 25 sentinel snaps with mid_price=0.5. Without the filter these would
    // all pass; std=0 saves us today, but mid + 1 real outlier would yield
    // a giant z-score. Filter drops them upstream so series.length=0 < 20.
    const snaps = Array.from({ length: 25 }, (_, i) => ({
      condition_id: "c1", token_id: "tokA",
      timestamp: now - (24 - i) * 3600_000,
      mid_price: 0.5,
      best_bid: 0.01, best_ask: 0.99,    // sentinel
    }));
    const history = fakeHistory({ marketSnaps: { c1: snaps } });
    const strat = new MeanRevStrategy({ minSamples: 20, zScoreThreshold: 2.0 });
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

// ── filterLiquidMarkets + filterByLastTradePrice ────────────────────────────
import { filterLiquidMarkets, filterByLastTradePrice } from "../src/strategies/util.js";

describe("filterByLastTradePrice", () => {
  // Polymarket-shape market metadata
  const ev = (id, lastTradePrice) => ({
    id,
    markets: [{ conditionId: `c${id}`, lastTradePrice }],
  });

  it("keeps events with lastTradePrice in tradeable range", () => {
    const events = [ev(1, 0.45), ev(2, 0.20), ev(3, 0.85)];
    const r = filterByLastTradePrice(events);
    assert.equal(r.events.length, 3);
    assert.equal(r.stats.dropped, 0);
  });

  it("drops events at extremes (≤ 0.02 / ≥ 0.98)", () => {
    const events = [
      ev(1, 0.001),    // resolved-ish NO
      ev(2, 0.999),    // resolved-ish YES
      ev(3, 0.50),     // tradeable
    ];
    const r = filterByLastTradePrice(events);
    assert.equal(r.events.length, 1);
    assert.equal(r.stats.dropped, 2);
  });

  it("drops events with null/missing lastTradePrice", () => {
    const events = [
      { id: 1, markets: [{ conditionId: "x" }] },             // missing
      { id: 2, markets: [{ conditionId: "y", lastTradePrice: null }] },
      ev(3, 0.50),
    ];
    const r = filterByLastTradePrice(events);
    assert.equal(r.events.length, 1);
  });

  it("respects custom minLastTrade threshold", () => {
    const events = [ev(1, 0.04), ev(2, 0.06)];
    const r = filterByLastTradePrice(events, { minLastTrade: 0.05 });
    assert.equal(r.events.length, 1);
    assert.equal(r.events[0].id, 2);
  });

  it("caps at requested limit", () => {
    const events = Array.from({ length: 10 }, (_, i) => ev(i, 0.50));
    const r = filterByLastTradePrice(events, { cap: 3 });
    assert.equal(r.events.length, 3);
    assert.equal(r.stats.liquid, 10);
  });

  it("multi-market event passes if ANY market is tradeable", () => {
    const e = {
      id: "multi",
      markets: [
        { conditionId: "a", lastTradePrice: 0.001 },   // dead
        { conditionId: "b", lastTradePrice: 0.45  },   // tradeable
      ],
    };
    const r = filterByLastTradePrice([e]);
    assert.equal(r.events.length, 1);
  });
});

describe("filterLiquidMarkets", () => {
  // Helpers — Polymarket API book shape: { bids: [{price,size}], asks: [{price,size}] }
  const liquidBook  = () => ({ bids: [{ price: 0.45, size: 100 }], asks: [{ price: 0.47, size: 100 }] });
  const sentinelBook = () => ({ bids: [{ price: 0.01, size: 100 }], asks: [{ price: 0.99, size: 100 }] });
  const event = (id, tokenSpecs) => ({
    id, slug: `e${id}`, title: `Event ${id}`,
    markets: [{
      conditionId: `c${id}`,
      tokens: tokenSpecs.map(([token_id, _book]) => ({ token_id })),
    }],
  });

  it("keeps events where ≥1 outcome has real liquidity", () => {
    const events = [event(1, [["tA", "real"], ["tB", "sentinel"]])];
    const byToken = new Map([
      ["tA", liquidBook()],
      ["tB", sentinelBook()],
    ]);
    const r = filterLiquidMarkets(events, byToken);
    assert.equal(r.events.length, 1);
    assert.equal(r.stats.fetched, 1);
    assert.equal(r.stats.liquid, 1);
    assert.equal(r.stats.dropped, 0);
  });

  it("drops events where ALL outcomes are sentinel (the production bug case)", () => {
    const events = [event(1, [["tA", "sentinel"], ["tB", "sentinel"]])];
    const byToken = new Map([
      ["tA", sentinelBook()],
      ["tB", sentinelBook()],
    ]);
    const r = filterLiquidMarkets(events, byToken);
    assert.equal(r.events.length, 0);
    assert.equal(r.stats.dropped, 1);
  });

  it("drops events with missing book entries (no orderbook fetched)", () => {
    const events = [event(1, [["tMissing", "?"]])];
    const byToken = new Map();        // empty — fetchOrderBooks returned nothing
    const r = filterLiquidMarkets(events, byToken);
    assert.equal(r.events.length, 0);
    assert.equal(r.stats.dropped, 1);
  });

  it("caps at `cap` even if more liquid events exist", () => {
    const events = Array.from({ length: 10 }, (_, i) => event(i, [[`t${i}`, "real"]]));
    const byToken = new Map(events.map((_, i) => [`t${i}`, liquidBook()]));
    const r = filterLiquidMarkets(events, byToken, { cap: 3 });
    assert.equal(r.events.length, 3);
    assert.equal(r.stats.liquid, 10);
    assert.equal(r.stats.used, 3);
  });

  it("preserves upstream order (first N pass)", () => {
    const events = [event("a", [["tA", "real"]]), event("b", [["tB", "real"]]), event("c", [["tC", "real"]])];
    const byToken = new Map([["tA", liquidBook()], ["tB", liquidBook()], ["tC", liquidBook()]]);
    const r = filterLiquidMarkets(events, byToken, { cap: 2 });
    assert.deepEqual(r.events.map(e => e.id), ["a", "b"]);
  });

  it("handles malformed input safely", () => {
    assert.equal(filterLiquidMarkets(null, new Map()).events.length, 0);
    assert.equal(filterLiquidMarkets([], null).events.length, 0);
    assert.equal(filterLiquidMarkets([{ markets: null }], new Map()).events.length, 0);
  });
});
