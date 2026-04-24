import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SignalStore } from "../src/signals.js";

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
  return { title: question, markets: [{ conditionId, question }] };
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
    const store = new SignalStore();
    const wallets = [
      wallet("0x1", [pos("CID-A", "Yes")]),
      wallet("0x2", [pos("CID-A", "Yes")]),
    ];
    assert.equal(store.detect(wallets, [market("CID-A")]).length, 0);
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
