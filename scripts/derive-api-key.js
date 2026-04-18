#!/usr/bin/env node
/**
 * derive-api-key.js — one-time bootstrap to obtain Polymarket L2 credentials.
 *
 * Runs an L1 ClobAuth EIP-712 signature against your `PRIVATE_KEY` and calls
 * GET /auth/derive-api-key. Prints the returned apiKey / secret / passphrase
 * so you can paste them into .env as POLY_API_KEY / POLY_API_SECRET /
 * POLY_PASSPHRASE. These credentials are stable (the endpoint returns the
 * same triple for the same signer on subsequent calls) — you only need to
 * run this once per wallet.
 *
 * Usage:
 *   node scripts/derive-api-key.js           # pretty-print
 *   node scripts/derive-api-key.js --env     # print in .env append format
 *   node scripts/derive-api-key.js --json    # machine-readable
 *
 * Safety:
 *   - Only reads your private key; never writes it to disk or a remote host.
 *   - Only outgoing network call is to clob.polymarket.com (or POLY_CLOB_URL).
 *   - The returned `secret` is a base64 HMAC key — treat it like a password.
 */

import dotenv from "dotenv";
import { deriveApiKey } from "../src/clob-auth.js";

dotenv.config();

function bail(msg, extra) {
  console.error(`✗ ${msg}`);
  if (extra) console.error(extra);
  process.exit(1);
}

const mode = process.argv.find(a => a === "--env" || a === "--json") || "--pretty";

async function main() {
  const { PRIVATE_KEY, POLY_CLOB_URL } = process.env;
  if (!PRIVATE_KEY) bail("PRIVATE_KEY not set in env. Put your Polymarket signer key in .env first.");

  const clobUrl = POLY_CLOB_URL || "https://clob.polymarket.com";
  if (mode === "--pretty") {
    console.error(`→ Deriving L2 credentials from ${clobUrl}…`);
  }

  let creds;
  try {
    creds = await deriveApiKey({ privateKey: PRIVATE_KEY, clobUrl });
  } catch (e) {
    bail("derive-api-key call failed", e?.stack || e.message);
  }

  if (mode === "--json") {
    console.log(JSON.stringify(creds, null, 2));
    return;
  }

  if (mode === "--env") {
    // Paste-into-.env format
    console.log(`POLY_API_KEY=${creds.apiKey}`);
    console.log(`POLY_API_SECRET=${creds.secret}`);
    console.log(`POLY_PASSPHRASE=${creds.passphrase}`);
    return;
  }

  // Pretty output
  console.log();
  console.log("  ✓ L2 credentials derived. Add these three lines to your .env:");
  console.log();
  console.log(`    POLY_API_KEY=${creds.apiKey}`);
  console.log(`    POLY_API_SECRET=${creds.secret}`);
  console.log(`    POLY_PASSPHRASE=${creds.passphrase}`);
  console.log();
  console.log("  ⚠  Treat the secret like a password. Don't commit .env to git.");
  console.log("  ℹ  Re-running this script returns the SAME triple — it's idempotent.");
  console.log();
}

main().catch((e) => bail("Unhandled exception", e?.stack || e));
