import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { writeFileSync, unlinkSync } from "fs";

import { getDiskUsage, fileSizeBytes, fmtBytes } from "../src/disk.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("getDiskUsage", () => {
  it("returns total/free/used bytes and a 0..1 usedFrac", () => {
    const u = getDiskUsage(__dirname);
    assert.ok(u, "expected stats for valid path");
    assert.ok(u.totalBytes > 0);
    assert.ok(u.freeBytes  >= 0);
    assert.ok(u.usedBytes  >= 0);
    assert.ok(u.usedFrac   >= 0 && u.usedFrac <= 1);
    assert.equal(u.totalBytes, u.usedBytes + u.freeBytes);
  });

  it("returns null on a non-existent path (graceful failure)", () => {
    const u = getDiskUsage("/this/path/definitely/does/not/exist/xyz");
    assert.equal(u, null);
  });
});

describe("fileSizeBytes", () => {
  it("returns the byte size of an existing file", () => {
    const p = resolve(__dirname, ".disk-test-tmp");
    writeFileSync(p, "hello");
    try {
      assert.equal(fileSizeBytes(p), 5);
    } finally {
      unlinkSync(p);
    }
  });

  it("returns 0 for a missing file (no throw)", () => {
    assert.equal(fileSizeBytes("/no/such/file.xyz"), 0);
  });
});

describe("fmtBytes", () => {
  it("formats bytes through TB", () => {
    assert.equal(fmtBytes(0), "0.0B");
    assert.equal(fmtBytes(512), "512B");
    assert.equal(fmtBytes(2048), "2.0KB");
    assert.equal(fmtBytes(5 * 1024 * 1024), "5.0MB");
    assert.equal(fmtBytes(2.5 * 1024 * 1024 * 1024), "2.5GB");
  });
  it("returns ? for non-finite", () => {
    assert.equal(fmtBytes(NaN), "?");
    assert.equal(fmtBytes(Infinity), "?");
  });
});
