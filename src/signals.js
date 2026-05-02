/**
 * Signal Detection Engine
 * ───────────────────────
 * Detects consensus signals from ELITE wallet positions with:
 *   - Temporal coherence (7-day recency filter)
 *   - Position size weighting ($10 minimum)
 *   - Signal strength scoring (0-100)
 *   - Signal lifecycle: NEW -> CONFIRMED -> STALE -> EXPIRED
 */

// ── Configuration ────────────────────────────────────────────────────────────
// Single-ELITE follow mode (2026-05-02): 1 ELITE wallet entering same
// direction triggers a signal, provided no other ELITE opposes the same
// market+direction (B8 rule below handles the opposing check).
//
// The relaxed quorum is paired with three compensating safeties:
//   1. Tightened ELITE gate (src/scoring.js): score>75, closed≥30,
//      total PnL > $2000, ROI > 5%. Anyone who clears that bar should be
//      defensible to follow alone.
//   2. maxEntryDrift (below) blocks signals where market has already
//      pumped past the ELITE's weighted-average entry by > 15¢.
//   3. config.marketCooldownMin (30 min) + killSwitch.maxLifetimeLossUsdc
//      ($30) cap blast radius if a follow trade goes bad.
const DEFAULTS = {
  recencyDays: 7,         // only count positions with activity in last N days
  minPositionSize: 10,    // minimum USD position size to count
  minWallets: 1,          // single ELITE follow
  includeProInConsensus: false, // pure ELITE — PRO is watchlist only
  sizeCapPerWallet: 10000,// cap per-wallet weight at this USD value
  staleAfterScans: 3,     // mark STALE if not confirmed in N scans
  expireAfterScans: 6,    // mark EXPIRED after N scans without confirmation
  // Entry-edge filter (audit P1-2): if current market price is already
  // `maxEntryDrift` price units above the ELITE wallets' weighted-average
  // entry price, skip the signal — ELITE got their edge cheap and we'd be
  // chasing. Negative drift (we'd enter cheaper than ELITE) is fine.
  // 0.15 = 15¢ on a 0-1 prediction market scale. Set to null to disable.
  // Especially important under single-ELITE follow — without consensus
  // smoothing, this is the main protection against late entries.
  maxEntryDrift: 0.15,
};

// ── Signal Store ─────────────────────────────────────────────────────────────

/**
 * Manages signal lifecycle across scans.
 */
export class SignalStore {
  constructor(config = {}) {
    this.config = { ...DEFAULTS, ...config };
    this.signals = new Map(); // key -> signal
    this.scanCount = 0;
  }

  /**
   * Run signal detection against current wallet and market data.
   *
   * @param {Array} wallets   wallet objects (with .tier, .positions)
   * @param {Array} markets   fetchMarkets() output
   * @param {object} [history]  HistoryReader (optional). When supplied,
   *   the entry-edge filter (maxEntryDrift) compares ELITE's average
   *   entry price to the latest mid-price snapshot. Without it, the
   *   filter is silently skipped (preserves legacy behaviour for older
   *   call sites).
   * @returns array of active signals (NEW, CONFIRMED).
   */
  detect(wallets, markets, history = null) {
    this.scanCount++;
    const cfg = this.config;
    const now = Date.now();
    const recencyCutoff = now / 1000 - cfg.recencyDays * 86400;

    // Track signals filtered by the entry-edge gate so callers can surface
    // "we saw a consensus but it was already pumped" diagnostics.
    this.lastSkippedByEdge = [];

    // Tier filter: ELITE always; PRO included during V1 accumulation when
    // eliteCount is too small to form pure-ELITE consensus. Variable name
    // kept for backward compat — it's "qualifying wallets", not strictly elite.
    const allowedTiers = cfg.includeProInConsensus
      ? new Set(["ELITE", "PRO"])
      : new Set(["ELITE"]);
    const elites = wallets.filter(w => allowedTiers.has(w.tier));
    if (elites.length === 0) return this.getActiveSignals();

    // Track which signals were confirmed this scan
    const confirmedKeys = new Set();

    for (const event of markets) {
      for (const m of (event.markets || [])) {
        const conditionId = m.conditionId;
        if (!conditionId) continue;

        // Collect qualifying positions per direction
        const directions = { YES: [], NO: [] };

        for (const w of elites) {
          for (const p of (w.positions || [])) {
            if (p.conditionId !== conditionId) continue;

            const dir = normalizeOutcome(p.outcome);
            if (!dir) continue;

            // Recency filter: skip if no recent activity
            const lastActivity = getLastActivity(w, conditionId);
            if (lastActivity < recencyCutoff) continue;

            // Size filter
            const posValue = p.currentValue || p.size || 0;
            if (posValue < cfg.minPositionSize) continue;

            // Weight: capped position value relative to max
            const weight = Math.min(posValue, cfg.sizeCapPerWallet) / cfg.sizeCapPerWallet;

            directions[dir].push({
              addr: w.addr,
              score: w.score,
              posValue,
              weight,
              avgPrice: p.avgPrice,
            });
          }
        }

        // Check each direction for consensus
        for (const dir of ["YES", "NO"]) {
          const aligned = directions[dir];
          if (aligned.length < cfg.minWallets) continue;

          const opposing = directions[dir === "YES" ? "NO" : "YES"];

          // B8: Suppress signal when ELITE wallets are too divided.
          // If opposing side has significant representation (ratio < 2:1), skip.
          if (opposing.length > 0 && aligned.length / opposing.length < 2) continue;

          const key = `${conditionId}::${dir}`;

          // ── Entry-edge filter (audit P1-2) ──────────────────────────────
          // Compare ELITE's weighted-avg entry to the current market price.
          // If price has drifted up by more than maxEntryDrift cents,
          // skip — we'd be chasing past the smart-money edge.
          //
          // currentPrice is read from market.lastTradePrice / outcomePrices,
          // NOT from snapshot.mid_price. Polymarket's /book-derived
          // mid_price is noise (sentinel 0.5 even on actively-traded
          // markets); the metadata's lastTradePrice IS the true mark.
          const entryAnalysis = analyseEntryEdge({
            aligned,
            market: m,
            direction: dir,
            maxDrift: cfg.maxEntryDrift,
          });
          if (entryAnalysis.skip) {
            this.lastSkippedByEdge.push({
              conditionId,
              direction: dir,
              reason: entryAnalysis.reason,
              eliteAvgEntry: entryAnalysis.eliteAvgEntry,
              currentPrice: entryAnalysis.currentPrice,
              entryEdge: entryAnalysis.entryEdge,
            });
            continue;
          }

          const strength = calcStrength(aligned, elites, directions);

          confirmedKeys.add(key);

          // Snapshot the entry-edge fields so dashboards can show them on
          // both NEW and refreshed-CONFIRMED signals.
          const edgeFields = {
            eliteAvgEntry: entryAnalysis.eliteAvgEntry ?? null,
            currentPrice:  entryAnalysis.currentPrice  ?? null,
            entryEdge:     entryAnalysis.entryEdge     ?? null,
          };

          if (this.signals.has(key)) {
            // Update existing signal
            const sig = this.signals.get(key);
            sig.lastConfirmedScan = this.scanCount;
            sig.lastConfirmedAt = now;
            sig.walletCount = aligned.length;
            sig.totalSize = aligned.reduce((s, a) => s + a.posValue, 0);
            sig.strength = strength;
            sig.wallets = aligned;
            sig.opposingCount = opposing.length;
            Object.assign(sig, edgeFields);
            if (sig.status === "NEW" || sig.status === "STALE") {
              sig.status = "CONFIRMED";
            }
          } else {
            // New signal
            this.signals.set(key, {
              conditionId,
              title: m.question || event.title || "",
              direction: dir,
              status: "NEW",
              strength,
              walletCount: aligned.length,
              totalSize: aligned.reduce((s, a) => s + a.posValue, 0),
              wallets: aligned,
              opposingCount: opposing.length,
              market: m,
              firstSeenAt: now,
              firstSeenScan: this.scanCount,
              lastConfirmedAt: now,
              lastConfirmedScan: this.scanCount,
              ...edgeFields,
            });
          }
        }
      }
    }

    // Age out signals that weren't confirmed this scan
    for (const [key, sig] of this.signals) {
      if (confirmedKeys.has(key)) continue;

      const scansSinceConfirm = this.scanCount - sig.lastConfirmedScan;
      if (scansSinceConfirm >= cfg.expireAfterScans) {
        sig.status = "EXPIRED";
      } else if (scansSinceConfirm >= cfg.staleAfterScans) {
        sig.status = "STALE";
      }
    }

    // Clean up expired signals older than 2x expiry window
    for (const [key, sig] of this.signals) {
      if (sig.status === "EXPIRED" && this.scanCount - sig.lastConfirmedScan > cfg.expireAfterScans * 2) {
        this.signals.delete(key);
      }
    }

    return this.getActiveSignals();
  }

  /**
   * Get all active (non-expired) signals, sorted by strength descending.
   */
  getActiveSignals() {
    return [...this.signals.values()]
      .filter(s => s.status !== "EXPIRED")
      .sort((a, b) => b.strength - a.strength);
  }

  /**
   * Get all signals including expired (for history/audit)
   */
  getAllSignals() {
    return [...this.signals.values()];
  }

  /**
   * Mark a signal as traded (prevents duplicate auto-trades)
   */
  markTraded(conditionId, direction) {
    const key = `${conditionId}::${direction}`;
    const sig = this.signals.get(key);
    if (sig) sig.traded = true;
  }

  /**
   * Check if a signal has already been traded
   */
  isTraded(conditionId, direction) {
    const key = `${conditionId}::${direction}`;
    return this.signals.get(key)?.traded === true;
  }

  /**
   * Rollback the traded flag so a failed attempt can be retried on the next scan
   * (subject to market cooldown enforced separately by risk module).
   */
  unmarkTraded(conditionId, direction) {
    const key = `${conditionId}::${direction}`;
    const sig = this.signals.get(key);
    if (sig) sig.traded = false;
  }
}

// ── Signal Strength Calculation ──────────────────────────────────────────────

/**
 * Compute signal strength (0-100) based on:
 *   - Number of aligned wallets (40%)
 *   - Average wallet quality/score (25%)
 *   - Total position size weight (20%)
 *   - Opposing wallet penalty (15%)
 */
function calcStrength(aligned, allElites, directions) {
  // 1. Wallet count factor (3=40, 4=55, 5=70, 6+=85, caps at 100)
  const countFactor = Math.min(100, 25 + aligned.length * 15);

  // 2. Average wallet score of aligned wallets (0-100)
  const avgScore = aligned.reduce((s, a) => s + a.score, 0) / aligned.length;

  // 3. Total weighted size factor
  const totalWeight = aligned.reduce((s, a) => s + a.weight, 0);
  const maxPossibleWeight = aligned.length; // each wallet max weight = 1
  const sizeFactor = Math.min(100, (totalWeight / Math.max(maxPossibleWeight, 1)) * 100);

  // 4. Opposing penalty: if ELITE wallets disagree, reduce strength
  const opposingDir = aligned[0] && aligned[0] === directions.YES?.[0] ? "NO" : "YES";
  const opposing = directions[opposingDir] || [];
  const opposingPenalty = opposing.length > 0
    ? Math.min(50, opposing.length * 15) // up to 50% penalty
    : 0;

  const raw = countFactor * 0.40 + avgScore * 0.25 + sizeFactor * 0.20 + (100 - opposingPenalty) * 0.15;
  return Math.round(Math.max(0, Math.min(100, raw)));
}

// ── Entry-edge analysis (audit P1-2) ────────────────────────────────────────

/**
 * Decide whether a consensus signal should fire based on how far the current
 * market price has drifted above the ELITE wallets' weighted-average entry.
 *
 * Reads currentPrice from the market metadata (`lastTradePrice` /
 * `outcomePrices`), NOT from orderbook snapshots. Polymarket's /book is
 * mostly sentinel noise; lastTradePrice is the true recent mark.
 *
 * Returns:
 *   { skip: false, eliteAvgEntry, currentPrice, entryEdge }
 *     — proceed; surface the prices on the signal payload
 *   { skip: true, reason, ...prices }
 *     — drop the signal; reason is one of:
 *         "drift-exceeded"  → currentPrice > entry + maxDrift (chasing)
 *         "no-market"       → market metadata not supplied (legacy)
 *         "no-price"        → market lacks a usable lastTradePrice
 *         "no-entry"        → ELITE positions had no avgPrice (data gap)
 *
 * Non-rejection cases preserve legacy "let through" behaviour so we don't
 * block consensus on missing data.
 *
 * Direction-symmetric: derives the directional price from the binary-market
 * convention (outcomePrices[0]=YES, [1]=NO; or lastTradePrice ≈ YES, with
 * NO ≈ 1 − lastTradePrice as fallback).
 */
export function analyseEntryEdge({ aligned, market, direction, maxDrift }) {
  if (!Array.isArray(aligned) || aligned.length === 0) {
    return { skip: false, reason: "no-aligned" };
  }
  // Weighted-average entry across the aligned ELITE wallets.
  let totalW = 0, weightedSum = 0;
  for (const a of aligned) {
    const p = Number(a.avgPrice);
    if (!Number.isFinite(p) || p <= 0) continue;
    const w = Number(a.weight) || 0;
    if (w <= 0) continue;
    totalW += w;
    weightedSum += p * w;
  }
  if (totalW === 0) {
    return { skip: false, reason: "no-entry" };
  }
  const eliteAvgEntry = weightedSum / totalW;

  if (!market) {
    return { skip: false, reason: "no-market", eliteAvgEntry };
  }

  const currentPrice = pickCurrentPriceForDirection(market, direction);
  if (currentPrice == null) {
    return { skip: false, reason: "no-price", eliteAvgEntry };
  }

  const entryEdge = currentPrice - eliteAvgEntry;

  if (Number.isFinite(maxDrift) && entryEdge > maxDrift) {
    return {
      skip: true, reason: "drift-exceeded",
      eliteAvgEntry, currentPrice, entryEdge,
    };
  }
  return { skip: false, eliteAvgEntry, currentPrice, entryEdge };
}

/**
 * Pull the directional price (YES side or NO side) from a market's
 * metadata. Prefer outcomePrices[] when present (it's per-outcome and
 * fresh). Fall back to lastTradePrice (assumed YES; NO = 1 - that).
 *
 * Returns null when no usable price is available.
 */
// "Usable" price range matches filterByLastTradePrice's default threshold
// (0.02 / 0.98). Markets at the extremes are effectively resolved and
// shouldn't drive entry-edge math even if they slip past the upstream filter.
const USABLE_LO = 0.02;
const USABLE_HI = 0.98;
function isUsablePrice(p) {
  return Number.isFinite(p) && p > USABLE_LO && p < USABLE_HI;
}

function pickCurrentPriceForDirection(market, direction) {
  const want = String(direction).toUpperCase();
  // Per-outcome prices (preferred — direction-correct by construction)
  const prices = Array.isArray(market.outcomePrices) ? market.outcomePrices : [];
  const outcomes = Array.isArray(market.outcomes) ? market.outcomes : [];
  // Match by outcome label first
  for (let i = 0; i < outcomes.length && i < prices.length; i++) {
    if (String(outcomes[i] || "").toUpperCase() === want) {
      const p = Number(prices[i]);
      if (isUsablePrice(p)) return p;
    }
  }
  // Fall back to index convention: 0 = YES, 1 = NO
  const idx = want === "YES" ? 0 : 1;
  const idxPrice = Number(prices[idx]);
  if (isUsablePrice(idxPrice)) return idxPrice;
  // Last resort: lastTradePrice (assume YES; flip for NO)
  const ltp = Number(market.lastTradePrice);
  if (isUsablePrice(ltp)) {
    return want === "YES" ? ltp : (1 - ltp);
  }
  return null;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function normalizeOutcome(outcome) {
  if (!outcome) return null;
  const lower = String(outcome).toLowerCase();
  if (lower === "yes" || lower === "0") return "YES";
  if (lower === "no" || lower === "1") return "NO";
  return null;
}

/**
 * Get the most recent trade timestamp for a wallet in a specific market.
 * Falls back to position update time.
 */
function getLastActivity(wallet, conditionId) {
  // Check recent trades first
  if (wallet.recentTrades) {
    const marketTrades = wallet.recentTrades.filter(t => t.conditionId === conditionId);
    if (marketTrades.length > 0) {
      return Math.max(...marketTrades.map(t => t.timestamp || 0));
    }
  }

  // Fall back to wallet's last update time
  return (wallet.updatedAt || 0) / 1000;
}
