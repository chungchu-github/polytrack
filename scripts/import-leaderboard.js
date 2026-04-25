#!/usr/bin/env node
/**
 * Import top traders from Polymarket's leaderboard into your watch list.
 *
 *   node scripts/import-leaderboard.js [opts]
 *
 * Pulls multiple leaderboard windows (alltime / monthly / weekly / daily),
 * merges and dedupes by proxyWallet, then filters out
 *   - market makers (low ROI = pnl/volume)
 *   - small fish (low absolute pnl)
 *   - wallets you already track
 *
 * --dry-run prints the candidate table and exits. Default mode POSTs each
 * surviving address to /wallets via the running polytrack API.
 *
 * Auth: pass a JWT via env (POLYTRACK_JWT) or --token. Or use
 *   --username / --password to log in fresh.
 *
 * Examples:
 *
 *   # See who would be added, no DB writes
 *   node scripts/import-leaderboard.js --dry-run
 *
 *   # Stricter filter — only > $100k PnL and ≥3% ROI
 *   node scripts/import-leaderboard.js --min-pnl 100000 --min-roi 0.03
 *
 *   # Full SaaS-friendly: log in fresh, import top 50, hit a remote host
 *   node scripts/import-leaderboard.js \
 *     --api https://polytrack.example.com \
 *     --username admin --password $POLYTRACK_PW \
 *     --top 50
 */
import { fetchLeaderboardRaw } from "../src/polymarket-api.js";

const DEFAULTS = {
  windows: ["alltime", "monthly", "weekly", "daily"],
  minPnl:  50_000,    // $50k absolute pnl
  minRoi:  0.02,      // 2 % pnl / volume
  top:     30,
  api:     "http://localhost:3001",
  dryRun:  false,
};

function parseArgs(argv) {
  const out = { ...DEFAULTS };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case "--dry-run":   out.dryRun = true; break;
      case "--min-pnl":   out.minPnl = Number(next()); break;
      case "--min-roi":   out.minRoi = Number(next()); break;
      case "--top":       out.top    = Number(next()); break;
      case "--windows":   out.windows = next().split(",").map(s => s.trim()).filter(Boolean); break;
      case "--api":       out.api    = next(); break;
      case "--token":     out.token  = next(); break;
      case "--username":  out.username = next(); break;
      case "--password":  out.password = next(); break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
      default:
        console.error(`Unknown arg: ${a}`);
        process.exit(1);
    }
  }
  if (!out.token) out.token = process.env.POLYTRACK_JWT || "";
  return out;
}

function printHelp() {
  console.log(`
import-leaderboard — pull ELITE-grade Polymarket traders into polytrack

Options:
  --dry-run               Print candidates, don't POST anything
  --min-pnl  <usd>        Min absolute pnl  (default $${DEFAULTS.minPnl.toLocaleString()})
  --min-roi  <ratio>      Min pnl/volume    (default ${DEFAULTS.minRoi})
  --top      <n>          Cap final list    (default ${DEFAULTS.top})
  --windows  <list>       Leaderboard windows comma-list
                          (default ${DEFAULTS.windows.join(",")})
  --api      <url>        polytrack base URL (default ${DEFAULTS.api})
  --token    <jwt>        JWT for /wallets (or set POLYTRACK_JWT)
  --username --password   Log in instead of passing token
`.trim());
}

async function login(api, username, password) {
  const res = await fetch(`${api}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`Login failed (${res.status}): ${body.error || "unknown"}`);
  }
  const { token } = await res.json();
  return token;
}

async function getExistingWallets(api, token) {
  const res = await fetch(`${api}/wallets`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`/wallets returned ${res.status}`);
  const list = await res.json();
  return new Set((list || []).map(w => (w.addr || w.address || "").toLowerCase()));
}

async function addWallet(api, token, addr) {
  const res = await fetch(`${api}/wallets`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ addr }),
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

/**
 * Merge multiple leaderboard windows. Same wallet may appear in several
 * windows with different pnl/volume — keep the entry with the highest ROI
 * since it's the strongest signal of skill.
 */
function mergeRows(rowsByWindow) {
  const best = new Map();
  for (const [window, rows] of Object.entries(rowsByWindow)) {
    for (const r of rows) {
      const roi = r.volume > 0 ? r.pnl / r.volume : 0;
      const prev = best.get(r.proxyWallet);
      const prevRoi = prev ? (prev.volume > 0 ? prev.pnl / prev.volume : 0) : -Infinity;
      if (!prev || roi > prevRoi) {
        best.set(r.proxyWallet, { ...r, window, roi });
      }
    }
  }
  return [...best.values()];
}

export function filterCandidates(rows, { minPnl, minRoi, top }) {
  return rows
    .filter(r => r.pnl >= minPnl && r.roi >= minRoi)
    .sort((a, b) => b.roi - a.roi)
    .slice(0, top);
}

function fmtUsd(n) {
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

function printTable(rows) {
  console.log("");
  console.log("  rank  ROI       PnL          volume        window      address                                       name");
  console.log("  ────  ────────  ───────────  ────────────  ──────────  ────────────────────────────────────────────  ────────");
  for (const r of rows) {
    const roiPct = (r.roi * 100).toFixed(2) + "%";
    console.log(
      `  ${String(r.rank ?? "").padStart(4)}  ${roiPct.padStart(8)}  ${fmtUsd(r.pnl).padStart(11)}  ${fmtUsd(r.volume).padStart(12)}  ${(r.window).padEnd(10)}  ${r.proxyWallet}  ${r.pseudonym || ""}`
    );
  }
  console.log("");
}

async function main() {
  const opts = parseArgs(process.argv);

  // Resolve auth (skip if dry-run)
  let token = opts.token;
  if (!opts.dryRun) {
    if (!token && opts.username && opts.password) {
      token = await login(opts.api, opts.username, opts.password);
      console.log("✓ Logged in.");
    }
    if (!token) {
      console.error("Need either --token / POLYTRACK_JWT, or --username/--password.");
      process.exit(1);
    }
  }

  // Pull all configured windows in parallel
  console.log(`Fetching leaderboard windows: ${opts.windows.join(", ")}…`);
  const fetched = await Promise.allSettled(
    opts.windows.map(w => fetchLeaderboardRaw({ time: w, sort: "profit" }).then(rows => [w, rows]))
  );
  const rowsByWindow = {};
  for (const r of fetched) {
    if (r.status === "fulfilled") {
      const [w, rows] = r.value;
      rowsByWindow[w] = rows;
      console.log(`  ${w.padEnd(10)} → ${rows.length} rows`);
    } else {
      console.warn(`  failed: ${r.reason?.message || r.reason}`);
    }
  }
  if (Object.keys(rowsByWindow).length === 0) {
    console.error("No windows succeeded — check network / Polymarket availability.");
    process.exit(2);
  }

  // Merge + filter
  const merged = mergeRows(rowsByWindow);
  const candidates = filterCandidates(merged, opts);
  console.log(
    `\nCandidates: ${candidates.length}/${merged.length} unique wallets pass ` +
    `(pnl ≥ ${fmtUsd(opts.minPnl)}, ROI ≥ ${(opts.minRoi * 100).toFixed(1)}%, top ${opts.top}).`
  );
  printTable(candidates);

  if (opts.dryRun) {
    console.log("(dry-run) — no changes written. Drop --dry-run to import.");
    return;
  }

  // Skip already-tracked
  const existing = await getExistingWallets(opts.api, token);
  const toAdd = candidates.filter(c => !existing.has(c.proxyWallet));
  console.log(`\nAlready tracked: ${candidates.length - toAdd.length}. New to import: ${toAdd.length}.`);

  let added = 0, failed = 0;
  for (const c of toAdd) {
    const r = await addWallet(opts.api, token, c.proxyWallet);
    if (r.ok) {
      added++;
      process.stdout.write(`  + ${c.proxyWallet}  (${c.pseudonym || "anon"})\n`);
    } else {
      failed++;
      process.stdout.write(`  ✗ ${c.proxyWallet}  HTTP ${r.status}: ${r.body?.error || "unknown"}\n`);
    }
  }

  console.log(`\nDone. Added ${added}, failed ${failed}, already-tracked ${candidates.length - toAdd.length}.`);
}

// Only run main when invoked directly (not on import for tests)
const invoked = import.meta.url.endsWith(process.argv[1]) ||
                process.argv[1]?.endsWith("import-leaderboard.js");
if (invoked) {
  main().catch((e) => {
    console.error("Fatal:", e.message);
    process.exit(1);
  });
}
