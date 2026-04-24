/**
 * HistoryReader — thin accessor over F0.5 snapshot tables for the backtest
 * engine. Pure DB reads; no network, no side effects.
 */
import { getDB, getMarketSnapshots, getPositionHistory, getWalletTierAt } from "../db.js";

export class HistoryReader {
  constructor() { this.db = getDB(); }

  getMarketSnapshots(conditionId, sinceMs, untilMs) {
    return getMarketSnapshots(conditionId, sinceMs, untilMs);
  }
  getPositionHistory(wallet, sinceMs, untilMs) {
    return getPositionHistory(wallet, sinceMs, untilMs);
  }

  /**
   * Reconstruct synthetic "markets" input (as produced by fetchMarkets) from
   * snapshot rows in [sinceMs, untilMs]. One event per distinct condition_id;
   * `tokens` derived from distinct token_ids observed.
   */
  getMarketsAt(sinceMs, untilMs) {
    const rows = this.db.prepare(
      `SELECT DISTINCT condition_id, token_id
         FROM market_snapshots
        WHERE timestamp >= ? AND timestamp <= ?`
    ).all(sinceMs, untilMs);
    const byCid = new Map();
    for (const r of rows) {
      if (!byCid.has(r.condition_id)) byCid.set(r.condition_id, new Set());
      byCid.get(r.condition_id).add(r.token_id);
    }
    return [...byCid.entries()].map(([cid, tokens]) => ({
      title: "",
      markets: [{
        conditionId: cid,
        question: "",
        tokens: [...tokens].map(id => ({ token_id: id })),
      }],
    }));
  }

  /**
   * Reconstruct wallet-shaped objects at time t from positions_history.
   * Used by ConsensusStrategy which expects `wallets[*].positions`.
   *
   * Tier is looked up from wallet_tier_history (N1 survivorship fix) so the
   * backtest only counts a wallet as ELITE if it was ELITE at time t. When no
   * history exists (e.g. pre-V7 data that pre-dates the tier log), we fall
   * back to "ELITE" to match the previous hardcoded behaviour — callers who
   * want the stricter default should filter upstream.
   */
  getWalletsAt(walletAddresses, t, windowMs = 60 * 60 * 1000) {
    const since = t - windowMs;
    const out = [];
    for (const addr of walletAddresses) {
      const rows = this.db.prepare(
        `SELECT * FROM positions_history
          WHERE wallet_address = ? AND snapshot_at <= ? AND snapshot_at >= ?
          ORDER BY snapshot_at DESC`
      ).all(addr, t, since);
      if (rows.length === 0) continue;
      // Keep most recent row per (condition_id, outcome)
      const seen = new Set();
      const positions = [];
      for (const r of rows) {
        const k = `${r.condition_id}::${r.outcome || ""}`;
        if (seen.has(k)) continue;
        seen.add(k);
        positions.push({
          conditionId: r.condition_id,
          outcome: r.outcome,
          size: r.size,
          avgPrice: r.avg_price,
          currentValue: r.current_value,
        });
      }
      const tier = getWalletTierAt(addr, t) ?? "ELITE";
      out.push({
        addr, tier, score: 80,
        winRate: 0, roi: 0, totalPnL: 0,
        positions,
        recentTrades: [],
        updatedAt: t,
      });
    }
    return out;
  }

  /** Find the market snapshot closest to `t` (within window) for a token. */
  getMarketAt(tokenId, t, windowMs = 2 * 60 * 60 * 1000) {
    return this.db.prepare(
      `SELECT * FROM market_snapshots
        WHERE token_id = ? AND timestamp <= ? AND timestamp >= ?
        ORDER BY timestamp DESC LIMIT 1`
    ).get(tokenId, t, t - windowMs);
  }

  /** List all wallet addresses that have any snapshot in the window. */
  listWallets(sinceMs, untilMs) {
    return this.db.prepare(
      `SELECT DISTINCT wallet_address FROM positions_history
        WHERE snapshot_at >= ? AND snapshot_at <= ?`
    ).all(sinceMs, untilMs).map(r => r.wallet_address);
  }
}
