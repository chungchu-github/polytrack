import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client.js";
import clsx from "clsx";

export default function Trades() {
  const { data: trades = [], isLoading } = useQuery({
    queryKey: ["trades"],
    queryFn: api.getTrades,
    refetchInterval: 60_000,
  });

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex items-center justify-between">
        <h1 className="font-display text-xl font-bold tracking-wider text-surface-50">
          Trade Log
        </h1>
        <div className="flex items-center gap-3">
          <span className="text-sm text-surface-400">{trades.length} trades</span>
          <button
            onClick={() => api.downloadTradesCsv().catch(e => alert(e.message))}
            disabled={trades.length === 0}
            className="rounded-md border border-surface-700 px-3 py-1.5 text-xs text-surface-300 hover:bg-surface-700 transition-colors disabled:opacity-40"
          >
            Export CSV
          </button>
        </div>
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-16 animate-pulse rounded-md bg-surface-800" />
          ))}
        </div>
      ) : trades.length === 0 ? (
        <div className="card text-center py-12">
          <p className="text-surface-500 text-sm">No trades executed yet.</p>
          <p className="text-surface-600 text-xs mt-1">
            Enable auto-copy in Settings or manually trade from a signal.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-surface-700">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-surface-700 bg-surface-800/50">
                <th className="px-3 py-2.5 text-left text-2xs font-semibold uppercase tracking-wider text-surface-400">Time</th>
                <th className="px-3 py-2.5 text-left text-2xs font-semibold uppercase tracking-wider text-surface-400">Market</th>
                <th className="px-3 py-2.5 text-center text-2xs font-semibold uppercase tracking-wider text-surface-400">Dir</th>
                <th className="px-3 py-2.5 text-right text-2xs font-semibold uppercase tracking-wider text-surface-400">Size</th>
                <th className="px-3 py-2.5 text-right text-2xs font-semibold uppercase tracking-wider text-surface-400">Price</th>
                <th className="px-3 py-2.5 text-center text-2xs font-semibold uppercase tracking-wider text-surface-400">Status</th>
                <th className="px-3 py-2.5 text-left text-2xs font-semibold uppercase tracking-wider text-surface-400">Order ID</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-surface-700/50">
              {trades.map((t, i) => (
                <tr key={`${t.orderId || t.conditionId}-${i}`} className="hover:bg-surface-800/30 transition-colors">
                  <td className="px-3 py-2.5 text-xs tabular-nums text-surface-400 whitespace-nowrap">
                    {t.executedAt ? new Date(t.executedAt).toLocaleString() : "—"}
                  </td>
                  <td className="px-3 py-2.5 max-w-[200px]">
                    <p className="truncate text-xs font-medium text-surface-200">
                      {t.title || t.conditionId?.slice(0, 20)}
                    </p>
                  </td>
                  <td className="px-3 py-2.5 text-center">
                    <span className={clsx(
                      "badge",
                      t.direction === "YES" ? "bg-success/15 text-success" : "bg-danger/15 text-danger"
                    )}>
                      {t.direction}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums font-medium text-surface-200">
                    ${t.size}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-surface-300">
                    {t.midPrice ? `${(t.midPrice * 100).toFixed(0)}¢` : "—"}
                    {t.limitPrice && (
                      <span className="text-surface-500 ml-1">→ {(t.limitPrice * 100).toFixed(0)}¢</span>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-center">
                    <StatusBadge status={t.status} />
                  </td>
                  <td className="px-3 py-2.5 font-mono text-2xs text-surface-500">
                    {t.orderId ? `${t.orderId.slice(0, 12)}…` : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {trades.some(t => t.error) && (
        <div className="card border-danger/30">
          <h2 className="card-header text-danger">Errors</h2>
          <div className="space-y-1">
            {trades.filter(t => t.error).slice(0, 5).map((t, i) => (
              <p key={i} className="text-xs text-danger/80">
                {t.title?.slice(0, 40)} — {t.error}
              </p>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }) {
  const styles = {
    FILLED:    "bg-success/15 text-success",
    PENDING:   "bg-primary/15 text-primary",
    SUBMITTED: "bg-primary/15 text-primary",
    ERROR:     "bg-danger/15 text-danger",
    SIMULATED: "bg-accent/15 text-accent",
  };
  return (
    <span className={clsx("badge", styles[status] || "bg-surface-600/30 text-surface-400")}>
      {status}
    </span>
  );
}
