import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AntiDegenStrategy } from "../../src/strategies/antidegen.js";

const RECENT_MS = Date.now() - 3600 * 1000;

function w(addr, tier, positions, { score = 60, roi = -50 } = {}) {
  return { addr, tier, score, roi, positions, updatedAt: RECENT_MS };
}
function pos(cid, outcome, currentValue = 500, avgPrice = 0.30) {
  return { conditionId: cid, outcome, currentValue, avgPrice };
}
function event(cid, yesPrice, question = "Will X?", endDate = null) {
  return {
    title: question,
    markets: [{
      conditionId: cid, question,
      outcomes: ["Yes", "No"],
      outcomePrices: [yesPrice, 1 - yesPrice],
      lastTradePrice: yesPrice,
      ...(endDate ? { endDate } : {}),
    }],
  };
}

describe("antidegen — fade detection", () => {
  it("1 DEGEN buys YES, 0 ELITE → fade signal NO", () => {
    const s = new AntiDegenStrategy({ minWallets: 1 });
    const wallets = [w("0xd1", "DEGEN", [pos("C1", "Yes", 500, 0.30)])];
    const sigs = s.detect({ wallets, markets: [event("C1", 0.32)] });
    assert.equal(sigs.length, 1);
    assert.equal(sigs[0].direction, "NO");
    assert.equal(sigs[0].fade, true);
    assert.equal(sigs[0].walletCount, 1);
    assert.equal(sigs[0].fadeOf.originalDirection, "YES");
    assert.deepEqual(sigs[0].fadeOf.degenAddrs, ["0xd1"]);
  });

  it("1 DEGEN buys NO → fade signal YES", () => {
    const s = new AntiDegenStrategy({ minWallets: 1 });
    const wallets = [w("0xd1", "DEGEN", [pos("C1", "No", 500, 0.30)])];
    const sigs = s.detect({ wallets, markets: [event("C1", 0.68)] });
    assert.equal(sigs.length, 1);
    assert.equal(sigs[0].direction, "YES");
    assert.equal(sigs[0].fadeOf.originalDirection, "NO");
  });

  it("1 DEGEN YES, 1 ELITE YES → skipped (ELITE-aligned)", () => {
    const s = new AntiDegenStrategy({ minWallets: 1 });
    const wallets = [
      w("0xd1", "DEGEN", [pos("C1", "Yes", 500, 0.30)]),
      w("0xe1", "ELITE", [pos("C1", "Yes", 800, 0.28)], { score: 85, roi: 50 }),
    ];
    const sigs = s.detect({ wallets, markets: [event("C1", 0.32)] });
    assert.equal(sigs.length, 0);
    assert.equal(s.lastSkippedByEliteAligned.length, 1);
    assert.equal(s.lastSkippedByEliteAligned[0].eliteCount, 1);
  });

  it("1 DEGEN YES, 1 ELITE NO → fade signal NO (opposite ELITE OK)", () => {
    const s = new AntiDegenStrategy({ minWallets: 1 });
    const wallets = [
      w("0xd1", "DEGEN", [pos("C1", "Yes", 500, 0.30)]),
      w("0xe1", "ELITE", [pos("C1", "No",  800, 0.65)], { score: 85, roi: 50 }),
    ];
    const sigs = s.detect({ wallets, markets: [event("C1", 0.32)] });
    assert.equal(sigs.length, 1);
    assert.equal(sigs[0].direction, "NO");
  });

  it("DEGEN entry 0.30, current 0.45 → fadeDrift 0.15 > 0.10 → skipped", () => {
    const s = new AntiDegenStrategy({ minWallets: 1 });
    const wallets = [w("0xd1", "DEGEN", [pos("C1", "Yes", 500, 0.30)])];
    const sigs = s.detect({ wallets, markets: [event("C1", 0.45)] });
    assert.equal(sigs.length, 0);
    assert.equal(s.lastSkippedByEdge.length, 1);
    assert.equal(s.lastSkippedByEdge[0].reason, "drift-exceeded");
  });

  it("DEGEN entry 0.30, current 0.20 → fade fresh (no drift skip)", () => {
    // Market moved AGAINST DEGEN — fade is even better positioned
    const s = new AntiDegenStrategy({ minWallets: 1 });
    const wallets = [w("0xd1", "DEGEN", [pos("C1", "Yes", 500, 0.30)])];
    const sigs = s.detect({ wallets, markets: [event("C1", 0.20)] });
    assert.equal(sigs.length, 1);
  });

  it("0 DEGEN wallets → no signals", () => {
    const s = new AntiDegenStrategy({ minWallets: 1 });
    const wallets = [
      w("0xe1", "ELITE", [pos("C1", "Yes")], { score: 85, roi: 50 }),
      w("0xb1", "BASIC", [pos("C1", "Yes")], { roi: -5 }),
    ];
    const sigs = s.detect({ wallets, markets: [event("C1", 0.32)] });
    assert.equal(sigs.length, 0);
  });

  it("PRO wallet alone (no DEGEN) → no signals", () => {
    const s = new AntiDegenStrategy({ minWallets: 1 });
    const wallets = [w("0xp1", "PRO", [pos("C1", "Yes", 500, 0.30)], { roi: 5 })];
    const sigs = s.detect({ wallets, markets: [event("C1", 0.32)] });
    assert.equal(sigs.length, 0);
  });

  it("size below minPositionSize → skipped", () => {
    const s = new AntiDegenStrategy({ minWallets: 1 });
    // minPositionSize default = 50; pass $20 dust
    const wallets = [w("0xd1", "DEGEN", [pos("C1", "Yes", 20, 0.30)])];
    const sigs = s.detect({ wallets, markets: [event("C1", 0.32)] });
    assert.equal(sigs.length, 0);
  });

  it("dryRun flag is true by default", () => {
    const s = new AntiDegenStrategy();
    assert.equal(s.config.dryRun, true);
  });

  it("strength reflects DEGEN loss magnitude", () => {
    const sShallow = new AntiDegenStrategy({ minWallets: 1 });
    const wShallow = [w("0xd1", "DEGEN", [pos("C1", "Yes", 500, 0.30)], { roi: -25 })];
    const aShallow = sShallow.detect({ wallets: wShallow, markets: [event("C1", 0.32)] });

    const sDeep = new AntiDegenStrategy({ minWallets: 1 });
    const wDeep = [w("0xd1", "DEGEN", [pos("C1", "Yes", 500, 0.30)], { roi: -75 })];
    const aDeep = sDeep.detect({ wallets: wDeep, markets: [event("C1", 0.32)] });

    assert.ok(aDeep[0].strength > aShallow[0].strength,
      `deeper-loss DEGEN should yield higher strength (${aShallow[0].strength} vs ${aDeep[0].strength})`);
  });

  it("regression: lossFactor actually contributes to strength (PR #41)", () => {
    // Pre-fix: antidegen.js read w.totalROI, which doesn't exist on the
    // wallet object (server.js loadWallet maps it to w.roi). lossFactor
    // was always 0 so strength capped at sizeFactor*0.25 + countBonus*0.10
    // ≈ 28 even for max-loss DEGENs. Production: 225 dryRun rows all
    // strength<30. Asserting a -50% ROI / $500 position cleanly clears
    // 30 proves the formula's loss term is wired up.
    const s = new AntiDegenStrategy({ minWallets: 1 });
    const wallets = [w("0xd1", "DEGEN", [pos("C1", "Yes", 500, 0.30)], { roi: -50 })];
    const sigs = s.detect({ wallets, markets: [event("C1", 0.32)] });
    // -50% ROI → lossFactor=50, contributes 50*0.65=32.5 by itself.
    // size $500 / cap $5000 → sizeFactor=10, contributes 2.5.
    // countBonus 30 contributes 3.
    // Expected ≈ 38, comfortably > 30.
    assert.ok(sigs[0].strength >= 30,
      `lossFactor must contribute — got strength=${sigs[0].strength}`);
  });

  it("lifecycle: NEW → CONFIRMED on second scan", () => {
    const s = new AntiDegenStrategy({ minWallets: 1 });
    const wallets = [w("0xd1", "DEGEN", [pos("C1", "Yes", 500, 0.30)])];
    const sigs1 = s.detect({ wallets, markets: [event("C1", 0.32)] });
    assert.equal(sigs1[0].status, "NEW");
    const sigs2 = s.detect({ wallets, markets: [event("C1", 0.32)] });
    assert.equal(sigs2[0].status, "CONFIRMED");
  });

  it("requireNoEliteAligned=false disables the ELITE-aligned gate", () => {
    const s = new AntiDegenStrategy({ requireNoEliteAligned: false, minWallets: 1 });
    const wallets = [
      w("0xd1", "DEGEN", [pos("C1", "Yes", 500, 0.30)]),
      w("0xe1", "ELITE", [pos("C1", "Yes", 800, 0.28)], { score: 85, roi: 50 }),
    ];
    const sigs = s.detect({ wallets, markets: [event("C1", 0.32)] });
    assert.equal(sigs.length, 1);
  });
});

// ── 2026-05-12 sample-quality patch ────────────────────────────────────────
// First $30 of live trades closed -$19 (5L/1W) on 6 same-evening European
// football fades. Two changes to reduce noise:
//   1. minWallets default 1 → 2  (require ≥ 2 DEGENs agreeing on (cid, dir))
//   2. maxSignalsPerResolveDay cluster filter (default 1)
describe("antidegen — sample-quality gates (2026-05-12)", () => {
  it("minWallets defaults to 2: single DEGEN → no signal", () => {
    const s = new AntiDegenStrategy();  // bare defaults
    assert.equal(s.config.minWallets, 2, "default minWallets must be 2");
    const wallets = [w("0xd1", "DEGEN", [pos("C1", "Yes", 500, 0.30)])];
    const sigs = s.detect({ wallets, markets: [event("C1", 0.32)] });
    assert.equal(sigs.length, 0);
  });

  it("2 DEGENs on same (cid, dir) → fade signal emitted", () => {
    const s = new AntiDegenStrategy();  // bare defaults
    const wallets = [
      w("0xd1", "DEGEN", [pos("C1", "Yes", 500, 0.30)]),
      w("0xd2", "DEGEN", [pos("C1", "Yes", 700, 0.31)]),
    ];
    const sigs = s.detect({ wallets, markets: [event("C1", 0.32)] });
    assert.equal(sigs.length, 1);
    assert.equal(sigs[0].walletCount, 2);
    assert.equal(sigs[0].direction, "NO");
  });

  it("2 DEGENs on different directions → no signal (no quorum either side)", () => {
    const s = new AntiDegenStrategy();
    const wallets = [
      w("0xd1", "DEGEN", [pos("C1", "Yes", 500, 0.30)]),
      w("0xd2", "DEGEN", [pos("C1", "No",  500, 0.65)]),
    ];
    const sigs = s.detect({ wallets, markets: [event("C1", 0.32)] });
    assert.equal(sigs.length, 0);
  });

  it("cluster filter: same resolve day → only strongest survives", () => {
    // Simulate the 2026-05-11 evening EPL scenario: 3 fade signals all
    // resolving the same UTC day. minWallets:1 here so we focus the test
    // on the cluster filter, not the wallet-count gate.
    const s = new AntiDegenStrategy({ minWallets: 1 });
    const endDate = "2026-05-11T22:00:00Z";
    const wallets = [
      w("0xd1", "DEGEN", [pos("C1", "Yes", 500, 0.30)], { roi: -80 }), // strongest
      w("0xd2", "DEGEN", [pos("C2", "Yes", 500, 0.30)], { roi: -40 }), // mid
      w("0xd3", "DEGEN", [pos("C3", "Yes", 500, 0.30)], { roi: -20 }), // weakest
    ];
    const markets = [
      event("C1", 0.32, "EPL match A", endDate),
      event("C2", 0.32, "EPL match B", endDate),
      event("C3", 0.32, "EPL match C", endDate),
    ];
    const sigs = s.detect({ wallets, markets });
    assert.equal(sigs.length, 1, "only 1 signal per resolve day with default cap=1");
    assert.equal(sigs[0].conditionId, "C1", "strongest (deepest-loss DEGEN) wins");
    assert.equal(s.lastClusterFiltered.length, 2, "two demoted entries logged");
  });

  it("cluster filter: signals on DIFFERENT resolve days both survive", () => {
    const s = new AntiDegenStrategy({ minWallets: 1 });
    const wallets = [
      w("0xd1", "DEGEN", [pos("C1", "Yes", 500, 0.30)]),
      w("0xd2", "DEGEN", [pos("C2", "Yes", 500, 0.30)]),
    ];
    const markets = [
      event("C1", 0.32, "Today", "2026-05-11T22:00:00Z"),
      event("C2", 0.32, "Next week", "2026-05-18T22:00:00Z"),
    ];
    const sigs = s.detect({ wallets, markets });
    assert.equal(sigs.length, 2);
  });

  it("cluster filter disabled (maxSignalsPerResolveDay=0) → all survive", () => {
    const s = new AntiDegenStrategy({ minWallets: 1, maxSignalsPerResolveDay: 0 });
    const endDate = "2026-05-11T22:00:00Z";
    const wallets = [
      w("0xd1", "DEGEN", [pos("C1", "Yes", 500, 0.30)]),
      w("0xd2", "DEGEN", [pos("C2", "Yes", 500, 0.30)]),
      w("0xd3", "DEGEN", [pos("C3", "Yes", 500, 0.30)]),
    ];
    const markets = [
      event("C1", 0.32, "EPL match A", endDate),
      event("C2", 0.32, "EPL match B", endDate),
      event("C3", 0.32, "EPL match C", endDate),
    ];
    const sigs = s.detect({ wallets, markets });
    assert.equal(sigs.length, 3);
  });

  it("cluster filter is a no-op when markets lack endDate", () => {
    // Defensive: gamma response missing endDate (some markets) should not
    // crash or drop signals.
    const s = new AntiDegenStrategy({ minWallets: 1 });
    const wallets = [
      w("0xd1", "DEGEN", [pos("C1", "Yes", 500, 0.30)]),
      w("0xd2", "DEGEN", [pos("C2", "Yes", 500, 0.30)]),
    ];
    const sigs = s.detect({
      wallets,
      markets: [event("C1", 0.32), event("C2", 0.32)],   // no endDate
    });
    assert.equal(sigs.length, 2);
  });
});

// ── 2026-05-21 lottery-ticket gate ──────────────────────────────────────────
// New trades 7-10 (post 2-decimal fix) were World Cup favorite fades: DEGEN
// bought a cheap long-shot YES @ ~0.09, we faded NO @ ~0.91 — tiny upside,
// full downside, near-zero edge. maxFadeEntryPrice (default 0.85) skips them.
describe("antidegen — lottery-ticket gate (maxFadeEntryPrice)", () => {
  it("skips fade when entry price > maxFadeEntryPrice", () => {
    // DEGEN buys YES @ 0.08 (long-shot). currentPrice(YES)=0.08 →
    // fade NO entry = 1 - 0.08 = 0.92 > 0.85 default → skip.
    const s = new AntiDegenStrategy({ minWallets: 1 });
    const wallets = [w("0xd1", "DEGEN", [pos("C1", "Yes", 500, 0.08)])];
    const sigs = s.detect({ wallets, markets: [event("C1", 0.08)] });
    assert.equal(sigs.length, 0);
    assert.equal(s.lastSkippedByFadePrice.length, 1);
    assert.ok(s.lastSkippedByFadePrice[0].fadeEntryPrice > 0.85);
  });

  it("allows fade when entry price <= maxFadeEntryPrice", () => {
    // DEGEN buys YES @ 0.30. fade NO entry = 0.70 <= 0.85 → allowed.
    const s = new AntiDegenStrategy({ minWallets: 1 });
    const wallets = [w("0xd1", "DEGEN", [pos("C1", "Yes", 500, 0.30)])];
    const sigs = s.detect({ wallets, markets: [event("C1", 0.30)] });
    assert.equal(sigs.length, 1);
    assert.equal(sigs[0].direction, "NO");
  });

  it("maxFadeEntryPrice=0 disables the gate (allows high-price fade)", () => {
    const s = new AntiDegenStrategy({ minWallets: 1, maxFadeEntryPrice: 0 });
    const wallets = [w("0xd1", "DEGEN", [pos("C1", "Yes", 500, 0.08)])];
    const sigs = s.detect({ wallets, markets: [event("C1", 0.08)] });
    assert.equal(sigs.length, 1);
  });

  it("boundary: fade entry exactly at threshold is allowed", () => {
    // DEGEN YES @ 0.15 → fade NO entry = 0.85, NOT > 0.85 → allowed.
    const s = new AntiDegenStrategy({ minWallets: 1, maxFadeEntryPrice: 0.85 });
    const wallets = [w("0xd1", "DEGEN", [pos("C1", "Yes", 500, 0.15)])];
    const sigs = s.detect({ wallets, markets: [event("C1", 0.15)] });
    assert.equal(sigs.length, 1);
  });
});
