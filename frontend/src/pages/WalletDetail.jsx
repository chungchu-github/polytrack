import { useParams, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client.js";
import ScoreRing from "../components/ScoreRing.jsx";
import PnLChart from "../components/PnLChart.jsx";
import clsx from "clsx";

export default function WalletDetail() {
  const { addr } = useParams();
  const { data: wallets = [] } = useQuery({ queryKey: ["wallets"], queryFn: api.getWallets });

  const wallet = wallets.find(w => w.addr === addr);

  if (!wallet) {
    return (
      <div className="space-y-4 animate-fade-in">
        <Link to="/wallets" className="text-sm text-primary hover:underline">&larr; Back to Wallets</Link>
        <div className="card py-12 text-center">
          <p className="text-surface-400">Wallet not found or not yet loaded.</p>
          <p className="text-xs text-surface-500 mt-1">Address: {addr}</p>
        </div>
      </div>
    );
  }

  const metrics = [
    { label: "Win Rate", value: `${wallet.winRate?.toFixed(1)}%`, good: wallet.winRate > 50 },
    { label: "ROI", value: `${wallet.roi?.toFixed(1)}%`, good: wallet.roi > 0 },
    { label: "Sharpe", value: wallet.sharpe?.toFixed(2), good: wallet.sharpe > 1 },
    { label: "Max Drawdown", value: `${wallet.maxDrawdown?.toFixed(1)}%`, good: wallet.maxDrawdown < 20 },
    { label: "Timing", value: wallet.timing?.toFixed(0), good: wallet.timing > 50 },
    { label: "Consistency", value: wallet.consistency?.toFixed(0), good: wallet.consistency > 50 },
  ];

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <Link to="/wallets" className="text-xs text-primary hover:underline">&larr; Back to Wallets</Link>
          <h1 className="mt-1 font-display text-lg font-bold tracking-wider text-surface-50 break-all sm:text-xl">
            {addr.slice(0, 6)}…{addr.slice(-4)}
          </h1>
          <p className="mt-0.5 font-mono text-xs text-surface-500 break-all hidden sm:block">{addr}</p>
        </div>
        <ScoreRing score={wallet.score} tier={wallet.tier} size={72} />
      </div>

      {/* Tier + PnL */}
      <div className="flex flex-wrap gap-3">
        <TierBadgeLarge tier={wallet.tier} />
        <div className="card flex-1 min-w-[140px]">
          <span className="stat-label">Total PnL</span>
          <span className={clsx("stat-value mt-1 block", wallet.totalPnL >= 0 ? "text-success" : "text-danger")}>
            ${fmt(wallet.totalPnL)}
          </span>
        </div>
        <div className="card flex-1 min-w-[140px]">
          <span className="stat-label">Volume</span>
          <span className="stat-value mt-1 block text-surface-200">${fmt(wallet.volume)}</span>
        </div>
        <div className="card flex-1 min-w-[140px]">
          <span className="stat-label">Positions</span>
          <span className="stat-value mt-1 block text-surface-200">
            {wallet.closedPositions}
            <span className="text-sm text-surface-500 font-body ml-1">closed</span>
          </span>
          <span className="text-xs text-surface-400">{wallet.openPositions} open</span>
        </div>
      </div>

      {/* Metrics Grid */}
      <div className="card">
        <h2 className="card-header">Performance Metrics</h2>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
          {metrics.map(m => (
            <div key={m.label}>
              <span className="text-2xs uppercase tracking-wider text-surface-500">{m.label}</span>
              <p className={clsx("text-lg font-display font-bold tabular-nums", m.good ? "text-success" : "text-danger")}>
                {m.value ?? "—"}
              </p>
            </div>
          ))}
        </div>
      </div>

      {/* PnL Chart */}
      <div className="card">
        <h2 className="card-header">PnL Over Time</h2>
        <PnLChart trades={wallet.recentTrades || []} height={260} />
      </div>

      {/* Positions */}
      {wallet.positions?.length > 0 && (
        <div className="card">
          <h2 className="card-header">Open Positions ({wallet.positions.length})</h2>
          <div className="overflow-x-auto -mx-4 px-4">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-surface-700 text-left">
                  <th className="pb-2 text-2xs font-semibold uppercase tracking-wider text-surface-400">Market</th>
                  <th className="pb-2 text-right text-2xs font-semibold uppercase tracking-wider text-surface-400">Size</th>
                  <th className="pb-2 text-right text-2xs font-semibold uppercase tracking-wider text-surface-400">Avg Price</th>
                  <th className="pb-2 text-right text-2xs font-semibold uppercase tracking-wider text-surface-400">Current</th>
                  <th className="pb-2 text-right text-2xs font-semibold uppercase tracking-wider text-surface-400">PnL</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-700/50">
                {wallet.positions.slice(0, 20).map((pos, i) => {
                  const size = Number(pos.size || 0);
                  const avgPrice = Number(pos.avgPrice || pos.averagePrice || 0);
                  const curPrice = Number(pos.curPrice || pos.currentPrice || avgPrice);
                  const pnl = size * (curPrice - avgPrice);

                  return (
                    <tr key={pos.conditionId || i} className="hover:bg-surface-800/30 transition-colors">
                      <td className="py-2 max-w-[200px]">
                        <p className="truncate text-xs text-surface-200">{pos.title || pos.question || pos.conditionId?.slice(0, 20)}</p>
                        <span className={clsx(
                          "badge mt-0.5",
                          pos.outcome === "Yes" ? "bg-success/15 text-success" : "bg-danger/15 text-danger"
                        )}>
                          {pos.outcome || "—"}
                        </span>
                      </td>
                      <td className="py-2 text-right tabular-nums text-surface-300">{size.toFixed(1)}</td>
                      <td className="py-2 text-right tabular-nums text-surface-400">{(avgPrice * 100).toFixed(0)}¢</td>
                      <td className="py-2 text-right tabular-nums text-surface-300">{(curPrice * 100).toFixed(0)}¢</td>
                      <td className={clsx("py-2 text-right tabular-nums font-medium", pnl >= 0 ? "text-success" : "text-danger")}>
                        ${pnl.toFixed(2)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Recent Trades */}
      {wallet.recentTrades?.length > 0 && (
        <div className="card">
          <h2 className="card-header">Recent Trades ({wallet.recentTrades.length})</h2>
          <div className="space-y-1.5 max-h-64 overflow-y-auto">
            {wallet.recentTrades.map((t, i) => (
              <div key={i} className="flex items-center justify-between rounded border border-surface-700/50 bg-surface-900/40 px-3 py-1.5 text-xs">
                <span className="truncate text-surface-300 max-w-[50%]">
                  {t.title || t.market || t.conditionId?.slice(0, 16)}
                </span>
                <div className="flex items-center gap-2 shrink-0">
                  <span className={clsx(
                    "badge",
                    t.side === "BUY" || t.type === "BUY" ? "bg-success/15 text-success" : "bg-danger/15 text-danger"
                  )}>
                    {t.side || t.type || "—"}
                  </span>
                  <span className="tabular-nums text-surface-400">${Number(t.usdcSize || t.amount || 0).toFixed(0)}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function TierBadgeLarge({ tier }) {
  const styles = {
    ELITE: "border-primary/30 bg-primary/10 text-primary",
    PRO:   "border-accent/30 bg-accent/10 text-accent",
    BASIC: "border-surface-600/30 bg-surface-700/20 text-surface-400",
  };
  return (
    <div className={clsx("card flex items-center justify-center min-w-[100px]", styles[tier] || styles.BASIC)}>
      <span className="font-display text-lg font-bold tracking-widest">{tier}</span>
    </div>
  );
}

function fmt(n) {
  if (n == null) return "—";
  return Math.abs(n) >= 1000 ? `${(n / 1000).toFixed(1)}k` : n.toFixed(0);
}
