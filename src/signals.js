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
const DEFAULTS = {
  recencyDays: 7,         // only count positions with activity in last N days
  minPositionSize: 10,    // minimum USD position size to count
  minWallets: 3,          // minimum ELITE wallets for signal
  sizeCapPerWallet: 10000,// cap per-wallet weight at this USD value
  staleAfterScans: 3,     // mark STALE if not confirmed in N scans
  expireAfterScans: 6,    // mark EXPIRED after N scans without confirmation
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
   * Returns array of active signals (NEW, CONFIRMED).
   */
  detect(wallets, markets) {
    this.scanCount++;
    const cfg = this.config;
    const now = Date.now();
    const recencyCutoff = now / 1000 - cfg.recencyDays * 86400;

    // Only use ELITE wallets
    const elites = wallets.filter(w => w.tier === "ELITE");
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
          const strength = calcStrength(aligned, elites, directions);

          confirmedKeys.add(key);

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
