import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client.js";
import { useSignalNotifications } from "../hooks/useNotifications.js";
import SignalDetailModal from "../components/SignalDetailModal.jsx";
import clsx from "clsx";

const STRAT_COLORS = {
  consensus: "bg-primary/15 text-primary",
  momentum:  "bg-accent/15 text-accent",
  meanrev:   "bg-amber-500/15 text-amber-400",
  arbitrage: "bg-success/15 text-success",
};

export default function Dashboard() {
  const { data: health } = useQuery({ queryKey: ["health"], queryFn: api.getHealth, refetchInterval: 10_000 });
  const { data: wallets = [] } = useQuery({ queryKey: ["wallets"], queryFn: api.getWallets, refetchInterval: 30_000 });
  const { data: signals = [] } = useQuery({ queryKey: ["signals"], queryFn: api.getSignals, refetchInterval: 60_000 });
  const { data: trades = [] } = useQuery({ queryKey: ["trades"], queryFn: api.getTrades, refetchInterval: 60_000 });

  // Browser notifications for new signals
  useSignalNotifications(signals);

  const [tradeTarget, setTradeTarget] = useState(null);

  const eliteCount = wallets.filter(w => w.tier === "ELITE").length;
  const proCount = wallets.filter(w => w.tier === "PRO").length;
  const newSignals = signals.filter(s => s.status === "NEW" || s.status === "CONFIRMED");
  const recentTrades = trades.slice(0, 5);

  return (
    <div className="space-y-6 animate-fade-in">
      <h1 className="font-display text-xl font-bold tracking-wider text-surface-50">
        Dashboard
      </h1>

      {/* Stats Grid */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Tracked Wallets" value={wallets.length} accent="text-surface-50" />
        <StatCard label="Elite Wallets" value={eliteCount} accent="text-primary" />
        <StatCard label="Active Signals" value={newSignals.length} accent="text-accent" />
        <StatCard
          label="Trades Executed"
          value={trades.length}
          accent="text-success"
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Active Signals */}
        <div className="card">
          <h2 className="card-header">Active Signals</h2>
          {newSignals.length === 0 ? (
            <p className="text-sm text-surface-500">No active signals detected.</p>
          ) : (
            <div className="space-y-2">
              {newSignals.slice(0, 6).map((sig, i) => (
                <div
                  key={`${sig.conditionId}-${sig.direction}-${i}`}
                  className="flex items-center justify-between rounded-md border border-surface-700 bg-surface-900/50 px-3 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-surface-200">
                      {sig.title}
                    </p>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className={clsx(
                        "badge",
                        sig.direction === "YES" ? "bg-success/15 text-success" : "bg-danger/15 text-danger"
                      )}>
                        {sig.direction}
                      </span>
                      <span className={clsx(
                        "badge",
                        STRAT_COLORS[sig.strategy] || "bg-surface-700 text-surface-300"
                      )}>
                        {sig.strategy || "consensus"}
                      </span>
                      <span className="text-2xs text-surface-500">
                        {sig.walletCount} wallets · strength {sig.strength}
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0 ml-2">
                    <StrengthBar value={sig.strength} />
                    <button
                      onClick={() => setTradeTarget(sig)}
                      className="rounded px-2 py-1 text-2xs font-semibold text-primary bg-primary/10 hover:bg-primary/20 transition-colors"
                      title="Execute trade"
                    >
                      Trade
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Recent Trades */}
        <div className="card">
          <h2 className="card-header">Recent Trades</h2>
          {recentTrades.length === 0 ? (
            <p className="text-sm text-surface-500">No trades executed yet.</p>
          ) : (
            <div className="space-y-2">
              {recentTrades.map((trade, i) => (
                <div
                  key={`${trade.conditionId}-${i}`}
                  className="flex items-center justify-between rounded-md border border-surface-700 bg-surface-900/50 px-3 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-surface-200">
                      {trade.title || trade.conditionId?.slice(0, 16)}
                    </p>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className={clsx(
                        "badge",
                        trade.direction === "YES" ? "bg-success/15 text-success" : "bg-danger/15 text-danger"
                      )}>
                        {trade.direction}
                      </span>
                      <span className="text-2xs text-surface-500">
                        ${trade.size} · {trade.status}
                      </span>
                    </div>
                  </div>
                  <StatusDot status={trade.status} />
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* V1 Gate: 30-day Data Accumulation */}
      <V1ProgressCard dc={health?.dataCapture} />

      {/* System Info */}
      <div className="card">
        <h2 className="card-header">System</h2>
        <div className="grid grid-cols-2 gap-3 text-sm lg:grid-cols-4">
          <MiniStat label="Uptime" value={health ? formatUptime(health.uptime) : "—"} />
          <MiniStat label="Memory" value={health ? `${health.memoryMB} MB` : "—"} />
          <MiniStat label="Last Scan" value={health?.lastScan ? new Date(health.lastScan).toLocaleTimeString() : "Never"} />
          <MiniStat label="Auto-Copy" value={health?.autoEnabled ? "ON" : "OFF"} valueClass={health?.autoEnabled ? "text-success" : "text-surface-500"} />
        </div>
      </div>

      <SignalDetailModal signal={tradeTarget} onClose={() => setTradeTarget(null)} />
    </div>
  );
}

function StatCard({ label, value, accent }) {
  return (
    <div className="card flex flex-col">
      <span className="stat-label">{label}</span>
      <span className={clsx("stat-value mt-1", accent)}>{value}</span>
    </div>
  );
}

function MiniStat({ label, value, valueClass = "text-surface-200" }) {
  return (
    <div>
      <span className="text-2xs uppercase tracking-wider text-surface-500">{label}</span>
      <p className={clsx("text-sm font-medium tabular-nums", valueClass)}>{value}</p>
    </div>
  );
}

function StrengthBar({ value }) {
  return (
    <div className="ml-3 flex items-center gap-2">
      <div className="h-1.5 w-16 rounded-full bg-surface-700 overflow-hidden">
        <div
          className={clsx(
            "h-full rounded-full transition-all",
            value >= 70 ? "bg-primary" : value >= 40 ? "bg-accent" : "bg-surface-500"
          )}
          style={{ width: `${Math.min(value, 100)}%` }}
        />
      </div>
      <span className="text-2xs tabular-nums text-surface-400 w-6 text-right">{value}</span>
    </div>
  );
}

function V1ProgressCard({ dc }) {
  if (!dc || dc.error) {
    return (
      <div className="card">
        <h2 className="card-header">V1 Gate — 30-day data accumulation</h2>
        <p className="text-sm text-surface-500">
          {dc?.error ? `Error: ${dc.error}` : "No data capture stats yet."}
        </p>
      </div>
    );
  }
  const pct = dc.v1ReadyPct ?? 0;
  const days = dc.daysCovered ?? 0;
  const target = dc.v1TargetDays ?? 30;
  const mkt = dc.marketSnapshots || {};
  const pos = dc.positionHistory || {};
  const totalCaptures = Number(mkt.total || 0);
  const lastCapture = mkt.newest ? new Date(mkt.newest) : null;
  const lastCaptureMins = lastCapture ? Math.round((Date.now() - lastCapture.getTime()) / 60000) : null;
  const isStalled = dc.healthy === false && totalCaptures > 0; // had data, now silent
  const isCleared = pct >= 100;

  return (
    <div className="card">
      {isCleared && (
        <div className="mb-3 rounded-md border border-success/40 bg-success/10 px-3 py-2">
          <p className="text-xs font-semibold text-success flex items-center gap-2">
            <span>🎯</span>
            <span>V1 gate cleared — ready to run V2 edge validation.</span>
            <a href="/backtest" className="ml-auto text-success underline underline-offset-2 hover:no-underline">
              Open Backtest →
            </a>
          </p>
        </div>
      )}
      {isStalled && (
        <div className="mb-3 rounded-md border border-danger/40 bg-danger/10 px-3 py-2">
          <p className="text-xs font-semibold text-danger">
            ⚠ No capture in the last 2 hours. Check <code>state.lastCaptureResult</code> and
            that <code>runScan</code> is still firing; hit Settings → "Scan Now" to recover.
          </p>
        </div>
      )}
      <div className="flex items-center justify-between mb-2">
        <h2 className="card-header !mb-0">V1 Gate — 30-day data accumulation</h2>
        <span className={clsx(
          "badge",
          totalCaptures === 0 ? "bg-surface-700 text-surface-400" :
          dc.healthy          ? "bg-success/15 text-success"     :
                                "bg-danger/15 text-danger"
        )}>
          {totalCaptures === 0 ? "never ran" : dc.healthy ? "capturing" : "stalled"}
        </span>
      </div>
      <div className="flex items-baseline gap-2 mb-2">
        <span className="text-3xl font-display text-primary tabular-nums">{days}</span>
        <span className="text-sm text-surface-500">/ {target} days</span>
        <span className="ml-auto text-xs text-surface-400 tabular-nums">{pct}%</span>
      </div>
      <div className="h-2 rounded-full bg-surface-700 overflow-hidden mb-3">
        <div
          className={clsx(
            "h-full transition-all",
            pct >= 100 ? "bg-success" : pct >= 50 ? "bg-primary" : "bg-accent"
          )}
          style={{ width: `${Math.min(pct, 100)}%` }}
        />
      </div>
      <div className="grid grid-cols-2 gap-3 text-sm lg:grid-cols-4">
        <MiniStat label="Market snapshots" value={totalCaptures.toLocaleString()} />
        <MiniStat label="Unique markets"   value={(mkt.uniqueMarkets ?? 0).toLocaleString()} />
        <MiniStat label="Last 24h"         value={(mkt.last24h ?? 0).toLocaleString()} />
        <MiniStat
          label="Position rows"
          value={(pos.total ?? 0).toLocaleString()}
          valueClass={pos.last24h > 0 ? "text-surface-200" : "text-surface-500"}
        />
      </div>
      <p className="text-2xs text-surface-600 mt-2 tabular-nums">
        Last capture: {lastCaptureMins == null
          ? "never"
          : lastCaptureMins < 60
            ? `${lastCaptureMins}m ago`
            : `${Math.round(lastCaptureMins / 60)}h ago`}
        {dc.lastCaptureResult && (
          <span className="ml-2 text-surface-600">
            · {dc.lastCaptureResult.inserted}✓ / {dc.lastCaptureResult.failed}✗ last run
          </span>
        )}
      </p>
    </div>
  );
}

function StatusDot({ status }) {
  const color = status === "FILLED" ? "bg-success" : status === "ERROR" ? "bg-danger" : "bg-primary";
  return <span className={clsx("h-2 w-2 rounded-full shrink-0", color)} title={status} />;
}

function formatUptime(seconds) {
  if (!seconds) return "—";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
