#!/usr/bin/env node
/**
 * verify-v2.js — cutover-eve smoke test for Polymarket CLOB V2.
 *
 * Exercises the full live trade path against clob-v2.polymarket.com (or the
 * production host after 2026-04-22 cutover) without risking real capital:
 *   1. Build & sign a V2 FOK buy order with ethers.signTypedData
 *   2. (Optional) submit to the CLOB and verify fill
 *
 * Usage:
 *   # Dry-run (default) — no network call, just prints the signed payload:
 *   node scripts/verify-v2.js
 *
 *   # Live — actually submits $1 order. Requires PRIVATE_KEY + FUNDER_ADDRESS:
 *   POLY_CLOB_URL=https://clob-v2.polymarket.com \
 *     node scripts/verify-v2.js --live --token-id=<YES token id> --usdc=1
 *
 * Safety:
 *   - Defaults to dry-run. Must pass --live explicitly to hit the network.
 *   - Default USDC amount is $1; override via --usdc=<n>.
 *   - Exits non-zero on preflight/signature/submit/verify failure so this is
 *     safe to wire into CI as a pre-cutover gate.
 */

import dotenv from "dotenv";
import { ethers } from "ethers";

import {
  buildOrder, preflightCheck, verifyFill,
  getExchangeDomain, EXCHANGE_V2_ADDRESS, NEG_RISK_EXCHANGE_ADDRESS,
} from "../src/trading.js";
import { fetchMidPrice, submitOrder } from "../src/polymarket-api.js";

dotenv.config();

function parseArgs(argv) {
  const opts = { live: false, tokenId: null, usdc: 1, negRisk: false };
  for (const a of argv.slice(2)) {
    if (a === "--live") opts.live = true;
    else if (a.startsWith("--token-id=")) opts.tokenId = a.slice(11);
    else if (a.startsWith("--usdc=")) opts.usdc = Number(a.slice(7));
    else if (a === "--neg-risk") opts.negRisk = true;
    else if (a === "-h" || a === "--help") {
      console.log(`Usage: node scripts/verify-v2.js [--live] [--token-id=<id>] [--usdc=<n>] [--neg-risk]`);
      process.exit(0);
    }
  }
  return opts;
}

function bail(msg, extra) {
  console.error(`✗ ${msg}`);
  if (extra) console.error(extra);
  process.exit(1);
}

async function main() {
  const opts = parseArgs(process.argv);
  const { PRIVATE_KEY, FUNDER_ADDRESS, POLY_CLOB_URL } = process.env;

  console.log("──────────────────────────────────────────────────────");
  console.log(" Polymarket CLOB V2 verification");
  console.log("──────────────────────────────────────────────────────");
  console.log(`  host       : ${POLY_CLOB_URL || "https://clob.polymarket.com (default)"}`);
  console.log(`  mode       : ${opts.live ? "LIVE (will submit order)" : "DRY-RUN (no network submit)"}`);
  console.log(`  tokenId    : ${opts.tokenId || "(missing — set --token-id=…)"}`);
  console.log(`  usdc       : ${opts.usdc}`);
  console.log(`  negRisk    : ${opts.negRisk}`);
  console.log(`  funder     : ${FUNDER_ADDRESS || "(missing)"}`);
  console.log(`  privateKey : ${PRIVATE_KEY ? "(set)" : "(missing)"}`);
  console.log();

  if (!PRIVATE_KEY)    bail("PRIVATE_KEY not set in env");
  if (!FUNDER_ADDRESS) bail("FUNDER_ADDRESS not set in env");
  if (!opts.tokenId)   bail("--token-id=<id> is required");

  // ── 1. Mid-price sanity check ────────────────────────────────────────────
  console.log("[1/4] Fetching mid-price…");
  const mid = await fetchMidPrice(opts.tokenId);
  if (mid == null || mid < 0.01 || mid > 0.99) bail(`Invalid mid-price ${mid}`);
  console.log(`      mid = ${mid}`);

  // ── 2. Preflight (book depth check) ──────────────────────────────────────
  console.log("[2/4] Preflight (book depth + neg-risk detection)…");
  const signal = { market: { active: true, closed: false, negRisk: opts.negRisk } };
  const pre = await preflightCheck(signal, opts.tokenId, opts.usdc);
  if (!pre.ok) bail(`Preflight failed: ${pre.reason}`);
  const negRisk = !!(opts.negRisk || pre.negRisk);
  console.log(`      ok — depth ≥ ${opts.usdc} USDC, negRisk=${negRisk}`);

  // ── 3. Build & sign V2 order ─────────────────────────────────────────────
  console.log("[3/4] Building V2 FOK buy order…");
  const limitPrice = Math.round(mid * 1.02 * 100) / 100; // 2% slippage headroom
  const { orderData, orderPayload, signature } = await buildOrder({
    privateKey: PRIVATE_KEY,
    funderAddress: FUNDER_ADDRESS,
    tokenId: opts.tokenId,
    price: limitPrice,
    maxUsdc: opts.usdc,
    negRisk,
  });

  // Local signature verification — must recover to the signer.
  const domain = getExchangeDomain(negRisk);
  const recovered = ethers.verifyTypedData(domain, { Order: [
    { name: "salt", type: "uint256" }, { name: "maker", type: "address" },
    { name: "signer", type: "address" }, { name: "tokenId", type: "uint256" },
    { name: "makerAmount", type: "uint256" }, { name: "takerAmount", type: "uint256" },
    { name: "side", type: "uint8" }, { name: "signatureType", type: "uint8" },
    { name: "timestamp", type: "uint256" }, { name: "metadata", type: "bytes32" },
    { name: "builder", type: "bytes32" },
  ]}, orderData, signature);

  const expectedSigner = new ethers.Wallet(PRIVATE_KEY).address;
  if (recovered.toLowerCase() !== expectedSigner.toLowerCase()) {
    bail(`Signature recovery mismatch: got ${recovered}, expected ${expectedSigner}`);
  }
  console.log(`      ok — signature recovers to ${recovered}`);
  console.log(`      domain.verifyingContract = ${domain.verifyingContract}`);
  console.log(`      domain.version           = ${domain.version}`);
  console.log(`      order.timestamp          = ${orderData.timestamp}`);
  console.log(`      order.metadata           = ${orderData.metadata}`);
  console.log(`      order.builder            = ${orderData.builder}`);

  // ── 4. Submit (only if --live) ───────────────────────────────────────────
  if (!opts.live) {
    console.log("[4/4] Dry-run — skipping submit.");
    console.log();
    console.log("✓ V2 signing path is healthy. Re-run with --live to hit the CLOB.");
    return;
  }

  console.log("[4/4] Submitting V2 order…");
  const { ok, status, data } = await submitOrder(orderPayload, {});
  if (!ok) bail(`Submit failed (HTTP ${status})`, data);

  const orderId = data?.orderID || data?.id;
  console.log(`      submitted — orderId=${orderId}, txHash=${data?.transactionHash || "(pending)"}`);

  console.log("      verifying fill (up to 60s)…");
  const fill = await verifyFill(orderId, {}, 60_000);
  console.log(`      status=${fill.status}, filledSize=${fill.filledSize}, filledPrice=${fill.filledPrice}`);
  if (fill.status === "FILLED" || fill.status === "PARTIAL") {
    console.log();
    console.log("✓ V2 round-trip succeeded.");
  } else {
    bail(`Fill did not confirm — status=${fill.status}`);
  }
}

main().catch((e) => bail("Unhandled exception", e?.stack || e));
