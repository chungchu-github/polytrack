/**
 * Polymarket CLOB Authentication (L1 + L2)
 * ────────────────────────────────────────
 * Polymarket's CLOB uses two-tier auth for trading endpoints:
 *
 *   L1 — EIP-712 "ClobAuth" signature. Proves wallet ownership. Used to
 *        derive or fetch the L2 API credentials via GET /auth/derive-api-key.
 *        The ClobAuth domain stays at version "1" even after the CLOB V2
 *        migration — only the Exchange domain bumped to "2".
 *
 *   L2 — HMAC-SHA256 headers (POLY-API-KEY / POLY-PASSPHRASE / POLY-SIGNATURE /
 *        POLY-TIMESTAMP). Required on every trading request (POST /order,
 *        DELETE /order, GET /order/:id). The HMAC key is the base64-decoded
 *        `secret` returned from derive-api-key.
 *
 * Reference: https://docs.polymarket.com/api-reference/authentication
 */

import crypto from "node:crypto";
import { ethers } from "ethers";
import fetch from "node-fetch";
import log from "./logger.js";

// ── L1: ClobAuth EIP-712 ────────────────────────────────────────────────────

const CLOB_AUTH_DOMAIN = {
  name:    "ClobAuthDomain",
  version: "1",           // unchanged post-V2 migration
  chainId: 137,           // Polygon
};

const CLOB_AUTH_TYPES = {
  ClobAuth: [
    { name: "address",   type: "address" },
    { name: "timestamp", type: "string"  },
    { name: "nonce",     type: "uint256" },
    { name: "message",   type: "string"  },
  ],
};

const CLOB_AUTH_MESSAGE = "This message attests that I control the given wallet";

/**
 * Sign an L1 ClobAuth EIP-712 message. Returns `{ signature, address, timestamp, nonce }`
 * — the four values that make up the L1 request headers.
 *
 * @param {object} params
 * @param {string} params.privateKey      - Signer EOA private key
 * @param {number} [params.timestamp]     - Unix SECONDS (defaults to now)
 * @param {number} [params.nonce=0]       - L1 replay nonce (0 is fine for derive-api-key)
 */
export async function signClobAuth({ privateKey, timestamp, nonce = 0 }) {
  const wallet = new ethers.Wallet(privateKey);
  const ts = String(timestamp ?? Math.floor(Date.now() / 1000));
  const payload = {
    address:   wallet.address,
    timestamp: ts,
    nonce:     BigInt(nonce),
    message:   CLOB_AUTH_MESSAGE,
  };
  const signature = await wallet.signTypedData(CLOB_AUTH_DOMAIN, CLOB_AUTH_TYPES, payload);
  return { signature, address: wallet.address, timestamp: ts, nonce };
}

/**
 * Build the L1 header bag (POLY-ADDRESS / POLY-SIGNATURE / POLY-TIMESTAMP /
 * POLY-NONCE) from a signClobAuth() result.
 */
export function buildL1Headers({ address, signature, timestamp, nonce = 0 }) {
  return {
    "POLY_ADDRESS":   address,
    "POLY_SIGNATURE": signature,
    "POLY_TIMESTAMP": String(timestamp),
    "POLY_NONCE":     String(nonce),
  };
}

/**
 * Call GET /auth/derive-api-key on the CLOB to obtain (or re-derive) this
 * signer's L2 credentials. Polymarket tolerates calling this repeatedly — it
 * returns the same triple for the same signer. Safe to run from a bootstrap
 * CLI without side effects.
 *
 * @param {object} params
 * @param {string} params.privateKey   - Signer EOA private key
 * @param {string} [params.clobUrl]    - CLOB base URL (env POLY_CLOB_URL or prod default)
 * @returns {Promise<{apiKey:string, secret:string, passphrase:string}>}
 */
export async function deriveApiKey({ privateKey, clobUrl }) {
  const base = clobUrl || process.env.POLY_CLOB_URL || "https://clob.polymarket.com";
  const auth = await signClobAuth({ privateKey });
  const headers = {
    "Content-Type": "application/json",
    ...buildL1Headers(auth),
  };
  const res = await fetch(`${base}/auth/derive-api-key`, {
    method: "GET",
    headers,
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`derive-api-key failed: HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  // Response keys come back as apiKey/secret/passphrase (camelCase).
  if (!data?.apiKey || !data?.secret || !data?.passphrase) {
    throw new Error(`derive-api-key returned malformed payload: ${JSON.stringify(data).slice(0, 200)}`);
  }
  return { apiKey: data.apiKey, secret: data.secret, passphrase: data.passphrase };
}

// ── L2: HMAC-SHA256 headers ─────────────────────────────────────────────────

/**
 * Compute the base64url-encoded HMAC-SHA256 signature that Polymarket
 * requires in the POLY_SIGNATURE header for every trading request.
 *
 *   sig = base64url(HMAC-SHA256(base64url_decode(secret), timestamp + method + path + body))
 *
 * Matches py-clob-client's signing/hmac.py behaviour exactly:
 *   - `secret` is URL-safe base64 → decode with `base64url` (Node ≥16).
 *   - `path` is the request path INCLUDING query string, excluding origin.
 *   - `body` is the raw JSON string for POST/DELETE; "" for GET.
 *   - Encoding is base64url WITHOUT padding (RFC 4648 §5).
 *   - No separator characters between timestamp/method/path/body.
 */
export function computeHmac({ secret, timestamp, method, path, body = "" }) {
  const keyBytes = Buffer.from(secret, "base64url");
  const msg = `${timestamp}${String(method).toUpperCase()}${path}${body || ""}`;
  const sig = crypto.createHmac("sha256", keyBytes).update(msg).digest();
  // Node's "base64url" encoding strips padding and uses -/_ by default.
  return sig.toString("base64url");
}

/**
 * Build the L2 header bag for a single trading request.
 *
 * Polymarket requires FIVE L2 headers (all underscores, matching py-clob-client):
 *   POLY_ADDRESS, POLY_API_KEY, POLY_PASSPHRASE, POLY_SIGNATURE, POLY_TIMESTAMP
 *
 * @param {object} params
 * @param {object} params.creds    - { apiKey, secret, passphrase, address }
 * @param {string} params.method   - "GET" | "POST" | "DELETE"
 * @param {string} params.path     - Path incl. query string (e.g. "/order" or "/order/abc")
 * @param {string|object} [params.body] - Request body — object is JSON.stringify'd
 */
export function buildL2Headers({ creds, method, path, body }) {
  if (!creds?.apiKey || !creds?.secret || !creds?.passphrase || !creds?.address) {
    return {}; // incomplete creds → no headers; upstream will 401 if required
  }
  const timestamp = String(Math.floor(Date.now() / 1000));
  const bodyStr = body == null
    ? ""
    : (typeof body === "string" ? body : JSON.stringify(body));
  const signature = computeHmac({
    secret: creds.secret,
    timestamp,
    method,
    path,
    body: bodyStr,
  });
  return {
    "POLY_ADDRESS":    creds.address,
    "POLY_API_KEY":    creds.apiKey,
    "POLY_PASSPHRASE": creds.passphrase,
    "POLY_TIMESTAMP":  timestamp,
    "POLY_SIGNATURE":  signature,
  };
}

// Cache the signer address so we don't re-derive it from PRIVATE_KEY on every
// request (ethers.Wallet construction is non-trivial).
let _cachedSignerAddress = null;
let _cachedSignerKey = null;

function deriveSignerAddress() {
  const pk = process.env.PRIVATE_KEY;
  if (!pk) return null;
  if (_cachedSignerAddress && _cachedSignerKey === pk) return _cachedSignerAddress;
  try {
    const addr = new ethers.Wallet(pk).address;
    _cachedSignerAddress = addr;
    _cachedSignerKey = pk;
    return addr;
  } catch {
    return null;
  }
}

/**
 * Resolve L2 credentials from the environment. Returns null if any piece is
 * missing — callers should treat that as "L2 auth not configured" and either
 * warn, bootstrap via derive-api-key, or fall back to simulation mode.
 *
 * The `address` field is the signer EOA (derived from PRIVATE_KEY) — the same
 * address that signs order payloads. Polymarket includes it in POLY_ADDRESS
 * to map the HMAC request back to an EOA.
 */
export function getEnvCreds() {
  const { POLY_API_KEY, POLY_API_SECRET, POLY_PASSPHRASE } = process.env;
  if (!POLY_API_KEY || !POLY_API_SECRET || !POLY_PASSPHRASE) return null;
  const address = deriveSignerAddress();
  if (!address) return null;
  return {
    apiKey:     POLY_API_KEY,
    secret:     POLY_API_SECRET,
    passphrase: POLY_PASSPHRASE,
    address,
  };
}

/**
 * Convenience: build L2 headers from the env creds. Returns {} when creds
 * are missing (so callers can keep a uniform signature).
 */
export function l2HeadersFromEnv({ method, path, body }) {
  const creds = getEnvCreds();
  if (!creds) {
    log.warn?.("L2 auth creds incomplete (need PRIVATE_KEY + POLY_API_KEY/SECRET/PASSPHRASE) — run scripts/derive-api-key.js");
    return {};
  }
  return buildL2Headers({ creds, method, path, body });
}
