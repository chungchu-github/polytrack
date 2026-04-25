import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { api } from "../api/client.js";
import ScoreRing from "../components/ScoreRing.jsx";
import EmptyState from "../components/EmptyState.jsx";
import { ListRowSkeleton } from "../components/LoadingSkeleton.jsx";
import clsx from "clsx";

const SORT_KEYS = [
  { key: "score", label: "Score" },
  { key: "totalPnL", label: "PnL" },
  { key: "winRate", label: "Win Rate" },
  { key: "roi", label: "ROI" },
  { key: "sharpe", label: "Sharpe" },
  { key: "trades", label: "Trades" },
];

export default function Wallets() {
  const queryClient = useQueryClient();
  const { data: wallets = [], isLoading } = useQuery({
    queryKey: ["wallets"],
    queryFn: api.getWallets,
    refetchInterval: 30_000,
  });

  const [sortKey, setSortKey] = useState("score");
  const [sortDir, setSortDir] = useState("desc");
  const [newAddr, setNewAddr] = useState("");
  const [tierFilter, setTierFilter] = useState("ALL");

  const [showTrash, setShowTrash] = useState(false);

  const addMutation = useMutation({
    mutationFn: (addr) => api.addWallet(addr),
    onSuccess: (_data, addr) => {
      queryClient.invalidateQueries({ queryKey: ["wallets"] });
      setNewAddr("");
      toast.success(`Wallet added: ${addr.slice(0, 6)}…${addr.slice(-4)}`);
    },
    onError: (e) => toast.error(e.message || "Failed to add wallet"),
  });

  const deleteMutation = useMutation({
    mutationFn: (addr) => api.deleteWallet(addr),
    onSuccess: (_data, addr) => {
      queryClient.invalidateQueries({ queryKey: ["wallets"] });
      queryClient.invalidateQueries({ queryKey: ["wallets-blacklist"] });
      toast.success(
        `Removed ${addr.slice(0, 6)}…${addr.slice(-4)} — restore from Trash if needed`
      );
    },
    onError: (e) => toast.error(e.message || "Failed to remove wallet"),
  });

  const restoreMutation = useMutation({
    mutationFn: (addr) => api.restoreWallet(addr),
    onSuccess: (_data, addr) => {
      queryClient.invalidateQueries({ queryKey: ["wallets"] });
      queryClient.invalidateQueries({ queryKey: ["wallets-blacklist"] });
      toast.success(`Restored ${addr.slice(0, 6)}…${addr.slice(-4)}`);
    },
    onError: (e) => toast.error(e.message || "Failed to restore wallet"),
  });

  function handleDelete(addr) {
    const short = `${addr.slice(0, 6)}…${addr.slice(-4)}`;
    if (window.confirm(`Stop tracking ${short}?\n\nIts V1 history is preserved and can be restored from Trash.`)) {
      deleteMutation.mutate(addr);
    }
  }

  const sorted = [...wallets]
    .filter(w => tierFilter === "ALL" || w.tier === tierFilter)
    .sort((a, b) => {
      const av = a[sortKey] ?? 0;
      const bv = b[sortKey] ?? 0;
      return sortDir === "desc" ? bv - av : av - bv;
    });

  function handleSort(key) {
    if (sortKey === key) {
      setSortDir(d => (d === "desc" ? "asc" : "desc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  }

  function handleAdd(e) {
    e.preventDefault();
    if (/^0x[0-9a-fA-F]{40}$/.test(newAddr.trim())) {
      addMutation.mutate(newAddr.trim().toLowerCase());
    }
  }

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex items-center justify-between">
        <h1 className="font-display text-xl font-bold tracking-wider text-surface-50">
          Wallets
        </h1>
        <span className="text-sm text-surface-400">{wallets.length} tracked</span>
      </div>

      {/* Add Wallet */}
      <form onSubmit={handleAdd} className="flex gap-2">
        <input
          type="text"
          value={newAddr}
          onChange={(e) => setNewAddr(e.target.value)}
          placeholder="0x... wallet address"
          className="flex-1 rounded-md border border-surface-700 bg-surface-800 px-3 py-2 text-sm text-surface-200 placeholder:text-surface-600 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/30"
          aria-label="Wallet address"
        />
        <button
          type="submit"
          disabled={addMutation.isPending || !/^0x[0-9a-fA-F]{40}$/.test(newAddr.trim())}
          className="btn-primary"
        >
          {addMutation.isPending ? "Adding…" : "Add Wallet"}
        </button>
      </form>
      {addMutation.isError && (
        <p className="text-sm text-danger" role="alert">{addMutation.error.message}</p>
      )}

      {/* Tier Filter */}
      <div className="flex gap-2">
        {["ALL", "ELITE", "PRO", "BASIC"].map(t => (
          <button
            key={t}
            onClick={() => setTierFilter(t)}
            className={clsx(
              "rounded-md px-3 py-1.5 text-2xs font-semibold uppercase tracking-wider transition-colors",
              tierFilter === t
                ? "bg-primary/15 text-primary"
                : "text-surface-400 hover:bg-surface-800 hover:text-surface-300"
            )}
          >
            {t}
          </button>
        ))}
      </div>

      {/* Table */}
      {isLoading ? (
        <ListRowSkeleton rows={5} />
      ) : wallets.length === 0 ? (
        <EmptyState
          icon="✦"
          title="No tracked wallets yet"
          description="Paste a Polymarket wallet address (0x…) above to start tracking. Aim for 20–50 high-quality wallets so consensus signals can fire."
        />
      ) : sorted.length === 0 ? (
        <EmptyState
          icon="◍"
          title={`No wallets match "${tierFilter}"`}
          description="Try a different tier filter, or wait for scoring to upgrade more wallets."
          action={tierFilter !== "ALL"
            ? { label: "Show all tiers", onClick: () => setTierFilter("ALL") }
            : null}
        />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-surface-700">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-surface-700 bg-surface-800/50">
                <th className="px-3 py-2.5 text-left text-2xs font-semibold uppercase tracking-wider text-surface-400">
                  Address
                </th>
                <th className="px-3 py-2.5 text-left text-2xs font-semibold uppercase tracking-wider text-surface-400">
                  Tier
                </th>
                {SORT_KEYS.map(({ key, label }) => (
                  <th
                    key={key}
                    onClick={() => handleSort(key)}
                    className="cursor-pointer select-none px-3 py-2.5 text-right text-2xs font-semibold uppercase tracking-wider text-surface-400 hover:text-surface-200 transition-colors"
                  >
                    {label}
                    {sortKey === key && (
                      <span className="ml-1 text-primary">{sortDir === "desc" ? "↓" : "↑"}</span>
                    )}
                  </th>
                ))}
                <th className="px-3 py-2.5 text-right text-2xs font-semibold uppercase tracking-wider text-surface-400 w-10">
                  {/* actions */}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-surface-700/50">
              {sorted.map(w => (
                <tr key={w.addr} className="hover:bg-surface-800/30 transition-colors">
                  <td className="px-3 py-2.5">
                    <Link to={`/wallets/${w.addr}`} className="font-mono text-xs text-primary hover:underline">
                      {w.addr.slice(0, 6)}…{w.addr.slice(-4)}
                    </Link>
                  </td>
                  <td className="px-3 py-2.5">
                    <TierBadge tier={w.tier} />
                  </td>
                  <td className="px-3 py-2.5 text-right">
                    <ScoreRing score={w.score} tier={w.tier} size={36} className="ml-auto" />
                  </td>
                  <td className={clsx("px-3 py-2.5 text-right tabular-nums font-medium", w.totalPnL >= 0 ? "text-success" : "text-danger")}>
                    ${fmt(w.totalPnL)}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-surface-300">
                    {w.winRate?.toFixed(1)}%
                  </td>
                  <td className={clsx("px-3 py-2.5 text-right tabular-nums", w.roi >= 0 ? "text-success" : "text-danger")}>
                    {w.roi?.toFixed(1)}%
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-surface-300">
                    {w.sharpe?.toFixed(2)}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-surface-300">
                    {w.trades}
                  </td>
                  <td className="px-3 py-2.5 text-right">
                    <button
                      onClick={() => handleDelete(w.addr)}
                      disabled={deleteMutation.isPending}
                      title="Stop tracking (soft delete)"
                      aria-label={`Remove tracking for ${w.addr}`}
                      className="text-surface-600 hover:text-danger transition-colors p-1 rounded disabled:opacity-30"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M3 6h18M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                      </svg>
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Trash drawer — admin can review + restore soft-deleted wallets */}
      <TrashSection
        open={showTrash}
        onToggle={() => setShowTrash(v => !v)}
        onRestore={(addr) => restoreMutation.mutate(addr)}
        restoring={restoreMutation.isPending}
      />
    </div>
  );
}

function TrashSection({ open, onToggle, onRestore, restoring }) {
  const { data: trashed = [], isLoading } = useQuery({
    queryKey: ["wallets-blacklist"],
    queryFn:  api.listBlacklisted,
    enabled:  open,
    refetchInterval: open ? 30_000 : false,
  });

  return (
    <div className="card !py-3">
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between text-2xs uppercase tracking-wider text-surface-500 hover:text-surface-300 transition-colors"
      >
        <span>{open ? "▼" : "▶"} Trash{!open && trashed?.length ? ` (${trashed.length})` : ""}</span>
        <span className="text-2xs text-surface-600">
          Soft-deleted wallets — V1 history retained
        </span>
      </button>
      {open && (
        <div className="mt-3">
          {isLoading ? (
            <p className="text-xs text-surface-500">Loading…</p>
          ) : trashed.length === 0 ? (
            <p className="text-xs text-surface-500">Trash is empty.</p>
          ) : (
            <table className="w-full text-xs">
              <thead>
                <tr className="text-2xs uppercase tracking-wider text-surface-500 text-left">
                  <th className="py-1.5 pr-2 font-normal">Address</th>
                  <th className="py-1.5 pr-2 font-normal">Tier</th>
                  <th className="py-1.5 pr-2 font-normal text-right">Score</th>
                  <th className="py-1.5 pr-2 font-normal text-right">PnL</th>
                  <th className="py-1.5 font-normal text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {trashed.map(w => (
                  <tr key={w.address} className="border-t border-surface-800">
                    <td className="py-1.5 pr-2 font-mono text-surface-300">
                      {w.address.slice(0, 6)}…{w.address.slice(-4)}
                    </td>
                    <td className="py-1.5 pr-2 text-surface-400">{w.tier}</td>
                    <td className="py-1.5 pr-2 tabular-nums text-right text-surface-300">{w.score}</td>
                    <td className={clsx(
                      "py-1.5 pr-2 tabular-nums text-right",
                      (w.total_pnl || 0) >= 0 ? "text-success" : "text-danger"
                    )}>
                      ${fmt(w.total_pnl)}
                    </td>
                    <td className="py-1.5 text-right">
                      <button
                        onClick={() => onRestore(w.address)}
                        disabled={restoring}
                        className="text-2xs text-primary underline underline-offset-2 hover:no-underline disabled:opacity-50"
                      >
                        Restore
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

function TierBadge({ tier }) {
  const cls = tier === "ELITE" ? "badge-elite" : tier === "PRO" ? "badge-pro" : "badge-basic";
  return <span className={cls}>{tier}</span>;
}

function fmt(n) {
  if (n == null) return "—";
  return Math.abs(n) >= 1000
    ? `${(n / 1000).toFixed(1)}k`
    : n.toFixed(0);
}
