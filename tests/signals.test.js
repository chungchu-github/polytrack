import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SignalStore, analyseEntryEdge } from "../src/signals.js";

const NOW_SEC = Math.floor(Date.now() / 1000);
const RECENT_MS = Date.now() - 3600 * 1000; // within recency window

function wallet(addr, positions, score = 80) {
  return {
    addr, score, tier: "ELITE",
    positions,
    updatedAt: RECENT_MS,
  };
}

function pos(conditionId, outcome, currentValue = 500, avgPrice = 0.5) {
  return { conditionId, outcome, currentValue, avgPrice };
}

function market(conditionId, question = "Will X happen?") {
  // Include synthetic tokens so entry-edge filter can resolve a token_id
  // for each direction. Tests that don't pass a HistoryReader will simply
  // fall through the no-history branch.
  return {
    title: question,
    markets: [{
      conditionId, question,
      tokens: [
        { token_id: `${conditionId}-YES`, outcome: "Yes" },
        { token_id: `${conditionId}-NO`,  outcome: "No"  },
      ],
    }],
  };
}

// Build a market metadata object the way Polymarket /markets returns one.
// PR liquidity-via-lasttradeprice: analyseEntryEdge reads price from
// market.outcomePrices / lastTradePrice rather than snapshot.mid_price.
function marketMeta(yesPrice, conditionId = "CID-X") {
  return {
    conditionId,
    outcomes:      ["Yes", "No"],
    outcomePrices: [yesPrice, 1 - yesPrice],
    lastTradePrice: yesPrice,
  };
}

// Updated detect() helper: consensus reads market metadata directly off the
// markets[].markets[] objects, so tests build a fake event with a single
// market carrying outcomePrices.
function marketWithPrice(conditionId, yesPrice, question = "Will X happen?") {
  return {
    title: question,
    markets: [{
      conditionId, question,
      tokens: [
        { token_id: `${conditionId}-YES`, outcome: "Yes" },
        { token_id: `${conditionId}-NO`,  outcome: "No"  },
      ],
      outcomes:      ["Yes", "No"],
      outcomePrices: [yesPrice, 1 - yesPrice],
      lastTradePrice: yesPrice,
    }],
  };
}

describe("signals — consensus detection", () => {
  it("emits a YES signal when 3+ ELITE wallets align", () => {
    const store = new SignalStore();
    const wallets = [
      wallet("0x1", [pos("CID-A", "Yes")]),
      wallet("0x2", [pos("CID-A", "Yes")]),
      wallet("0x3", [pos("CID-A", "Yes")]),
    ];
    const sigs = store.detect(wallets, [market("CID-A")]);
    assert.equal(sigs.length, 1);
    assert.equal(sigs[0].direction, "YES");
    assert.equal(sigs[0].walletCount, 3);
    assert.equal(sigs[0].status, "NEW");
  });

  it("skips when fewer than minWallets", () => {
    // Pin minWallets=3 explicitly: default is now 2 (V1 accumulation override).
    const store = new SignalStore({ minWallets: 3 });
    const wallets = [
      wallet("0x1", [pos("CID-A", "Yes")]),
      wallet("0x2", [pos("CID-A", "Yes")]),
    ];
    assert.equal(store.detect(wallets, [market("CID-A")]).length, 0);
  });

  it("default minWallets=2 fires on 2 aligned ELITEs (V1 accumulation)", () => {
    const store = new SignalStore();
    const wallets = [
      wallet("0x1", [pos("CID-A", "Yes")]),
      wallet("0x2", [pos("CID-A", "Yes")]),
    ];
    const sigs = store.detect(wallets, [market("CID-A")]);
    assert.equal(sigs.length, 1);
    assert.equal(sigs[0].walletCount, 2);
  });
});

describe("signals — B8 opposing suppression", () => {
  it("suppresses when aligned/opposing ratio < 2:1", () => {
    const store = new SignalStore();
    const wallets = [
      wallet("0x1", [pos("CID-A", "Yes")]),
      wallet("0x2", [pos("CID-A", "Yes")]),
      wallet("0x3", [pos("CID-A", "Yes")]),
      wallet("0x4", [pos("CID-A", "No")]),
      wallet("0x5", [pos("CID-A", "No")]),
    ];
    // ratio 3:2 = 1.5 → suppress
    const sigs = store.detect(wallets, [market("CID-A")]);
    assert.equal(sigs.length, 0);
  });

  it("passes through at 2:1 ratio or better", () => {
    const store = new SignalStore();
    const wallets = [
      wallet("0x1", [pos("CID-A", "Yes")]),
      wallet("0x2", [pos("CID-A", "Yes")]),
      wallet("0x3", [pos("CID-A", "Yes")]),
      wallet("0x4", [pos("CID-A", "Yes")]),
      wallet("0x5", [pos("CID-A", "No")]),
      wallet("0x6", [pos("CID-A", "No")]),
    ];
    // 4:2 = 2.0 (aligned.length / opposing.length < 2 is false, so NOT suppressed)
    const sigs = store.detect(wallets, [market("CID-A")]);
    assert.equal(sigs.length, 1);
    assert.equal(sigs[0].opposingCount, 2);
  });
});

describe("signals — lifecycle", () => {
  it("transitions NEW → CONFIRMED on re-confirmation", () => {
    const store = new SignalStore();
    const wallets = [
      wallet("0x1", [pos("CID-A", "Yes")]),
      wallet("0x2", [pos("CID-A", "Yes")]),
      wallet("0x3", [pos("CID-A", "Yes")]),
    ];
    store.detect(wallets, [market("CID-A")]);
    store.detect(wallets, [market("CID-A")]);
    const sigs = store.getActiveSignals();
    assert.equal(sigs[0].status, "CONFIRMED");
  });

  it("marks STALE after staleAfterScans without confirmation", () => {
    const store = new SignalStore({ staleAfterScans: 2, expireAfterScans: 5 });
    const wallets = [
      wallet("0x1", [pos("CID-A", "Yes")]),
      wallet("0x2", [pos("CID-A", "Yes")]),
      wallet("0x3", [pos("CID-A", "Yes")]),
    ];
    store.detect(wallets, [market("CID-A")]);
    // Re-scan with ELITE wallets present but none matching CID-A so aging runs.
    const noise = [wallet("0x9", [pos("CID-Z", "Yes")])];
    store.detect(noise, [market("CID-A")]);
    store.detect(noise, [market("CID-A")]);
    const sigs = store.getAllSignals();
    assert.equal(sigs[0].status, "STALE");
  });
});

describe("signals — markTraded / unmarkTraded", () => {
  it("tracks traded flag and supports rollback", () => {
    const store = new SignalStore();
    store.detect(
      [
        wallet("0x1", [pos("CID-A", "Yes")]),
        wallet("0x2", [pos("CID-A", "Yes")]),
        wallet("0x3", [pos("CID-A", "Yes")]),
      ],
      [market("CID-A")]
    );
    assert.equal(store.isTraded("CID-A", "YES"), false);
    store.markTraded("CID-A", "YES");
    assert.equal(store.isTraded("CID-A", "YES"), true);
    store.unmarkTraded("CID-A", "YES");
    assert.equal(store.isTraded("CID-A", "YES"), false);
  });
});

describe("signals — filters", () => {
  it("filters out positions below minPositionSize", () => {
    const store = new SignalStore({ minPositionSize: 100 });
    const wallets = [
      wallet("0x1", [pos("CID-A", "Yes", 50)]),   // too small
      wallet("0x2", [pos("CID-A", "Yes", 50)]),
      wallet("0x3", [pos("CID-A", "Yes", 50)]),
    ];
    assert.equal(store.detect(wallets, [market("CID-A")]).length, 0);
  });

  it("ignores non-ELITE wallets", () => {
    const store = new SignalStore();
    const wallets = [
      { addr: "0x1", tier: "PRO",  score: 60, positions: [pos("CID-A", "Yes")], updatedAt: RECENT_MS },
      { addr: "0x2", tier: "PRO",  score: 60, positions: [pos("CID-A", "Yes")], updatedAt: RECENT_MS },
      { addr: "0x3", tier: "PRO",  score: 60, positions: [pos("CID-A", "Yes")], updatedAt: RECENT_MS },
    ];
    assert.equal(store.detect(wallets, [market("CID-A")]).length, 0);
  });
});

// ── Entry-edge filter (audit P1-2) ──────────────────────────────────────────

describe("analyseEntryEdge", () => {
  const aligned = [
    { addr: "0x1", weight: 0.5, avgPrice: 0.40, posValue: 5000 },
    { addr: "0x2", weight: 0.3, avgPrice: 0.50, posValue: 3000 },
  ];
  // Weighted avg: (0.40*0.5 + 0.50*0.3) / 0.8 = 0.4375

  it("passes through when no market metadata is supplied", () => {
    const r = analyseEntryEdge({ aligned, market: null, direction: "YES", maxDrift: 0.15 });
    assert.equal(r.skip, false);
    assert.equal(r.reason, "no-market");
    assert.ok(Math.abs(r.eliteAvgEntry - 0.4375) < 1e-9);
  });

  it("rejects when current price has drifted ABOVE entry by > maxDrift", () => {
    // YES at 0.65 → drift = +0.2125 from 0.4375 entry
    const r = analyseEntryEdge({ aligned, market: marketMeta(0.65), direction: "YES", maxDrift: 0.15 });
    assert.equal(r.skip, true);
    assert.equal(r.reason, "drift-exceeded");
    assert.ok(r.entryEdge > 0.15);
  });

  it("keeps signal when within drift band above entry", () => {
    // YES at 0.50 → drift = +0.0625
    const r = analyseEntryEdge({ aligned, market: marketMeta(0.50), direction: "YES", maxDrift: 0.15 });
    assert.equal(r.skip, false);
    assert.ok(r.entryEdge > 0 && r.entryEdge < 0.15);
  });

  it("keeps signal when current price is BELOW entry (cheaper than ELITE got in)", () => {
    const r = analyseEntryEdge({ aligned, market: marketMeta(0.30), direction: "YES", maxDrift: 0.15 });
    assert.equal(r.skip, false);
    assert.ok(r.entryEdge < 0);
  });

  it("uses NO outcomePrice for NO-direction signals", () => {
    // YES at 0.30 means NO at 0.70 → drift = +0.2625 from 0.4375
    const r = analyseEntryEdge({ aligned, market: marketMeta(0.30), direction: "NO", maxDrift: 0.15 });
    assert.equal(r.skip, true);
    assert.ok(Math.abs(r.currentPrice - 0.70) < 1e-9);
  });

  it("falls back to lastTradePrice when outcomePrices is missing", () => {
    const m = { conditionId: "X", lastTradePrice: 0.55 };   // no outcomePrices
    const r = analyseEntryEdge({ aligned, market: m, direction: "YES", maxDrift: 0.15 });
    assert.equal(r.skip, false);
    assert.equal(r.currentPrice, 0.55);
  });

  it("for NO direction, lastTradePrice fallback flips to 1 - ltp", () => {
    const m = { conditionId: "X", lastTradePrice: 0.30 };
    const r = analyseEntryEdge({ aligned, market: m, direction: "NO", maxDrift: 0.15 });
    assert.equal(r.skip, true);
    assert.ok(Math.abs(r.currentPrice - 0.70) < 1e-9);
  });

  it("passes through when market has no usable price (extremes / null)", () => {
    const r1 = analyseEntryEdge({
      aligned,
      market: { conditionId: "X", outcomePrices: [0.999, 0.001] },   // extreme
      direction: "YES", maxDrift: 0.15,
    });
    assert.equal(r1.skip, false);
    assert.equal(r1.reason, "no-price");

    const r2 = analyseEntryEdge({
      aligned,
      market: { conditionId: "X" },                                  // no fields
      direction: "YES", maxDrift: 0.15,
    });
    assert.equal(r2.skip, false);
    assert.equal(r2.reason, "no-price");
  });

  it("passes through when ELITE positions lack avgPrice (data gap)", () => {
    const noPrice = [{ addr: "0x1", weight: 0.5, avgPrice: null, posValue: 5000 }];
    const r = analyseEntryEdge({ aligned: noPrice, market: marketMeta(0.99), direction: "YES", maxDrift: 0.15 });
    assert.equal(r.skip, false);
    assert.equal(r.reason, "no-entry");
  });
});

describe("signals — entry-edge integration", () => {
  it("filters out signal when current price already pumped past ELITE entry", () => {
    const store = new SignalStore({ maxEntryDrift: 0.15 });
    const wallets = [
      wallet("0x1", [pos("CID-A", "Yes", 5000, 0.40)]),
      wallet("0x2", [pos("CID-A", "Yes", 5000, 0.40)]),
    ];
    // YES at 0.70 — drift = +0.30 > 0.15
    const sigs = store.detect(wallets, [marketWithPrice("CID-A", 0.70)]);
    assert.equal(sigs.length, 0);
    assert.equal(store.lastSkippedByEdge.length, 1);
    assert.equal(store.lastSkippedByEdge[0].reason, "drift-exceeded");
  });

  it("emits signal with edge fields when current price is within drift band", () => {
    const store = new SignalStore({ maxEntryDrift: 0.15 });
    const wallets = [
      wallet("0x1", [pos("CID-A", "Yes", 5000, 0.40)]),
      wallet("0x2", [pos("CID-A", "Yes", 5000, 0.40)]),
    ];
    const sigs = store.detect(wallets, [marketWithPrice("CID-A", 0.50)]);
    assert.equal(sigs.length, 1);
    assert.equal(sigs[0].eliteAvgEntry, 0.40);
    assert.equal(sigs[0].currentPrice, 0.50);
    assert.ok(Math.abs(sigs[0].entryEdge - 0.10) < 1e-9);
    assert.equal(store.lastSkippedByEdge.length, 0);
  });
});
