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
  // Hard-block by market title substring (case-insensitive). Applied in
  // server.js right after detectAll so blocked titles never reach dryRun
  // recording or live execution. Use for topics the operator can't / won't
  // touch (e.g. specific elections, jurisdictionally restricted markets).
  blockedTitleKeywords: [],
  // V3: 0=disabled; >0 caps lifetime auto-trade USDC AND bypasses V1 Gate.
  // Set >0 only when ready to send real CLOB orders. Smoke-test attempt
  // 2026-05-10 paused after discovering the funder is an EIP-1167 Magic-link
  // proxy but Polymarket V2 CLOB requires ERC-1967 deposit wallets. Resume
  // after deploying a real deposit wallet and migrating pUSD into it.
  liveTestCapUsdc: 0,
  // F2: per-strategy settings. Only `consensus` is enabled by default.
  strategies: {
    consensus: { enabled: true,  maxTradeUsdc: 100, minStrength: 50 },
    momentum:  { enabled: false, maxTradeUsdc: 50,  minStrength: 60, lookbackHours: 4, minPriceMovePct: 8 },
    meanrev:   { enabled: false, maxTradeUsdc: 50,  minStrength: 55, lookbackDays: 7,  zScoreThreshold: 2.0 },
    arbitrage: { enabled: false, maxTradeUsdc: 200, minStrength: 70, minEdgePct: 1.5 },
    // antidegen (2026-05-07) — fade韭菜 strategy. dryRun=true locks first-week
    // observation: signals fire and persist to dry_run_signals but auto-copy
    // is skipped at the executeCopyTrade gate in server.js.
    antidegen: {
      enabled: true,
      // Default to true — antidegen stays in observation mode until the
      // deposit wallet flow is set up (see liveTestCapUsdc note above).
      // Flip to false in data/config.json (not here) when ready to trade.
      dryRun: true,
      maxTradeUsdc: 5,         // 1/4 of consensus, even after dryRun is lifted
      minStrength: 60,
      marketCooldownMin: 60,   // tighter than consensus (30)
      // 2026-05-12 sample-quality patch — see src/strategies/antidegen.js
      // DEFAULTS for the rationale. Keys must exist here too for
      // mergeStrategies() to preserve operator overrides from data/config.json.
      minWallets: 2,
      maxSignalsPerResolveDay: 1,
    },
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
  // Snapshot retention windows. Defaults sized for a 23G VPS where the
  // working DB hits 6.9G at steady state — VACUUM needs ~2x DB size of free
  // disk, so we keep both tables tight enough that the file doesn't grow
  // past what the host can comfortably hold + back up. Production crash
  // 2026-05-02: 30d markets / 7d positions accumulated 6.9G DB, then 30d
  // backups (8.5G) ran disk to 100%, `database or disk is full` everywhere.
  // Tightened defaults below are derived from that recovery.
  retention: {
    positionDays:    1,    // was 7d; positions_history grows ~2.4M rows/day
                           // at this scan cadence — 1d keeps DB ≈ 2-3G
    marketDays:      7,    // was 30d; market_snapshots ~1.4M rows/day
    // Auto-aggressive trip: when disk usage exceeds this fraction, the
    // 6h prune cron switches to emergency-mode retention (positionsHrs h,
    // marketsHrs h) instead of the configured days. Belt-and-suspenders
    // so an unexpected growth burst can't OOM-kill the whole host again.
    emergencyDiskUsedFrac: 0.85,
    emergencyPositionHours: 6,
    emergencyMarketHours:   24,
  },

  // killSwitch — autonomous auto-trade circuit breaker. Trips when any of
  // three conditions hits the configured threshold. Default thresholds are
  // set for the V1 small-amount validation budget ($50-100). Adjust upward
  // for larger live deployments after the strategy proves out.
  killSwitch: {
    enabled:               true,
    maxLifetimeLossUsdc:   30,
    maxDrawdownPct:        0.25,
    minRollingSharpe:     -0.5,
    rollingWindowDays:     28,
  },
  // PR B — periodic leaderboard auto-import. Disabled by default; operator
  // opts in via Settings UI. Conservative thresholds so a single run can't
  // flood the watch list with marginal candidates.
  autoImport: {
    enabled:          false,
    intervalHours:    168,             // weekly
    minPnl:           100_000,         // $100k absolute
    minRoi:           0.025,           // 2.5%
    maxAddPerRun:     5,
    rejectedTtlHours: 168,             // skip re-eval of rejected addrs for 7d
    windows:          ["alltime", "monthly", "weekly"],
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
      // Deep-seed nested object blocks so an older config.json (written
      // before a new strategy / policy field existed) doesn't drop the
      // newly-added DEFAULTS. Without this, e.g. adding `antidegen` to
      // DEFAULTS.strategies has no effect on existing deployments because
      // the shallow spread above replaces the entire `strategies` object.
      // Reuses the same merge helpers as saveConfig() so behaviour is
      // identical between load and save paths.
      if (raw.strategies && typeof raw.strategies === "object") {
        cache.strategies = mergeStrategies(DEFAULTS.strategies, raw.strategies);
      }
      if (raw.exitPolicy && typeof raw.exitPolicy === "object") {
        cache.exitPolicy = mergeExitPolicy(DEFAULTS.exitPolicy, raw.exitPolicy);
      }
      if (raw.killSwitch && typeof raw.killSwitch === "object") {
        cache.killSwitch = mergeKillSwitch(DEFAULTS.killSwitch, raw.killSwitch);
      }
      if (raw.retention && typeof raw.retention === "object") {
        cache.retention = mergeRetention(DEFAULTS.retention, raw.retention);
      }
      if (raw.autoImport && typeof raw.autoImport === "object") {
        cache.autoImport = mergeAutoImport(DEFAULTS.autoImport, raw.autoImport);
      }
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
    if (k === "killSwitch" && v && typeof v === "object") {
      next.killSwitch = mergeKillSwitch(current.killSwitch || DEFAULTS.killSwitch, v);
      continue;
    }
    if (k === "retention" && v && typeof v === "object") {
      next.retention = mergeRetention(current.retention || DEFAULTS.retention, v);
      continue;
    }
    if (typeof DEFAULTS[k] === "number") {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) continue;
      next[k] = n;
    } else if (typeof DEFAULTS[k] === "string") {
      next[k] = String(v || "");
    } else if (Array.isArray(DEFAULTS[k]) && Array.isArray(v)) {
      // Accept string arrays only (blockedTitleKeywords). Drop null/undefined
      // first (String(null) === "null" otherwise), then trim + drop blanks.
      next[k] = v
        .filter(item => item != null)
        .map(item => String(item).trim())
        .filter(Boolean);
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
  for (const numKey of ["intervalHours", "minPnl", "minRoi", "maxAddPerRun", "rejectedTtlHours"]) {
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

function mergeRetention(existing, patch) {
  const base = existing || DEFAULTS.retention;
  const out = { ...base };
  for (const k of [
    "positionDays", "marketDays",
    "emergencyPositionHours", "emergencyMarketHours",
  ]) {
    if (Number.isFinite(Number(patch[k])) && Number(patch[k]) >= 0) {
      out[k] = Number(patch[k]);
    }
  }
  // emergencyDiskUsedFrac must be in (0, 1]
  if (Number.isFinite(Number(patch.emergencyDiskUsedFrac))) {
    const v = Number(patch.emergencyDiskUsedFrac);
    if (v > 0 && v <= 1) out.emergencyDiskUsedFrac = v;
  }
  return out;
}

function mergeKillSwitch(existing, patch) {
  const base = existing || DEFAULTS.killSwitch;
  const out = { ...base };
  if (typeof patch.enabled === "boolean") out.enabled = patch.enabled;
  for (const numKey of ["maxLifetimeLossUsdc", "maxDrawdownPct", "rollingWindowDays"]) {
    if (Number.isFinite(Number(patch[numKey])) && Number(patch[numKey]) >= 0) {
      out[numKey] = Number(patch[numKey]);
    }
  }
  // minRollingSharpe is allowed to be negative — typical thresholds are -0.5 etc
  if (Number.isFinite(Number(patch.minRollingSharpe))) {
    out.minRollingSharpe = Number(patch.minRollingSharpe);
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
