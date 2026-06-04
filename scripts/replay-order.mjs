/**
 * replay-order.mjs — DIAGNOSTIC, READ-ONLY. NEVER SUBMITS AN ORDER.
 *
 * Replays the live order-construction path (resolveTokenId → preflightCheck →
 * buildOrder) against CURRENT markets and inspects the resulting signed order
 * WITHOUT calling submitOrder. Purpose: prove whether TODAY's code produces a
 * CLOB-valid order, isolating the historical failure modes seen in `trades`:
 *
 *   "invalid price, must be >0 and <1"   → limitPrice >= 1   (priceOk=false)
 *   "invalid amounts, max 2/5 decimals"  → maker/taker not quantised (amountsOk=false)
 *   "Could not resolve token ID"         → tokens[] mapping  (token=false)
 *   "invalid signature" / neg-risk       → wrong exchange domain (exchange flag)
 *   preflight rejects                    → closed / mid / depth / min-size (expected, not bugs)
 *
 * SAFETY: buildOrder signs locally (offline, no network, no money). submitOrder
 * is never called, so no order ever reaches the book. The private key never
 * leaves the box. Signature-acceptance / balance / region can only be confirmed
 * by an actual $5 submit — that is a SEPARATE, explicit step, not this script.
 *
 * Usage:
 *   node scripts/replay-order.mjs <conditionId> [YES|NO] [sizeUsdc]
 *   node scripts/replay-order.mjs --auto [count]     # sample current markets
 */
import "dotenv/config";
import {
  resolveTokenId, preflightCheck, buildOrder,
  getExchangeDomain, EXCHANGE_V2_ADDRESS, NEG_RISK_EXCHANGE_ADDRESS,
} from "../src/trading.js";
import { fetchMarketsByConditionIds, fetchMarkets } from "../src/polymarket-api.js";
import { loadConfig } from "../src/config.js";

const PRIVATE_KEY    = process.env.PRIVATE_KEY || "";
const FUNDER_ADDRESS = process.env.FUNDER_ADDRESS || "";
const SLIPPAGE_PCT   = loadConfig().slippagePct ?? 2;
const DEFAULT_SIZE   = 5;
const SIG_LABEL = { 0: "EOA", 1: "POLY_PROXY", 2: "GNOSIS_SAFE", 3: "POLY_1271" };

if (!PRIVATE_KEY || !FUNDER_ADDRESS) {
  console.error("✗ PRIVATE_KEY / FUNDER_ADDRESS missing from .env — cannot build/sign. Aborting (nothing submitted).");
  process.exit(1);
}

// Verbatim mirror of executeCopyTrade's limit-price calc (trading.js L678-680).
function calcLimitPrice(midPrice, tickSize) {
  const tick = tickSize && tickSize > 0 ? tickSize : 0.01;
  const raw  = midPrice * (1 + SLIPPAGE_PCT / 100);
  return Math.round(Math.ceil(raw / tick) * tick * 1e6) / 1e6;
}

async function replayOne(market, eventTitle, direction, sizeUsdc) {
  const title = (market.question || eventTitle || "").slice(0, 42);
  const r = {
    title, dir: direction, negRisk: null, token: false, preflight: "",
    limit: null, priceOk: null, maker: null, taker: null, amountsOk: null,
    sig: null, exchangeOk: null, verdict: "",
  };

  // 1. token resolution
  const tokenId = resolveTokenId(market, direction);
  if (!tokenId) { r.verdict = "✗ token-resolve"; return r; }
  r.token = true;

  // 2. preflight (hits live CLOB mid-price + orderbook)
  let pre;
  try {
    pre = await preflightCheck({ market, direction, conditionId: market.conditionId }, tokenId, sizeUsdc);
  } catch (e) { r.verdict = `✗ preflight-threw: ${e.message.slice(0,32)}`; return r; }
  r.negRisk = pre.negRisk ?? null;
  if (!pre.ok) { r.preflight = (pre.reason || "").slice(0,38); r.verdict = "— preflight-skip (not a bug)"; return r; }
  r.preflight = "ok";

  // 3. limit price (mirrored) — the "invalid price" check
  const limit = calcLimitPrice(pre.midPrice, pre.tickSize);
  r.limit = limit;
  r.priceOk = limit > 0 && limit < 1;

  // 4. neg-risk routing (same precedence as executeCopyTrade)
  const negRisk = !!(market.negRisk ?? pre.negRisk ?? false);
  r.negRisk = negRisk;

  // 5. build + SIGN (offline) — never submitted
  try {
    const { orderData } = await buildOrder({
      privateKey: PRIVATE_KEY, funderAddress: FUNDER_ADDRESS,
      tokenId, price: limit, maxUsdc: sizeUsdc, negRisk,
    });
    r.maker = orderData.makerAmount.toString();
    r.taker = orderData.takerAmount.toString();
    r.sig = SIG_LABEL[orderData.signatureType] ?? String(orderData.signatureType);
    // CLOB V2 BUY: maker (USDC, 6dp) max 2 decimals → multiple of 1e4;
    //             taker (tokens, 6dp) max 5 decimals → multiple of 10.
    const makerOk = BigInt(orderData.makerAmount) % 10000n === 0n;
    const takerOk = BigInt(orderData.takerAmount) % 10n === 0n;
    r.amountsOk = makerOk && takerOk;
    const want = (negRisk ? NEG_RISK_EXCHANGE_ADDRESS : EXCHANGE_V2_ADDRESS).toLowerCase();
    r.exchangeOk = getExchangeDomain(negRisk).verifyingContract.toLowerCase() === want;
    const probs = [
      !r.priceOk && "price>=1",
      !r.amountsOk && "amounts",
      !r.exchangeOk && "exchange",
    ].filter(Boolean);
    r.verdict = probs.length ? `✗ ${probs.join(",")}` : "✓ CLOB-valid construction";
  } catch (e) {
    r.verdict = `✗ build/sign threw: ${e.message.slice(0,36)}`;
  }
  return r;
}

async function main() {
  const args = process.argv.slice(2);
  const targets = [];

  if (args[0] && args[0] !== "--auto") {
    const cid = args[0];
    const dir = (args[1] || "NO").toUpperCase();
    const sz  = Number(args[2]) || DEFAULT_SIZE;
    const events = await fetchMarketsByConditionIds([cid]);
    if (!events.length || !events[0].markets?.length) {
      console.error(`✗ no market found for conditionId ${cid}`); process.exit(1);
    }
    targets.push({ market: events[0].markets[0], eventTitle: events[0].title, dir, size: sz });
  } else {
    const n = Number(args[1]) || 10;
    const events = await fetchMarkets({ limit: 40 });
    const flat = [];
    for (const e of events) for (const m of (e.markets || [])) flat.push({ market: m, eventTitle: e.title });
    for (const f of flat.slice(0, n)) targets.push({ ...f, dir: "NO", size: DEFAULT_SIZE });
  }

  console.log(`\nReplaying ${targets.length} market(s) — slippage ${SLIPPAGE_PCT}%, size $${DEFAULT_SIZE}.`);
  console.log("*** READ-ONLY: orders are built + signed locally, NOTHING is submitted. ***\n");

  const rows = [];
  for (const t of targets) rows.push(await replayOne(t.market, t.eventTitle, t.dir, t.size));

  console.table(rows.map(r => ({
    title: r.title, dir: r.dir, negRisk: r.negRisk, token: r.token,
    preflight: r.preflight, limit: r.limit, priceOk: r.priceOk,
    amountsOk: r.amountsOk, sig: r.sig, exchangeOk: r.exchangeOk, verdict: r.verdict,
  })));

  if (targets.length === 1) {
    console.log("\nFull order amounts (micro-units, 6dp):");
    console.log(`  makerAmount=${rows[0].maker}  takerAmount=${rows[0].taker}`);
  }

  const built = rows.filter(r => r.amountsOk != null);
  const bad   = built.filter(r => r.verdict.startsWith("✗"));
  console.log(`\n${built.length} order(s) fully constructed; ${bad.length} would be CLOB-rejected on construction.`);
  console.log("'— preflight-skip' rows are NOT bugs — preflight correctly refusing dead/illiquid markets.");
  console.log("\nNOTE: this verifies LOCAL construction only. signature-acceptance, balance, and");
  console.log("region-restriction can only be confirmed by an actual $5 submit (a separate, explicit step).");
}

main().catch(e => { console.error("replay failed:", e); process.exit(1); });
