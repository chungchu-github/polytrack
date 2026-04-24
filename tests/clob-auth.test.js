/**
 * CLOB L1/L2 auth unit tests — exercise the signing primitives without
 * hitting the network. `deriveApiKey` is not tested here (needs a live
 * Polymarket CLOB); everything else is pure crypto and deterministic.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { ethers } from "ethers";

import {
  signClobAuth, buildL1Headers, buildL2Headers, computeHmac,
  getEnvCreds, l2HeadersFromEnv,
} from "../src/clob-auth.js";

const TEST_WALLET = ethers.Wallet.createRandom();

describe("L1: ClobAuth EIP-712", () => {
  it("produces a signature that recovers to the signer's address", async () => {
    const { signature, address, timestamp, nonce } = await signClobAuth({
      privateKey: TEST_WALLET.privateKey,
      timestamp: 1700000000,
      nonce: 0,
    });
    assert.equal(address.toLowerCase(), TEST_WALLET.address.toLowerCase());
    assert.equal(timestamp, "1700000000");
    assert.equal(nonce, 0);

    const recovered = ethers.verifyTypedData(
      { name: "ClobAuthDomain", version: "1", chainId: 137 },
      { ClobAuth: [
        { name: "address",   type: "address" },
        { name: "timestamp", type: "string"  },
        { name: "nonce",     type: "uint256" },
        { name: "message",   type: "string"  },
      ]},
      {
        address,
        timestamp,
        nonce: BigInt(nonce),
        message: "This message attests that I control the given wallet",
      },
      signature
    );
    assert.equal(recovered.toLowerCase(), TEST_WALLET.address.toLowerCase());
  });

  it("buildL1Headers emits the four POLY_ headers", () => {
    const h = buildL1Headers({
      address: "0xabc",
      signature: "0xdeadbeef",
      timestamp: "1700000000",
      nonce: 0,
    });
    assert.equal(h.POLY_ADDRESS,   "0xabc");
    assert.equal(h.POLY_SIGNATURE, "0xdeadbeef");
    assert.equal(h.POLY_TIMESTAMP, "1700000000");
    assert.equal(h.POLY_NONCE,     "0");
  });

  it("defaults timestamp to now when not supplied", async () => {
    const before = Math.floor(Date.now() / 1000);
    const { timestamp } = await signClobAuth({ privateKey: TEST_WALLET.privateKey });
    const after = Math.floor(Date.now() / 1000);
    const ts = Number(timestamp);
    assert.ok(ts >= before && ts <= after + 1, `timestamp ${ts} outside [${before}, ${after}]`);
  });
});

describe("L2: HMAC-SHA256 headers", () => {
  // Pre-computed reference: secret "c2VjcmV0" is base64("secret")
  // HMAC-SHA256("secret", "1700000000GET/order") =
  //   crypto-verified below.
  const SECRET_B64 = Buffer.from("secret").toString("base64");

  it("computeHmac output matches a node-crypto reference HMAC", () => {
    const ts = "1700000000";
    const method = "GET";
    const path = "/order/abc";
    const body = "";

    const expected = crypto
      .createHmac("sha256", Buffer.from(SECRET_B64, "base64"))
      .update(`${ts}${method}${path}${body}`)
      .digest("base64")
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

    const got = computeHmac({ secret: SECRET_B64, timestamp: ts, method, path, body });
    assert.equal(got, expected);
  });

  it("output is base64url — no +, /, or = characters", () => {
    const sig = computeHmac({
      secret: Buffer.from("a-reasonably-long-test-secret-key-for-hmac-sha256").toString("base64"),
      timestamp: "1700000000",
      method: "POST",
      path: "/order",
      body: JSON.stringify({ some: "payload" }),
    });
    assert.ok(!sig.includes("+"), `signature contains +: ${sig}`);
    assert.ok(!sig.includes("/"), `signature contains /: ${sig}`);
    assert.ok(!sig.includes("="), `signature contains =: ${sig}`);
    assert.match(sig, /^[A-Za-z0-9_-]+$/, `signature not base64url: ${sig}`);
  });

  it("different requests yield different signatures", () => {
    const base = { secret: SECRET_B64, timestamp: "1700000000" };
    const a = computeHmac({ ...base, method: "GET",  path: "/order/abc", body: "" });
    const b = computeHmac({ ...base, method: "POST", path: "/order/abc", body: "" });
    const c = computeHmac({ ...base, method: "GET",  path: "/order/xyz", body: "" });
    assert.notEqual(a, b);
    assert.notEqual(a, c);
    assert.notEqual(b, c);
  });
});

describe("buildL2Headers", () => {
  const creds = {
    apiKey:     "test-api-key",
    secret:     Buffer.from("test-secret-raw-bytes").toString("base64url"),
    passphrase: "test-passphrase",
    address:    "0x1111111111111111111111111111111111111111",
  };

  it("emits all five required headers (POLY_ADDRESS + API_KEY + PASSPHRASE + TIMESTAMP + SIGNATURE)", () => {
    const h = buildL2Headers({ creds, method: "POST", path: "/order", body: { x: 1 } });
    assert.equal(h.POLY_ADDRESS,    creds.address);
    assert.equal(h.POLY_API_KEY,    creds.apiKey);
    assert.equal(h.POLY_PASSPHRASE, creds.passphrase);
    assert.ok(h.POLY_TIMESTAMP);
    assert.ok(h.POLY_SIGNATURE);
    assert.match(h.POLY_SIGNATURE, /^[A-Za-z0-9_-]+$/);
    // Ensure exactly these 5 keys — no stray headers
    assert.deepEqual(Object.keys(h).sort(),
      ["POLY_ADDRESS", "POLY_API_KEY", "POLY_PASSPHRASE", "POLY_SIGNATURE", "POLY_TIMESTAMP"]);
  });

  it("returns empty object when creds are missing or incomplete", () => {
    assert.deepEqual(buildL2Headers({ creds: null,      method: "GET", path: "/order" }), {});
    assert.deepEqual(buildL2Headers({ creds: {},        method: "GET", path: "/order" }), {});
    assert.deepEqual(buildL2Headers({ creds: { apiKey: "a" }, method: "GET", path: "/order" }), {});
    // address missing → {}
    assert.deepEqual(buildL2Headers({
      creds: { apiKey: "a", secret: "c2VjcmV0", passphrase: "p" },
      method: "GET", path: "/order",
    }), {});
  });

  it("accepts string body and doesn't double-stringify", () => {
    const raw = `{"x":1}`;
    const viaString = buildL2Headers({ creds, method: "POST", path: "/order", body: raw });
    const viaObject = buildL2Headers({ creds, method: "POST", path: "/order", body: { x: 1 } });
    if (viaString.POLY_TIMESTAMP === viaObject.POLY_TIMESTAMP) {
      assert.equal(viaString.POLY_SIGNATURE, viaObject.POLY_SIGNATURE);
    }
  });
});

describe("env plumbing", () => {
  const TEST_PK = TEST_WALLET.privateKey;

  it("getEnvCreds returns null when any piece is missing", () => {
    const prev = { ...process.env };
    try {
      delete process.env.POLY_API_KEY;
      delete process.env.POLY_API_SECRET;
      delete process.env.POLY_PASSPHRASE;
      delete process.env.PRIVATE_KEY;
      assert.equal(getEnvCreds(), null);

      process.env.POLY_API_KEY    = "a";
      process.env.POLY_API_SECRET = "b";
      // POLY_PASSPHRASE still missing
      assert.equal(getEnvCreds(), null);

      process.env.POLY_PASSPHRASE = "p";
      // PRIVATE_KEY still missing → address can't derive → null
      assert.equal(getEnvCreds(), null);
    } finally {
      Object.assign(process.env, prev);
    }
  });

  it("getEnvCreds returns the full triple + address when all four are set", () => {
    const prev = { ...process.env };
    try {
      process.env.POLY_API_KEY    = "api";
      process.env.POLY_API_SECRET = Buffer.from("sec").toString("base64url");
      process.env.POLY_PASSPHRASE = "pass";
      process.env.PRIVATE_KEY     = TEST_PK;
      const c = getEnvCreds();
      assert.equal(c.apiKey,     "api");
      assert.equal(c.passphrase, "pass");
      assert.ok(c.secret);
      assert.equal(c.address.toLowerCase(), TEST_WALLET.address.toLowerCase());
    } finally {
      Object.assign(process.env, prev);
    }
  });

  it("l2HeadersFromEnv produces 5 headers when fully configured", () => {
    const prev = { ...process.env };
    try {
      process.env.POLY_API_KEY    = "api";
      process.env.POLY_API_SECRET = Buffer.from("sec").toString("base64url");
      process.env.POLY_PASSPHRASE = "pass";
      process.env.PRIVATE_KEY     = TEST_PK;
      const h = l2HeadersFromEnv({ method: "POST", path: "/order", body: "{}" });
      assert.equal(h.POLY_API_KEY, "api");
      assert.equal(h.POLY_ADDRESS.toLowerCase(), TEST_WALLET.address.toLowerCase());
      assert.ok(h.POLY_SIGNATURE);
      assert.ok(h.POLY_TIMESTAMP);
      assert.ok(h.POLY_PASSPHRASE);
    } finally {
      Object.assign(process.env, prev);
    }
  });

  it("l2HeadersFromEnv returns empty when creds are absent", () => {
    const prev = { ...process.env };
    try {
      delete process.env.POLY_API_KEY;
      delete process.env.POLY_API_SECRET;
      delete process.env.POLY_PASSPHRASE;
      const h = l2HeadersFromEnv({ method: "GET", path: "/order/1" });
      assert.deepEqual(h, {});
    } finally {
      Object.assign(process.env, prev);
    }
  });
});
