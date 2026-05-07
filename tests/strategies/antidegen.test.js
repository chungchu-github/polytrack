import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AntiDegenStrategy } from "../../src/strategies/antidegen.js";

const RECENT_MS = Date.now() - 3600 * 1000;

function w(addr, tier, positions, { score = 60, totalROI = -50 } = {}) {
  return { addr, tier, score, totalROI, positions, updatedAt: RECENT_MS };
}
function pos(cid, outcome, currentValue = 500, avgPrice = 0.30) {
  return { conditionId: cid, outcome, currentValue, avgPrice };
}
function event(cid, yesPrice, question = "Will X?") {
  return {
    title: question,
    markets: [{
      conditionId: cid, question,
      outcomes: ["Yes", "No"],
      outcomePrices: [yesPrice, 1 - yesPrice],
      lastTradePrice: yesPrice,
    }],
  };
}

describe("antidegen — fade detection", () => {
  it("1 DEGEN buys YES, 0 ELITE → fade signal NO", () => {
    const s = new AntiDegenStrategy();
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
    const s = new AntiDegenStrategy();
    const wallets = [w("0xd1", "DEGEN", [pos("C1", "No", 500, 0.30)])];
    const sigs = s.detect({ wallets, markets: [event("C1", 0.68)] });
    assert.equal(sigs.length, 1);
    assert.equal(sigs[0].direction, "YES");
    assert.equal(sigs[0].fadeOf.originalDirection, "NO");
  });

  it("1 DEGEN YES, 1 ELITE YES → skipped (ELITE-aligned)", () => {
    const s = new AntiDegenStrategy();
    const wallets = [
      w("0xd1", "DEGEN", [pos("C1", "Yes", 500, 0.30)]),
      w("0xe1", "ELITE", [pos("C1", "Yes", 800, 0.28)], { score: 85, totalROI: 50 }),
    ];
    const sigs = s.detect({ wallets, markets: [event("C1", 0.32)] });
    assert.equal(sigs.length, 0);
    assert.equal(s.lastSkippedByEliteAligned.length, 1);
    assert.equal(s.lastSkippedByEliteAligned[0].eliteCount, 1);
  });

  it("1 DEGEN YES, 1 ELITE NO → fade signal NO (opposite ELITE OK)", () => {
    const s = new AntiDegenStrategy();
    const wallets = [
      w("0xd1", "DEGEN", [pos("C1", "Yes", 500, 0.30)]),
      w("0xe1", "ELITE", [pos("C1", "No",  800, 0.65)], { score: 85, totalROI: 50 }),
    ];
    const sigs = s.detect({ wallets, markets: [event("C1", 0.32)] });
    assert.equal(sigs.length, 1);
    assert.equal(sigs[0].direction, "NO");
  });

  it("DEGEN entry 0.30, current 0.45 → fadeDrift 0.15 > 0.10 → skipped", () => {
    const s = new AntiDegenStrategy();
    const wallets = [w("0xd1", "DEGEN", [pos("C1", "Yes", 500, 0.30)])];
    const sigs = s.detect({ wallets, markets: [event("C1", 0.45)] });
    assert.equal(sigs.length, 0);
    assert.equal(s.lastSkippedByEdge.length, 1);
    assert.equal(s.lastSkippedByEdge[0].reason, "drift-exceeded");
  });

  it("DEGEN entry 0.30, current 0.20 → fade fresh (no drift skip)", () => {
    // Market moved AGAINST DEGEN — fade is even better positioned
    const s = new AntiDegenStrategy();
    const wallets = [w("0xd1", "DEGEN", [pos("C1", "Yes", 500, 0.30)])];
    const sigs = s.detect({ wallets, markets: [event("C1", 0.20)] });
    assert.equal(sigs.length, 1);
  });

  it("0 DEGEN wallets → no signals", () => {
    const s = new AntiDegenStrategy();
    const wallets = [
      w("0xe1", "ELITE", [pos("C1", "Yes")], { score: 85, totalROI: 50 }),
      w("0xb1", "BASIC", [pos("C1", "Yes")], { totalROI: -5 }),
    ];
    const sigs = s.detect({ wallets, markets: [event("C1", 0.32)] });
    assert.equal(sigs.length, 0);
  });

  it("PRO wallet alone (no DEGEN) → no signals", () => {
    const s = new AntiDegenStrategy();
    const wallets = [w("0xp1", "PRO", [pos("C1", "Yes", 500, 0.30)], { totalROI: 5 })];
    const sigs = s.detect({ wallets, markets: [event("C1", 0.32)] });
    assert.equal(sigs.length, 0);
  });

  it("size below minPositionSize → skipped", () => {
    const s = new AntiDegenStrategy();
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
    const sShallow = new AntiDegenStrategy();
    const wShallow = [w("0xd1", "DEGEN", [pos("C1", "Yes", 500, 0.30)], { totalROI: -25 })];
    const aShallow = sShallow.detect({ wallets: wShallow, markets: [event("C1", 0.32)] });

    const sDeep = new AntiDegenStrategy();
    const wDeep = [w("0xd1", "DEGEN", [pos("C1", "Yes", 500, 0.30)], { totalROI: -75 })];
    const aDeep = sDeep.detect({ wallets: wDeep, markets: [event("C1", 0.32)] });

    assert.ok(aDeep[0].strength > aShallow[0].strength,
      `deeper-loss DEGEN should yield higher strength (${aShallow[0].strength} vs ${aDeep[0].strength})`);
  });

  it("lifecycle: NEW → CONFIRMED on second scan", () => {
    const s = new AntiDegenStrategy();
    const wallets = [w("0xd1", "DEGEN", [pos("C1", "Yes", 500, 0.30)])];
    const sigs1 = s.detect({ wallets, markets: [event("C1", 0.32)] });
    assert.equal(sigs1[0].status, "NEW");
    const sigs2 = s.detect({ wallets, markets: [event("C1", 0.32)] });
    assert.equal(sigs2[0].status, "CONFIRMED");
  });

  it("requireNoEliteAligned=false disables the ELITE-aligned gate", () => {
    const s = new AntiDegenStrategy({ requireNoEliteAligned: false });
    const wallets = [
      w("0xd1", "DEGEN", [pos("C1", "Yes", 500, 0.30)]),
      w("0xe1", "ELITE", [pos("C1", "Yes", 800, 0.28)], { score: 85, totalROI: 50 }),
    ];
    const sigs = s.detect({ wallets, markets: [event("C1", 0.32)] });
    assert.equal(sigs.length, 1);
  });
});
