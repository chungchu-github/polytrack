import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { interpretClockSkew } from "../src/time-check.js";

describe("interpretClockSkew", () => {
  it("reports 'ok' when skew is 0", () => {
    const r = interpretClockSkew(1_700_000_000_000, 1_700_000_000_000);
    assert.equal(r.skewSec, 0);
    assert.equal(r.level, "ok");
  });

  it("reports 'ok' at 2s drift (under 5s threshold)", () => {
    // local is 2s ahead
    const r = interpretClockSkew(1_700_000_002_000, 1_700_000_000_000);
    assert.equal(r.skewSec, 2);
    assert.equal(r.level, "ok");
  });

  it("reports 'ok' at exactly 5s (boundary inclusive)", () => {
    const r = interpretClockSkew(1_700_000_005_000, 1_700_000_000_000);
    assert.equal(r.skewSec, 5);
    assert.equal(r.level, "ok");
  });

  it("reports 'warn' when local is more than 5s ahead", () => {
    const r = interpretClockSkew(1_700_000_010_000, 1_700_000_000_000);
    assert.equal(r.skewSec, 10);
    assert.equal(r.level, "warn");
  });

  it("reports 'warn' when local is more than 5s behind (negative skew)", () => {
    const r = interpretClockSkew(1_700_000_000_000, 1_700_000_030_000);
    assert.equal(r.skewSec, -30);
    assert.equal(r.level, "warn");
  });

  it("rounds fractional seconds to nearest integer", () => {
    // 5400ms local ahead → rounds to 5s, should stay ok (not >5)
    const r1 = interpretClockSkew(1_700_000_005_400, 1_700_000_000_000);
    assert.equal(r1.skewSec, 5);
    assert.equal(r1.level, "ok");
    // 5600ms local ahead → rounds to 6s, should flip to warn
    const r2 = interpretClockSkew(1_700_000_005_600, 1_700_000_000_000);
    assert.equal(r2.skewSec, 6);
    assert.equal(r2.level, "warn");
  });
});
