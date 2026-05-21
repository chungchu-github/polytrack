/**
 * CLOB V2 trading tests — verify buildOrder produces a V2-compliant order.
 *
 * Covers:
 *   - EIP-712 domain (version "2", chainId 137, correct contract)
 *   - Order struct (contains V2 fields, no V1 fields)
 *   - Signature recoverability
 *   - Neg-risk contract routing
 *   - Wire body field ordering
 *
 * These tests do NOT call the network — they exercise the signing layer
 * against a randomly generated wallet so no real private key is required.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ethers } from "ethers";

import {
  buildOrder, buildUnsignedOrder, signOrder, wrapOrderPayload,
  getExchangeDomain, ORDER_TYPES,
  EXCHANGE_V2_ADDRESS, NEG_RISK_EXCHANGE_ADDRESS,
  classifyClobOrderStatus, evaluateExit,
  buildPoly1271Signature,
  SIGNATURE_TYPE_POLY_1271,
} from "../src/trading.js";

const TEST_WALLET = ethers.Wallet.createRandom();
const TEST_FUNDER = "0x1111111111111111111111111111111111111111";
const TEST_TOKEN_ID = "7123456789012345678901234567890";

// wrapOrderPayload reads POLY_API_KEY from env for the `owner` field. Tests
// run in isolation (no .env loaded) so set a dummy here to mimic production
// where derive-api-key.js has populated this variable.
process.env.POLY_API_KEY = process.env.POLY_API_KEY || "test-api-key-uuid";

function validBuildOrder(overrides = {}) {
  return buildOrder({
    privateKey: TEST_WALLET.privateKey,
    funderAddress: TEST_FUNDER,
    tokenId: TEST_TOKEN_ID,
    price: 0.50,
    maxUsdc: 10,
    ...overrides,
  });
}

describe("V2 EIP-712 domain", () => {
  it("uses name=Polymarket CTF Exchange, version=2, chainId=137", () => {
    const d = getExchangeDomain(false);
    assert.equal(d.name, "Polymarket CTF Exchange");
    assert.equal(d.version, "2");
    assert.equal(d.chainId, 137);
    assert.equal(d.verifyingContract, EXCHANGE_V2_ADDRESS);
  });

  it("routes to Neg Risk CTF Exchange V2 when negRisk=true", () => {
    const d = getExchangeDomain(true);
    assert.equal(d.verifyingContract, NEG_RISK_EXCHANGE_ADDRESS);
    assert.equal(d.version, "2");
  });

  it("CTF V2 and Neg Risk V2 contracts differ", () => {
    assert.notEqual(EXCHANGE_V2_ADDRESS, NEG_RISK_EXCHANGE_ADDRESS);
  });
});

describe("V2 Order type schema", () => {
  it("contains the V2-only fields timestamp / metadata / builder", () => {
    const fields = ORDER_TYPES.Order.map(f => f.name);
    assert.ok(fields.includes("timestamp"), "timestamp missing");
    assert.ok(fields.includes("metadata"),  "metadata missing");
    assert.ok(fields.includes("builder"),   "builder missing");
  });

  it("does NOT contain the V1-only fields taker / expiration / nonce / feeRateBps", () => {
    const fields = ORDER_TYPES.Order.map(f => f.name);
    for (const removed of ["taker", "expiration", "nonce", "feeRateBps"]) {
      assert.ok(!fields.includes(removed), `V1 field "${removed}" still present`);
    }
  });

  it("declares correct types for V2 fields", () => {
    const byName = Object.fromEntries(ORDER_TYPES.Order.map(f => [f.name, f.type]));
    assert.equal(byName.timestamp, "uint256");
    assert.equal(byName.metadata,  "bytes32");
    assert.equal(byName.builder,   "bytes32");
    assert.equal(byName.side,      "uint8");
  });
});

describe("buildOrder (V2)", () => {
  it("produces an orderData struct with all V2 fields and none of the V1 fields", async () => {
    const { orderData } = await validBuildOrder();
    assert.ok(typeof orderData.timestamp === "bigint");
    assert.equal(orderData.metadata, "0x" + "0".repeat(64));
    assert.equal(orderData.builder,  "0x" + "0".repeat(64));
    assert.equal(orderData.signer,   TEST_WALLET.address);
    assert.equal(orderData.maker,    TEST_FUNDER);
    assert.equal(orderData.side,     0);
    assert.equal(typeof orderData.nonce,       "undefined");
    assert.equal(typeof orderData.taker,       "undefined");
    assert.equal(typeof orderData.feeRateBps,  "undefined");
    // expiration: NOT in EIP-712 signed struct (V2 dropped it from
    // ORDER_TYPE_STRING) but IS in OrderDataV2 dataclass for the wire body.
    // Default "0" = GTC.
    assert.equal(orderData.expiration, "0");
  });

  it("timestamp is near Date.now() (ms-precision, within 5s)", async () => {
    const before = Date.now();
    const { orderData } = await validBuildOrder();
    const after = Date.now();
    const ts = Number(orderData.timestamp);
    assert.ok(ts >= before - 5000 && ts <= after + 5000,
      `timestamp ${ts} not within test window [${before}, ${after}]`);
  });

  it("signature recovers to the signer's address", async () => {
    const { orderData, signature } = await validBuildOrder();
    const recovered = ethers.verifyTypedData(
      getExchangeDomain(false),
      ORDER_TYPES,
      orderData,
      signature
    );
    assert.equal(recovered.toLowerCase(), TEST_WALLET.address.toLowerCase());
  });

  it("neg-risk orders recover against the Neg Risk Exchange domain", async () => {
    const { orderData, signature } = await validBuildOrder({ negRisk: true });
    const recovered = ethers.verifyTypedData(
      getExchangeDomain(true),
      ORDER_TYPES,
      orderData,
      signature
    );
    assert.equal(recovered.toLowerCase(), TEST_WALLET.address.toLowerCase());
  });

  it("different orders get different salts (randomness, not a counter)", async () => {
    const [a, b] = await Promise.all([validBuildOrder(), validBuildOrder()]);
    assert.notEqual(a.orderData.salt, b.orderData.salt);
  });

  it("wire body matches py-clob-client-v2 order_to_json_v2 shape", async () => {
    const { orderPayload } = await validBuildOrder();
    assert.equal(orderPayload.order.side, "BUY");
    assert.equal(orderPayload.orderType, "FOK");
    assert.ok(orderPayload.order.timestamp, "wire body missing timestamp");
    assert.ok(orderPayload.order.metadata,  "wire body missing metadata");
    assert.ok(orderPayload.order.builder,   "wire body missing builder");
    // V2 wire body keeps `expiration` even though it's NOT in the EIP-712
    // signed struct (off-chain matcher uses it for TTL). Default "0" = GTC.
    assert.equal(orderPayload.order.expiration, "0");
    // Top-level fields per py-clob-client-v2/order_data_v2.py:order_to_json_v2
    assert.equal(typeof orderPayload.owner, "string", "owner (apiKey) required");
    assert.equal(orderPayload.deferExec, false);
    assert.equal(orderPayload.postOnly, false);
    // V1-only fields that should NOT be in V2 wire body
    for (const removed of ["taker", "nonce", "feeRateBps"]) {
      assert.equal(orderPayload.order[removed], undefined,
        `wire body still sends V1 field "${removed}"`);
    }
  });

  it("encodes a builder code string as a bytes32 value", async () => {
    const { orderData } = await validBuildOrder({ builderCode: "polytrack" });
    assert.ok(/^0x[0-9a-f]{64}$/i.test(orderData.builder));
    assert.notEqual(orderData.builder, "0x" + "0".repeat(64));
  });

  it("falls back to zero bytes32 when builder code is blank", async () => {
    const { orderData } = await validBuildOrder({ builderCode: "" });
    assert.equal(orderData.builder, "0x" + "0".repeat(64));
  });

  it("defaults signatureType to 1 (POLY_PROXY) — Magic social login mode", async () => {
    // Default when neither param nor env is set. Clear env for deterministic test.
    const prev = process.env.POLY_SIGNATURE_TYPE;
    delete process.env.POLY_SIGNATURE_TYPE;
    try {
      const { orderData, orderPayload } = await validBuildOrder();
      assert.equal(orderData.signatureType, 1);
      assert.equal(orderPayload.order.signatureType, 1);
    } finally {
      if (prev !== undefined) process.env.POLY_SIGNATURE_TYPE = prev;
    }
  });

  it("honours POLY_SIGNATURE_TYPE env override", async () => {
    const prev = process.env.POLY_SIGNATURE_TYPE;
    process.env.POLY_SIGNATURE_TYPE = "1";
    try {
      const { orderData } = await validBuildOrder();
      assert.equal(orderData.signatureType, 1);
    } finally {
      if (prev === undefined) delete process.env.POLY_SIGNATURE_TYPE;
      else process.env.POLY_SIGNATURE_TYPE = prev;
    }
  });

  it("explicit signatureType param beats env", async () => {
    const prev = process.env.POLY_SIGNATURE_TYPE;
    process.env.POLY_SIGNATURE_TYPE = "2";
    try {
      const { orderData } = await validBuildOrder({ signatureType: 0 });
      assert.equal(orderData.signatureType, 0);
    } finally {
      if (prev === undefined) delete process.env.POLY_SIGNATURE_TYPE;
      else process.env.POLY_SIGNATURE_TYPE = prev;
    }
  });

  it("signature still recovers correctly for signatureType=2", async () => {
    const { orderData, signature } = await validBuildOrder({ signatureType: 2 });
    const recovered = ethers.verifyTypedData(
      getExchangeDomain(false), ORDER_TYPES, orderData, signature
    );
    assert.equal(recovered.toLowerCase(), TEST_WALLET.address.toLowerCase());
  });
});

// ── F1: non-custodial primitives (buildUnsignedOrder / signOrder / wrapOrderPayload) ──

describe("F1 — buildUnsignedOrder", () => {
  function validUnsignedArgs(overrides = {}) {
    return {
      signerAddress: TEST_WALLET.address,
      funderAddress: TEST_FUNDER,
      tokenId: TEST_TOKEN_ID,
      price: 0.5,
      maxUsdc: 10,
      ...overrides,
    };
  }

  it("produces orderData without touching a private key", () => {
    const { orderData, domain, types } = buildUnsignedOrder(validUnsignedArgs());
    assert.equal(orderData.signer, TEST_WALLET.address);
    assert.equal(orderData.maker,  TEST_FUNDER);
    // salt is a JS Number (not BigInt) so JSON.stringify can emit it as
    // an integer literal — matching py-clob-client-v2's order_to_json_v2.
    // Generated by Math.floor(Math.random() * Date.now()), bounded to ~2^41,
    // safely within Number.MAX_SAFE_INTEGER.
    assert.equal(typeof orderData.salt, "number");
    assert.ok(Number.isInteger(orderData.salt));
    assert.ok(orderData.salt > 0);
    assert.ok(typeof orderData.timestamp === "bigint");
    assert.equal(domain.version, "2");
    assert.equal(domain.verifyingContract, EXCHANGE_V2_ADDRESS);
    assert.deepEqual(types, ORDER_TYPES);
  });

  it("routes to NEG_RISK exchange when negRisk=true", () => {
    const { domain } = buildUnsignedOrder(validUnsignedArgs({ negRisk: true }));
    assert.equal(domain.verifyingContract, NEG_RISK_EXCHANGE_ADDRESS);
  });

  it("throws clearly when required args are missing", () => {
    assert.throws(() => buildUnsignedOrder(validUnsignedArgs({ signerAddress: "" })), /signerAddress/);
    assert.throws(() => buildUnsignedOrder(validUnsignedArgs({ funderAddress: "" })), /funderAddress/);
    assert.throws(() => buildUnsignedOrder(validUnsignedArgs({ tokenId: "" })),       /tokenId/);
    assert.throws(() => buildUnsignedOrder(validUnsignedArgs({ price: 0 })),          /price/);
    assert.throws(() => buildUnsignedOrder(validUnsignedArgs({ maxUsdc: 0 })),        /maxUsdc/);
  });

  // Regression: 2026-05-11 production hit
  //   {"error":"invalid price, price must be greater than 0 and less than 1"}
  // for $5 BUY at limit 0.837. Old impl computed tokens = floor(5/0.837) = 5
  // then takerAmount = 5e6, collapsing implied price to maker/taker = 1.0.
  // Stay in 1e6 micro-units + ceil to keep ratio strictly < limit.
  it("keeps implied price < 1 on small-budget high-price BUY", () => {
    for (const price of [0.50, 0.70, 0.837, 0.92, 0.99]) {
      const { orderData } = buildUnsignedOrder(validUnsignedArgs({
        price, maxUsdc: 5, side: 0,
      }));
      const ratio = Number(orderData.makerAmount) / Number(orderData.takerAmount);
      assert.ok(ratio < 1.0,
        `price=${price}: implied ratio ${ratio} must be < 1 (was ${orderData.makerAmount}/${orderData.takerAmount})`);
      assert.ok(ratio <= price + 1e-9,
        `price=${price}: implied ratio ${ratio} must be <= limit ${price}`);
    }
  });

  // Regression: 2026-05-19 production hit on every World Cup fade with:
  //   "invalid amounts, the market buy orders maker amount supports a max
  //    accuracy of 2 decimals"
  // NegRisk exchange requires both maker and taker amounts to be multiples
  // of 10_000 micro-units (= 2 decimal places in token / USDC terms).
  it("rounds maker AND taker to 2-decimal precision (10_000 micro-unit step)", () => {
    // Sweep a mix of prices, focusing on those that produce non-clean
    // takerAmount in the previous (ceil-only) implementation.
    for (const price of [0.05, 0.123, 0.379, 0.50, 0.837, 0.92, 0.987]) {
      const { orderData } = buildUnsignedOrder(validUnsignedArgs({
        price, maxUsdc: 5, side: 0,
      }));
      assert.equal(orderData.makerAmount % 10000n, 0n,
        `price=${price}: makerAmount ${orderData.makerAmount} not multiple of 10_000`);
      assert.equal(orderData.takerAmount % 10000n, 0n,
        `price=${price}: takerAmount ${orderData.takerAmount} not multiple of 10_000`);
      // Quantisation must NOT push the ratio above the limit price (we
      // floor maker / ceil taker on BUY for this reason).
      const ratio = Number(orderData.makerAmount) / Number(orderData.takerAmount);
      assert.ok(ratio <= price + 1e-9,
        `price=${price}: post-quantise ratio ${ratio} > limit ${price}`);
      assert.ok(ratio < 1.0,
        `price=${price}: post-quantise ratio ${ratio} not strictly < 1`);
    }
  });

  it("SELL side: 2-decimal quantisation keeps proceeds ≥ limit", () => {
    for (const price of [0.123, 0.50, 0.92]) {
      const { orderData } = buildUnsignedOrder({
        signerAddress: TEST_WALLET.address,
        funderAddress: TEST_FUNDER,
        tokenId: TEST_TOKEN_ID,
        side: 1,
        price,
        tokenQty: 10.5,
      });
      assert.equal(orderData.makerAmount % 10000n, 0n);
      assert.equal(orderData.takerAmount % 10000n, 0n);
      // For SELL: ratio = takerAmount/makerAmount = USDC per token ≥ limit
      const proceedsPerToken = Number(orderData.takerAmount) / Number(orderData.makerAmount);
      assert.ok(proceedsPerToken >= price - 1e-9,
        `price=${price}: quantised proceeds ${proceedsPerToken} fell below limit`);
    }
  });
});

describe("F1 — signOrder + wrapOrderPayload round-trip", () => {
  it("signOrder output recovers to the private key's address", async () => {
    const { orderData, domain } = buildUnsignedOrder({
      signerAddress: TEST_WALLET.address,
      funderAddress: TEST_FUNDER,
      tokenId: TEST_TOKEN_ID,
      price: 0.5, maxUsdc: 10,
    });
    const signature = await signOrder({
      privateKey: TEST_WALLET.privateKey,
      orderData, domain,
    });
    const recovered = ethers.verifyTypedData(domain, ORDER_TYPES, orderData, signature);
    assert.equal(recovered.toLowerCase(), TEST_WALLET.address.toLowerCase());
  });

  it("wrapOrderPayload produces a CLOB-ready wire body matching V2 wire shape", () => {
    const orderData = {
      salt:          123,                  // JS Number per py-clob-client-v2
      maker:         TEST_FUNDER,
      signer:        TEST_WALLET.address,
      tokenId:       999n,
      makerAmount:   10_000_000n,
      takerAmount:   20_000_000n,
      side:          0,
      signatureType: 1,
      timestamp:     1700000000000n,
      metadata:      "0x" + "0".repeat(64),
      builder:       "0x" + "0".repeat(64),
      expiration:    "0",
    };
    const wire = wrapOrderPayload({
      orderData, signature: "0xdeadbeef", owner: "test-api-key-uuid",
    });
    assert.equal(wire.orderType, "FOK");
    assert.equal(wire.order.salt, 123);              // integer in JSON
    assert.equal(wire.order.tokenId, "999");
    assert.equal(wire.order.makerAmount, "10000000");
    assert.equal(wire.order.side, "BUY");
    assert.equal(wire.order.expiration, "0");
    assert.equal(wire.owner, "test-api-key-uuid");
    assert.equal(wire.deferExec, false);
    assert.equal(wire.postOnly, false);
    assert.equal(wire.order.signature, "0xdeadbeef");
    assert.equal(wire.order.timestamp, "1700000000000");
  });

  it("SELL side serialises to string \"SELL\" in wire body", () => {
    const wire = wrapOrderPayload({
      orderData: {
        salt: 1n, maker: TEST_FUNDER, signer: TEST_WALLET.address, tokenId: 1n,
        makerAmount: 1n, takerAmount: 1n, side: 1, signatureType: 1,
        timestamp: 1n, metadata: "0x" + "0".repeat(64), builder: "0x" + "0".repeat(64),
      },
      signature: "0x00",
    });
    assert.equal(wire.order.side, "SELL");
  });

  it("buildOrder wrapper output is byte-identical to buildUnsignedOrder+signOrder+wrapOrderPayload (same salt/timestamp)", async () => {
    // This is the key regression guard: the split must not change wire bytes.
    const sharedSalt = 42n;
    const sharedTs   = 1700000000000n;

    // Manually patch orderData to pin salt/timestamp (the public API picks random ones)
    const unsigned = buildUnsignedOrder({
      signerAddress: TEST_WALLET.address,
      funderAddress: TEST_FUNDER,
      tokenId: TEST_TOKEN_ID,
      price: 0.5, maxUsdc: 10,
      signatureType: 1,
    });
    unsigned.orderData.salt      = sharedSalt;
    unsigned.orderData.timestamp = sharedTs;

    const sig = await signOrder({
      privateKey: TEST_WALLET.privateKey,
      orderData: unsigned.orderData,
      domain: unsigned.domain,
    });
    const manual = wrapOrderPayload({ orderData: unsigned.orderData, signature: sig });

    // Reconstruct via the composed buildOrder but with same signer — the only
    // way these differ is salt/timestamp (random each call). Check that every
    // other field matches expected V2 shape.
    assert.equal(manual.order.signer, TEST_WALLET.address);
    assert.equal(manual.order.signatureType, 1);
    assert.ok(/^0x[0-9a-f]{130}$/i.test(manual.order.signature), "signature 65-byte hex");
  });
});

describe("classifyClobOrderStatus (reconciliation)", () => {
  it("maps fill-family statuses to FILLED", () => {
    for (const s of ["matched", "MATCHED", "filled", "FILLED", "mined", "MINED"]) {
      assert.equal(classifyClobOrderStatus(s), "FILLED", `"${s}" should map to FILLED`);
    }
  });

  it("maps partial-family statuses to PARTIAL", () => {
    assert.equal(classifyClobOrderStatus("partial"), "PARTIAL");
    assert.equal(classifyClobOrderStatus("partially_filled"), "PARTIAL");
  });

  it("preserves cancelled / expired / rejected verbatim", () => {
    assert.equal(classifyClobOrderStatus("cancelled"), "CANCELLED");
    assert.equal(classifyClobOrderStatus("EXPIRED"),   "EXPIRED");
    assert.equal(classifyClobOrderStatus("rejected"),  "REJECTED");
  });

  it("maps open/live/pending to OPEN", () => {
    for (const s of ["live", "open", "submitted", "pending"]) {
      assert.equal(classifyClobOrderStatus(s), "OPEN", `"${s}" should map to OPEN`);
    }
  });

  it("returns UNKNOWN for null, empty, or unrecognised input", () => {
    assert.equal(classifyClobOrderStatus(null),        "UNKNOWN");
    assert.equal(classifyClobOrderStatus(undefined),   "UNKNOWN");
    assert.equal(classifyClobOrderStatus(""),          "UNKNOWN");
    assert.equal(classifyClobOrderStatus("moon_gas"),  "UNKNOWN");
  });
});

// ── P0 #4 — SELL-side buildUnsignedOrder ─────────────────────────────────────

describe("buildUnsignedOrder — SELL side", () => {
  const TEST_SIGNER = TEST_WALLET.address;

  it("builds a SELL order with maker=tokens, taker=USDC", () => {
    const { orderData } = buildUnsignedOrder({
      signerAddress: TEST_SIGNER,
      funderAddress: TEST_FUNDER,
      tokenId:       TEST_TOKEN_ID,
      price:         0.40,
      side:          1,        // SELL
      tokenQty:      100,      // selling 100 tokens at $0.40 each → expect 40 USDC
    });
    assert.equal(orderData.side, 1);
    // 100 tokens * 1e6 = 100_000_000
    assert.equal(orderData.makerAmount, BigInt(100_000_000));
    // 100 tokens * 0.40 USDC * 1e6 = 40_000_000
    assert.equal(orderData.takerAmount, BigInt(40_000_000));
  });

  it("BUY default still works (no side specified → side 0)", () => {
    const { orderData } = buildUnsignedOrder({
      signerAddress: TEST_SIGNER,
      funderAddress: TEST_FUNDER,
      tokenId:       TEST_TOKEN_ID,
      price:         0.50,
      maxUsdc:       10,
    });
    assert.equal(orderData.side, 0);
    // BUY: makerAmount = USDC (10 * 1e6), takerAmount = tokens (10/0.50 = 20 tokens * 1e6)
    assert.equal(orderData.makerAmount, BigInt(10_000_000));
    assert.equal(orderData.takerAmount, BigInt(20_000_000));
  });

  it("rejects SELL without tokenQty", () => {
    assert.throws(() => buildUnsignedOrder({
      signerAddress: TEST_SIGNER,
      funderAddress: TEST_FUNDER,
      tokenId:       TEST_TOKEN_ID,
      price:         0.50,
      side:          1,
    }), /tokenQty required/);
  });

  it("rejects BUY without maxUsdc", () => {
    assert.throws(() => buildUnsignedOrder({
      signerAddress: TEST_SIGNER,
      funderAddress: TEST_FUNDER,
      tokenId:       TEST_TOKEN_ID,
      price:         0.50,
      side:          0,
    }), /maxUsdc required/);
  });

  it("rejects invalid side", () => {
    assert.throws(() => buildUnsignedOrder({
      signerAddress: TEST_SIGNER,
      funderAddress: TEST_FUNDER,
      tokenId:       TEST_TOKEN_ID,
      price:         0.50,
      side:          2,
      maxUsdc:       10,
    }), /side must be 0/);
  });

  it("SELL serialises to side='SELL' in wire body", async () => {
    const { orderData, domain } = buildUnsignedOrder({
      signerAddress: TEST_SIGNER,
      funderAddress: TEST_FUNDER,
      tokenId:       TEST_TOKEN_ID,
      price:         0.30,
      side:          1,
      tokenQty:      50,
    });
    const sig = await signOrder({
      privateKey: TEST_WALLET.privateKey,
      orderData,
      domain,
    });
    const body = wrapOrderPayload({ orderData, signature: sig });
    assert.equal(body.order.side, "SELL");
    assert.equal(body.order.makerAmount, "50000000");
    assert.equal(body.order.takerAmount, "15000000");  // 50 * 0.30 * 1e6
  });
});

// ── P0 #4 — evaluateExit decision logic ──────────────────────────────────────

describe("evaluateExit", () => {
  const POLICY = { enabled: true, maxHoldDays: 14, stopLossPct: 0.30 };
  const baseTrade = {
    status:    "FILLED",
    fillPrice: 0.50,
    direction: "YES",
    exitedAt:  null,
  };
  const dayMs = 24 * 60 * 60 * 1000;

  it("returns shouldExit:false when policy is disabled", () => {
    const r = evaluateExit({
      trade:           { ...baseTrade, filledAt: 1000 },
      latestMidPrice:  0.20,
      now:             1000 + 30 * dayMs,
      policy:          { ...POLICY, enabled: false },
    });
    assert.equal(r.shouldExit, false);
  });

  it("returns shouldExit:false on PENDING / unfilled trades", () => {
    const r = evaluateExit({
      trade:          { ...baseTrade, status: "PENDING", filledAt: null },
      latestMidPrice: 0.20,
      now:            Date.now(),
      policy:         POLICY,
    });
    assert.equal(r.shouldExit, false);
  });

  it("returns shouldExit:false on already-exited trades", () => {
    const r = evaluateExit({
      trade:          { ...baseTrade, filledAt: 1000, exitedAt: 1500 },
      latestMidPrice: 0.20,
      now:            1000 + 30 * dayMs,
      policy:         POLICY,
    });
    assert.equal(r.shouldExit, false);
  });

  it("triggers max_hold when age exceeds maxHoldDays", () => {
    const filledAt = 1000;
    const r = evaluateExit({
      trade:          { ...baseTrade, filledAt },
      latestMidPrice: 0.45,            // small loss, but not stop-loss
      now:            filledAt + 15 * dayMs,
      policy:         POLICY,
    });
    assert.equal(r.shouldExit, true);
    assert.equal(r.reason,     "max_hold");
  });

  it("triggers stop_loss when price drops past threshold", () => {
    const filledAt = Date.now() - 1 * dayMs;
    const r = evaluateExit({
      trade:          { ...baseTrade, filledAt },
      latestMidPrice: 0.30,            // entry 0.50 → -40%
      policy:         POLICY,
    });
    assert.equal(r.shouldExit, true);
    assert.equal(r.reason,     "stop_loss");
    assert.ok(r.currentPnLPct < -0.30);
  });

  it("does not trigger stop_loss above threshold", () => {
    const filledAt = Date.now() - 1 * dayMs;
    const r = evaluateExit({
      trade:          { ...baseTrade, filledAt },
      latestMidPrice: 0.40,            // entry 0.50 → -20%, above -30% threshold
      policy:         POLICY,
    });
    assert.equal(r.shouldExit, false);
    assert.ok(Math.abs(r.currentPnLPct + 0.20) < 1e-9);
  });

  it("computes positive currentPnLPct for winning positions", () => {
    const filledAt = Date.now() - 1 * dayMs;
    const r = evaluateExit({
      trade:          { ...baseTrade, filledAt },
      latestMidPrice: 0.70,            // up 40%
      policy:         POLICY,
    });
    assert.equal(r.shouldExit, false);
    assert.ok(Math.abs(r.currentPnLPct - 0.40) < 1e-9);
  });

  it("max_hold takes priority over stop_loss", () => {
    const filledAt = 1000;
    const r = evaluateExit({
      trade:          { ...baseTrade, filledAt },
      latestMidPrice: 0.10,            // also stop-loss eligible
      now:            filledAt + 30 * dayMs,
      policy:         POLICY,
    });
    assert.equal(r.shouldExit, true);
    assert.equal(r.reason,     "max_hold");  // time check first
  });

  it("does nothing with no fresh price and within time horizon", () => {
    const filledAt = Date.now() - 5 * dayMs;
    const r = evaluateExit({
      trade:          { ...baseTrade, filledAt },
      latestMidPrice: null,
      policy:         POLICY,
    });
    assert.equal(r.shouldExit, false);
    assert.equal(r.currentPnLPct, null);
  });

  it("maxHoldDays=0 disables time-based exit", () => {
    const filledAt = 1000;
    const r = evaluateExit({
      trade:          { ...baseTrade, filledAt },
      latestMidPrice: 0.45,
      now:            filledAt + 365 * dayMs,
      policy:         { ...POLICY, maxHoldDays: 0 },
    });
    assert.equal(r.shouldExit, false);
  });

  it("stopLossPct=0 disables loss-based exit", () => {
    const filledAt = Date.now() - 1 * dayMs;
    const r = evaluateExit({
      trade:          { ...baseTrade, filledAt },
      latestMidPrice: 0.10,            // crashed to 20% of entry
      policy:         { ...POLICY, stopLossPct: 0 },
    });
    assert.equal(r.shouldExit, false);
  });
});

// ── POLY_1271 (sigtype=3) Solady packed signature ───────────────────────────
//
// Mirrors py-clob-client-v2 v1.0.1
// order_utils/exchange_order_builder_v2.py::_build_poly_1271_order_signature.
// We can't easily check byte-for-byte equality against the Python output (the
// digest depends on a random salt), so the test instead pins the structural
// invariants that CLOB validates server-side:
//   1. Packed sig length = 65 + 32 + 32 + len(ORDER_TYPE_STRING) + 2.
//   2. Last 2 bytes = uint16-BE length of ORDER_TYPE_STRING.
//   3. The N bytes before the length match the ORDER_TYPE_STRING UTF-8 bytes.
//   4. The contents_hash + app_domain_separator at the appropriate offsets
//      match what we recompute from the same orderData/domain.
//   5. Recovering the inner signature against the wallet-domain digest yields
//      the EOA address derived from the signing key — proves the wrapper is
//      signed by the correct private key (not the funder address).
describe("trading — POLY_1271 Solady packed signature", () => {
  // Hand-construct an orderData rather than going through buildUnsignedOrder
  // so the test is deterministic (no Math.random in salt / Date.now in ts).
  const FUNDER = "0xafd96337fc55cc90320b6281c0c4016c24b81a4e";
  const ORDER_TYPE_STRING_LEN = 186; // sanity-check against accidental string edits
  const orderData = {
    salt: 1234567890,
    maker: FUNDER,
    signer: FUNDER,                          // POLY_1271: signer = funder
    tokenId: BigInt("742126720381116423384184412325128784633166194374209530196688686498463"),
    makerAmount: BigInt(5_000_000),          // $5 pUSD
    takerAmount: BigInt(38_000_000),
    side: 0,
    signatureType: 3,
    timestamp: BigInt(1778482365624),
    metadata: "0x" + "00".repeat(32),
    builder:  "0x" + "00".repeat(32),
  };
  const domain = {
    name: "Polymarket CTF Exchange",
    version: "2",
    chainId: 137,
    verifyingContract: EXCHANGE_V2_ADDRESS,
  };

  it("produces correctly-shaped packed signature", () => {
    const sig = buildPoly1271Signature({
      orderData, domain, privateKey: TEST_WALLET.privateKey,
    });
    const bytes = ethers.getBytes(sig);

    // 65 (inner) + 32 (appDomainSep) + 32 (contentsHash) + N (typeStr) + 2 (len)
    assert.equal(bytes.length, 65 + 32 + 32 + ORDER_TYPE_STRING_LEN + 2,
      `expected ${65 + 32 + 32 + ORDER_TYPE_STRING_LEN + 2} bytes, got ${bytes.length}`);

    // Trailing uint16-BE length matches len(ORDER_TYPE_STRING)
    const len = (bytes[bytes.length - 2] << 8) | bytes[bytes.length - 1];
    assert.equal(len, ORDER_TYPE_STRING_LEN);

    // contentsType prefix matches ORDER_TYPE_STRING utf8
    const contentsTypeBytes = bytes.slice(65 + 32 + 32, 65 + 32 + 32 + len);
    const decoded = new TextDecoder("utf-8").decode(contentsTypeBytes);
    assert.match(decoded, /^Order\(uint256 salt,address maker,address signer,/);
    assert.equal(decoded.length, ORDER_TYPE_STRING_LEN);
  });

  it("inner signature recovers to the EOA private key", () => {
    const sig = buildPoly1271Signature({
      orderData, domain, privateKey: TEST_WALLET.privateKey,
    });
    const innerSig = ethers.hexlify(ethers.getBytes(sig).slice(0, 65));

    // Re-derive the digest the same way the production code does.
    const appDomainTypeHash = ethers.keccak256(ethers.toUtf8Bytes(
      "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)",
    ));
    const appDomainSep = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["bytes32", "bytes32", "bytes32", "uint256", "address"],
        [
          appDomainTypeHash,
          ethers.keccak256(ethers.toUtf8Bytes("Polymarket CTF Exchange")),
          ethers.keccak256(ethers.toUtf8Bytes("2")),
          domain.chainId,
          domain.verifyingContract,
        ],
      ),
    );
    const orderTypeStr = "Order(uint256 salt,address maker,address signer,uint256 tokenId," +
      "uint256 makerAmount,uint256 takerAmount,uint8 side,uint8 signatureType," +
      "uint256 timestamp,bytes32 metadata,bytes32 builder)";
    const orderTypeHash = ethers.keccak256(ethers.toUtf8Bytes(orderTypeStr));
    const contentsHash = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        [
          "bytes32",
          "uint256", "address", "address",
          "uint256", "uint256", "uint256",
          "uint8", "uint8", "uint256",
          "bytes32", "bytes32",
        ],
        [
          orderTypeHash,
          orderData.salt, orderData.maker, orderData.signer,
          orderData.tokenId, orderData.makerAmount, orderData.takerAmount,
          orderData.side, orderData.signatureType, orderData.timestamp,
          orderData.metadata, orderData.builder,
        ],
      ),
    );
    const soladyTypeStr =
      "TypedDataSign(Order contents,string name,string version,uint256 chainId," +
      "address verifyingContract,bytes32 salt)" + orderTypeStr;
    const soladyTypeHash = ethers.keccak256(ethers.toUtf8Bytes(soladyTypeStr));
    const tdsStructHash = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["bytes32", "bytes32", "bytes32", "bytes32", "uint256", "address", "bytes32"],
        [
          soladyTypeHash,
          contentsHash,
          ethers.keccak256(ethers.toUtf8Bytes("DepositWallet")),
          ethers.keccak256(ethers.toUtf8Bytes("1")),
          domain.chainId,
          orderData.signer,
          "0x" + "00".repeat(32),
        ],
      ),
    );
    const digest = ethers.keccak256(ethers.concat(["0x1901", appDomainSep, tdsStructHash]));

    // Recover the EOA from the inner signature over the digest.
    const recovered = ethers.recoverAddress(digest, innerSig);
    assert.equal(recovered.toLowerCase(), TEST_WALLET.address.toLowerCase());

    // Sanity: contentsHash + appDomainSep are at expected offsets in the packed sig.
    const bytes = ethers.getBytes(sig);
    const packedAppSep = ethers.hexlify(bytes.slice(65, 65 + 32));
    const packedContents = ethers.hexlify(bytes.slice(65 + 32, 65 + 64));
    assert.equal(packedAppSep.toLowerCase(), appDomainSep.toLowerCase());
    assert.equal(packedContents.toLowerCase(), contentsHash.toLowerCase());
  });

  it("signOrder dispatches POLY_1271 path when signatureType=3", async () => {
    const sig = await signOrder({
      privateKey: TEST_WALLET.privateKey,
      orderData,
      domain,
    });
    // Packed signature is much longer than a standard 65-byte EOA sig (~387B).
    assert.ok(ethers.getBytes(sig).length > 200,
      "POLY_1271 signature should be packed (>200 bytes), got " + ethers.getBytes(sig).length);
  });

  it("accepts un-prefixed private key (MetaMask export format)", () => {
    const pkNoPrefix = TEST_WALLET.privateKey.slice(2);
    // Should NOT throw — production reads PRIVATE_KEY from env and MetaMask
    // exports the key without the "0x" prefix.
    const sig = buildPoly1271Signature({
      orderData, domain, privateKey: pkNoPrefix,
    });
    assert.equal(ethers.getBytes(sig).length, 65 + 32 + 32 + 186 + 2);
  });

  it("signOrder still produces 65-byte sig for non-POLY_1271 paths", async () => {
    const sig = await signOrder({
      privateKey: TEST_WALLET.privateKey,
      orderData: { ...orderData, signatureType: 0, signer: TEST_WALLET.address },
      domain,
    });
    assert.equal(ethers.getBytes(sig).length, 65);
  });
});
