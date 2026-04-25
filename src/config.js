/**
 * Runtime Configuration
 * ─────────────────────
 * Persists user-adjustable settings (trade size, slippage, risk limits,
 * signal thresholds, webhook URLs) to data/config.json so they survive
 * restarts without requiring an env var change.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = resolve(__dirname, "..", "data", "config.json");

const DEFAULTS = {
  maxTradeUsdc: 100,
  slippagePct: 2,
  minSignalStrength: 0,       // don't filter by default
  maxDailyLossUsdc: 200,
  maxMarketExposureUsdc: 300,
  maxTotalExposureUsdc: 1000,
  marketCooldownMin: 30,
  webhookUrl: "",             // Discord/Slack webhook
  liveTestCapUsdc: 0,         // V3: 0=disabled; >0 caps lifetime auto-trade USDC
  // F2: per-strategy settings. Only `consensus` is enabled by default.
  strategies: {
    consensus: { enabled: true,  maxTradeUsdc: 100, minStrength: 50 },
    momentum:  { enabled: false, maxTradeUsdc: 50,  minStrength: 60, lookbackHours: 4, minPriceMovePct: 8 },
    meanrev:   { enabled: false, maxTradeUsdc: 50,  minStrength: 55, lookbackDays: 7,  zScoreThreshold: 2.0 },
    arbitrage: { enabled: false, maxTradeUsdc: 200, minStrength: 70, minEdgePct: 1.5 },
  },
  // P0 #4 — auto-exit / stop-loss for filled positions.
  // Disabled by default so existing deployments don't surprise-sell anything.
  // maxHoldDays:  0 disables time-based exit (otherwise: exit any FILLED trade older than N days)
  // stopLossPct:  0 disables loss-based exit (otherwise: positive fraction, e.g. 0.30 = exit at -30%)
  exitPolicy: {
    enabled: false,
    maxHoldDays: 14,
    stopLossPct: 0.30,
  },
  // PR B — periodic leaderboard auto-import. Disabled by default; operator
  // opts in via Settings UI. Conservative thresholds so a single run can't
  // flood the watch list with marginal candidates.
  autoImport: {
    enabled:       false,
    intervalHours: 168,             // weekly
    minPnl:        100_000,         // $100k absolute
    minRoi:        0.025,           // 2.5%
    maxAddPerRun:  5,
    windows:       ["alltime", "monthly", "weekly"],
  },
};

const ALLOWED_KEYS = new Set(Object.keys(DEFAULTS));

let cache = null;

export function loadConfig() {
  if (cache) return cache;
  try {
    if (existsSync(CONFIG_PATH)) {
      const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
      cache = { ...DEFAULTS, ...raw };
    } else {
      cache = { ...DEFAULTS };
    }
  } catch {
    cache = { ...DEFAULTS };
  }
  return cache;
}

export function saveConfig(patch) {
  const current = loadConfig();
  const next = { ...current };
  for (const [k, v] of Object.entries(patch || {})) {
    if (!ALLOWED_KEYS.has(k)) continue;
    if (k === "strategies" && v && typeof v === "object") {
      next.strategies = mergeStrategies(current.strategies || DEFAULTS.strategies, v);
      continue;
    }
    if (k === "exitPolicy" && v && typeof v === "object") {
      next.exitPolicy = mergeExitPolicy(current.exitPolicy || DEFAULTS.exitPolicy, v);
      continue;
    }
    if (k === "autoImport" && v && typeof v === "object") {
      next.autoImport = mergeAutoImport(current.autoImport || DEFAULTS.autoImport, v);
      continue;
    }
    if (typeof DEFAULTS[k] === "number") {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) continue;
      next[k] = n;
    } else if (typeof DEFAULTS[k] === "string") {
      next[k] = String(v || "");
    }
  }
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2));
  cache = next;
  return next;
}

function mergeAutoImport(existing, patch) {
  const base = existing || DEFAULTS.autoImport;
  const out = { ...base };
  if (typeof patch.enabled === "boolean") out.enabled = patch.enabled;
  for (const numKey of ["intervalHours", "minPnl", "minRoi", "maxAddPerRun"]) {
    if (Number.isFinite(Number(patch[numKey])) && Number(patch[numKey]) >= 0) {
      out[numKey] = Number(patch[numKey]);
    }
  }
  if (Array.isArray(patch.windows)) {
    const allowed = new Set(["alltime", "monthly", "weekly", "daily"]);
    out.windows = patch.windows
      .map(w => String(w))
      .filter(w => allowed.has(w));
    if (out.windows.length === 0) out.windows = base.windows;
  }
  return out;
}

function mergeExitPolicy(existing, patch) {
  const base = existing || DEFAULTS.exitPolicy;
  const out = { ...base };
  if (typeof patch.enabled === "boolean") out.enabled = patch.enabled;
  if (Number.isFinite(Number(patch.maxHoldDays)) && Number(patch.maxHoldDays) >= 0) {
    out.maxHoldDays = Number(patch.maxHoldDays);
  }
  if (Number.isFinite(Number(patch.stopLossPct)) && Number(patch.stopLossPct) >= 0 && Number(patch.stopLossPct) <= 1) {
    out.stopLossPct = Number(patch.stopLossPct);
  }
  return out;
}

function mergeStrategies(existing, patch) {
  const out = { ...existing };
  for (const [name, cfg] of Object.entries(patch || {})) {
    if (!cfg || typeof cfg !== "object") continue;
    const base = out[name] || DEFAULTS.strategies[name];
    if (!base) continue;
    const merged = { ...base };
    for (const [k, v] of Object.entries(cfg)) {
      if (typeof base[k] === "boolean") merged[k] = !!v;
      else if (typeof base[k] === "number") {
        const n = Number(v);
        if (Number.isFinite(n) && n >= 0) merged[k] = n;
      }
    }
    out[name] = merged;
  }
  return out;
}
