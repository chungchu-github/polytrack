/**
 * AntiDegenStrategy — fade signals from high-frequency, sustained-loss
 * wallets (the "韭菜" / DEGEN tier defined in src/scoring.js, 2026-05-07).
 *
 * Trigger: any DEGEN wallet enters position on (cid, dir) AND no ELITE wallet
 * is aligned on the same (cid, dir). Emitted signal direction is INVERTED
 * (DEGEN buys YES → emit signal direction=NO, fade=true).
 *
 * Why no SignalStore reuse: lifecycle semantics differ from consensus —
 * fade quorum is "1 DEGEN AND no ELITE on same side" rather than
 * "≥N qualifying same-side". Keeping the logic local makes the strategy
 * easier to evolve independently of follow-mode.
 *
 * Risk caps (compensating for fade not being structurally smart-money):
 *   - dryRun=true default — first-week observation only, no live trades
 *   - maxFadeDrift: market price that has already moved with DEGEN's
 *     direction by >10¢ → skip (the "edge" is already gone)
 *   - requireNoEliteAligned: an ELITE on the same side immediately
 *     disqualifies (DEGEN occasionally agrees with smart money — don't fade)
 *   - per-strategy killSwitch + tighter marketCooldownMin live in config.js
 */
import { BaseStrategy } from "./base.js";
import {
  analyseEntryEdge,
  normalizeOutcome,
  getLastActivity,
} from "../signals.js";

const DEFAULTS = {
  enabled: true,
  dryRun: true,                   // first-week observation lock
  recencyDays: 3,                 // DEGEN signals decay faster than ELITE
  minPositionSize: 50,            // filter dust-level fades
  // 2026-05-12: raised from 1 → 2 after first $30 of live trades closed
  // -$19 (5L/1W) on same-day European football. Hypothesis: single-DEGEN
  // signals on sports markets are weakly informative; requiring 2+ degens
  // on the same (cid, dir) raises the bar for "this is a fade-worthy
  // structural error" vs "one casual gambler picked NO on a weak team."
  minWallets: 2,
  requireNoEliteAligned: true,    // ELITE on same side → skip
  sizeCapPerWallet: 5000,
  staleAfterScans: 3,
  expireAfterScans: 6,
  maxFadeDrift: 0.10,             // currentPrice > degenEntry + 10¢ on
                                  // ORIGINAL direction → market corrected, skip
  // 2026-05-21: skip "lottery-ticket fades". When a DEGEN buys a cheap
  // long-shot (e.g. "Will Brazil win the 2026 World Cup?" YES @ 0.09 — a
  // rational small punt, not a degenerate error), the fade is the near-
  // certain NO @ 0.91: max upside ~10¢ vs full-$ downside, on a market the
  // book already prices efficiently. Negative-to-zero edge. Skip any fade
  // whose entry price exceeds this. 0 disables the gate.
  maxFadeEntryPrice: 0.85,
  // 2026-05-12: cluster filter. The first live loss-streak was 6 signals
  // firing in a 1.5h window, all on European football matches resolving
  // the same evening — outcomes were highly correlated and one bad night
  // of results wiped 5/6 fades. Cap active signals per market-resolve
  // day (UTC) so a single sports card can't blanket the strategy.
  // 0 disables the filter (back to old behaviour).
  maxSignalsPerResolveDay: 1,
};

export class AntiDegenStrategy extends BaseStrategy {
  defaults() { return DEFAULTS; }
  get name() { return "antidegen"; }

  constructor(config = {}) {
    super(config);
    this.signals = new Map();     // key: `${cid}::${fadeDir}` → signal
    this.scanCount = 0;
    this.lastSkippedByEdge = [];
    this.lastSkippedByEliteAligned = [];
    this.lastSkippedByFadePrice = [];
    this.lastClusterFiltered = [];
  }

  detect({ wallets, markets } = {}) {
    this.scanCount++;
    const cfg = this.config;
    const now = Date.now();
    const recencyCutoff = now / 1000 - cfg.recencyDays * 86400;

    this.lastSkippedByEdge = [];
    this.lastSkippedByEliteAligned = [];
    this.lastSkippedByFadePrice = [];

    const degens = (wallets || []).filter(w => w.tier === "DEGEN");
    const elites = (wallets || []).filter(w => w.tier === "ELITE");
    if (degens.length === 0) return this.getActiveSignals();

    const confirmedKeys = new Set();

    for (const event of (markets || [])) {
      for (const m of (event.markets || [])) {
        const conditionId = m.conditionId;
        if (!conditionId) continue;

        // Aggregate DEGEN positions per ORIGINAL direction
        const degenByDir = { YES: [], NO: [] };
        for (const w of degens) {
          for (const p of (w.positions || [])) {
            if (p.conditionId !== conditionId) continue;
            const dir = normalizeOutcome(p.outcome);
            if (!dir) continue;
            const lastActivity = getLastActivity(w, conditionId);
            if (lastActivity < recencyCutoff) continue;
            const posValue = p.currentValue || p.size || 0;
            if (posValue < cfg.minPositionSize) continue;
            const weight = Math.min(posValue, cfg.sizeCapPerWallet) / cfg.sizeCapPerWallet;
            degenByDir[dir].push({
              addr: w.addr,
              score: w.score,
              // roi is stored in PERCENT units on the wallet object (e.g. -25
              // for -25%) by both server.js loadWallet and state.js hydration.
              // Reading w.totalROI (the original-name from scoreWallet's
              // return shape) was a bug — those fields don't survive the
              // mapping in loadWallet → setWallet, so lossFactor was always
              // 0 and strength capped at sizeFactor*0.25 + countBonus*0.10
              // (max 28). Production: 225 dryRun rows all had strength<30,
              // even for high-loss DEGENs.
              roi: w.roi ?? 0,
              posValue,
              weight,
              avgPrice: p.avgPrice,
            });
          }
        }

        // Count ELITE positions per direction (for the no-elite-aligned gate)
        const eliteCountByDir = { YES: 0, NO: 0 };
        if (cfg.requireNoEliteAligned) {
          for (const w of elites) {
            for (const p of (w.positions || [])) {
              if (p.conditionId !== conditionId) continue;
              const dir = normalizeOutcome(p.outcome);
              if (!dir) continue;
              eliteCountByDir[dir]++;
            }
          }
        }

        for (const origDir of ["YES", "NO"]) {
          const aligned = degenByDir[origDir];
          if (aligned.length < cfg.minWallets) continue;

          // Gate: any ELITE on the same (original) side → skip the fade
          if (cfg.requireNoEliteAligned && eliteCountByDir[origDir] > 0) {
            this.lastSkippedByEliteAligned.push({
              conditionId, originalDirection: origDir,
              degenCount: aligned.length,
              eliteCount: eliteCountByDir[origDir],
            });
            continue;
          }

          // Drift gate: has the market already moved WITH DEGEN by > maxFadeDrift?
          // analyseEntryEdge computes (currentPrice on origDir) - (degen avg entry).
          // Pass lowPriceEntryThreshold=null to disable the ratio sub-gate
          // (irrelevant for fade; absolute drift is the right metric here).
          const edge = analyseEntryEdge({
            aligned,
            market: m,
            direction: origDir,
            maxDrift: cfg.maxFadeDrift,
            lowPriceEntryThreshold: null,
            maxEntryRatio: null,
          });
          if (edge.skip) {
            this.lastSkippedByEdge.push({
              conditionId, originalDirection: origDir, reason: edge.reason,
              degenAvgEntry: edge.eliteAvgEntry, currentPrice: edge.currentPrice,
              fadeDrift: edge.entryEdge,
            });
            continue;
          }

          // Lottery-ticket gate: the fade-entry price is the opposite
          // outcome's price ≈ 1 - currentPrice(origDir) for a binary market.
          // When that's > maxFadeEntryPrice, the fade is a near-certain
          // favorite (tiny upside, full downside) the book already prices
          // efficiently — skip. edge.currentPrice is the origDir price.
          if (cfg.maxFadeEntryPrice > 0 && edge.currentPrice != null) {
            const fadeEntryPrice = 1 - edge.currentPrice;
            if (fadeEntryPrice > cfg.maxFadeEntryPrice) {
              this.lastSkippedByFadePrice.push({
                conditionId, originalDirection: origDir,
                degenCount: aligned.length,
                fadeEntryPrice,
              });
              continue;
            }
          }

          // INVERT direction for the fade signal
          const fadeDir = origDir === "YES" ? "NO" : "YES";
          const key = `${conditionId}::${fadeDir}`;

          const totalSize = aligned.reduce((s, a) => s + a.posValue, 0);
          const strength  = calcFadeStrength(aligned);

          confirmedKeys.add(key);

          const fadeFields = {
            degenCount:    aligned.length,
            degenAvgEntry: edge.eliteAvgEntry ?? null,
            currentPrice:  edge.currentPrice ?? null,
            fadeDrift:     edge.entryEdge ?? null,
            fadeOf:        {
              originalDirection: origDir,
              degenAddrs: aligned.map(a => a.addr),
            },
          };

          if (this.signals.has(key)) {
            const sig = this.signals.get(key);
            sig.lastConfirmedScan = this.scanCount;
            sig.lastConfirmedAt = now;
            sig.walletCount = aligned.length;
            sig.totalSize = totalSize;
            sig.strength = strength;
            sig.wallets = aligned;
            Object.assign(sig, fadeFields);
            if (sig.status === "NEW" || sig.status === "STALE") {
              sig.status = "CONFIRMED";
            }
          } else {
            this.signals.set(key, {
              conditionId,
              title: m.question || event.title || "",
              direction: fadeDir,
              fade: true,
              status: "NEW",
              strength,
              walletCount: aligned.length,
              totalSize,
              wallets: aligned,
              market: m,
              firstSeenAt: now,
              firstSeenScan: this.scanCount,
              lastConfirmedAt: now,
              lastConfirmedScan: this.scanCount,
              ...fadeFields,
            });
          }
        }
      }
    }

    // Lifecycle: NEW/CONFIRMED → STALE → EXPIRED
    for (const [key, sig] of this.signals) {
      if (confirmedKeys.has(key)) continue;
      const scansSinceConfirm = this.scanCount - sig.lastConfirmedScan;
      if (scansSinceConfirm >= cfg.expireAfterScans) sig.status = "EXPIRED";
      else if (scansSinceConfirm >= cfg.staleAfterScans) sig.status = "STALE";
    }
    for (const [key, sig] of this.signals) {
      if (sig.status === "EXPIRED" && this.scanCount - sig.lastConfirmedScan > cfg.expireAfterScans * 2) {
        this.signals.delete(key);
      }
    }

    // Cluster filter — keep at most `maxSignalsPerResolveDay` ACTIVE signals
    // per market resolution day (UTC). Stronger signals win. Demoted ones
    // are tagged EXPIRED so getActiveSignals() drops them, but stay in the
    // map so the next scan can re-emerge them with a fresh strength.
    this.lastClusterFiltered = [];
    if (cfg.maxSignalsPerResolveDay > 0) {
      const active = [...this.signals.values()]
        .filter(s => s.status !== "EXPIRED")
        .sort((a, b) => b.strength - a.strength);
      const dayCount = new Map();
      for (const sig of active) {
        const end = sig.market?.endDate ?? sig.market?.end_date_iso;
        if (!end) continue;
        const dayKey = String(end).slice(0, 10);   // "YYYY-MM-DD"
        const n = dayCount.get(dayKey) || 0;
        if (n >= cfg.maxSignalsPerResolveDay) {
          sig.status = "EXPIRED";
          sig.clusterFiltered = true;
          this.lastClusterFiltered.push({
            conditionId: sig.conditionId,
            direction:   sig.direction,
            strength:    sig.strength,
            resolveDay:  dayKey,
          });
        } else {
          dayCount.set(dayKey, n + 1);
        }
      }
    }

    return this.getActiveSignals();
  }

  getActiveSignals() {
    return [...this.signals.values()]
      .filter(s => s.status !== "EXPIRED")
      .sort((a, b) => b.strength - a.strength);
  }

  // Concurrency-lock API parity with consensus (engine delegates these)
  markTraded(cid, dir)   { const s = this.signals.get(`${cid}::${dir}`); if (s) s.traded = true; }
  unmarkTraded(cid, dir) { const s = this.signals.get(`${cid}::${dir}`); if (s) s.traded = false; }
  isTraded(cid, dir)     { return this.signals.get(`${cid}::${dir}`)?.traded === true; }
  getActive()            { return this.getActiveSignals(); }
}

/**
 * Fade strength heuristic. With minWallets=1 the count factor is fixed,
 * so we lean on:
 *   - DEGEN's loss magnitude (deeper -ROI = stronger fade conviction)
 *   - position size (skin in the game)
 * Returns 0..100. Designed so a single -50% ROI degen with a $500 position
 * lands around 60–70 (above the default minStrength=60 gate in config).
 */
function calcFadeStrength(aligned) {
  if (!aligned.length) return 0;
  const avgRoi = aligned.reduce((s, a) => s + (a.roi ?? 0), 0) / aligned.length;
  // -ROI in % units (e.g. -50 → 50). Cap at 100.
  const lossFactor = Math.max(0, Math.min(100, -avgRoi));
  const sizeFactor = Math.min(100, aligned.reduce((s, a) => s + a.weight, 0) * 100);
  // Weighted: loss conviction 65%, size 25%, count bonus 10%
  const countBonus = Math.min(100, 30 + (aligned.length - 1) * 20);
  return Math.round(lossFactor * 0.65 + sizeFactor * 0.25 + countBonus * 0.10);
}
