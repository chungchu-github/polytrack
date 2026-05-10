/**
 * find-funder.js — derive signer EOA from PRIVATE_KEY, then poke Polymarket
 * APIs to figure out whether the EOA itself acts as the funder, or there's
 * a separate Magic/Safe proxy holding USDC.
 *
 * For POLY_SIGNATURE_TYPE=1, the proxy is created server-side by Polymarket
 * on first wallet bind. There's no public unauthenticated endpoint that maps
 * EOA → proxy. This script:
 *   1. Prints the signer EOA
 *   2. Queries data-api /positions?user=<EOA> (works if EOA == funder)
 *   3. Queries clob /balance-allowance with L2 creds (if .env has them) —
 *      the response includes the address Polymarket considers as the funder
 *   4. Reports findings + suggested .env line
 *
 * Usage:  node scripts/find-funder.js
 */
import dotenv from "dotenv";
import { ethers } from "ethers";

dotenv.config();

const { PRIVATE_KEY, POLY_API_KEY, POLY_API_SECRET, POLY_PASSPHRASE } = process.env;
if (!PRIVATE_KEY) {
  console.error("✗ PRIVATE_KEY missing in .env");
  process.exit(1);
}

const eoa = new ethers.Wallet(PRIVATE_KEY).address;
console.log(`signer EOA (from PRIVATE_KEY): ${eoa}\n`);

// 1. Does the EOA itself have any Polymarket trading history?
console.log("[1] data-api /positions?user=<EOA>");
try {
  const r = await fetch(`https://data-api.polymarket.com/positions?user=${eoa}&sizeThreshold=0.01`);
  const j = await r.json();
  if (Array.isArray(j) && j.length > 0) {
    console.log(`    ✓ EOA has ${j.length} active position(s) — EOA itself is the funder`);
    console.log(`    → Set FUNDER_ADDRESS=${eoa} in .env`);
  } else {
    console.log(`    ∅ EOA has no positions — proxy almost certainly separate`);
  }
} catch (e) {
  console.log(`    ✗ ${e.message}`);
}

// 2. data-api /value also surfaces USDC balance attached to a user
console.log("\n[2] data-api /value?user=<EOA>");
try {
  const r = await fetch(`https://data-api.polymarket.com/value?user=${eoa}`);
  const j = await r.json();
  console.log(`    ${JSON.stringify(j).slice(0, 200)}`);
} catch (e) {
  console.log(`    ✗ ${e.message}`);
}

// 3. If L2 creds exist, CLOB /balance-allowance returns the address Polymarket
//    treats as the funder. The endpoint requires HMAC-signed L2 headers — for
//    Magic-proxy users the response includes the proxy address.
if (POLY_API_KEY && POLY_API_SECRET && POLY_PASSPHRASE) {
  console.log("\n[3] clob /balance-allowance (L2 authenticated)");
  try {
    const { buildL2Headers } = await import("../src/clob-auth.js");
    // Try with both EOA and (no funder) — the response payload includes the
    // address-of-record that Polymarket associates with the API key.
    // Polymarket CLOB: GET /balance-allowance?asset_type=COLLATERAL returns USDC.
    // HMAC path must include the query string verbatim.
    const path = "/balance-allowance?asset_type=COLLATERAL";
    // Try both addresses: EOA (signer) and any FUNDER_ADDRESS in .env.
    // Polymarket validates POLY_ADDRESS against the API key's bound address.
    for (const addr of [eoa, process.env.FUNDER_ADDRESS].filter(Boolean)) {
      const headers = buildL2Headers({
        method: "GET", path,
        creds: { apiKey: POLY_API_KEY, secret: POLY_API_SECRET, passphrase: POLY_PASSPHRASE, address: addr },
      });
      const r = await fetch(`https://clob.polymarket.com${path}`, { headers });
      const txt = await r.text();
      console.log(`    POLY_ADDRESS=${addr} → [${r.status}] ${txt.slice(0, 300)}`);
    }
    // Polymarket sometimes returns the bound proxy in the error body or in a
    // 200 response containing { address, balance }
  } catch (e) {
    console.log(`    ✗ ${e.message}`);
  }
} else {
  console.log("\n[3] L2 creds (POLY_API_KEY/SECRET/PASSPHRASE) not in .env — skipping authenticated probe");
  console.log("    Run: node scripts/derive-api-key.js --env  to get them");
}

console.log("\n──── Next step ────");
console.log("If [1] showed positions → EOA is your funder. Set:");
console.log(`    FUNDER_ADDRESS=${eoa}`);
console.log("If [3] returned a different address → that's your Magic proxy. Set:");
console.log("    FUNDER_ADDRESS=<that address>");
console.log("If both empty → wallet is brand new, no positions yet. Need to either");
console.log("  (a) make a tiny test order to surface the proxy in the error response, or");
console.log("  (b) use a one-time login at polymarket.com to copy the proxy.");
