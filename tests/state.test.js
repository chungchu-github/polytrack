import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sortStaleFirst } from "../src/state.js";

describe("state — sortStaleFirst (scan scheduling)", () => {
  it("returns addresses sorted oldest-rescored first", () => {
    const wallets = new Map([
      ["0xa", { updatedAt: 3000 }],
      ["0xb", { updatedAt: 1000 }],
      ["0xc", { updatedAt: 2000 }],
    ]);
    assert.deepEqual(
      sortStaleFirst(["0xa", "0xb", "0xc"], wallets),
      ["0xb", "0xc", "0xa"],
    );
  });

  it("places wallets missing from the map at the front (treats as updatedAt=0)", () => {
    const wallets = new Map([
      ["0xa", { updatedAt: 1000 }],
    ]);
    // 0xnew is unknown — should land before 0xa
    const out = sortStaleFirst(["0xa", "0xnew"], wallets);
    assert.equal(out[0], "0xnew");
    assert.equal(out[1], "0xa");
  });

  it("does not mutate the input array", () => {
    const input = ["0xa", "0xb", "0xc"];
    const wallets = new Map([
      ["0xa", { updatedAt: 3000 }],
      ["0xb", { updatedAt: 1000 }],
      ["0xc", { updatedAt: 2000 }],
    ]);
    sortStaleFirst(input, wallets);
    assert.deepEqual(input, ["0xa", "0xb", "0xc"], "input array must not be mutated");
  });

  it("regression: 265-wallet pool fully cycles within ceil(N/cap) scans", () => {
    // Reproduces the production starvation case. Build a 265-wallet map
    // where the trailing 215 have stale (12d-old) updatedAt and the lead
    // 50 are fresh — simulating an insertion-order watch list. After
    // sortStaleFirst, the stale tail must move to the front.
    const NOW = Date.now();
    const STALE = NOW - 12 * 86400 * 1000;
    const wallets = new Map();
    const addrs = [];
    for (let i = 0; i < 265; i++) {
      const addr = `0x${String(i).padStart(40, "0")}`;
      addrs.push(addr);
      wallets.set(addr, { updatedAt: i < 50 ? NOW : STALE });
    }
    // Watch list in insertion order (fresh first, stale tail last)
    const sorted = sortStaleFirst(addrs, wallets);
    // First 50 after sort must all be from the stale tail
    const firstBatch = sorted.slice(0, 50);
    for (const addr of firstBatch) {
      assert.equal(wallets.get(addr).updatedAt, STALE,
        `${addr} should be in the stale tail after sort`);
    }
  });
});
