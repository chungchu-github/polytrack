import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../api/client.js";
import ScoreRing from "../components/ScoreRing.jsx";
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

  const addMutation = useMutation({
    mutationFn: (addr) => api.addWallet(addr),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["wallets"] });
      setNewAddr("");
    },
  });

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
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-14 animate-pulse rounded-md bg-surface-800" />
          ))}
        </div>
      ) : sorted.length === 0 ? (
        <p className="text-sm text-surface-500">No wallets found.</p>
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
                </tr>
              ))}
            </tbody>
          </table>
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
