/**
 * Polymarket API Client
 * Handles all external API calls with retry, rate limiting, and circuit breaker.
 */

import fetch from "node-fetch";
import log from "./logger.js";
import { l2HeadersFromEnv } from "./clob-auth.js";

// ── API Endpoints ────────────────────────────────────────────────────────────
const GAMMA_API = "https://gamma-api.polymarket.com";
const DATA_API  = "https://data-api.polymarket.com";
// CLOB V2 cutover 2026-04-22 ~11:00 UTC: production host auto-routes to V2
// after the switchover, so no URL change is required post-cutover. Set
// POLY_CLOB_URL=https://clob-v2.polymarket.com during pre-cutover testing.
const CLOB_API  = process.env.POLY_CLOB_URL || "https://clob.polymarket.com";
const CLOB_WS   = (process.env.POLY_CLOB_URL || "https://clob.polymarket.com")
  .replace(/^https/, "wss") + "/ws";

// ── Circuit Breaker State ────────────────────────────────────────────────────
const circuits = new Map(); // endpoint -> { failures, openUntil }

const CIRCUIT_THRESHOLD = 3;      // consecutive failures to trip
const CIRCUIT_COOLDOWN  = 60_000; // ms to wait before retrying

function getCircuit(endpoint) {
  if (!circuits.has(endpoint)) circuits.set(endpoint, { failures: 0, openUntil: 0 });
  return circuits.get(endpoint);
}

function recordSuccess(endpoint) {
  const c = getCircuit(endpoint);
  c.failures = 0;
  c.openUntil = 0;
}

function recordFailure(endpoint) {
  const c = getCircuit(endpoint);
  c.failures++;
  if (c.failures >= CIRCUIT_THRESHOLD) {
    c.openUntil = Date.now() + CIRCUIT_COOLDOWN;
  }
}

function isCircuitOpen(endpoint) {
  const c = getCircuit(endpoint);
  if (c.openUntil === 0) return false;
  if (Date.now() > c.openUntil) {
    // half-open: allow one request through
    c.openUntil = 0;
    c.failures = 0;
    return false;
  }
  return true;
}

// ── Request Queue (concurrency limiter) ──────────────────────────────────────
const MAX_CONCURRENT = 3;
let activeRequests = 0;
const queue = [];

function enqueue(fn) {
  return new Promise((resolve, reject) => {
    const run = async () => {
      activeRequests++;
      try {
        resolve(await fn());
      } catch (e) {
        reject(e);
      } finally {
        activeRequests--;
        if (queue.length > 0) queue.shift()();
      }
    };
    if (activeRequests < MAX_CONCURRENT) {
      run();
    } else {
      queue.push(run);
    }
  });
}

// ── Core Fetch with Retry ────────────────────────────────────────────────────
async function apiFetch(url, opts = {}, { retries = 3, backoff = 1000 } = {}) {
  const endpoint = new URL(url).hostname;

  if (isCircuitOpen(endpoint)) {
    throw new Error(`Circuit open for ${endpoint} — backing off`);
  }

  return enqueue(async () => {
    let lastError;
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const res = await fetch(url, {
          ...opts,
          headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
          signal: AbortSignal.timeout(opts.timeout || 10_000),
        });

        if (res.status === 429) {
          // rate limited — wait and retry
          const retryAfter = Number(res.headers.get("retry-after") || 2) * 1000;
          await sleep(retryAfter);
          continue;
        }

        if (!res.ok) {
          throw new Error(`HTTP ${res.status} from ${url}`);
        }

        const data = await res.json();
        recordSuccess(endpoint);
        return data;
      } catch (e) {
        lastError = e;
        if (attempt < retries - 1) {
          await sleep(backoff * Math.pow(2, attempt));
        }
      }
    }

    recordFailure(endpoint);
    throw lastError;
  });
}

// ── Polymarket-Specific API Methods ──────────────────────────────────────────

/**
 * Gamma API returns arrays as JSON strings (`"[\"Yes\",\"No\"]"`) on market
 * objects. Normalise once at the boundary so downstream code (datacapture,
 * resolveTokenId, signal engine, frontend) gets native arrays.
 */
export function parseJsonArray(v) {
  if (Array.isArray(v)) return v;
  if (typeof v !== "string") return [];
  try {
    const parsed = JSON.parse(v);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

/**
 * Rebuild the synthetic `tokens: [{token_id, outcome, price}]` structure from
 * Gamma's flat fields (`clobTokenIds`, `outcomes`, `outcomePrices`). Polymarket
 * deprecated the nested `tokens` array — this adapter keeps our internal
 * contract stable so we don't have to touch every call site.
 */
export function normaliseMarket(m = {}) {
  const tokenIds = parseJsonArray(m.clobTokenIds);
  const outcomes = parseJsonArray(m.outcomes);
  const prices   = parseJsonArray(m.outcomePrices);

  // Preserve legacy shape if server already gave us tokens (defensive — won't
  // happen against real Gamma today but keeps fixtures compatible).
  const legacy = Array.isArray(m.tokens) ? m.tokens : null;

  const tokens = legacy && legacy.length
    ? legacy
    : tokenIds.map((id, i) => ({
        token_id: id,
        outcome:  outcomes[i] ?? null,
        price:    Number(prices[i] ?? m.lastTradePrice ?? 0) || 0,
      }));

  return {
    id:            m.id,
    conditionId:   m.conditionId,
    question:      m.question,
    outcomePrices: prices,              // array (was JSON string)
    outcomes,                           // array (was JSON string)
    negRisk:       !!m.negRisk,
    active:        m.active !== false && m.acceptingOrders !== false,
    closed:        !!m.closed,
    minOrderSize:  Number(m.orderMinSize || 0) || null,
    tickSize:      Number(m.orderPriceMinTickSize || 0) || null,
    lastTradePrice: Number(m.lastTradePrice || 0) || null,
    bestAsk:       Number(m.bestAsk || 0) || null,
    tokens,
  };
}

/**
 * Fetch active markets (events) from Gamma API.
 *
 * Gamma's `GET /events` response shape (verified 2026-04 against live API):
 *   - events[].markets[] carries flat fields — no nested `tokens` array.
 *   - `clobTokenIds` / `outcomes` / `outcomePrices` are JSON-STRINGIFIED arrays.
 *   - `negRisk`, `orderMinSize`, `orderPriceMinTickSize` etc. live on `markets[]`.
 * `normaliseMarket` rebuilds the synthetic `tokens: [{token_id, outcome, price}]`
 * shape so downstream consumers don't know Gamma changed.
 */
/**
 * Recently-active conditionIds discovered from the platform-wide /trades
 * feed. This is the THIRD market-discovery source and the only one that
 * surfaces markets with currently-active orderbooks — verified live: trades
 * happen every 2-30s on Polymarket, and any cid in the recent-trades feed
 * has by definition just had orderbook activity, so capturing its book
 * within seconds returns real (non-sentinel) bids/asks.
 *
 * Unlike the volume_24hr sweep (post-resolution noise) and the tracked-
 * wallet positions (ELITE entered hours/days ago, market now stale),
 * this source IS where buyable books exist right now.
 *
 * Returns up to `cap` unique cids, ordered most-recent-first. We pull
 * `limit` raw trades and dedup — Polymarket's /trades caps at ~500 per
 * request and many trades cluster on a few hot markets, so 500 raw
 * trades typically yields 50-150 unique cids.
 */
/**
 * Pure helper — sort trades newest-first, dedup conditionIds, cap.
 * Exported for unit testing without the network call.
 */
export function extractRecentlyActiveCids(trades, cap = 150) {
  if (!Array.isArray(trades)) return [];
  const sorted = [...trades].sort(
    (a, b) => Number(b?.timestamp || 0) - Number(a?.timestamp || 0)
  );
  const seen = new Set();
  const out = [];
  for (const t of sorted) {
    const cid = t?.conditionId;
    if (!cid || seen.has(cid)) continue;
    seen.add(cid);
    out.push(cid);
    if (out.length >= cap) break;
  }
  return out;
}

export async function fetchRecentlyActiveCids({ limit = 500, cap = 150 } = {}) {
  let trades;
  try {
    trades = await apiFetch(`${DATA_API}/trades?limit=${limit}`);
  } catch {
    return [];
  }
  return extractRecentlyActiveCids(trades, cap);
}

/**
 * Fetch raw market metadata for a list of conditionIds. Used by the scan
 * loop to discover markets that tracked wallets are positioned in (which
 * is what consensus actually trades on), separate from the broad
 * top-100-by-volume sweep that's mostly post-resolution noise.
 *
 * Why this exists: live VPS data (2026-04-26) showed `/events?order=volume_24hr`
 * returns 100% sentinel-orderbook events — long-tail post-resolution markets
 * that accumulated volume historically. Tracked-wallet positions, by contrast,
 * are markets ELITE wallets actively chose, so they're more likely to have
 * tradeable books. Ground-truthed: 14 wallets → ~1900 unique conditionIds vs
 * the broad source's 100 → 0 liquid.
 *
 * Returns an event-shaped array — same structure as fetchMarkets so the rest
 * of the pipeline (capture / filter / strategies) needs no changes. We
 * synthesize one event per market (no real "event" parent for arbitrary
 * markets), title falling back to the market question.
 *
 * Chunks at `batchSize` cids per request — Gamma's URL length cap means
 * cramming 200+ ids into one request silently truncates.
 */
export async function fetchMarketsByConditionIds(conditionIds, { batchSize = 50 } = {}) {
  const cids = [...new Set((conditionIds || []).filter(Boolean).map(String))];
  if (cids.length === 0) return [];

  const out = [];
  for (let i = 0; i < cids.length; i += batchSize) {
    const chunk = cids.slice(i, i + batchSize);
    // Repeated query param (verified against live API): condition_ids=A&condition_ids=B.
    const qs = chunk.map(c => `condition_ids=${encodeURIComponent(c)}`).join("&");
    let markets;
    try {
      markets = await apiFetch(`${GAMMA_API}/markets?${qs}&limit=${chunk.length}`);
    } catch {
      // One bad chunk shouldn't kill the whole discovery — skip and continue.
      continue;
    }
    if (!Array.isArray(markets)) continue;
    for (const m of markets) {
      if (!m?.conditionId) continue;
      const norm = normaliseMarket(m);
      out.push({
        id:     m.id,
        slug:   m.slug || `cid-${String(m.conditionId).slice(0, 10)}`,
        title:  m.question || "",
        volume: Number(m.volume || m.volumeNum || 0) || null,
        markets: [norm],
      });
    }
  }
  return out;
}

// Default bumped from 20 → 100 (PR liquid-filter): event-level volume_24hr
// rank doesn't predict whether outcome tokens have real orderbooks today,
// so we over-fetch and let filterLiquidMarkets drop the placeholder events.
export async function fetchMarkets({ limit = 100 } = {}) {
  const events = await apiFetch(
    `${GAMMA_API}/events?active=true&closed=false&order=volume_24hr&ascending=false&limit=${limit}`
  );
  return (Array.isArray(events) ? events : []).slice(0, limit).map(e => ({
    id:     e.id,
    slug:   e.slug,
    title:  e.title,
    volume: e.volume,
    markets: (e.markets || []).map(normaliseMarket),
  }));
}

/**
 * Fetch trade activity for a wallet.
 * Throws on failure — caller decides whether to use cached data.
 *
 * NOTE (2025-08-26): Data API capped `limit` at 500 and `offset` at 1000.
 * To read beyond 500 records, paginate with `offset=500, 1000, …` (stop at 1000).
 */
export async function fetchWalletTrades(addr, { limit = 200, offset = 0 } = {}) {
  const bounded = Math.min(Math.max(1, limit), 500);
  const off     = Math.min(Math.max(0, offset), 1000);
  const data = await apiFetch(
    `${DATA_API}/activity?user=${addr}&type=TRADE&limit=${bounded}&offset=${off}`
  );
  return Array.isArray(data) ? data : [];
}

/**
 * Fetch current positions for a wallet.
 * Throws on failure — caller decides whether to use cached data.
 */
export async function fetchWalletPositions(addr) {
  const data = await apiFetch(
    `${DATA_API}/positions?user=${addr}&sizeThreshold=0.1`
  );
  return Array.isArray(data) ? data : [];
}

// ── Leaderboard scraping ────────────────────────────────────────────────────
//
// Polymarket retired their public data-api leaderboard endpoint. The web app
// now hydrates the leaderboard via the Next.js `_next/data/<buildId>/...json`
// route. The buildId rotates on every Polymarket deploy so we have to fetch
// the homepage HTML, regex it out, then fetch the data file.
//
// Cached for 10 minutes to avoid pounding the homepage on every scan.

const POLYMARKET_HOST = "https://polymarket.com";
const BUILD_ID_TTL_MS = 10 * 60_000;
let _buildIdCache = { id: null, fetchedAt: 0 };

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/130.0 Safari/537.36";

/**
 * Pull the Next.js buildId out of the homepage HTML. Exported pure so tests
 * can feed in a fixture without hitting the network.
 *
 * @returns {string | null}
 */
export function extractBuildId(html) {
  if (typeof html !== "string") return null;
  const m = html.match(/"buildId":"(build-[A-Za-z0-9_-]+)"/);
  return m ? m[1] : null;
}

/**
 * Normalise the dehydrated Next.js Query payload into a flat array of
 * { proxyWallet, pnl, volume, pseudonym, rank }. Exported pure for testing.
 */
export function parseLeaderboardJson(payload) {
  const queries = payload?.pageProps?.dehydratedState?.queries;
  if (!Array.isArray(queries) || queries.length === 0) return [];
  // Some routes include multiple queries (e.g. one per category). The
  // leaderboard route puts the rows in the first one's data array.
  const data = queries[0]?.state?.data;
  if (!Array.isArray(data)) return [];
  return data
    .map(r => ({
      rank:        Number(r.rank) || null,
      proxyWallet: (r.proxyWallet || r.address || "").toLowerCase(),
      pnl:         Number(r.pnl) || 0,
      volume:      Number(r.volume ?? r.amount) || 0,
      pseudonym:   r.pseudonym || r.name || null,
    }))
    .filter(r => /^0x[a-f0-9]{40}$/.test(r.proxyWallet));
}

async function getBuildId({ force = false } = {}) {
  const now = Date.now();
  if (!force && _buildIdCache.id && now - _buildIdCache.fetchedAt < BUILD_ID_TTL_MS) {
    return _buildIdCache.id;
  }
  const res = await fetch(`${POLYMARKET_HOST}/leaderboard`, {
    headers: { "User-Agent": BROWSER_UA },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Polymarket homepage returned ${res.status}`);
  const html = await res.text();
  const id = extractBuildId(html);
  if (!id) throw new Error("Could not locate buildId in Polymarket homepage HTML");
  _buildIdCache = { id, fetchedAt: now };
  return id;
}

/**
 * Fetch a single leaderboard window as normalised rows. Default returns
 * Polymarket's "overall / alltime / sort=profit" view; override via opts.
 *
 * Returns full rows (not just addresses) so callers can filter by ROI.
 *
 * @param {object} opts
 * @param {string} [opts.category]  e.g. "overall" | "sports" | "crypto"
 * @param {string} [opts.time]      "alltime" | "monthly" | "weekly" | "daily"
 * @param {string} [opts.sort]      "profit" | "volume"
 */
export async function fetchLeaderboardRaw(opts = {}) {
  const {
    category = "overall",
    time     = "alltime",
    sort     = "profit",
  } = opts;
  const params = new URLSearchParams({ category, time, sort });
  const fetchOnce = async (buildId) => {
    const url = `${POLYMARKET_HOST}/_next/data/${buildId}/en/leaderboard.json?${params}`;
    const res = await fetch(url, {
      headers: { "User-Agent": BROWSER_UA },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 404) {
      // buildId rotated mid-flight — caller will retry.
      const err = new Error("buildId stale (404)");
      err.code = "BUILD_ID_STALE";
      throw err;
    }
    if (!res.ok) throw new Error(`Leaderboard fetch ${res.status}`);
    return res.json();
  };

  let buildId = await getBuildId();
  let payload;
  try {
    payload = await fetchOnce(buildId);
  } catch (e) {
    if (e.code === "BUILD_ID_STALE") {
      buildId = await getBuildId({ force: true });
      payload = await fetchOnce(buildId);
    } else {
      throw e;
    }
  }
  return parseLeaderboardJson(payload);
}

/**
 * Backward-compatible thin wrapper used by the scan loop. Returns just the
 * lower-cased addresses, like the old data-api version did.
 */
export async function fetchLeaderboard({ time = "alltime", limit = 20 } = {}) {
  try {
    const rows = await fetchLeaderboardRaw({ time, sort: "profit" });
    return rows.slice(0, limit).map(r => r.proxyWallet);
  } catch (e) {
    log.warn(`fetchLeaderboard failed: ${e.message}`);
    return [];
  }
}

/**
 * Fetch recent trades on a specific market. Returns raw row objects with
 * proxyWallet / size / price / side / timestamp / pseudonym fields.
 *
 * Polymarket's `/trades` endpoint caps at ~100 per call. Used by the
 * active-traders aggregation for per-market discovery.
 */
export async function fetchMarketTrades(conditionId, { limit = 100 } = {}) {
  if (!conditionId) return [];
  try {
    const rows = await apiFetch(
      `${DATA_API}/trades?market=${encodeURIComponent(conditionId)}&limit=${limit}`
    );
    return Array.isArray(rows) ? rows : [];
  } catch (e) {
    log.warn(`fetchMarketTrades failed for ${conditionId.slice(0, 10)}…: ${e.message}`);
    return [];
  }
}

/**
 * Discover active traders by walking the top hottest markets and pulling
 * their recent trades. The Polymarket leaderboard endpoint caps at 20
 * unique addresses no matter how it's queried; this is the alternative
 * data source for finding fresh candidates beyond that ceiling.
 *
 * Returns an array of:
 *   { proxyWallet, marketCount, totalTradedUsd, lastTradeTs }
 * sorted by totalTradedUsd descending. Already-known wallets are NOT
 * filtered here — that's the caller's job.
 *
 * @param {object} opts
 * @param {number} [opts.marketLimit]    top N markets to walk
 * @param {number} [opts.perMarketLimit] trades per market
 * @param {number} [opts.minTradeUsd]    skip individual trades below this
 *                                       threshold (filters out dust)
 */
export async function fetchActiveTraders({
  marketLimit    = 15,
  perMarketLimit = 100,
  minTradeUsd    = 50,
} = {}) {
  // 1. Hottest markets by 24h volume — same source the scan loop uses.
  let events;
  try {
    events = await apiFetch(
      `${GAMMA_API}/events?active=true&closed=false&order=volume_24hr&ascending=false&limit=${marketLimit}`
    );
  } catch (e) {
    log.warn(`fetchActiveTraders: events fetch failed — ${e.message}`);
    return [];
  }

  const cids = (Array.isArray(events) ? events : [])
    .flatMap(e => Array.isArray(e?.markets) ? e.markets.map(m => m.conditionId) : [])
    .filter(Boolean);

  // 2. Aggregate trades across markets. Each address accumulates total
  //    visible USD volume + a counter of distinct markets touched + the
  //    most recent trade timestamp.
  const agg = new Map();
  for (const cid of cids) {
    const trades = await fetchMarketTrades(cid, { limit: perMarketLimit });
    for (const t of trades) {
      const addr = (t.proxyWallet || "").toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(addr)) continue;
      const sizeUsd = Number(t.size || 0) * Number(t.price || 0);
      if (!(sizeUsd >= minTradeUsd)) continue;
      const ts = Number(t.timestamp || 0) * 1000;  // API returns seconds
      const a = agg.get(addr) || { proxyWallet: addr, marketCount: 0, markets: new Set(), totalTradedUsd: 0, lastTradeTs: 0 };
      if (!a.markets.has(cid)) { a.markets.add(cid); a.marketCount++; }
      a.totalTradedUsd += sizeUsd;
      if (ts > a.lastTradeTs) a.lastTradeTs = ts;
      agg.set(addr, a);
    }
  }

  return [...agg.values()]
    .map(a => ({
      proxyWallet:    a.proxyWallet,
      marketCount:    a.marketCount,
      totalTradedUsd: Math.round(a.totalTradedUsd),
      lastTradeTs:    a.lastTradeTs,
    }))
    .sort((a, b) => b.totalTradedUsd - a.totalTradedUsd);
}

/**
 * Fetch mid-price for a token.
 * Returns null on failure (price is checked before use).
 */
export async function fetchMidPrice(tokenId) {
  try {
    const data = await apiFetch(`${CLOB_API}/midpoint?token_id=${tokenId}`);
    return data?.mid ? Math.round(Number(data.mid) * 100) / 100 : null;
  } catch (e) {
    log.warn(`fetchMidPrice failed for ${tokenId}: ${e.message}`);
    return null;
  }
}

/**
 * Fetch order status by ID.
 * Returns null on failure (caller handles missing status).
 *
 * L2 HMAC auth is auto-attached via env creds so callers no longer need to
 * pass headers — the extraHeaders arg is kept for test injection / overrides.
 */
export async function fetchOrderStatus(orderId, extraHeaders = {}) {
  try {
    const path = `/order/${orderId}`;
    const authHeaders = l2HeadersFromEnv({ method: "GET", path });
    return await apiFetch(`${CLOB_API}${path}`, {
      headers: { ...authHeaders, ...extraHeaders },
    });
  } catch (e) {
    log.warn(`fetchOrderStatus failed for ${orderId}: ${e.message}`);
    return null;
  }
}

/**
 * Fetch orderbook for a token.
 * Used for depth checks and slippage estimation. Returns null on failure.
 *
 * As of 2025-07 the /book response also carries inline market metadata:
 *   - min_order_size — smallest allowed order size (tokens)
 *   - tick_size      — price increment (e.g. 0.01 or 0.001)
 *   - neg_risk       — true for Neg Risk CTF multi-outcome markets
 * These are surfaced verbatim so callers can route/validate without a second round-trip.
 */
export async function fetchOrderBook(tokenId) {
  try {
    const data = await apiFetch(`${CLOB_API}/book?token_id=${tokenId}`);
    return {
      bids: (data?.bids || []).map(b => ({ price: Number(b.price), size: Number(b.size) })),
      asks: (data?.asks || []).map(a => ({ price: Number(a.price), size: Number(a.size) })),
      min_order_size: data?.min_order_size != null ? Number(data.min_order_size) : null,
      tick_size:      data?.tick_size      != null ? Number(data.tick_size)      : null,
      neg_risk:       data?.neg_risk === true,
    };
  } catch (e) {
    log.warn(`fetchOrderBook failed for ${tokenId}: ${e.message}`);
    return null;
  }
}

/**
 * Fetch multiple orderbooks in a single request (CLOB batch endpoint, 2025-06).
 * Up to 500 tokens per call. Returns a Map<tokenId, book> where `book` has the
 * same shape as fetchOrderBook() (minus `null` entries for unknown tokens).
 *
 * Falls back to null on catastrophic failure; callers can then individually
 * retry with fetchOrderBook() if needed.
 */
export async function fetchOrderBooks(tokenIds = []) {
  if (!tokenIds.length) return new Map();
  if (tokenIds.length > 500) {
    throw new Error(`fetchOrderBooks: max 500 tokens per request, got ${tokenIds.length}`);
  }
  try {
    const body = tokenIds.map(token_id => ({ token_id: String(token_id) }));
    const res = await fetch(`${CLOB_API}/books`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const arr = await res.json();
    const out = new Map();
    for (const data of Array.isArray(arr) ? arr : []) {
      const tid = data?.asset_id || data?.token_id;
      if (!tid) continue;
      out.set(String(tid), {
        bids: (data.bids || []).map(b => ({ price: Number(b.price), size: Number(b.size) })),
        asks: (data.asks || []).map(a => ({ price: Number(a.price), size: Number(a.size) })),
        min_order_size: data.min_order_size != null ? Number(data.min_order_size) : null,
        tick_size:      data.tick_size      != null ? Number(data.tick_size)      : null,
        neg_risk:       data.neg_risk === true,
      });
    }
    return out;
  } catch (e) {
    log.warn(`fetchOrderBooks batch failed (${tokenIds.length} tokens): ${e.message}`);
    return null;
  }
}

/**
 * Cancel an order by ID. Returns { ok, data }.
 * Polymarket requires L2 HMAC auth on DELETE /order/:id — auto-attached.
 */
export async function cancelOrder(orderId, extraHeaders = {}) {
  try {
    const path = `/order/${orderId}`;
    const authHeaders = l2HeadersFromEnv({ method: "DELETE", path });
    const res = await fetch(`${CLOB_API}${path}`, {
      method: "DELETE",
      headers: { ...authHeaders, ...extraHeaders },
      signal: AbortSignal.timeout(10_000),
    });
    return { ok: res.ok, status: res.status, data: await res.json().catch(() => ({})) };
  } catch (e) {
    return { ok: false, status: 0, data: { error: e.message } };
  }
}

/**
 * Submit an order to the CLOB. Requires BOTH:
 *   - L1: EIP-712 order signature inside `orderPayload.order.signature` (built by trading.js::buildOrder)
 *   - L2: HMAC-SHA256 auth headers (auto-attached from env creds)
 *
 * If L2 creds are missing, Polymarket will reject with 401. Run
 * `node scripts/derive-api-key.js` once to populate POLY_API_KEY / SECRET /
 * PASSPHRASE in your .env.
 */
export async function submitOrder(orderPayload, extraHeaders = {}) {
  const path = "/order";
  const bodyStr = JSON.stringify(orderPayload);
  const authHeaders = l2HeadersFromEnv({ method: "POST", path, body: bodyStr });
  const res = await fetch(`${CLOB_API}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders,
      ...extraHeaders,
    },
    body: bodyStr,
    signal: AbortSignal.timeout(15_000),
  });
  return { ok: res.ok, status: res.status, data: await res.json() };
}

/**
 * Generic proxy fetch (for CORS proxy endpoint)
 */
export async function proxyFetch(url) {
  const allowed = ["gamma-api.polymarket.com", "data-api.polymarket.com", "clob.polymarket.com"];
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Invalid URL");
  }
  if (!allowed.includes(parsed.hostname)) {
    throw new Error("Disallowed proxy target");
  }
  return apiFetch(url);
}

// ── Exports ──────────────────────────────────────────────────────────────────
export { GAMMA_API, DATA_API, CLOB_API, CLOB_WS };

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
