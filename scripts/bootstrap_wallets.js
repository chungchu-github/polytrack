#!/usr/bin/env node
/**
 * bootstrap_wallets.js — Import poly_data historical seeds into Polytrack
 *
 * Reads data/historical_seeds.json (produced by poly_data_etl.py) and POSTs
 * each wallet address to the Polytrack API. Skips wallets already tracked.
 *
 * Usage:
 *   node scripts/bootstrap_wallets.js --token YOUR_JWT
 *   node scripts/bootstrap_wallets.js --username admin --password $PW
 *   node scripts/bootstrap_wallets.js --dry-run          # preview only
 *   node scripts/bootstrap_wallets.js --seeds /path/to/custom_seeds.json
 *   node scripts/bootstrap_wallets.js --min-score 70     # stricter filter
 *
 * Options:
 *   --seeds PATH        Seeds JSON file  [default: data/historical_seeds.json]
 *   --api URL           Polytrack base URL  [default: http://localhost:3001]
 *   --token JWT         Auth token (or set POLYTRACK_JWT env var)
 *   --username          Login username (alternative to --token)
 *   --password          Login password (alternative to --token)
 *   --min-score N       Only import wallets with score >= N  [default: 0]
 *   --top N             Import at most N wallets  [default: all]
 *   --tier TIER         Only import ELITE / PRO  [default: all that pass]
 *   --dry-run           Print what would be imported, don't POST
 *   --delay-ms N        Delay between POSTs in ms  [default: 200]
 */
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT  = resolve(__dirname, "..");

const DEFAULTS = {
  seeds:    resolve(REPO_ROOT, "data", "historical_seeds.json"),
  api:      "http://localhost:3001",
  token:    "",
  minScore: 0,
  top:      Infinity,
  tier:     null,
  dryRun:   false,
  delayMs:  200,
};

function parseArgs(argv) {
  const out = { ...DEFAULTS };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case "--seeds":     out.seeds    = resolve(next()); break;
      case "--api":       out.api      = next();          break;
      case "--token":     out.token    = next();          break;
      case "--username":  out.username = next();          break;
      case "--password":  out.password = next();          break;
      case "--min-score": out.minScore = Number(next());  break;
      case "--top":       out.top      = Number(next());  break;
      case "--tier":      out.tier     = next().toUpperCase(); break;
      case "--delay-ms":  out.delayMs  = Number(next());  break;
      case "--dry-run":   out.dryRun   = true;            break;
      case "--help": case "-h":
        printHelp(); process.exit(0);
      default:
        console.error(`Unknown arg: ${a}`); process.exit(1);
    }
  }
  if (!out.token) out.token = process.env.POLYTRACK_JWT || "";
  return out;
}

function printHelp() {
  console.log(`
bootstrap_wallets — import poly_data historical wallet seeds into Polytrack

  node scripts/bootstrap_wallets.js [options]

Options:
  --seeds PATH        Seeds JSON  [default: data/historical_seeds.json]
  --api URL           Polytrack base URL  [default: http://localhost:3001]
  --token JWT         Auth JWT (or POLYTRACK_JWT env)
  --username/--password  Login instead of passing token
  --min-score N       Only import wallets with score >= N  [default: 0]
  --top N             Import at most N wallets
  --tier ELITE|PRO    Filter by tier
  --delay-ms N        Delay between POSTs  [default: 200]
  --dry-run           Preview only, no API calls
`.trim());
}

async function login(api, username, password) {
  const res = await fetch(`${api}/auth/login`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ username, password }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`Login failed (${res.status}): ${body.error || "unknown"}`);
  }
  const { token } = await res.json();
  return token;
}

async function getTrackedWallets(api, token) {
  const res = await fetch(`${api}/wallets`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`GET /wallets returned ${res.status}`);
  const list = await res.json();
  return new Set((list || []).map(w => (w.addr || w.address || "").toLowerCase()));
}

async function postWallet(api, token, addr) {
  const res = await fetch(`${api}/wallets`, {
    method:  "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body:    JSON.stringify({ addr }),
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function fmtUsd(n) {
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

function printTable(wallets) {
  console.log("\n  #    Score  Tier    WinRate  Sharpe  PnL         Trades  Address");
  console.log("  ─────────────────────────────────────────────────────────────────────────────────");
  for (let i = 0; i < wallets.length; i++) {
    const w = wallets[i];
    console.log(
      `  ${String(i + 1).padStart(3)}  ${String(w.score).padStart(5)}  ${w.tier.padEnd(6)}  ` +
      `${w.winRate.toFixed(1)}%    ${w.sharpe.toFixed(2).padStart(6)}  ` +
      `${fmtUsd(w.totalPnL).padStart(10)}  ${String(w.totalTrades || 0).padStart(6)}  ${w.address}`
    );
  }
  console.log("");
}

async function main() {
  const opts = parseArgs(process.argv);

  // Load seeds
  let seeds;
  try {
    const raw = readFileSync(opts.seeds, "utf8");
    seeds = JSON.parse(raw);
  } catch (e) {
    console.error(`Cannot read seeds file: ${opts.seeds}`);
    console.error(`  ${e.message}`);
    console.error("\nRun poly_data_etl.py first to generate it.");
    process.exit(1);
  }

  console.log(`Seeds file: ${opts.seeds}`);
  console.log(`  Generated: ${seeds.generated_at || "unknown"}`);
  console.log(`  Total wallets in file: ${seeds.wallets?.length ?? 0}`);
  if (seeds.filters) {
    const f = seeds.filters;
    console.log(`  ETL filters: min_score=${f.min_score} min_pnl=${f.min_pnl} min_closed=${f.min_closed}`);
  }

  // Apply local filters
  let candidates = (seeds.wallets || [])
    .filter(w => w.score >= opts.minScore)
    .filter(w => !opts.tier || w.tier === opts.tier);

  if (Number.isFinite(opts.top)) {
    candidates = candidates.slice(0, opts.top);
  }

  console.log(`\nAfter local filters (min-score=${opts.minScore}, tier=${opts.tier || "any"}): ${candidates.length} wallets`);

  if (candidates.length === 0) {
    console.log("Nothing to import.");
    return;
  }

  if (opts.dryRun) {
    printTable(candidates);
    console.log("(--dry-run) No changes made. Drop --dry-run to import.");
    return;
  }

  // Auth
  let token = opts.token;
  if (!token && opts.username && opts.password) {
    token = await login(opts.api, opts.username, opts.password);
    console.log("✓ Logged in.");
  }
  if (!token) {
    console.error("Need --token / POLYTRACK_JWT, or --username + --password.");
    process.exit(1);
  }

  // Check already-tracked
  console.log("\nFetching currently tracked wallets…");
  const existing = await getTrackedWallets(opts.api, token);
  const toAdd = candidates.filter(c => !existing.has(c.address.toLowerCase()));
  const skipped = candidates.length - toAdd.length;

  console.log(`  Already tracked: ${skipped}  |  New to import: ${toAdd.length}`);

  if (toAdd.length === 0) {
    console.log("All candidates already tracked. Nothing to do.");
    return;
  }

  printTable(toAdd);
  console.log(`Importing ${toAdd.length} wallets (${opts.delayMs}ms between each)…\n`);

  let added = 0, failed = 0;
  for (const w of toAdd) {
    const r = await postWallet(opts.api, token, w.address);
    if (r.ok) {
      added++;
      console.log(`  + [${w.tier}] score=${w.score} pnl=${fmtUsd(w.totalPnL)} ${w.address}`);
    } else {
      failed++;
      console.log(`  ✗ ${w.address}  HTTP ${r.status}: ${r.body?.error || "unknown"}`);
    }
    if (opts.delayMs > 0) await sleep(opts.delayMs);
  }

  console.log(`\n── Done ────────────────────────────────────────────`);
  console.log(`  Imported:        ${added}`);
  console.log(`  Failed:          ${failed}`);
  console.log(`  Already tracked: ${skipped}`);
  if (added > 0) {
    console.log(`\nPolytrack will now score these wallets against live Polymarket data.`);
    console.log(`Check /wallets to see their live scores populate over the next scan cycle.`);
  }
}

const invoked = import.meta.url.endsWith(process.argv[1]) ||
                process.argv[1]?.endsWith("bootstrap_wallets.js");
if (invoked) {
  main().catch(e => { console.error("Fatal:", e.message); process.exit(1); });
}
