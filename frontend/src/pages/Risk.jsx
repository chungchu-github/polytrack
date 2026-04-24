import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client.js";
import clsx from "clsx";

const STRATEGY_NAMES = ["consensus", "momentum", "meanrev", "arbitrage"];
const STRAT_COLORS = {
  consensus: "text-primary",
  momentum:  "text-accent",
  meanrev:   "text-amber-400",
  arbitrage: "text-success",
};

export default function Risk() {
  const { data: health } = useQuery({
    queryKey: ["health"],
    queryFn: api.getHealth,
    refetchInterval: 5_000,
  });
  const { data: trades = [] } = useQuery({
    queryKey: ["trades"],
    queryFn: api.getTrades,
    refetchInterval: 10_000,
  });

  const risk = health?.risk || {};
  const accuracy = health?.signalAccuracy || {};
  const breakerStreak = health?.tradeFailureStreak ?? 0;

  const dailyLoss      = Number(risk.dailyLossUsdc || 0);
  const maxDaily       = Number(risk.maxDailyLossUsdc || 0);
  const totalExposure  = Number(risk.totalExposureUsdc || 0);
  const maxTotal       = Number(risk.maxTotalExposureUsdc || 0);
  const marketMax      = Number(risk.maxMarketExposureUsdc || 0);
  const marketExposure = risk.marketExposure || {}; // { conditionId: sizeUsdc }

  const marketRows = Object.entries(marketExposure)
    .map(([cid, size]) => ({ cid, size: Number(size) }))
    .sort((a, b) => b.size - a.size)
    .slice(0, 10);

  const errorTrades = trades.filter(t => t.status === "ERROR").length;
  const filledTrades = trades.filter(t => t.status === "FILLED" || t.status === "PARTIAL").length;

  const liveCap   = Number(risk.liveTestCapUsdc || 0);
  const liveUsed  = Number(risk.liveTestUsed    || 0);

  // F2: per-strategy accuracy (from /health)
  const accuracyByStrategy = health?.signalAccuracyByStrategy || {};

  // F2: per-strategy trade count + size (computed client-side; `strategy` column
  // was added in V4 migration). If older trades lack strategy, bucket as unknown.
  const tradeStatsByStrategy = {};
  for (const t of trades) {
    const key = t.strategy || "unknown";
    if (!tradeStatsByStrategy[key]) tradeStatsByStrategy[key] = { count: 0, filled: 0, totalSize: 0 };
    tradeStatsByStrategy[key].count++;
    if (t.status === "FILLED" || t.status === "PARTIAL") tradeStatsByStrategy[key].filled++;
    tradeStatsByStrategy[key].totalSize += Number(t.size || 0);
  }

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex items-center justify-between">
        <h1 className="font-display text-xl font-bold tracking-wider text-surface-50">
          Risk
        </h1>
        <span className={clsx(
          "badge",
          health?.autoEnabled ? "bg-success/15 text-success" : "bg-surface-600/30 text-surface-400"
        )}>
          Auto-Copy {health?.autoEnabled ? "ON" : "OFF"}
        </span>
      </div>

      {/* V3 Live-Test Budget — always rendered (shows "disabled" state when cap=0) */}
      {liveCap > 0 ? (
        <div className="rounded-md border border-accent/40 bg-accent/5 p-3">
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs font-semibold text-accent uppercase tracking-wider">
              V3 Live-Test Mode — hard cap active
            </p>
            <span className={clsx(
              "badge",
              liveUsed >= liveCap ? "bg-danger/15 text-danger" :
              liveUsed >= liveCap * 0.8 ? "bg-amber-500/15 text-amber-400" :
              "bg-success/15 text-success"
            )}>
              ${liveUsed.toFixed(2)} / ${liveCap.toFixed(0)}
            </span>
          </div>
          <div className="h-2 rounded-full bg-surface-700 overflow-hidden">
            <div
              className={clsx(
                "h-full transition-all",
                liveUsed >= liveCap ? "bg-danger" :
                liveUsed >= liveCap * 0.8 ? "bg-amber-400" : "bg-accent"
              )}
              style={{ width: `${Math.min((liveUsed / liveCap) * 100, 100)}%` }}
            />
          </div>
          <p className="text-2xs text-surface-500 mt-1">
            At 100%, all auto-copy is paused until the cap is raised (Settings → V3
            Live-Test Cap) or reset to 0 to disable the gate.
          </p>
        </div>
      ) : (
        <div className="rounded-md border border-surface-700 bg-surface-900/40 p-3">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold text-surface-400 uppercase tracking-wider">
              V3 Live-Test Mode — disabled
            </p>
            <span className="badge bg-surface-700 text-surface-400">no cap</span>
          </div>
          <p className="text-2xs text-surface-500 mt-1">
            Set a positive value in <strong className="text-surface-300">Settings → V3 Live-Test Cap (USDC)</strong>{" "}
            to enforce a cumulative auto-copy budget. Recommended starting value for first live run: $5.
          </p>
        </div>
      )}

      {/* Limit gauges */}
      <div className="grid gap-4 lg:grid-cols-3">
        <LimitCard
          label="Daily Loss"
          current={dailyLoss}
          limit={maxDaily}
          valueFmt={v => `$${v.toFixed(0)}`}
          dangerAtPct={80}
        />
        <LimitCard
          label="Total Exposure"
          current={totalExposure}
          limit={maxTotal}
          valueFmt={v => `$${v.toFixed(0)}`}
          dangerAtPct={80}
        />
        <LimitCard
          label="Per-Market Cap"
          current={marketRows[0]?.size || 0}
          limit={marketMax}
          valueFmt={v => `$${v.toFixed(0)}`}
          subtitle={marketRows[0] ? `top: ${marketRows[0].cid.slice(0, 10)}…` : "no open markets"}
          dangerAtPct={80}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Circuit Breaker */}
        <div className="card">
          <h2 className="card-header">Circuit Breaker</h2>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-surface-200">Consecutive trade failures</p>
              <p className="text-2xs text-surface-500 mt-0.5">Auto-copy disables at threshold</p>
            </div>
            <div className="text-right">
              <p className={clsx(
                "text-3xl font-display tabular-nums",
                breakerStreak >= 3 ? "text-danger" : breakerStreak > 0 ? "text-amber-400" : "text-surface-200"
              )}>
                {breakerStreak}
              </p>
            </div>
          </div>
        </div>

        {/* Signal Accuracy */}
        <div className="card">
          <h2 className="card-header">Signal Accuracy</h2>
          {accuracy.total > 0 ? (
            <div className="space-y-2">
              <div className="flex items-baseline gap-2">
                <span className="text-3xl font-display text-primary tabular-nums">
                  {accuracy.accuracy?.toFixed(1) ?? "—"}%
                </span>
                <span className="text-xs text-surface-500">
                  {accuracy.correct}/{accuracy.total} resolved
                </span>
              </div>
              <div className="h-2 rounded-full bg-surface-700 overflow-hidden">
                <div
                  className="h-full bg-primary transition-all"
                  style={{ width: `${Math.min(accuracy.accuracy || 0, 100)}%` }}
                />
              </div>
            </div>
          ) : (
            <p className="text-sm text-surface-500">No resolved signals yet.</p>
          )}
        </div>
      </div>

      {/* Trade Stats */}
      <div className="card">
        <h2 className="card-header">Execution Stats</h2>
        <div className="grid grid-cols-3 gap-4">
          <Stat label="Total Trades" value={trades.length} />
          <Stat label="Filled" value={filledTrades} valueClass="text-success" />
          <Stat label="Errors" value={errorTrades} valueClass={errorTrades > 0 ? "text-danger" : "text-surface-200"} />
        </div>
      </div>

      {/* F2: Per-Strategy Accuracy */}
      <div className="card">
        <h2 className="card-header">Accuracy by Strategy</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-2xs uppercase tracking-wider text-surface-500 text-left">
                <th className="py-2 pr-3 font-normal">Strategy</th>
                <th className="py-2 pr-3 font-normal tabular-nums text-right">Total</th>
                <th className="py-2 pr-3 font-normal tabular-nums text-right">Correct</th>
                <th className="py-2 font-normal tabular-nums text-right">Accuracy</th>
              </tr>
            </thead>
            <tbody>
              {STRATEGY_NAMES.map((name) => {
                const a = accuracyByStrategy[name] || { total: 0, correct: 0, accuracy: null };
                return (
                  <tr key={name} className="border-t border-surface-800">
                    <td className={clsx("py-2 pr-3 font-medium", STRAT_COLORS[name])}>{name}</td>
                    <td className="py-2 pr-3 tabular-nums text-right text-surface-200">{a.total}</td>
                    <td className="py-2 pr-3 tabular-nums text-right text-surface-200">{a.correct}</td>
                    <td className="py-2 tabular-nums text-right text-surface-200">
                      {a.total > 0 ? `${(a.accuracy ?? 0).toFixed(1)}%` : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* F2: Trade activity by strategy */}
      <div className="card">
        <h2 className="card-header">Trades by Strategy</h2>
        {Object.keys(tradeStatsByStrategy).length === 0 ? (
          <p className="text-sm text-surface-500">No trades executed yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-2xs uppercase tracking-wider text-surface-500 text-left">
                  <th className="py-2 pr-3 font-normal">Strategy</th>
                  <th className="py-2 pr-3 font-normal tabular-nums text-right">Trades</th>
                  <th className="py-2 pr-3 font-normal tabular-nums text-right">Filled</th>
                  <th className="py-2 font-normal tabular-nums text-right">Size (USDC)</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(tradeStatsByStrategy).map(([name, s]) => (
                  <tr key={name} className="border-t border-surface-800">
                    <td className={clsx("py-2 pr-3 font-medium", STRAT_COLORS[name] || "text-surface-300")}>
                      {name}
                    </td>
                    <td className="py-2 pr-3 tabular-nums text-right text-surface-200">{s.count}</td>
                    <td className="py-2 pr-3 tabular-nums text-right text-success">{s.filled}</td>
                    <td className="py-2 tabular-nums text-right text-surface-200">${s.totalSize.toFixed(0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Per-Market Exposure */}
      <div className="card">
        <h2 className="card-header">Per-Market Exposure</h2>
        {marketRows.length === 0 ? (
          <p className="text-sm text-surface-500">No open market exposure.</p>
        ) : (
          <div className="space-y-2">
            {marketRows.map(r => {
              const pct = marketMax > 0 ? (r.size / marketMax) * 100 : 0;
              return (
                <div key={r.cid} className="space-y-1">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-mono text-surface-400 truncate max-w-[50%]">{r.cid}</span>
                    <span className="tabular-nums text-surface-200">
                      ${r.size.toFixed(0)}
                      {marketMax > 0 && <span className="text-surface-500 ml-1">/ ${marketMax}</span>}
                    </span>
                  </div>
                  <div className="h-1.5 rounded-full bg-surface-700 overflow-hidden">
                    <div
                      className={clsx(
                        "h-full transition-all",
                        pct >= 80 ? "bg-danger" : pct >= 60 ? "bg-amber-400" : "bg-primary"
                      )}
                      style={{ width: `${Math.min(pct, 100)}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function LimitCard({ label, current, limit, valueFmt, subtitle, dangerAtPct = 80 }) {
  const pct = limit > 0 ? (current / limit) * 100 : 0;
  const color = pct >= dangerAtPct ? "text-danger" : pct >= 60 ? "text-amber-400" : "text-surface-100";
  const barColor = pct >= dangerAtPct ? "bg-danger" : pct >= 60 ? "bg-amber-400" : "bg-primary";

  return (
    <div className="card">
      <p className="text-2xs uppercase tracking-wider text-surface-500">{label}</p>
      <div className="mt-1 flex items-baseline gap-1">
        <span className={clsx("text-2xl font-display tabular-nums", color)}>
          {valueFmt(current)}
        </span>
        {limit > 0 && (
          <span className="text-sm text-surface-500">/ {valueFmt(limit)}</span>
        )}
      </div>
      {subtitle && <p className="text-2xs text-surface-600 mt-0.5">{subtitle}</p>}
      <div className="mt-2 h-1.5 rounded-full bg-surface-700 overflow-hidden">
        <div className={clsx("h-full transition-all", barColor)} style={{ width: `${Math.min(pct, 100)}%` }} />
      </div>
      <p className="text-2xs text-surface-500 mt-1 tabular-nums">{pct.toFixed(0)}% of cap</p>
    </div>
  );
}

function Stat({ label, value, valueClass = "text-surface-200" }) {
  return (
    <div>
      <p className="text-2xs uppercase tracking-wider text-surface-500">{label}</p>
      <p className={clsx("text-2xl font-display tabular-nums mt-0.5", valueClass)}>{value}</p>
    </div>
  );
}
