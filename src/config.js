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
