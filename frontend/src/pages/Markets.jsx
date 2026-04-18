import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client.js";
import clsx from "clsx";

export default function Markets() {
  const { data: markets = [], isLoading } = useQuery({
    queryKey: ["markets"],
    queryFn: api.getMarkets,
    refetchInterval: 30_000,
  });
  const { data: signals = [] } = useQuery({
    queryKey: ["signals"],
    queryFn: api.getSignals,
    refetchInterval: 15_000,
  });

  const signalMap = new Map();
  for (const s of signals) {
    const key = s.conditionId;
    if (!signalMap.has(key)) signalMap.set(key, []);
    signalMap.get(key).push(s);
  }

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex items-center justify-between">
        <h1 className="font-display text-xl font-bold tracking-wider text-surface-50">
          Markets
        </h1>
        <span className="text-sm text-surface-400">{markets.length} active</span>
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-24 animate-pulse rounded-lg bg-surface-800" />
          ))}
        </div>
      ) : markets.length === 0 ? (
        <p className="text-sm text-surface-500">No markets loaded. Trigger a scan first.</p>
      ) : (
        <div className="space-y-3">
          {markets.map(event => (
            <div key={event.id} className="card">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <h3 className="text-sm font-semibold text-surface-100 leading-snug">
                    {event.title}
                  </h3>
                  {event.volume && (
                    <span className="text-2xs text-surface-500 mt-0.5 block">
                      Vol: ${Number(event.volume).toLocaleString()}
                    </span>
                  )}
                </div>
              </div>

              {/* Sub-markets */}
              {(event.markets || []).length > 0 && (
                <div className="mt-3 space-y-2">
                  {event.markets.map(m => {
                    const prices = parsePrices(m.outcomePrices);
                    const mSignals = signalMap.get(m.conditionId) || [];

                    return (
                      <div
                        key={m.id}
                        className="flex items-center gap-3 rounded-md border border-surface-700/50 bg-surface-900/40 px-3 py-2"
                      >
                        {/* Question */}
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-xs text-surface-300">
                            {m.question || m.conditionId?.slice(0, 20)}
                          </p>
                        </div>

                        {/* Signal indicator */}
                        {mSignals.length > 0 && (
                          <div className="flex gap-1">
                            {mSignals.map((s, i) => (
                              <span
                                key={i}
                                className={clsx(
                                  "badge animate-pulse-glow",
                                  s.direction === "YES" ? "bg-success/15 text-success" : "bg-danger/15 text-danger"
                                )}
                                title={`${s.walletCount} wallets, strength ${s.strength}`}
                              >
                                {s.direction} · {s.strength}
                              </span>
                            ))}
                          </div>
                        )}

                        {/* Price bars */}
                        <div className="flex items-center gap-2 shrink-0">
                          <PriceBar label="Yes" value={prices.yes} color="text-success" />
                          <PriceBar label="No" value={prices.no} color="text-danger" />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function PriceBar({ label, value, color }) {
  const pct = Math.round(value * 100);
  return (
    <div className="flex items-center gap-1.5 w-20">
      <span className={clsx("text-2xs font-medium w-6", color)}>{label}</span>
      <div className="flex-1 h-1.5 rounded-full bg-surface-700 overflow-hidden">
        <div
          className={clsx(
            "h-full rounded-full",
            value > 0.5 ? "bg-success" : "bg-danger"
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-2xs tabular-nums text-surface-400 w-8 text-right">{pct}¢</span>
    </div>
  );
}

function parsePrices(outcomePrices) {
  if (!outcomePrices) return { yes: 0.5, no: 0.5 };
  try {
    const arr = typeof outcomePrices === "string" ? JSON.parse(outcomePrices) : outcomePrices;
    return { yes: Number(arr[0]) || 0.5, no: Number(arr[1]) || 0.5 };
  } catch {
    return { yes: 0.5, no: 0.5 };
  }
}
