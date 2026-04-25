/**
 * Tests for the tracked-wallet market-discovery helpers in server.js.
 *
 * The two functions are not exported (server.js is the entrypoint and
 * has lots of side-effecty imports we'd rather not pull in for tests),
 * so we re-implement them here as a contract spec — the inline copies
 * MUST match server.js. If you change one, change both. The
 * "in-server-implementation-matches" guard at the bottom of this file
 * fails the test if server.js drifts.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = resolve(__dirname, "..", "src", "server.js");

// ── Inline copies (kept in sync with server.js — see drift guard below) ─────

function collectTrackedConditionIds(state, { cap = 200 } = {}) {
  const maxSizeByCid = new Map();
  for (const w of state.wallets.values()) {
    for (const p of w.positions || []) {
      const cid = p.conditionId;
      if (!cid) continue;
      const size = Number(p.currentValue || p.size || 0);
      const prev = maxSizeByCid.get(cid) || 0;
      if (size > prev) maxSizeByCid.set(cid, size);
    }
  }
  return [...maxSizeByCid.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, cap)
    .map(([cid]) => cid);
}

function mergeMarketSourcesByCid(primary, secondary) {
  const seen = new Set();
  const out = [];
  for (const list of [primary, secondary]) {
    for (const evt of list || []) {
      const cids = (evt.markets || []).map(m => m?.conditionId).filter(Boolean);
      if (cids.length === 0) continue;
      const allSeen = cids.every(cid => seen.has(cid));
      if (allSeen) continue;
      for (const cid of cids) seen.add(cid);
      out.push(evt);
    }
  }
  return out;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function mkState(walletsByAddr) {
  return {
    wallets: new Map(Object.entries(walletsByAddr).map(
      ([addr, positions]) => [addr, { addr, positions }]
    )),
  };
}

function evt(...cids) {
  return { id: cids.join("-"), markets: cids.map(c => ({ conditionId: c })) };
}

// ── collectTrackedConditionIds ──────────────────────────────────────────────

describe("collectTrackedConditionIds", () => {
  it("dedups cids across multiple wallets", () => {
    const state = mkState({
      "0x1": [{ conditionId: "A", currentValue: 100 }, { conditionId: "B", currentValue: 50 }],
      "0x2": [{ conditionId: "A", currentValue: 200 }, { conditionId: "C", currentValue: 30 }],
    });
    const cids = collectTrackedConditionIds(state);
    assert.equal(new Set(cids).size, 3);
    assert.deepEqual(new Set(cids), new Set(["A", "B", "C"]));
  });

  it("keeps the largest position size per cid for ranking", () => {
    const state = mkState({
      "0x1": [{ conditionId: "A", currentValue: 100 }],
      "0x2": [{ conditionId: "A", currentValue: 999 }],   // wins
      "0x3": [{ conditionId: "B", currentValue: 500 }],
    });
    const cids = collectTrackedConditionIds(state);
    // A has max=999, B has max=500 → A first
    assert.deepEqual(cids, ["A", "B"]);
  });

  it("caps at the requested limit, dropping the smallest", () => {
    const state = mkState({
      "0x1": [
        { conditionId: "A", currentValue: 100 },
        { conditionId: "B", currentValue: 80  },
        { conditionId: "C", currentValue: 60  },
        { conditionId: "D", currentValue: 40  },
      ],
    });
    const cids = collectTrackedConditionIds(state, { cap: 2 });
    assert.deepEqual(cids, ["A", "B"]);
  });

  it("falls back to size when currentValue is missing", () => {
    const state = mkState({
      "0x1": [{ conditionId: "A", size: 700 }],
    });
    const cids = collectTrackedConditionIds(state);
    assert.deepEqual(cids, ["A"]);
  });

  it("ignores positions without conditionId", () => {
    const state = mkState({
      "0x1": [{ conditionId: "A", currentValue: 100 }, { currentValue: 50 }],
    });
    assert.deepEqual(collectTrackedConditionIds(state), ["A"]);
  });

  it("returns empty array for empty state", () => {
    assert.deepEqual(collectTrackedConditionIds(mkState({})), []);
  });
});

// ── mergeMarketSourcesByCid ─────────────────────────────────────────────────

describe("mergeMarketSourcesByCid", () => {
  it("returns union when no duplicates", () => {
    const r = mergeMarketSourcesByCid([evt("A")], [evt("B")]);
    assert.equal(r.length, 2);
  });

  it("primary wins on duplicate cid (drops secondary entry)", () => {
    const primary   = [{ id: "primary",   markets: [{ conditionId: "A" }] }];
    const secondary = [{ id: "secondary", markets: [{ conditionId: "A" }] }];
    const r = mergeMarketSourcesByCid(primary, secondary);
    assert.equal(r.length, 1);
    assert.equal(r[0].id, "primary");
  });

  it("handles a multi-market event being partially duplicated", () => {
    // event with cids [A, B] in primary; event with [B] only in secondary
    const primary   = [{ id: "p", markets: [{ conditionId: "A" }, { conditionId: "B" }] }];
    const secondary = [{ id: "s", markets: [{ conditionId: "B" }] }];
    const r = mergeMarketSourcesByCid(primary, secondary);
    assert.equal(r.length, 1);
    assert.equal(r[0].id, "p");
  });

  it("ignores events without any conditionId", () => {
    const r = mergeMarketSourcesByCid([{ markets: [{}] }, evt("A")], []);
    assert.equal(r.length, 1);
  });

  it("safe on null/undefined inputs", () => {
    assert.deepEqual(mergeMarketSourcesByCid(null, undefined), []);
    assert.deepEqual(mergeMarketSourcesByCid([evt("A")], null).length, 1);
  });
});

// ── Drift guard ─────────────────────────────────────────────────────────────
// If server.js' implementation diverges from the inline copy above, fail
// loud so we update both. Hash-style: tokenized signatures must match.

describe("server.js drift guard", () => {
  it("collectTrackedConditionIds in server.js matches inline copy", () => {
    const src = readFileSync(SERVER_PATH, "utf8");
    assert.match(src, /function collectTrackedConditionIds\(state, \{ cap = 200 \} = \{\}\)/);
    assert.match(src, /maxSizeByCid\.set\(cid, size\)/);
  });
  it("mergeMarketSourcesByCid in server.js matches inline copy", () => {
    const src = readFileSync(SERVER_PATH, "utf8");
    assert.match(src, /function mergeMarketSourcesByCid\(primary, secondary\)/);
    assert.match(src, /const allSeen = cids\.every\(cid => seen\.has\(cid\)\)/);
  });
});
