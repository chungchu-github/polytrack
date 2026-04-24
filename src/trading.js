/**
 * Trade Execution Engine (CLOB V2)
 * ────────────────────────────────
 * Handles EIP-712 order signing and submission for Polymarket CLOB V2
 * (cutover 2026-04-22). Key V2 differences vs V1:
 *   - Domain version "2"
 *   - New Exchange contract (CTF V2 + Neg Risk V2)
 *   - Order struct: removed taker/expiration/nonce/feeRateBps;
 *                   added timestamp(ms)/metadata(bytes32)/builder(bytes32)
 *   - Collateral changed from USDC.e to pUSD (backed 1:1 by USDC)
 *
 * V2 migration guide: https://docs.polymarket.com/v2-migration
 */

import { ethers } from "ethers";
import { fetchMidPrice, fetchOrderStatus, submitOrder, fetchOrderBook } from "./polymarket-api.js";

// ── Configuration ────────────────────────────────────────────────────────────
// V2 Exchange contracts (live 2026-04-22 ~11:00 UTC on clob.polymarket.com;
// already live on clob-v2.polymarket.com for testing).
export const EXCHANGE_V2_ADDRESS       = "0xE111180000d2663C0091e4f400237545B87B996B";
export const NEG_RISK_EXCHANGE_ADDRESS = "0xe2222d279d744050d28e00520010520000310F59";
const CHAIN_ID = 137; // Polygon

// bytes32 zero — used for metadata / builder when no builder-code attribution.
const ZERO_BYTES32 = "0x" + "0".repeat(64);
const BUILDER_CODE = process.env.POLY_BUILDER_CODE || "";

/**
 * Polymarket signature schemes (CLOB V2):
 *   0 = EOA                — self-custody; signer wallet IS the maker
 *   1 = POLY_PROXY         — Magic proxy (email / Google / social login) — MOST COMMON
 *   2 = POLY_GNOSIS_SAFE   — newer Safe-based proxy (some MetaMask/wallet-connect accounts)
 *
 * Default is 1 (POLY_PROXY) because social-login accounts (Magic) use this
 * scheme. Override via POLY_SIGNATURE_TYPE env var. To verify your own
 * account, open polymarket.com → place any $1 order → DevTools Network tab →
 * inspect the `signatureType` field in the POST /order request body.
 *
 * Reference: https://docs.polymarket.com/api-reference/authentication
 */
export const SIGNATURE_TYPE_EOA             = 0;
export const SIGNATURE_TYPE_POLY_PROXY       = 1;
export const SIGNATURE_TYPE_POLY_GNOSIS_SAFE = 2;

function getDefaultSignatureType() {
  const raw = process.env.POLY_SIGNATURE_TYPE;
  if (raw == null || raw === "") return SIGNATURE_TYPE_POLY_PROXY;
  const n = Number(raw);
  if (![0, 1, 2].includes(n)) {
    throw new Error(`POLY_SIGNATURE_TYPE must be 0, 1, or 2 (got "${raw}")`);
  }
  return n;
}

export function getExchangeDomain(negRisk = false) {
  return {
    name:              "Polymarket CTF Exchange",
    version:           "2",
    chainId:           CHAIN_ID,
    verifyingContract: negRisk ? NEG_RISK_EXCHANGE_ADDRESS : EXCHANGE_V2_ADDRESS,
  };
}

// EIP-712 type hash order must match the V2 Exchange contract exactly.
// Spec: https://docs.polymarket.com/v2-migration
export const ORDER_TYPES = {
  Order: [
    { name: "salt",          type: "uint256" },
    { name: "maker",         type: "address" },
    { name: "signer",        type: "address" },
    { name: "tokenId",       type: "uint256" },
    { name: "makerAmount",   type: "uint256" },
    { name: "takerAmount",   type: "uint256" },
    { name: "side",          type: "uint8"   },
    { name: "signatureType", type: "uint8"   },
    { name: "timestamp",     type: "uint256" },
    { name: "metadata",      type: "bytes32" },
    { name: "builder",       type: "bytes32" },
  ],
};

/**
 * Convert a builder code (string or hex) to a bytes32 value. Defaults to
 * ZERO_BYTES32 when no builder attribution is configured.
 */
function builderCodeToBytes32(code) {
  if (!code) return ZERO_BYTES32;
  if (/^0x[0-9a-fA-F]{64}$/.test(code)) return code;
  // Encode short string codes (e.g. "polytrack") as bytes32 via UTF-8 padding.
  try { return ethers.encodeBytes32String(code); }
  catch { return ZERO_BYTES32; }
}

// ── Token Resolution ─────────────────────────────────────────────────────────

/**
 * Resolve token ID from market data by matching the outcome name.
 * Does NOT rely on array index ordering.
 */
export function resolveTokenId(market, direction) {
  const tokens = market?.tokens;
  if (!Array.isArray(tokens) || tokens.length === 0) return null;

  const target = direction === "YES" ? "Yes" : "No";

  // Try matching by outcome field
  for (const t of tokens) {
    if (t.outcome === target && t.token_id) return t.token_id;
  }

  // Fallback: try case-insensitive match
  for (const t of tokens) {
    if (String(t.outcome).toLowerCase() === target.toLowerCase() && t.token_id) {
      return t.token_id;
    }
  }

  return null;
}

// ── Order Builder ────────────────────────────────────────────────────────────

/**
 * Build and sign an EIP-712 order for CLOB V2.
 *
 * @param {object} params
 * @param {string}  params.privateKey     - Wallet private key
 * @param {string}  params.funderAddress  - Polymarket proxy wallet address
 * @param {string}  params.tokenId        - Target token ID
 * @param {number}  params.price          - Limit price per token (slippage applied)
 * @param {number}  params.maxUsdc        - Maximum pUSD to spend (V2 collateral)
 * @param {boolean} [params.negRisk=false] - Route through Neg Risk CTF Exchange V2
 *                                            (required for multi-outcome markets)
 * @param {string}  [params.builderCode]  - Optional builder attribution code
 * @returns {object} { orderPayload, signature, orderData }
 *
 * NOTE (V2): nonce/expiration/feeRateBps/taker are removed from the struct.
 * Per-address uniqueness is now enforced by `timestamp` (ms), and order
 * validity follows the exchange's own TTL policy rather than a per-order
 * expiration field.
 */
/**
 * F1 building block — produce the V2 unsigned order struct + the EIP-712 domain
 * + the types schema, without needing a private key. The frontend (wagmi/viem)
 * or any remote signer calls this to get typed data, signs locally, then calls
 * `wrapOrderPayload` with the signature to produce the CLOB-ready wire body.
 *
 * This is the "non-custodial" entry point. Backend still composes build+sign
 * internally via `buildOrder()` below, so existing call sites are untouched.
 */
export function buildUnsignedOrder({
  signerAddress,
  funderAddress,
  tokenId,
  price,           // retained for callers' logging convenience
  maxUsdc,
  negRisk = false,
  builderCode,
  signatureType,
}) {
  if (!signerAddress) throw new Error("buildUnsignedOrder: signerAddress required");
  if (!funderAddress) throw new Error("buildUnsignedOrder: funderAddress required");
  if (!tokenId)       throw new Error("buildUnsignedOrder: tokenId required");
  if (!(price > 0))   throw new Error("buildUnsignedOrder: price must be > 0");
  if (!(maxUsdc > 0)) throw new Error("buildUnsignedOrder: maxUsdc must be > 0");

  const salt = BigInt("0x" + ethers.hexlify(ethers.randomBytes(8)).slice(2));
  const tokenQty    = Math.floor(maxUsdc / price);
  const makerAmount = BigInt(Math.round(maxUsdc * 1e6));    // pUSD 6 decimals
  const takerAmount = BigInt(Math.round(tokenQty * 1e6));   // outcome tokens 6 decimals
  const builderBytes = builderCodeToBytes32(builderCode ?? BUILDER_CODE);
  const sigType = signatureType ?? getDefaultSignatureType();

  const orderData = {
    salt,
    maker:         funderAddress,
    signer:        signerAddress,
    tokenId:       BigInt(tokenId),
    makerAmount,
    takerAmount,
    side:          0,                     // 0 = BUY (signing payload uint8)
    signatureType: sigType,
    timestamp:     BigInt(Date.now()),    // ms — replaces nonce for uniqueness
    metadata:      ZERO_BYTES32,
    builder:       builderBytes,
  };

  return {
    orderData,
    domain: getExchangeDomain(negRisk),
    types:  ORDER_TYPES,
  };
}

/**
 * F1 building block — sign typed data with a private key. Separated from
 * `buildUnsignedOrder` so the frontend path can swap this out for
 * `window.ethereum.signTypedData_v4` via wagmi/viem.
 */
export async function signOrder({ privateKey, orderData, domain }) {
  const wallet = new ethers.Wallet(privateKey);
  return wallet.signTypedData(domain, ORDER_TYPES, orderData);
}

/**
 * F1 building block — serialise a signed order into the JSON wire body the
 * CLOB `/order` endpoint expects. BigInts → decimal strings, side 0/1 → "BUY"/"SELL".
 */
export function wrapOrderPayload({ orderData, signature, orderType = "FOK" }) {
  return {
    order: {
      salt:          orderData.salt.toString(),
      maker:         orderData.maker,
      signer:        orderData.signer,
      tokenId:       orderData.tokenId.toString(),
      makerAmount:   orderData.makerAmount.toString(),
      takerAmount:   orderData.takerAmount.toString(),
      side:          orderData.side === 1 ? "SELL" : "BUY",
      signatureType: orderData.signatureType,
      timestamp:     orderData.timestamp.toString(),
      metadata:      orderData.metadata,
      builder:       orderData.builder,
      signature,
    },
    orderType,
  };
}

/**
 * Custodial convenience — unchanged public API. Composes the three primitives
 * above so every existing caller keeps working.
 */
export async function buildOrder(params) {
  const signerAddress = new ethers.Wallet(params.privateKey).address;
  const { orderData, domain } = buildUnsignedOrder({ ...params, signerAddress });
  const signature = await signOrder({ privateKey: params.privateKey, orderData, domain });
  const orderPayload = wrapOrderPayload({ orderData, signature });
  return { orderPayload, signature, orderData };
}

// ── Fill Verification ────────────────────────────────────────────────────────

/**
 * Map a raw CLOB order status into our canonical trade-status vocabulary.
 * Shared between the live polling path (verifyFill) and the boot-time
 * reconciliation path (sweepStaleOrders), so both agree on what each
 * CLOB status actually means.
 *
 * Returns one of: "FILLED" | "PARTIAL" | "CANCELLED" | "EXPIRED" |
 *                 "REJECTED" | "OPEN" | "UNKNOWN"
 *
 * - "OPEN" means the order is still live on the book.
 * - "UNKNOWN" means we got no answer (API down, bad ID, etc.) — callers
 *   should NOT mutate DB state on this.
 */
export function classifyClobOrderStatus(rawStatus) {
  if (rawStatus == null || rawStatus === "") return "UNKNOWN";
  const s = String(rawStatus).toUpperCase();
  if (s === "MATCHED" || s === "FILLED" || s === "MINED") return "FILLED";
  if (s === "PARTIAL" || s === "PARTIALLY_FILLED")        return "PARTIAL";
  if (s === "CANCELLED" || s === "EXPIRED" || s === "REJECTED") return s;
  if (s === "LIVE" || s === "OPEN" || s === "SUBMITTED" || s === "PENDING") return "OPEN";
  return "UNKNOWN";
}

/**
 * Poll order status to verify fill. Returns final status.
 *
 * @param {string} orderId
 * @param {object} headers - CLOB auth headers
 * @param {number} timeoutMs - max time to poll (default 10s)
 * @returns {{ status: string, filledSize: number|null }}
 */
export async function verifyFill(orderId, headers = {}, timeoutMs = 60_000) {
  if (!orderId) return { status: "UNKNOWN", filledSize: null, filledPrice: null };

  const start = Date.now();
  let delay = 500; // start at 500ms, double up to ~8s cap

  while (Date.now() - start < timeoutMs) {
    const order = await fetchOrderStatus(orderId, headers);
    if (order) {
      const s = (order.status || "").toUpperCase();
      const filledSize  = Number(order.size_matched || order.filledSize || 0) || null;
      const filledPrice = Number(order.price_matched || order.filledPrice || order.avg_price || 0) || null;

      if (s === "MATCHED" || s === "FILLED" || s === "MINED") {
        return { status: "FILLED", filledSize, filledPrice };
      }
      if (s === "PARTIAL" || s === "PARTIALLY_FILLED") {
        return { status: "PARTIAL", filledSize, filledPrice };
      }
      if (s === "CANCELLED" || s === "EXPIRED" || s === "REJECTED") {
        return { status: s, filledSize, filledPrice };
      }
      // Otherwise: SUBMITTED/PENDING — keep polling
    }

    await sleep(delay);
    delay = Math.min(delay * 2, 8000);
  }

  return { status: "UNKNOWN", filledSize: null, filledPrice: null };
}

// ── Pre-Trade Check ──────────────────────────────────────────────────────────

/**
 * Validates market + liquidity before signing/submitting an order.
 * Returns { ok: boolean, reason?, midPrice?, availableDepth? }.
 *
 * Does NOT check wallet USDC balance — that requires a chain RPC call and is
 * left to the caller (risk module tracks cumulative exposure instead).
 */
export async function preflightCheck(signal, tokenId, sizeUsdc) {
  // 1. Market must be active
  const market = signal.market || {};
  if (market.closed === true || market.active === false) {
    return { ok: false, reason: "Market closed or inactive" };
  }

  // 2. Mid-price must exist and be in valid range
  const midPrice = await fetchMidPrice(tokenId);
  if (midPrice == null || midPrice < 0.01 || midPrice > 0.99) {
    return { ok: false, reason: `Invalid mid-price ${midPrice} — market may be resolved` };
  }

  // 3. Orderbook depth on the ask side must cover our order.
  //    /book (2025-07+) returns neg_risk / min_order_size / tick_size inline.
  const book = await fetchOrderBook(tokenId);
  const negRisk  = !!(book?.neg_risk);
  const tickSize = book?.tick_size  ?? null;
  const minSize  = book?.min_order_size ?? null;
  if (book) {
    const shares = sizeUsdc / midPrice;

    // 3a. Reject before signing if shares < exchange's minimum order size.
    if (minSize != null && shares < minSize) {
      return {
        ok: false,
        reason: `Order size ${shares.toFixed(4)} shares < market minimum ${minSize}`,
        negRisk, tickSize, minSize,
      };
    }

    // 3b. Depth check (eat asks cheapest-first)
    const asks = book.asks.slice().sort((a, b) => a.price - b.price);
    let remaining = shares;
    let depthUsdc = 0;
    for (const level of asks) {
      const take = Math.min(level.size, remaining);
      depthUsdc += take * level.price;
      remaining -= take;
      if (remaining <= 0) break;
    }
    if (remaining > 0) {
      return {
        ok: false,
        reason: `Insufficient orderbook depth — ${depthUsdc.toFixed(2)} USDC available, need ${sizeUsdc}`,
        negRisk, tickSize, minSize,
      };
    }
    return { ok: true, midPrice, availableDepth: depthUsdc, negRisk, tickSize, minSize };
  }

  // If orderbook unavailable, don't block trade (soft-fail on depth only)
  return { ok: true, midPrice, availableDepth: null, negRisk, tickSize, minSize };
}

// ── Execute Copy Trade ───────────────────────────────────────────────────────

/**
 * Full trade execution flow: resolve token, get price, build order, submit, verify.
 *
 * @param {object} signal - Signal from signal engine
 * @param {object} config - { privateKey, funderAddress, maxTradeUsdc, slippagePct }
 * @returns {object} trade result
 *
 * V2 notes: L2 HMAC headers are no longer plumbed through. CLOB V2 authenticates
 * order submission and cancellation via the EIP-712 signature embedded in the
 * order body; server-side L2 headers are currently no-ops for our flow.
 */
export async function executeCopyTrade(signal, config) {
  const {
    privateKey,
    funderAddress,
    maxTradeUsdc = 100,
    slippagePct = 2,
  } = config;

  // Simulation mode if no credentials
  if (!privateKey || !funderAddress) {
    return {
      ...signal,
      size: maxTradeUsdc,
      status: "SIMULATED",
      simulatedAt: Date.now(),
    };
  }

  // 1. Resolve token ID by outcome name
  const tokenId = resolveTokenId(signal.market, signal.direction);
  if (!tokenId) {
    throw new Error(`Could not resolve token ID for ${signal.direction} in market ${signal.conditionId}`);
  }

  // 2. Preflight: market active, mid-price valid, orderbook depth sufficient
  const pre = await preflightCheck(signal, tokenId, maxTradeUsdc);
  if (!pre.ok) {
    throw new Error(`Preflight failed: ${pre.reason}`);
  }
  const midPrice = pre.midPrice;

  // 3. Apply slippage: for BUY we're willing to pay up to mid * (1 + slippage%),
  //    rounded to the market's tick_size (default 0.01 when unknown). Rounding
  //    down below the slipped price would risk no-fills, so we always round up.
  const tick = pre.tickSize && pre.tickSize > 0 ? pre.tickSize : 0.01;
  const raw  = midPrice * (1 + slippagePct / 100);
  const limitPrice = Math.round(Math.ceil(raw / tick) * tick * 1e6) / 1e6;

  // 4. Build and sign V2 order.
  //    Neg-risk routing: multi-outcome markets go through NEG_RISK_EXCHANGE V2.
  //    Detection sources, in priority order:
  //      (a) signal.market.negRisk (Gamma API field)
  //      (b) preflight book.neg_risk (CLOB /book field, 2025-07 addition)
  //      (c) default false (standard binary market)
  const negRisk = !!(signal?.market?.negRisk ?? pre.negRisk ?? false);

  const { orderPayload } = await buildOrder({
    privateKey,
    funderAddress,
    tokenId,
    price: limitPrice,
    maxUsdc: maxTradeUsdc,
    negRisk,
  });

  // 5. Submit to CLOB
  const { ok, data } = await submitOrder(orderPayload, {});

  const orderId = data?.orderID || data?.id;

  // 6. Verify fill (poll for up to 60s with exponential backoff)
  let finalStatus = ok ? "SUBMITTED" : "FAILED";
  let filledSize = null;
  let filledPrice = null;
  let slippageWarning;
  if (ok && orderId) {
    const fillResult = await verifyFill(orderId, {});
    if (fillResult.status !== "UNKNOWN") finalStatus = fillResult.status;
    filledSize  = fillResult.filledSize;
    filledPrice = fillResult.filledPrice;

    // Slippage validation: filled price should be <= limit price for BUY
    if (filledPrice != null && filledPrice > limitPrice) {
      slippageWarning = `Filled at ${filledPrice} > limit ${limitPrice}`;
    }
  }

  return {
    conditionId: signal.conditionId,
    title: signal.title,
    direction: signal.direction,
    walletCount: signal.walletCount,
    strength: signal.strength,
    tokenId,
    midPrice,
    limitPrice,
    size: maxTradeUsdc,
    filledSize,
    filledPrice,
    orderId,
    status: finalStatus,
    txHash: data?.transactionHash,
    error: !ok ? JSON.stringify(data).slice(0, 200) : slippageWarning,
    executedAt: Date.now(),
  };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
