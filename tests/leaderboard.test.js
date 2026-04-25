import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { extractBuildId, parseLeaderboardJson } from "../src/polymarket-api.js";
import { filterCandidates } from "../scripts/import-leaderboard.js";

describe("extractBuildId", () => {
  it("pulls the buildId out of Next.js HTML", () => {
    const html = `<!doctype html>...<script>{"buildId":"build-AbCd_1234","other":"x"}</script>...`;
    assert.equal(extractBuildId(html), "build-AbCd_1234");
  });

  it("returns null when no buildId appears", () => {
    assert.equal(extractBuildId("<html>nothing here</html>"), null);
    assert.equal(extractBuildId(""), null);
    assert.equal(extractBuildId(null), null);
    assert.equal(extractBuildId(undefined), null);
  });

  it("ignores buildIds that don't match the build- prefix", () => {
    const html = `"buildId":"prod-1234"`;
    assert.equal(extractBuildId(html), null);
  });
});

describe("parseLeaderboardJson", () => {
  it("normalises a real-shape payload", () => {
    const payload = {
      pageProps: {
        dehydratedState: {
          queries: [{
            state: {
              data: [
                {
                  rank: 1,
                  proxyWallet: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
                  amount: 142_495_323,
                  pnl: 3_502_213,
                  volume: 142_495_323,
                  pseudonym: "shadowtrader",
                },
                {
                  rank: 2,
                  proxyWallet: "0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
                  amount: 119_607_599,
                  pnl: 21_366,
                  volume: 119_607_599,
                  name: "tripping",
                },
              ],
            },
          }],
        },
      },
    };
    const rows = parseLeaderboardJson(payload);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[0], {
      rank: 1,
      proxyWallet: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      pnl: 3_502_213,
      volume: 142_495_323,
      pseudonym: "shadowtrader",
    });
    assert.equal(rows[1].proxyWallet, "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    assert.equal(rows[1].pseudonym, "tripping",
                 "falls back to `name` when pseudonym missing");
  });

  it("falls back to `address` field when proxyWallet is missing", () => {
    const payload = {
      pageProps: { dehydratedState: { queries: [{
        state: { data: [{ rank: 1, address: "0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC", pnl: 100, volume: 1000 }] },
      }]}},
    };
    const rows = parseLeaderboardJson(payload);
    assert.equal(rows[0].proxyWallet, "0xcccccccccccccccccccccccccccccccccccccccc");
  });

  it("filters out malformed addresses", () => {
    const payload = {
      pageProps: { dehydratedState: { queries: [{
        state: { data: [
          { rank: 1, proxyWallet: "0x123",  pnl: 1, volume: 1 },           // too short
          { rank: 2, proxyWallet: "garbage", pnl: 1, volume: 1 },
          { rank: 3, proxyWallet: "0x" + "f".repeat(40), pnl: 1, volume: 1 }, // ok
        ] },
      }]}},
    };
    const rows = parseLeaderboardJson(payload);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].proxyWallet, "0xffffffffffffffffffffffffffffffffffffffff");
  });

  it("returns [] for unexpected shapes", () => {
    assert.deepEqual(parseLeaderboardJson({}), []);
    assert.deepEqual(parseLeaderboardJson({ pageProps: {} }), []);
    assert.deepEqual(parseLeaderboardJson({ pageProps: { dehydratedState: { queries: [] } } }), []);
    assert.deepEqual(parseLeaderboardJson(null), []);
  });

  it("coerces missing volume to 0 (avoids divide-by-zero downstream)", () => {
    const payload = {
      pageProps: { dehydratedState: { queries: [{
        state: { data: [{ rank: 1, proxyWallet: "0x" + "a".repeat(40), pnl: 100 }] },
      }]}},
    };
    const rows = parseLeaderboardJson(payload);
    assert.equal(rows[0].volume, 0);
  });
});

describe("filterCandidates (import-leaderboard)", () => {
  function row({ pnl, volume, addr = "0x" + "a".repeat(40), name = "x" }) {
    return {
      rank: 1, proxyWallet: addr, pnl, volume, pseudonym: name,
      roi: volume > 0 ? pnl / volume : 0,
      window: "alltime",
    };
  }

  it("keeps rows above both thresholds", () => {
    const rows = [
      row({ pnl: 100_000, volume: 2_000_000, addr: "0x" + "a".repeat(40) }),  // 5% ROI
      row({ pnl: 200_000, volume: 4_000_000, addr: "0x" + "b".repeat(40) }),  // 5% ROI
    ];
    const out = filterCandidates(rows, { minPnl: 50_000, minRoi: 0.02, top: 10 });
    assert.equal(out.length, 2);
  });

  it("excludes market makers (high vol, low ROI)", () => {
    const rows = [
      row({ pnl: 21_000, volume: 119_000_000, addr: "0x" + "1".repeat(40), name: "tripping" }), // 0.018% ROI
      row({ pnl: 1_900_000, volume: 78_000_000, addr: "0x" + "2".repeat(40), name: "swisstony" }), // 2.4% ROI
    ];
    const out = filterCandidates(rows, { minPnl: 50_000, minRoi: 0.02, top: 10 });
    assert.equal(out.length, 1);
    assert.equal(out[0].pseudonym, "swisstony");
  });

  it("excludes small fish (high ROI, tiny PnL)", () => {
    const rows = [
      row({ pnl: 1_000, volume: 5_000, addr: "0x" + "1".repeat(40) }),    // 20% ROI but tiny
      row({ pnl: 60_000, volume: 1_000_000, addr: "0x" + "2".repeat(40) }), // 6% ROI
    ];
    const out = filterCandidates(rows, { minPnl: 50_000, minRoi: 0.02, top: 10 });
    assert.equal(out.length, 1);
    assert.equal(out[0].pnl, 60_000);
  });

  it("sorts by ROI descending and applies top cap", () => {
    const rows = [
      row({ pnl: 100_000, volume: 5_000_000, addr: "0x" + "1".repeat(40) }), // 2.0%
      row({ pnl: 100_000, volume: 1_000_000, addr: "0x" + "2".repeat(40) }), // 10%
      row({ pnl: 100_000, volume: 2_000_000, addr: "0x" + "3".repeat(40) }), // 5%
    ];
    const out = filterCandidates(rows, { minPnl: 50_000, minRoi: 0.02, top: 2 });
    assert.equal(out.length, 2);
    assert.equal(out[0].volume, 1_000_000, "highest ROI first");
    assert.equal(out[1].volume, 2_000_000);
  });
});

// ── PR B — leaderboard-poller pure helpers ──────────────────────────────────

import { mergeRows, dedupeAgainstKnown } from "../src/leaderboard-poller.js";

describe("mergeRows", () => {
  function row({ addr, pnl, volume, name = "x", rank = 1 }) {
    return { rank, proxyWallet: addr, pnl, volume, pseudonym: name };
  }

  it("keeps the highest-ROI observation when a wallet appears in multiple windows", () => {
    const A = "0x" + "a".repeat(40);
    const merged = mergeRows({
      alltime: [row({ addr: A, pnl: 1_000_000, volume: 100_000_000 })],   // 1% ROI
      monthly: [row({ addr: A, pnl: 200_000,   volume: 5_000_000 })],     // 4% ROI ← winner
      weekly:  [row({ addr: A, pnl: 50_000,    volume: 5_000_000 })],     // 1% ROI
    });
    assert.equal(merged.length, 1);
    assert.equal(merged[0].window, "monthly");
    assert.ok(Math.abs(merged[0].roi - 0.04) < 1e-9);
  });

  it("dedups but keeps distinct wallets", () => {
    const A = "0x" + "a".repeat(40);
    const B = "0x" + "b".repeat(40);
    const merged = mergeRows({
      alltime: [row({ addr: A, pnl: 100_000, volume: 1_000_000 })],
      monthly: [row({ addr: B, pnl: 200_000, volume: 1_000_000 })],
    });
    assert.equal(merged.length, 2);
  });

  it("treats zero-volume rows as 0 ROI without throwing", () => {
    const merged = mergeRows({
      alltime: [row({ addr: "0x" + "c".repeat(40), pnl: 1, volume: 0 })],
    });
    assert.equal(merged.length, 1);
    assert.equal(merged[0].roi, 0);
  });

  it("returns [] for empty input", () => {
    assert.deepEqual(mergeRows({}), []);
  });
});

describe("dedupeAgainstKnown", () => {
  it("filters out addresses that exist in the excluded set", () => {
    const A = "0x" + "a".repeat(40);
    const B = "0x" + "b".repeat(40);
    const C = "0x" + "c".repeat(40);
    const out = dedupeAgainstKnown(
      [
        { proxyWallet: A, pnl: 1, volume: 1, roi: 1 },
        { proxyWallet: B, pnl: 1, volume: 1, roi: 1 },
        { proxyWallet: C, pnl: 1, volume: 1, roi: 1 },
      ],
      new Set([A, C]),
    );
    assert.equal(out.length, 1);
    assert.equal(out[0].proxyWallet, B);
  });

  it("returns the input unchanged when the excluded set is empty", () => {
    const rows = [{ proxyWallet: "0x" + "a".repeat(40) }];
    assert.deepEqual(dedupeAgainstKnown(rows, new Set()), rows);
  });
});
