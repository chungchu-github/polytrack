/**
 * Leaderboard auto-import (PR B).
 *
 * Pulls Polymarket leaderboard windows, merges + filters, and adds the top
 * unseen wallets to the watch list — all in-process, no HTTP layer.
 *
 * Pure helpers (mergeRows, filterCandidates) are exported for unit testing.
 * The async pollAndImport orchestrates the full poll → filter → import
 * pipeline; it's called by both the cron in server.js and the manual
 * /import/run endpoint.
 */
import { fetchLeaderboardRaw } from "./polymarket-api.js";
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
 * Full auto-import pipeline.
 *
 * @param {object} state    runtime state (state.wallets is the live tracked map)
 * @param {object} opts
 * @param {string[]} opts.windows         leaderboard time windows to poll
 * @param {number}   opts.minPnl
 * @param {number}   opts.minRoi
 * @param {number}   opts.maxAddPerRun    cap so a single run can't flood
 * @param {function} opts.loadWallet      async (addr) => walletObj  (server.js's loadWallet)
 * @param {function} opts.setWallet       (state, walletObj) => void (server.js's setWallet)
 * @param {function} [opts.log]
 *
 * @returns {{ added: string[], skipped: number, failed: string[], scanned: number }}
 */
export async function pollAndImport(state, opts) {
  const {
    windows = ["alltime", "monthly", "weekly"],
    minPnl = 100_000,
    minRoi = 0.025,
    maxAddPerRun = 5,
    loadWallet,
    setWallet,
    log = console,
  } = opts;

  if (typeof loadWallet !== "function" || typeof setWallet !== "function") {
    throw new Error("pollAndImport requires loadWallet + setWallet callbacks");
  }

  // 1. Pull every window in parallel; tolerate per-window failures.
  const settled = await Promise.allSettled(
    windows.map(w => fetchLeaderboardRaw({ time: w, sort: "profit" }).then(rows => [w, rows]))
  );
  const rowsByWindow = {};
  for (const r of settled) {
    if (r.status === "fulfilled") {
      const [w, rows] = r.value;
      rowsByWindow[w] = rows;
    } else {
      log.warn?.(`pollAndImport: window failed — ${r.reason?.message || r.reason}`);
    }
  }
  if (Object.keys(rowsByWindow).length === 0) {
    return { added: [], skipped: 0, failed: [], scanned: 0, error: "all windows failed" };
  }

  // 2. Merge + filter.
  const merged = mergeRows(rowsByWindow);
  const ranked = filterCandidates(merged, { minPnl, minRoi, top: maxAddPerRun * 5 });

  // 3. Subtract anything we already know about (live or blacklisted).
  const excluded = new Set([
    ...Array.from(state.wallets.keys()),
    ...getBlacklistedWallets().map(w => w.address),
  ]);
  const fresh = dedupeAgainstKnown(ranked, excluded).slice(0, maxAddPerRun);

  // 4. Load each new wallet through the same path manual /wallets POST uses.
  const added = [];
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

  return {
    added,
    skipped: ranked.length - fresh.length,
    failed,
    scanned: merged.length,
  };
}
