import { useMemo } from "react";
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine,
} from "recharts";

export default function PnLChart({ trades = [], height = 240 }) {
  const data = useMemo(() => {
    if (!trades.length) return [];

    const sorted = [...trades]
      .filter(t => t.proxyWalletAddress || t.conditionId)
      .sort((a, b) => {
        const ta = new Date(a.timestamp || a.createdAt || 0).getTime();
        const tb = new Date(b.timestamp || b.createdAt || 0).getTime();
        return ta - tb;
      });

    let cumPnL = 0;
    return sorted.map((t, i) => {
      const pnl = Number(t.pnl || t.realizedPnl || 0);
      cumPnL += pnl;
      const ts = new Date(t.timestamp || t.createdAt || 0);
      return {
        index: i,
        date: ts.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
        pnl: Math.round(cumPnL * 100) / 100,
      };
    });
  }, [trades]);

  if (data.length < 2) {
    return (
      <div className="flex items-center justify-center text-sm text-surface-500" style={{ height }}>
        Not enough trade data for chart.
      </div>
    );
  }

  const minPnL = Math.min(...data.map(d => d.pnl));
  const maxPnL = Math.max(...data.map(d => d.pnl));
  const hasNeg = minPnL < 0;

  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <defs>
          <linearGradient id="pnlGradientPos" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#10B981" stopOpacity={0.3} />
            <stop offset="100%" stopColor="#10B981" stopOpacity={0} />
          </linearGradient>
          <linearGradient id="pnlGradientNeg" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#EF4444" stopOpacity={0} />
            <stop offset="100%" stopColor="#EF4444" stopOpacity={0.3} />
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
          width={52}
          domain={[hasNeg ? "dataMin" : 0, "dataMax"]}
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
          formatter={(value) => [`$${value.toFixed(2)}`, "Cumulative PnL"]}
        />
        {hasNeg && (
          <ReferenceLine y={0} stroke="#334155" strokeDasharray="3 3" />
        )}
        <Area
          type="monotone"
          dataKey="pnl"
          stroke={minPnL >= 0 ? "#10B981" : maxPnL <= 0 ? "#EF4444" : "#F59E0B"}
          strokeWidth={2}
          fill={minPnL >= 0 ? "url(#pnlGradientPos)" : "url(#pnlGradientNeg)"}
          dot={false}
          activeDot={{ r: 4, fill: "#F59E0B", stroke: "#0F172A", strokeWidth: 2 }}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
