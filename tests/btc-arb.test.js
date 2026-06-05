import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseBtcMarket,
  checkBinaryArb,
  checkBucketArb,
  groupFamilies,
  checkCalendarMonotonicity,
  checkThresholdMonotonicity,
} from "../src/btc-arb.js";

describe("parseBtcMarket", () => {
  it("parses a threshold market with full date", () => {
    const r = parseBtcMarket("Will Bitcoin reach $150,000 by December 31, 2026?");
    assert.equal(r.kind, "threshold");
    assert.equal(r.targetUsd, 150000);
    assert.equal(r.dateMs, Date.parse("December 31, 2026"));
  });
  it("expands $k and $m suffixes", () => {
    assert.equal(parseBtcMarket("BTC above $100k on Jul 31?").targetUsd, 100000);
    assert.equal(parseBtcMarket("Bitcoin to $1m this year?").targetUsd, 1000000);
    assert.equal(parseBtcMarket("Bitcoin above $2.5k?").targetUsd, 2500);
  });
  it("classifies up/down as direction", () => {
    assert.equal(parseBtcMarket("Bitcoin Up or Down — July 4, 8PM ET").kind, "direction");
  });
  it("returns unknown for non-threshold, non-direction", () => {
    assert.deepEqual(parseBtcMarket("Will the Lakers win?"), { kind: "unknown", targetUsd: null, dateMs: null });
  });
  it("threshold with no parseable date keeps targetUsd, dateMs null", () => {
    const r = parseBtcMarket("Will Bitcoin hit $200,000 eventually?");
    assert.equal(r.kind, "threshold");
    assert.equal(r.targetUsd, 200000);
    assert.equal(r.dateMs, null);
  });
});

describe("checkBinaryArb", () => {
  it("locks profit when YES+NO asks sum < 1", () => {
    const r = checkBinaryArb({ yesAsks: [{ price: 0.45, size: 100 }], noAsks: [{ price: 0.45, size: 100 }], fee: 0, capUsd: 1000 });
    assert.ok(Math.abs(r.gap - 0.10) < 1e-9);
    assert.ok(Math.abs(r.executableUsd - 90) < 1e-9);  // 100 pairs * 0.90
    assert.ok(Math.abs(r.profitUsd - 10) < 1e-9);      // 100 pairs * 0.10
  });
  it("no arb when sum >= 1", () => {
    const r = checkBinaryArb({ yesAsks: [{ price: 0.6, size: 100 }], noAsks: [{ price: 0.6, size: 100 }] });
    assert.ok(r.gap < 0);
    assert.equal(r.executableUsd, 0);
    assert.equal(r.profitUsd, 0);
  });
  it("respects capUsd (partial fill)", () => {
    const r = checkBinaryArb({ yesAsks: [{ price: 0.4, size: 1000 }], noAsks: [{ price: 0.4, size: 1000 }], fee: 0, capUsd: 100 });
    assert.ok(Math.abs(r.executableUsd - 100) < 1e-9);
    assert.ok(Math.abs(r.profitUsd - 25) < 1e-9);      // 125 pairs * 0.20
  });
});

describe("checkBucketArb", () => {
  it("locks profit when best asks sum < 1", () => {
    const r = checkBucketArb({ legsBest: [{ price: 0.30, size: 50 }, { price: 0.30, size: 80 }, { price: 0.30, size: 40 }], fee: 0 });
    assert.ok(Math.abs(r.gap - 0.10) < 1e-9);
    assert.equal(r.executableShares, 40);              // min leg depth
    assert.ok(Math.abs(r.profitUsd - 4) < 1e-9);       // 40 * 0.10
  });
  it("no arb when sum >= 1", () => {
    const r = checkBucketArb({ legsBest: [{ price: 0.5, size: 10 }, { price: 0.6, size: 10 }], fee: 0 });
    assert.ok(r.gap < 0);
    assert.equal(r.profitUsd, 0);
  });
  it("guards against <2 legs or non-positive prices", () => {
    assert.equal(checkBucketArb({ legsBest: [{ price: 0.3, size: 10 }] }).profitUsd, 0);
    assert.equal(checkBucketArb({ legsBest: [{ price: 0, size: 10 }, { price: 0.3, size: 10 }] }).profitUsd, 0);
  });
});

describe("consistency checks", () => {
  const mk = (conditionId, targetUsd, dateMs, prob) => ({ kind: "threshold", conditionId, targetUsd, dateMs, prob, question: conditionId });

  it("calendar: flags P(by earlier) > P(by later) for same target", () => {
    const fam = groupFamilies([
      mk("a", 100000, Date.parse("2026-05-31"), 0.40),
      mk("b", 100000, Date.parse("2026-06-30"), 0.30),
    ]);
    const v = checkCalendarMonotonicity(fam.calendar, 0);
    assert.equal(v.length, 1);
    assert.ok(Math.abs(v[0].magnitude - 0.10) < 1e-9);
  });
  it("calendar: no violation when monotone increasing", () => {
    const fam = groupFamilies([
      mk("a", 100000, Date.parse("2026-05-31"), 0.30),
      mk("b", 100000, Date.parse("2026-06-30"), 0.40),
    ]);
    assert.equal(checkCalendarMonotonicity(fam.calendar, 0).length, 0);
  });
  it("threshold: flags P(>low) < P(>high) for same date", () => {
    const d = Date.parse("2026-06-30");
    const fam = groupFamilies([mk("a", 90000, d, 0.30), mk("b", 100000, d, 0.40)]);
    const v = checkThresholdMonotonicity(fam.threshold, 0);
    assert.equal(v.length, 1);
    assert.ok(Math.abs(v[0].magnitude - 0.10) < 1e-9);
  });
  it("ignores direction and date-less markets", () => {
    const fam = groupFamilies([
      { kind: "direction", conditionId: "x", targetUsd: null, dateMs: null, prob: 0.5 },
      mk("y", 100000, null, 0.3),
    ]);
    assert.equal(fam.calendar.size, 0);
    assert.equal(fam.threshold.size, 0);
  });
});
