import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, signOutAndPromptLogin } from "../api/client.js";
import InviteManager from "../components/InviteManager.jsx";
import clsx from "clsx";

// SessionCard — replaces the old API_TOKEN field. Shows the logged-in user
// and provides a logout button (clears the JWT and reopens LoginModal in
// a clean state). Defined here so Settings.jsx stays self-contained.
function SessionCard() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ["me"], queryFn: api.me });
  const user = data?.user;

  function handleLogout() {
    api.logout();                 // best-effort, server is stateless
    queryClient.removeQueries();  // drop cached user / wallets / etc.
    signOutAndPromptLogin();      // wipes token + opens login modal cleanly
    toast.success("Signed out");
  }

  return (
    <div className="card">
      <h2 className="card-header">Session</h2>
      {isLoading ? (
        <p className="text-sm text-surface-500">Loading…</p>
      ) : user ? (
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm text-surface-200">
              Signed in as <strong className="text-primary">{user.username}</strong>
              <span className="ml-2 text-2xs uppercase tracking-wider text-surface-500">
                {user.role}
              </span>
            </p>
            {user.last_login && (
              <p className="text-2xs text-surface-600 mt-0.5">
                Last login: {new Date(user.last_login).toLocaleString()}
              </p>
            )}
          </div>
          <button
            onClick={handleLogout}
            className="px-3 py-1.5 rounded-md border border-surface-700 text-xs text-surface-300 hover:bg-surface-800 transition-colors"
          >
            Sign out
          </button>
        </div>
      ) : (
        <p className="text-sm text-danger">Not signed in.</p>
      )}
    </div>
  );
}

const CONFIG_FIELDS = [
  { key: "maxTradeUsdc",         label: "Max Trade Size (USDC)",   step: "1",    hint: "Default position size per auto-trade" },
  { key: "slippagePct",          label: "Slippage Tolerance (%)",  step: "0.1",  hint: "Max price drift allowed from mid at limit calc" },
  { key: "minSignalStrength",    label: "Min Signal Strength",     step: "1",    hint: "0 = no filter; auto-copy skips signals below this" },
  { key: "maxDailyLossUsdc",     label: "Max Daily Loss (USDC)",   step: "10",   hint: "Auto-copy halts when today's realized loss ≥ this" },
  { key: "maxMarketExposureUsdc",label: "Max Per-Market Exposure", step: "10",   hint: "Cap on cumulative size in any single market" },
  { key: "maxTotalExposureUsdc", label: "Max Total Exposure",      step: "50",   hint: "Cap on sum of all open position sizes" },
  { key: "marketCooldownMin",    label: "Market Cooldown (min)",   step: "1",    hint: "After a trade, re-entry into same market is blocked for this long" },
  { key: "liveTestCapUsdc",      label: "V3 Live-Test Cap (USDC)", step: "1",    hint: "0 disables; >0 hard-caps cumulative auto-trade USDC — enables V3 small-amount real-money validation" },
];

// F2: per-strategy UI schema. `common` fields appear for every strategy,
// `extra` contains strategy-specific params that align with config.js DEFAULTS.
const STRATEGY_FIELDS = [
  {
    name: "consensus",
    label: "Consensus (ELITE wallet alignment)",
    color: "text-primary",
    extra: [],
  },
  {
    name: "momentum",
    label: "Momentum (price trend)",
    color: "text-accent",
    extra: [
      { key: "lookbackHours",    label: "Lookback (hours)",     step: "1" },
      { key: "minPriceMovePct",  label: "Min Price Move (%)",   step: "0.1" },
    ],
  },
  {
    name: "meanrev",
    label: "Mean Reversion (z-score)",
    color: "text-amber-400",
    extra: [
      { key: "lookbackDays",     label: "Lookback (days)",      step: "1" },
      { key: "zScoreThreshold",  label: "Z-Score Threshold",    step: "0.1" },
    ],
  },
  {
    name: "arbitrage",
    label: "Arbitrage (binary bid-sum edge)",
    color: "text-success",
    extra: [
      { key: "minEdgePct",       label: "Min Edge (%)",         step: "0.1" },
    ],
  },
];
const COMMON_STRAT_FIELDS = [
  { key: "maxTradeUsdc", label: "Max Trade (USDC)", step: "1" },
  { key: "minStrength",  label: "Min Strength",     step: "1" },
];

export default function Settings() {
  const queryClient = useQueryClient();
  const { data: health } = useQuery({ queryKey: ["health"], queryFn: api.getHealth, refetchInterval: 10_000 });
  const { data: config } = useQuery({ queryKey: ["config"], queryFn: api.getConfig });

  const [form, setForm] = useState({});
  const [cfgSaved, setCfgSaved] = useState(false);
  useEffect(() => { if (config) setForm(config); }, [config]);

  const cfgMutation = useMutation({
    mutationFn: (patch) => api.saveConfig(patch),
    onSuccess: (data) => {
      setForm(data);
      setCfgSaved(true);
      setTimeout(() => setCfgSaved(false), 2000);
      queryClient.invalidateQueries({ queryKey: ["config"] });
      toast.success("Config saved");
    },
    onError: (e) => toast.error(e.message || "Failed to save config"),
  });

  const autoMutation = useMutation({
    mutationFn: (enabled) => api.setAuto(enabled),
    onSuccess: (_data, enabled) => {
      queryClient.invalidateQueries({ queryKey: ["health"] });
      toast.success(`Auto-copy ${enabled ? "enabled" : "disabled"}`);
    },
    onError: (e) => toast.error(e.message || "Failed to toggle auto-copy"),
  });

  const scanMutation = useMutation({
    mutationFn: () => api.triggerScan(),
    onSuccess: () => toast.success("Scan triggered"),
    onError:   (e) => toast.error(e.message || "Scan failed"),
  });

  return (
    <div className="space-y-6 animate-fade-in max-w-2xl">
      <h1 className="font-display text-xl font-bold tracking-wider text-surface-50">
        Settings
      </h1>

      {/* CLOB V2 Migration Notice (2026-04-22 cutover) */}
      <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3">
        <p className="text-xs font-semibold text-amber-400 uppercase tracking-wider">
          CLOB V2 Migration — 2026-04-22 11:00 UTC
        </p>
        <p className="text-xs text-amber-400/80 mt-1 leading-relaxed">
          Polymarket is cutting over to CLOB V2 on April 22. Polytrack's signing path
          is already V2-compliant, but the collateral token changes from{" "}
          <strong className="text-amber-300">USDC.e</strong> to{" "}
          <strong className="text-amber-300">pUSD</strong>. Before the cutover, convert
          your proxy wallet balance to pUSD via the Polymarket UI, otherwise orders
          will fail with "insufficient balance" despite USDC.e being present.
          All open orders are wiped at cutover.
        </p>
      </div>

      {/* Session — replaces the old API Token field. JWT-based now. */}
      <SessionCard />

      {/* Invite Manager (admin only) */}
      <InviteManager />


      {/* Auto-Copy */}
      <div className="card">
        <h2 className="card-header">Auto-Copy Trading</h2>
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm text-surface-200">
              Automatically execute trades when strong signals are detected.
            </p>
            <p className="text-xs text-surface-500 mt-0.5">
              Requires private key to be configured on the server.
            </p>
          </div>
          <button
            onClick={() => autoMutation.mutate(!health?.autoEnabled)}
            disabled={autoMutation.isPending}
            className={clsx(
              "relative inline-flex h-7 w-12 shrink-0 cursor-pointer items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-primary/30",
              health?.autoEnabled ? "bg-primary" : "bg-surface-600"
            )}
            role="switch"
            aria-checked={health?.autoEnabled || false}
            aria-label="Toggle auto-copy trading"
          >
            <span
              className={clsx(
                "inline-block h-5 w-5 rounded-full bg-white shadow-sm transition-transform",
                health?.autoEnabled ? "translate-x-6" : "translate-x-1"
              )}
            />
          </button>
        </div>
        {!health?.hasPrivateKey && (
          <p className="mt-2 rounded-md bg-warning/10 px-3 py-2 text-xs text-warning" role="alert">
            No private key configured. Trades will be simulated only.
          </p>
        )}
      </div>

      {/* Runtime Config (Phase D5) */}
      <div className="card">
        <h2 className="card-header">Trading & Risk Configuration</h2>
        <p className="text-xs text-surface-500 mb-3">
          Persisted to server (<code className="text-surface-400">data/config.json</code>). Applied on next scan + manual trade.
        </p>
        <form
          onSubmit={(e) => { e.preventDefault(); cfgMutation.mutate(form); }}
          className="space-y-3"
        >
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {CONFIG_FIELDS.map(f => (
              <div key={f.key}>
                <label htmlFor={`cfg-${f.key}`} className="text-xs text-surface-400 block mb-1">{f.label}</label>
                <input
                  id={`cfg-${f.key}`}
                  type="number"
                  step={f.step}
                  min="0"
                  value={form[f.key] ?? ""}
                  onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
                  className="w-full rounded-md border border-surface-700 bg-surface-800 px-3 py-2 text-sm text-surface-200 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/30"
                />
                <p className="text-2xs text-surface-600 mt-0.5">{f.hint}</p>
              </div>
            ))}
          </div>
          <div>
            <label htmlFor="cfg-webhook" className="text-xs text-surface-400 block mb-1">Alert Webhook URL</label>
            <input
              id="cfg-webhook"
              type="url"
              value={form.webhookUrl ?? ""}
              onChange={(e) => setForm({ ...form, webhookUrl: e.target.value })}
              placeholder="https://discord.com/api/webhooks/... or Slack"
              className="w-full rounded-md border border-surface-700 bg-surface-800 px-3 py-2 text-sm text-surface-200 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/30"
            />
            <p className="text-2xs text-surface-600 mt-0.5">Discord/Slack compatible. Leave blank to disable.</p>
          </div>
          <div className="flex items-center gap-3 pt-1">
            <button type="submit" disabled={cfgMutation.isPending} className="btn-primary">
              {cfgMutation.isPending ? "Saving…" : cfgSaved ? "Saved ✓" : "Save Config"}
            </button>
            {cfgMutation.isError && (
              <span className="text-xs text-danger">{cfgMutation.error.message}</span>
            )}
          </div>
        </form>
      </div>

      {/* Strategies (F2) — auto-save on toggle / input blur */}
      <div className="card">
        <div className="flex items-center justify-between mb-1">
          <h2 className="card-header !mb-0">Strategies</h2>
          <span className="text-2xs text-surface-500">
            {cfgMutation.isPending ? "Saving…" :
             cfgSaved              ? "Saved ✓"  :
             cfgMutation.isError   ? <span className="text-danger">{cfgMutation.error.message}</span> :
                                     "Changes save automatically"}
          </span>
        </div>
        <p className="text-xs text-surface-500 mb-3">
          Each strategy runs independently. Toggling enabled or editing a parameter
          (on blur) pushes the change to the server — no explicit save needed.
        </p>
        <div className="space-y-4">
          {STRATEGY_FIELDS.map((s) => {
            const current = form.strategies?.[s.name] || {};
            // Updates local form AND kicks off the save mutation with just the
            // changed strategy's slice (mergeStrategies on the server preserves others).
            const updateStratAndSave = (patch) => {
              const next = { ...(current || {}), ...patch };
              setForm((prev) => ({
                ...prev,
                strategies: { ...(prev.strategies || {}), [s.name]: next },
              }));
              cfgMutation.mutate({ strategies: { [s.name]: patch } });
            };
            // Onchange-only-local (for number inputs) — we save on blur to avoid
            // saving on every keystroke while the user is mid-edit.
            const setStratLocal = (patch) => {
              setForm((prev) => ({
                ...prev,
                strategies: {
                  ...(prev.strategies || {}),
                  [s.name]: { ...(prev.strategies?.[s.name] || {}), ...patch },
                },
              }));
            };
            return (
              <div key={s.name} className="rounded-md border border-surface-700 bg-surface-900/40 p-3">
                <div className="flex items-center justify-between mb-3">
                  <div>
                    <div className={clsx("text-sm font-medium", s.color)}>{s.label}</div>
                    <div className="text-2xs text-surface-500">Strategy key: <code>{s.name}</code></div>
                  </div>
                  <button
                    type="button"
                    onClick={() => updateStratAndSave({ enabled: !current.enabled })}
                    className={clsx(
                      "relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-primary/30",
                      current.enabled ? "bg-primary" : "bg-surface-600"
                    )}
                    role="switch"
                    aria-checked={!!current.enabled}
                    aria-label={`Toggle ${s.name} strategy`}
                  >
                    <span
                      className={clsx(
                        "inline-block h-4 w-4 rounded-full bg-white shadow-sm transition-transform",
                        current.enabled ? "translate-x-6" : "translate-x-1"
                      )}
                    />
                  </button>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  {[...COMMON_STRAT_FIELDS, ...s.extra].map((f) => (
                    <div key={f.key}>
                      <label className="text-2xs text-surface-500 block mb-1">{f.label}</label>
                      <input
                        type="number"
                        step={f.step}
                        min="0"
                        value={current[f.key] ?? ""}
                        onChange={(e) => setStratLocal({ [f.key]: e.target.value })}
                        onBlur={(e) => {
                          // Save only if value differs from last-saved config value.
                          const saved = config?.strategies?.[s.name]?.[f.key];
                          if (String(saved ?? "") !== e.target.value) {
                            updateStratAndSave({ [f.key]: e.target.value });
                          }
                        }}
                        disabled={!current.enabled}
                        className={clsx(
                          "w-full rounded-md border border-surface-700 bg-surface-800 px-2 py-1.5 text-xs text-surface-200 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/30",
                          !current.enabled && "opacity-50"
                        )}
                      />
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Manual Scan */}
      <div className="card">
        <h2 className="card-header">Scan Control</h2>
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm text-surface-200">Trigger a manual wallet scan</p>
            <p className="text-xs text-surface-500 mt-0.5">
              Last scan: {health?.lastScan ? new Date(health.lastScan).toLocaleString() : "Never"}
            </p>
          </div>
          <button
            onClick={() => scanMutation.mutate()}
            disabled={scanMutation.isPending || health?.scanning}
            className="btn-primary"
          >
            {health?.scanning ? "Scanning…" : scanMutation.isPending ? "Starting…" : "Scan Now"}
          </button>
        </div>
        {scanMutation.isError && (
          <p className="mt-2 text-xs text-danger" role="alert">{scanMutation.error.message}</p>
        )}
        {scanMutation.isSuccess && (
          <p className="mt-2 text-xs text-success">Scan started successfully.</p>
        )}
      </div>

      {/* System Info */}
      <div className="card">
        <h2 className="card-header">System Info</h2>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
          <InfoRow label="Version" value={health?.version || "—"} />
          <InfoRow label="Uptime" value={health ? formatUptime(health.uptime) : "—"} />
          <InfoRow label="Memory" value={health ? `${health.memoryMB} MB` : "—"} />
          <InfoRow label="Wallets" value={health?.wallets ?? "—"} />
          <InfoRow label="Signals" value={health?.signals ?? "—"} />
          <InfoRow label="DB Wallets" value={health?.db?.walletCount ?? "—"} />
          <InfoRow label="DB Trades" value={health?.db?.tradeCount ?? "—"} />
          <InfoRow label="DB Scans" value={health?.db?.scanCount ?? "—"} />
        </dl>
      </div>
    </div>
  );
}

function InfoRow({ label, value }) {
  return (
    <>
      <dt className="text-surface-500">{label}</dt>
      <dd className="text-surface-200 tabular-nums text-right">{value}</dd>
    </>
  );
}

function formatUptime(seconds) {
  if (!seconds) return "—";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
