import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine,
} from "recharts";
import clsx from "clsx";
import { api } from "../api/client.js";

// F3 Backtest page — submit runs, poll status, render metrics + equity curve.
// Backend endpoints: POST /backtest, GET /backtests, GET /backtest/:id, DELETE /backtest/:id

const STRATEGIES = ["consensus", "momentum", "meanrev", "arbitrage"];

// Sensible defaults per strategy (mirror src/config.js DEFAULTS.strategies).
// These seed the JSON textarea when the user picks a strategy.
const STRATEGY_CONFIG_DEFAULTS = {
  consensus: { enabled: true,  minStrength: 50 },
  momentum:  { enabled: true,  minStrength: 60, lookbackHours: 4, minPriceMovePct: 8,  minVolume24h: 1000, monotonicity: 0.5 },
  meanrev:   { enabled: true,  minStrength: 55, lookbackDays: 7,  zScoreThreshold: 2.0, minSamples: 20 },
  arbitrage: { enabled: true,  minStrength: 70, minEdgePct: 1.5 },
};

const STRAT_COLORS = {
  consensus: "text-primary",
  momentum:  "text-accent",
  meanrev:   "text-amber-400",
  arbitrage: "text-success",
};

function toEpochStartOfDay(dateStr) {
  if (!dateStr) return null;
  // dateStr = "YYYY-MM-DD"; treat as local 00:00.
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
}

function toEpochEndOfDay(dateStr) {
  if (!dateStr) return null;
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d, 23, 59, 59, 999).getTime();
}

function fmtDate(ms) {
  if (!ms) return "—";
  const d = new Date(Number(ms));
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function fmtUsd(v) {
  if (v == null || Number.isNaN(Number(v))) return "—";
  const n = Number(v);
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

export default function Backtest() {
  const qc = useQueryClient();

  const [form, setForm] = useState(() => {
    const end = new Date();
    const start = new Date(Date.now() - 7 * 86400_000);
    return {
      dateStart: start.toISOString().slice(0, 10),
      dateEnd:   end.toISOString().slice(0, 10),
      strategy:  "consensus",
      strategyConfig: JSON.stringify(STRATEGY_CONFIG_DEFAULTS.consensus, null, 2),
      sizeUsdc:    100,
      initialCash: 10000,
      stepMinutes: 60,
      slippagePct: 2,
    };
  });

  const [selectedId, setSelectedId] = useState(null);
  const [formError, setFormError] = useState("");

  // List of all historical backtests
  const { data: history = [] } = useQuery({
    queryKey: ["backtests"],
    queryFn: api.listBacktests,
    refetchInterval: 5_000,
  });

  // Detail of the currently-selected backtest — polls while RUNNING
  const { data: detail } = useQuery({
    queryKey: ["backtest", selectedId],
    queryFn: () => api.getBacktest(selectedId),
    enabled: !!selectedId,
    refetchInterval: (q) => (q.state.data?.status === "RUNNING" ? 2_000 : false),
  });

  const runMutation = useMutation({
    mutationFn: (params) => api.runBacktest(params),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["backtests"] });
      if (data?.id) setSelectedId(data.id);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id) => api.deleteBacktest(id),
    onSuccess: (_res, id) => {
      if (selectedId === id) setSelectedId(null);
      qc.invalidateQueries({ queryKey: ["backtests"] });
    },
  });

  function handleStrategyChange(next) {
    setForm((prev) => ({
      ...prev,
      strategy: next,
      strategyConfig: JSON.stringify(STRATEGY_CONFIG_DEFAULTS[next] || {}, null, 2),
    }));
  }

  function handleSubmit(e) {
    e.preventDefault();
    setFormError("");

    const dateStart = toEpochStartOfDay(form.dateStart);
    const dateEnd   = toEpochEndOfDay(form.dateEnd);
    if (!dateStart || !dateEnd || dateStart >= dateEnd) {
      setFormError("Invalid date range");
      return;
    }

    let strategyConfig = {};
    try { strategyConfig = JSON.parse(form.strategyConfig || "{}"); }
    catch { setFormError("Strategy config is not valid JSON"); return; }

    runMutation.mutate({
      dateStart, dateEnd,
      strategy: form.strategy,
      strategyConfig,
      sizeUsdc:    Number(form.sizeUsdc)    || 100,
      initialCash: Number(form.initialCash) || 10000,
      stepMinutes: Number(form.stepMinutes) || 60,
      slippagePct: Number(form.slippagePct) || 2,
    });
  }

  return (
    <div className="animate-fade-in">
      <h1 className="font-display text-xl font-bold tracking-wider text-surface-50 mb-4">
        Backtest
      </h1>

      <div className="grid gap-6 lg:grid-cols-[260px_1fr]">
        {/* ── History sidebar ─────────────────────────────────────────────── */}
        <aside className="card h-fit">
          <h2 className="card-header">History</h2>
          {history.length === 0 ? (
            <p className="text-sm text-surface-500">No backtests yet.</p>
          ) : (
            <div className="space-y-1.5 max-h-[600px] overflow-y-auto pr-1">
              {history.map((h) => (
                <div
                  key={h.id}
                  className={clsx(
                    "rounded-md border px-2.5 py-2 cursor-pointer transition-colors",
                    selectedId === h.id
                      ? "border-primary/50 bg-primary/10"
                      : "border-surface-700 bg-surface-900/40 hover:bg-surface-800/60"
                  )}
                  onClick={() => setSelectedId(h.id)}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className={clsx("text-xs font-semibold", STRAT_COLORS[h.strategy] || "text-surface-200")}>
                      {h.strategy}
                    </span>
                    <span
                      className={clsx(
                        "text-2xs uppercase tracking-wider",
                        h.status === "DONE"    ? "text-success" :
                        h.status === "RUNNING" ? "text-primary animate-pulse-glow" :
                        h.status === "FAILED"  ? "text-danger" : "text-surface-500"
                      )}
                    >
                      {h.status}
                    </span>
                  </div>
                  <div className="text-2xs text-surface-500 tabular-nums mt-0.5">
                    {fmtDate(h.date_start)} → {fmtDate(h.date_end)}
                  </div>
                  <div className="flex items-center justify-between mt-1">
                    <span className="text-2xs text-surface-600 tabular-nums">
                      #{h.id} · {fmtDate(h.created_at)}
                    </span>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (confirm(`Delete backtest #${h.id}?`)) deleteMutation.mutate(h.id);
                      }}
                      className="text-2xs text-surface-500 hover:text-danger"
                      aria-label={`Delete backtest ${h.id}`}
                    >
                      ✕
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </aside>

        {/* ── Main: V2 gate + form + results ──────────────────────────────── */}
        <div className="space-y-6 min-w-0">
          {/* V2 Gate — one-click edge validation across all strategies */}
          <EdgeValidationCard />

          {/* Form */}
          <form onSubmit={handleSubmit} className="card space-y-4">
            <h2 className="card-header">Configure Run</h2>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              <Field label="Start Date">
                <input
                  type="date"
                  value={form.dateStart}
                  onChange={(e) => setForm({ ...form, dateStart: e.target.value })}
                  className="w-full rounded-md border border-surface-700 bg-surface-800 px-3 py-2 text-sm text-surface-200 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/30"
                />
              </Field>
              <Field label="End Date">
                <input
                  type="date"
                  value={form.dateEnd}
                  onChange={(e) => setForm({ ...form, dateEnd: e.target.value })}
                  className="w-full rounded-md border border-surface-700 bg-surface-800 px-3 py-2 text-sm text-surface-200 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/30"
                />
              </Field>
              <Field label="Strategy">
                <select
                  value={form.strategy}
                  onChange={(e) => handleStrategyChange(e.target.value)}
                  className="w-full rounded-md border border-surface-700 bg-surface-800 px-3 py-2 text-sm text-surface-200 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/30"
                >
                  {STRATEGIES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </Field>
              <Field label="Size (USDC)">
                <input
                  type="number" min="1" step="1"
                  value={form.sizeUsdc}
                  onChange={(e) => setForm({ ...form, sizeUsdc: e.target.value })}
                  className="w-full rounded-md border border-surface-700 bg-surface-800 px-3 py-2 text-sm text-surface-200 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/30"
                />
              </Field>
              <Field label="Initial Cash (USDC)">
                <input
                  type="number" min="1" step="100"
                  value={form.initialCash}
                  onChange={(e) => setForm({ ...form, initialCash: e.target.value })}
                  className="w-full rounded-md border border-surface-700 bg-surface-800 px-3 py-2 text-sm text-surface-200 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/30"
                />
              </Field>
              <Field label="Step (minutes)">
                <input
                  type="number" min="1" step="1"
                  value={form.stepMinutes}
                  onChange={(e) => setForm({ ...form, stepMinutes: e.target.value })}
                  className="w-full rounded-md border border-surface-700 bg-surface-800 px-3 py-2 text-sm text-surface-200 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/30"
                />
              </Field>
            </div>

            <Field label="Strategy Config (JSON)">
              <textarea
                rows={5}
                spellCheck={false}
                value={form.strategyConfig}
                onChange={(e) => setForm({ ...form, strategyConfig: e.target.value })}
                className="w-full rounded-md border border-surface-700 bg-surface-800 px-3 py-2 font-mono text-2xs text-surface-200 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/30"
              />
            </Field>

            <div className="flex items-center gap-3">
              <button
                type="submit"
                disabled={runMutation.isPending}
                className="btn-primary"
              >
                {runMutation.isPending ? "Starting…" : "Run Backtest"}
              </button>
              {formError && <span className="text-xs text-danger">{formError}</span>}
              {runMutation.isError && (
                <span className="text-xs text-danger">{runMutation.error.message}</span>
              )}
            </div>
          </form>

          {/* Results */}
          {!selectedId ? (
            <div className="card">
              <p className="text-sm text-surface-500">
                Select a backtest from the history sidebar or run a new one to see results.
              </p>
            </div>
          ) : !detail ? (
            <div className="card">
              <p className="text-sm text-surface-500">Loading backtest #{selectedId}…</p>
            </div>
          ) : (
            <BacktestResult detail={detail} />
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Result subcomponents ─────────────────────────────────────────────── */

function BacktestResult({ detail }) {
  const metrics = detail.metrics || {};
  const trades = detail.trades || [];
  const equityCurve = detail.equityCurve || [];

  if (detail.status === "RUNNING") {
    return (
      <div className="card">
        <h2 className="card-header">Running…</h2>
        <p className="text-sm text-surface-400">
          Backtest #{detail.id} ({detail.strategy}) is still running. This page refreshes every 2 seconds.
        </p>
      </div>
    );
  }

  if (detail.status === "FAILED") {
    return (
      <div className="card">
        <h2 className="card-header">Failed</h2>
        <p className="text-sm text-danger">{detail.error || "Unknown error"}</p>
      </div>
    );
  }

  return (
    <>
      {/* Metrics cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <MetricCard
          label="Total PnL"
          value={fmtUsd(metrics.totalPnL)}
          valueClass={
            (metrics.totalPnL ?? 0) > 0 ? "text-success" :
            (metrics.totalPnL ?? 0) < 0 ? "text-danger"  : "text-surface-200"
          }
          sub={`Final $${(metrics.finalEquity ?? 0).toFixed(2)}`}
        />
        <MetricCard
          label="Win Rate"
          value={metrics.winRate != null ? `${metrics.winRate}%` : "—"}
          sub={`${metrics.wins ?? 0} W / ${metrics.losses ?? 0} L`}
        />
        <MetricCard
          label="Sharpe"
          value={metrics.sharpe != null ? metrics.sharpe.toFixed(2) : "—"}
          sub="simple (no ann.)"
        />
        <MetricCard
          label="Max Drawdown"
          value={metrics.maxDrawdownPct != null ? `${metrics.maxDrawdownPct}%` : "—"}
          valueClass={(metrics.maxDrawdownPct ?? 0) > 10 ? "text-danger" : "text-surface-200"}
          sub="peak → trough"
        />
      </div>

      {/* Equity curve */}
      <div className="card">
        <div className="flex items-center justify-between mb-2">
          <h2 className="card-header !mb-0">Equity Curve</h2>
          <span className="text-2xs text-surface-500 tabular-nums">
            {equityCurve.length} points · initial ${metrics.initialCash ?? 0}
          </span>
        </div>
        <EquityChart points={equityCurve} initial={metrics.initialCash} />
      </div>

      {/* Run meta + trades */}
      <div className="card">
        <h2 className="card-header">Run Details</h2>
        <dl className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-1.5 text-xs">
          <Meta label="ID" value={`#${detail.id}`} />
          <Meta label="Strategy" value={<span className={STRAT_COLORS[detail.strategy] || "text-surface-200"}>{detail.strategy}</span>} />
          <Meta label="Trades" value={metrics.tradeCount ?? 0} />
          <Meta label="Settlements" value={metrics.settlements ?? 0} />
          <Meta label="Open Positions" value={metrics.openPositions ?? 0} />
          <Meta label="Cash (final)" value={fmtUsd(metrics.cash)} />
          <Meta label="Date Range" value={`${fmtDate(detail.date_start)} → ${fmtDate(detail.date_end)}`} />
          <Meta label="Completed" value={fmtDate(detail.completed_at)} />
        </dl>
      </div>

      <div className="card">
        <h2 className="card-header">Trade Log</h2>
        <TradeTable trades={trades} />
      </div>
    </>
  );
}

function EquityChart({ points = [], initial = 0 }) {
  const data = useMemo(() => {
    if (!points.length) return [];
    return points.map((p, i) => ({
      index: i,
      date: new Date(Number(p.t) || 0).toLocaleDateString("en-US", { month: "short", day: "numeric" }),
      equity: Math.round(Number(p.equity || 0) * 100) / 100,
    }));
  }, [points]);

  if (data.length < 2) {
    return (
      <div className="flex items-center justify-center text-sm text-surface-500" style={{ height: 260 }}>
        No equity data for this backtest.
      </div>
    );
  }

  const minEq = Math.min(...data.map(d => d.equity));
  const maxEq = Math.max(...data.map(d => d.equity));
  const finalEq = data[data.length - 1].equity;
  const profitable = finalEq >= (initial || minEq);
  const color = profitable ? "#10B981" : "#EF4444";

  return (
    <ResponsiveContainer width="100%" height={260}>
      <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <defs>
          <linearGradient id="eqGradPos" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#10B981" stopOpacity={0.3} />
            <stop offset="100%" stopColor="#10B981" stopOpacity={0} />
          </linearGradient>
          <linearGradient id="eqGradNeg" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#EF4444" stopOpacity={0.3} />
            <stop offset="100%" stopColor="#EF4444" stopOpacity={0} />
          </linearGradient>
        </defs>
        <XAxis
          dataKey="date"
          tick={{ fill: "#64748B", fontSize: 10 }}
          axisLine={{ stroke: "#334155" }}
          tickLine={false}
          interval="preserveStartEnd"
        />
        <YAxis
          tick={{ fill: "#64748B", fontSize: 10 }}
          axisLine={false}
          tickLine={false}
          tickFormatter={(v) => `$${v}`}
          width={60}
          domain={[Math.min(initial || minEq, minEq), maxEq]}
        />
        <Tooltip
          contentStyle={{
            backgroundColor: "#1E293B",
            border: "1px solid #334155",
            borderRadius: 8,
            fontSize: 12,
            fontFamily: "JetBrains Mono, monospace",
          }}
          labelStyle={{ color: "#94A3B8" }}
          formatter={(value) => [`$${Number(value).toFixed(2)}`, "Equity"]}
        />
        {initial > 0 && (
          <ReferenceLine y={initial} stroke="#334155" strokeDasharray="3 3"
            label={{ value: `start $${initial}`, fill: "#64748B", fontSize: 10, position: "insideTopLeft" }} />
        )}
        <Area
          type="monotone"
          dataKey="equity"
          stroke={color}
          strokeWidth={2}
          fill={profitable ? "url(#eqGradPos)" : "url(#eqGradNeg)"}
          dot={false}
          activeDot={{ r: 4, fill: "#F59E0B", stroke: "#0F172A", strokeWidth: 2 }}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

function TradeTable({ trades }) {
  if (!trades.length) {
    return <p className="text-sm text-surface-500">No trades in this backtest.</p>;
  }
  const visible = trades.slice(0, 50);
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-2xs uppercase tracking-wider text-surface-500 text-left">
            <th className="py-1.5 pr-3 font-normal">Kind</th>
            <th className="py-1.5 pr-3 font-normal">Market</th>
            <th className="py-1.5 pr-3 font-normal">Direction</th>
            <th className="py-1.5 pr-3 font-normal tabular-nums text-right">Shares</th>
            <th className="py-1.5 pr-3 font-normal tabular-nums text-right">Fill Price</th>
            <th className="py-1.5 pr-3 font-normal tabular-nums text-right">USDC</th>
            <th className="py-1.5 pr-3 font-normal tabular-nums text-right">PnL</th>
            <th className="py-1.5 font-normal">Time</th>
          </tr>
        </thead>
        <tbody>
          {visible.map((t, i) => {
            const isSettlement = t.kind === "SETTLEMENT";
            const pnl = Number(t.pnl || 0);
            return (
              <tr key={i} className="border-t border-surface-800">
                <td className="py-1.5 pr-3">
                  <span className={clsx(
                    "badge",
                    isSettlement ? "bg-amber-500/15 text-amber-400" : "bg-primary/15 text-primary"
                  )}>
                    {isSettlement ? "SETTLE" : (t.status || "FILL")}
                  </span>
                </td>
                <td className="py-1.5 pr-3 font-mono text-surface-400 truncate max-w-[140px]">
                  {t.conditionId?.slice(0, 16) || "—"}…
                </td>
                <td className="py-1.5 pr-3">
                  <span className={clsx(
                    "badge",
                    t.direction === "YES" ? "bg-success/15 text-success" : "bg-danger/15 text-danger"
                  )}>
                    {t.direction || "—"}
                  </span>
                </td>
                <td className="py-1.5 pr-3 tabular-nums text-right text-surface-200">
                  {t.shares != null ? Number(t.shares).toFixed(2) : "—"}
                </td>
                <td className="py-1.5 pr-3 tabular-nums text-right text-surface-200">
                  {t.fillPrice != null ? Number(t.fillPrice).toFixed(3) : "—"}
                </td>
                <td className="py-1.5 pr-3 tabular-nums text-right text-surface-200">
                  {t.filledUsdc != null ? fmtUsd(t.filledUsdc) :
                   t.payout     != null ? fmtUsd(t.payout) : "—"}
                </td>
                <td className={clsx(
                  "py-1.5 pr-3 tabular-nums text-right",
                  pnl > 0 ? "text-success" : pnl < 0 ? "text-danger" : "text-surface-400"
                )}>
                  {isSettlement ? fmtUsd(pnl) : "—"}
                </td>
                <td className="py-1.5 text-surface-500 tabular-nums">
                  {t.timestamp ? new Date(Number(t.timestamp)).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {trades.length > visible.length && (
        <p className="text-2xs text-surface-500 mt-2">
          Showing first {visible.length} of {trades.length} trades.
        </p>
      )}
    </div>
  );
}

function EdgeValidationCard() {
  const [days, setDays] = useState(30);
  const [result, setResult] = useState(null);

  const mut = useMutation({
    mutationFn: (params) => api.validateEdge(params),
    onSuccess: setResult,
  });

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-2 gap-2">
        <h2 className="card-header !mb-0">V2 Gate — Edge Validation</h2>
        <div className="flex items-center gap-2">
          {result?.evaluatedAt && (
            <span className="text-2xs text-surface-500 tabular-nums">
              Evaluated {formatRelativeTime(result.evaluatedAt)}
            </span>
          )}
          {result && (
            <span className={clsx(
              "badge",
              result.allPass ? "bg-success/15 text-success" : "bg-danger/15 text-danger"
            )}>
              {result.allPass ? "all strategies pass" : `${result.passCount}/${result.results.length} pass`}
            </span>
          )}
        </div>
      </div>
      <p className="text-2xs text-surface-500 mb-3">
        Runs a backtest over the trailing window for every strategy and grades against
        Sharpe&nbsp;&gt;&nbsp;1.0, win&nbsp;rate&nbsp;&gt;&nbsp;55%, and ≥&nbsp;10 trades. Required before enabling real-money auto-copy.
      </p>
      {!result && !mut.isPending && (
        <p className="text-2xs text-surface-600 italic mb-3">
          Not yet evaluated. Click below to run all 4 strategies against the current trailing window.
        </p>
      )}
      <div className="flex items-center gap-2 mb-3">
        <label className="text-xs text-surface-400">Window (days):</label>
        <input
          type="number"
          min="1" max="365" step="1"
          value={days}
          onChange={(e) => setDays(Number(e.target.value))}
          className="w-20 rounded-md border border-surface-700 bg-surface-800 px-2 py-1 text-xs text-surface-200 focus:border-primary focus:outline-none"
        />
        <button
          type="button"
          onClick={() => mut.mutate({ days })}
          disabled={mut.isPending}
          className="btn-primary text-xs"
        >
          {mut.isPending ? (
            <span className="inline-flex items-center gap-1">
              <span className="inline-block h-3 w-3 rounded-full border-2 border-surface-900 border-t-transparent animate-spin" />
              Validating…
            </span>
          ) : result ? "Re-run Edge Validation" : "Run Edge Validation"}
        </button>
        {mut.isError && (
          <span className="text-xs text-danger">{mut.error.message}</span>
        )}
      </div>
      {result && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {result.results.map((r) => {
            const m = r.metrics || {};
            return (
              <div
                key={r.strategy}
                className={clsx(
                  "rounded-md border p-3",
                  r.pass
                    ? "border-success/40 bg-success/5"
                    : "border-danger/40 bg-danger/5"
                )}
              >
                <div className="flex items-center justify-between mb-2">
                  <span className={clsx("text-sm font-semibold", STRAT_COLORS[r.strategy] || "text-surface-200")}>
                    {r.strategy}
                  </span>
                  <span className={clsx(
                    "badge",
                    r.pass ? "bg-success/15 text-success" : "bg-danger/15 text-danger"
                  )}>
                    {r.pass ? "PASS" : "FAIL"}
                  </span>
                </div>
                <dl className="grid grid-cols-2 gap-x-2 gap-y-1 text-2xs">
                  <dt className="text-surface-500">Sharpe</dt>
                  <dd className={clsx("tabular-nums text-right", (m.sharpe ?? 0) > 1 ? "text-success" : "text-surface-200")}>
                    {m.sharpe != null ? m.sharpe.toFixed(2) : "—"}
                  </dd>
                  <dt className="text-surface-500">Win rate</dt>
                  <dd className={clsx("tabular-nums text-right", (m.winRate ?? 0) > 55 ? "text-success" : "text-surface-200")}>
                    {m.winRate != null ? `${m.winRate}%` : "—"}
                  </dd>
                  <dt className="text-surface-500">Trades</dt>
                  <dd className={clsx("tabular-nums text-right", (m.tradeCount ?? 0) >= 10 ? "text-success" : "text-surface-200")}>
                    {m.tradeCount ?? 0}
                  </dd>
                  <dt className="text-surface-500">Total PnL</dt>
                  <dd className={clsx(
                    "tabular-nums text-right",
                    (m.totalPnL ?? 0) > 0 ? "text-success" :
                    (m.totalPnL ?? 0) < 0 ? "text-danger"  : "text-surface-200"
                  )}>
                    {m.totalPnL != null ? `$${m.totalPnL}` : "—"}
                  </dd>
                </dl>
                {!r.pass && r.reasons?.length > 0 && (
                  <p className="text-2xs text-danger/80 mt-2 leading-tight">
                    {r.reasons.join(" · ")}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function MetricCard({ label, value, sub, valueClass = "text-surface-100" }) {
  return (
    <div className="card">
      <p className="text-2xs uppercase tracking-wider text-surface-500">{label}</p>
      <p className={clsx("text-2xl font-display tabular-nums mt-1", valueClass)}>{value}</p>
      {sub && <p className="text-2xs text-surface-600 mt-0.5">{sub}</p>}
    </div>
  );
}

function Field({ label, children }) {
  return (
    <label className="block">
      <span className="text-2xs uppercase tracking-wider text-surface-500 block mb-1">{label}</span>
      {children}
    </label>
  );
}

function Meta({ label, value }) {
  return (
    <>
      <dt className="text-surface-500">{label}</dt>
      <dd className="text-surface-200 tabular-nums text-right">{value}</dd>
    </>
  );
}

// Human-readable relative timestamp (for edge-validation "Evaluated X ago" hint).
// Keeps the number short — we don't need calendar-precision for a cache marker.
function formatRelativeTime(ms) {
  if (!ms) return "—";
  const diff = Date.now() - Number(ms);
  if (diff < 0)        return "in the future";
  if (diff < 60_000)   return "just now";
  if (diff < 3600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86400_000) return `${Math.round(diff / 3600_000)}h ago`;
  return `${Math.round(diff / 86400_000)}d ago`;
}
