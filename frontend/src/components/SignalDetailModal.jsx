import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client.js";
import clsx from "clsx";

/**
 * Three-stage flow:
 *   1. "details"  — supporting wallets + signal context (D1)
 *   2. "preview"  — estimated price, depth, slippage (D2)
 *   3. "status"   — real-time order status after submission
 */
export default function SignalDetailModal({ signal, onClose }) {
  const open = !!signal;
  const [stage, setStage] = useState("details");
  const [size, setSize] = useState("");
  const [result, setResult] = useState(null);
  const qc = useQueryClient();

  const context = useQuery({
    queryKey: ["signal-context", signal?.conditionId, signal?.direction],
    queryFn: () => api.getSignalContext(signal.conditionId, signal.direction),
    enabled: open && stage === "details",
  });

  const preview = useQuery({
    queryKey: ["signal-preview", signal?.conditionId, signal?.direction, size],
    queryFn: () => api.previewTrade(signal.conditionId, signal.direction, size),
    enabled: open && stage === "preview",
  });

  const execute = useMutation({
    mutationFn: () => api.manualTrade(signal.conditionId, signal.direction, size || undefined),
    onSuccess: (data) => {
      setResult(data);
      setStage("status");
      qc.invalidateQueries({ queryKey: ["trades"] });
    },
    onError: (err) => {
      setResult({ status: "ERROR", error: err.message });
      setStage("status");
    },
  });

  useEffect(() => {
    if (!open) {
      setStage("details");
      setSize("");
      setResult(null);
    }
  }, [open]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    if (open) document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm animate-fade-in"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg mx-4 rounded-lg border border-surface-700 bg-surface-800 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between border-b border-surface-700 px-5 py-4">
          <div className="min-w-0 flex-1">
            <p className="font-display text-sm uppercase tracking-wider text-surface-400">
              {stage === "details" ? "Signal Details" : stage === "preview" ? "Trade Preview" : "Order Status"}
            </p>
            <p className="mt-1 truncate text-sm font-medium text-surface-100">{signal.title}</p>
            <div className="mt-1 flex items-center gap-2">
              <span className={clsx(
                "badge",
                signal.direction === "YES" ? "bg-success/15 text-success" : "bg-danger/15 text-danger"
              )}>
                {signal.direction}
              </span>
              <span className="text-2xs text-surface-500">
                strength {signal.strength} · {signal.walletCount} wallets
              </span>
            </div>
          </div>
          <button
            onClick={onClose}
            className="shrink-0 text-surface-500 hover:text-surface-200 transition-colors text-xl leading-none"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-4 min-h-[280px] max-h-[60vh] overflow-y-auto">
          {stage === "details" && <DetailsStage context={context.data} loading={context.isLoading} error={context.error} />}
          {stage === "preview" && <PreviewStage preview={preview.data} loading={preview.isLoading} size={size} onSizeChange={setSize} />}
          {stage === "status" && <StatusStage result={result} loading={execute.isPending} />}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-3 border-t border-surface-700 px-5 py-3">
          <button
            onClick={onClose}
            className="rounded-md border border-surface-700 px-3 py-1.5 text-xs text-surface-300 hover:bg-surface-700 transition-colors"
          >
            {stage === "status" ? "Close" : "Cancel"}
          </button>
          {stage === "details" && (
            <button
              onClick={() => setStage("preview")}
              className="rounded-md bg-primary/15 border border-primary/30 px-3 py-1.5 text-xs font-semibold text-primary hover:bg-primary/25 transition-colors"
            >
              Preview Trade →
            </button>
          )}
          {stage === "preview" && (
            <div className="flex items-center gap-2">
              <button
                onClick={() => setStage("details")}
                className="text-xs text-surface-500 hover:text-surface-200"
              >
                ← Back
              </button>
              <button
                disabled={execute.isPending || (preview.data && !preview.data.ok)}
                onClick={() => execute.mutate()}
                className="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-surface-900 hover:bg-primary/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {execute.isPending ? "Submitting…" : "Confirm Trade"}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function DetailsStage({ context, loading, error }) {
  if (loading) return <p className="text-sm text-surface-500">Loading supporting wallets…</p>;
  if (error) return <p className="text-sm text-danger">{error.message}</p>;
  if (!context) return null;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-2 text-center">
        <MiniStat label="Supporting" value={context.supporting.length} />
        <MiniStat label="Opposing" value={context.opposingCount} />
        <MiniStat label="Strength" value={context.strength} />
      </div>

      <div>
        <p className="text-2xs uppercase tracking-wider text-surface-500 mb-2">Supporting ELITE Wallets</p>
        <div className="space-y-1.5">
          {context.supporting.map(w => (
            <div key={w.addr} className="flex items-center justify-between rounded border border-surface-700 bg-surface-900/50 px-2.5 py-1.5">
              <div className="min-w-0 flex-1">
                <p className="text-xs font-mono text-surface-200">{w.addr.slice(0, 8)}…{w.addr.slice(-4)}</p>
                <p className="text-2xs text-surface-500 mt-0.5">
                  score {w.score} · WR {w.winRate != null ? `${w.winRate}%` : "—"} · PnL ${w.totalPnL ?? "—"}
                </p>
              </div>
              <div className="shrink-0 text-right">
                <p className="text-xs tabular-nums text-surface-200">${(w.posValue || 0).toFixed(0)}</p>
                <p className="text-2xs text-surface-500">@ {w.avgPrice != null ? w.avgPrice.toFixed(3) : "—"}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function PreviewStage({ preview, loading, size, onSizeChange }) {
  return (
    <div className="space-y-4">
      <div>
        <label className="text-2xs uppercase tracking-wider text-surface-500">Position Size (USDC)</label>
        <input
          type="number"
          value={size}
          onChange={(e) => onSizeChange(e.target.value)}
          placeholder="Default from config"
          className="mt-1 w-full rounded-md border border-surface-700 bg-surface-900 px-3 py-2 text-sm text-surface-100 focus:outline-none focus:border-primary"
        />
      </div>

      {loading && <p className="text-sm text-surface-500">Estimating…</p>}

      {preview && !loading && (
        <>
          <div className="grid grid-cols-2 gap-2">
            <PreviewField label="Mid Price" value={preview.midPrice != null ? preview.midPrice.toFixed(3) : "—"} />
            <PreviewField label="Limit Price" value={preview.limitPrice != null ? preview.limitPrice.toFixed(3) : "—"} />
            <PreviewField label="Size" value={`$${preview.sizeUsdc}`} />
            <PreviewField label="Slippage" value={`${preview.slippagePct}%`} />
            <PreviewField
              label="Depth Available"
              value={preview.availableDepth != null ? `$${preview.availableDepth.toFixed(0)}` : "—"}
              valueClass={preview.availableDepth != null && preview.availableDepth < preview.sizeUsdc ? "text-danger" : "text-surface-100"}
            />
            <PreviewField label="Mode" value={preview.simulationMode ? "SIMULATION" : "LIVE"} valueClass={preview.simulationMode ? "text-amber-400" : "text-success"} />
          </div>

          {!preview.ok && (
            <div className="rounded-md bg-danger/10 border border-danger/30 px-3 py-2">
              <p className="text-2xs font-semibold text-danger uppercase tracking-wider">Preflight Blocked</p>
              <p className="text-xs text-danger/90 mt-0.5">{preview.reason}</p>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function StatusStage({ result, loading }) {
  if (loading) return <p className="text-sm text-surface-500">Submitting order…</p>;
  if (!result) return null;

  const ok = result.status === "FILLED" || result.status === "PARTIAL" || result.status === "SIMULATED";

  return (
    <div className="space-y-3">
      <div className={clsx(
        "rounded-md border px-3 py-2",
        ok ? "bg-success/10 border-success/30" : "bg-danger/10 border-danger/30"
      )}>
        <p className={clsx("text-2xs font-semibold uppercase tracking-wider", ok ? "text-success" : "text-danger")}>
          {result.status}
        </p>
        {result.error && <p className="text-xs text-danger/90 mt-0.5">{result.error}</p>}
      </div>

      <div className="grid grid-cols-2 gap-2">
        <PreviewField label="Order ID" value={result.orderId ? `${result.orderId.slice(0, 10)}…` : "—"} />
        <PreviewField label="Filled" value={result.filledSize != null ? `${result.filledSize}` : "—"} />
        <PreviewField label="Fill Price" value={result.filledPrice != null ? result.filledPrice.toFixed(3) : "—"} />
        <PreviewField label="Limit" value={result.limitPrice != null ? result.limitPrice.toFixed(3) : "—"} />
      </div>
    </div>
  );
}

function MiniStat({ label, value }) {
  return (
    <div className="rounded border border-surface-700 bg-surface-900/50 py-2">
      <p className="text-2xs uppercase tracking-wider text-surface-500">{label}</p>
      <p className="text-lg font-display text-surface-100 mt-0.5">{value}</p>
    </div>
  );
}

function PreviewField({ label, value, valueClass = "text-surface-100" }) {
  return (
    <div className="rounded border border-surface-700 bg-surface-900/50 px-2.5 py-1.5">
      <p className="text-2xs uppercase tracking-wider text-surface-500">{label}</p>
      <p className={clsx("text-sm tabular-nums mt-0.5", valueClass)}>{value}</p>
    </div>
  );
}
