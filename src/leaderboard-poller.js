/**
 * Auto-import discovery pipeline.
 *
 * Two data sources, combined:
 *   1. Polymarket leaderboard endpoint (capped at 20 unique addresses
 *      regardless of category/time/sort — that ceiling is hardcoded by
 *      Polymarket, not by us).
 *   2. Per-market /trades endpoint walking the hottest markets — gives
 *      hundreds of unique active traders. This is the source that lets
 *      auto-import keep finding new candidates after the leaderboard's
 *      20 are already tracked.
 *
 * Pure helpers (mergeRows, filterCandidates, dedupeAgainstKnown,
 * mergeSources) are exported for unit testing. The async pollAndImport
 * orchestrates poll → filter → import; called by both the cron in
 * server.js and the manual /import/run endpoint.
 */
import { fetchLeaderboardRaw, fetchActiveTraders } from "./polymarket-api.js";
import { getBlacklistedWallets } from "./db.js";

/**
 * Same wallet can show in alltime + monthly + weekly with different
 * pnl/volume snapshots. Keep the highest-ROI observation per address —
 * that's the strongest signal of skill. Returns rows with `roi` + `window`.
 */
export function mergeRows(rowsByWindow) {
  const best = new Map();
  for (const [window, rows] of Object.entries(rowsByWindow)) {
    for (const r of rows) {
      const roi = r.volume > 0 ? r.pnl / r.volume : 0;
      const prev = best.get(r.proxyWallet);
      const prevRoi = prev ? (prev.volume > 0 ? prev.pnl / prev.volume : 0) : -Infinity;
      if (!prev || roi > prevRoi) {
        best.set(r.proxyWallet, { ...r, window, roi });
      }
    }
  }
  return [...best.values()];
}

/**
 * Drop market makers (high vol, low ROI) and small fish (low absolute pnl),
 * sort by ROI desc, cap at `top`.
 */
export function filterCandidates(rows, { minPnl, minRoi, top }) {
  return rows
    .filter(r => r.pnl >= minPnl && r.roi >= minRoi)
    .sort((a, b) => b.roi - a.roi)
    .slice(0, top);
}

/**
 * Subtract already-known addresses (currently tracked + blacklisted) from
 * a candidate list. Pure for testability.
 *
 * @param {Array} candidates  rows with .proxyWallet
 * @param {Set<string>}        excluded   lowercased addresses to drop
 */
export function dedupeAgainstKnown(candidates, excluded) {
  return candidates.filter(c => !excluded.has(c.proxyWallet));
}

/**
 * Combine leaderboard rows + active-trader rows into one candidate list.
 *
 * Leaderboard rows carry pnl / volume / roi (we know they pass minPnl/minRoi
 * via filterCandidates). Active-trader rows only carry on-market trade
 * activity — they don't have all-time PnL, so they're added with the
 * optimistic assumption that lots of activity ≈ skill, and polytrack's
 * own scoring will sort them after they're tracked.
 *
 * Leaderboard wins on duplicates (its data is richer). Returns a unified
 * shape with `source: "leaderboard" | "active-trader"`.
 */
export function mergeSources(leaderboardRows, activeRows) {
  const out = new Map();
  for (const r of leaderboardRows || []) {
    out.set(r.proxyWallet, {
      proxyWallet:    r.proxyWallet,
      pnl:            r.pnl,
      volume:         r.volume,
      roi:            r.roi,
      pseudonym:      r.pseudonym,
      source:         "leaderboard",
    });
  }
  for (const r of activeRows || []) {
    if (out.has(r.proxyWallet)) continue;       // leaderboard wins
    out.set(r.proxyWallet, {
      proxyWallet:    r.proxyWallet,
      pnl:            null,
      volume:         null,
      roi:            null,
      pseudonym:      null,
      source:         "active-trader",
      marketCount:    r.marketCount,
      totalTradedUsd: r.totalTradedUsd,
      lastTradeTs:    r.lastTradeTs,
    });
  }
  return [...out.values()];
}

/**
 * Full auto-import pipeline.
 *
 * @param {object} state    runtime state (state.wallets is the live tracked map)
 * @param {object} opts
 * @param {string[]} opts.windows           leaderboard time windows to poll
 * @param {number}   opts.minPnl
 * @param {number}   opts.minRoi
 * @param {number}   opts.maxAddPerRun      cap so a single run can't flood
 * @param {number}   [opts.activeMarketLimit]    top N markets to walk (default 15)
 * @param {number}   [opts.activeMinTradeUsd]    skip dust trades (default $50)
 * @param {function} opts.loadWallet        async (addr) => walletObj
 * @param {function} opts.setWallet         (state, walletObj) => void
 * @param {function} [opts.log]
 *
 * @returns {{
 *   added:           string[],
 *   failed:          string[],
 *   skipped:         number,
 *   sources: {
 *     leaderboard:   { fetched: number, passedFilter: number },
 *     activeTrader:  { fetched: number },
 *   },
 *   excluded: {
 *     alreadyTracked: number,
 *     blacklisted:    number,
 *   },
 * }}
 */
export async function pollAndImport(state, opts) {
  const {
    windows = ["alltime", "monthly", "weekly"],
    minPnl = 100_000,
    minRoi = 0.025,
    maxAddPerRun = 5,
    activeMarketLimit = 15,
    activeMinTradeUsd = 50,
    loadWallet,
    setWallet,
    log = console,
  } = opts;

  if (typeof loadWallet !== "function" || typeof setWallet !== "function") {
    throw new Error("pollAndImport requires loadWallet + setWallet callbacks");
  }

  // ── Source 1: leaderboard (capped at 20 unique by upstream) ───────────────
  const settled = await Promise.allSettled(
    windows.map(w => fetchLeaderboardRaw({ time: w, sort: "profit" }).then(rows => [w, rows]))
  );
  const rowsByWindow = {};
  for (const r of settled) {
    if (r.status === "fulfilled") {
      const [w, rows] = r.value;
      rowsByWindow[w] = rows;
    } else {
      log.warn?.(`pollAndImport: leaderboard window failed — ${r.reason?.message || r.reason}`);
    }
  }
  const leaderboardMerged = mergeRows(rowsByWindow);
  const leaderboardPassed = filterCandidates(
    leaderboardMerged,
    { minPnl, minRoi, top: maxAddPerRun * 5 },
  );

  // ── Source 2: active traders walking hottest markets ──────────────────────
  let activeRows = [];
  try {
    activeRows = await fetchActiveTraders({
      marketLimit: activeMarketLimit,
      perMarketLimit: 100,
      minTradeUsd: activeMinTradeUsd,
    });
  } catch (e) {
    log.warn?.(`pollAndImport: active-trader fetch failed — ${e.message}`);
  }

  // ── Combine, dedupe, cap ─────────────────────────────────────────────────
  const combined = mergeSources(leaderboardPassed, activeRows);

  const trackedAddrs    = new Set(Array.from(state.wallets.keys()).map(a => a.toLowerCase()));
  const blacklistAddrs  = new Set(getBlacklistedWallets().map(w => w.address.toLowerCase()));
  const excluded        = new Set([...trackedAddrs, ...blacklistAddrs]);
  const fresh           = dedupeAgainstKnown(combined, excluded).slice(0, maxAddPerRun);

  // ── Load + persist ───────────────────────────────────────────────────────
  const added  = [];
  const failed = [];
  for (const c of fresh) {
    try {
      const w = await loadWallet(c.proxyWallet);
      setWallet(state, w);
      added.push(c.proxyWallet);
    } catch (e) {
      failed.push(c.proxyWallet);
      log.warn?.(`pollAndImport: ${c.proxyWallet} failed — ${e.message}`);
    }
  }

  const trackedHits   = combined.filter(c => trackedAddrs.has(c.proxyWallet)).length;
  const blacklistHits = combined.filter(c => blacklistAddrs.has(c.proxyWallet)).length;

  return {
    added,
    failed,
    skipped: combined.length - fresh.length,
    sources: {
      leaderboard:  { fetched: leaderboardMerged.length, passedFilter: leaderboardPassed.length },
      activeTrader: { fetched: activeRows.length },
    },
    excluded: {
      alreadyTracked: trackedHits,
      blacklisted:    blacklistHits,
    },
  };
}
