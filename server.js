/**
 * POLYTRACK — Backend Proxy Server
 * ─────────────────────────────────
 * Handles:
 *   1. CORS proxy for all Polymarket public APIs
 *   2. WebSocket relay for real-time price/trade streams
 *   3. Auto-copy trade execution (EIP-712 signing via ethers.js)
 *   4. Signal detection engine (server-side, persistent)
 *   5. REST API for the frontend dashboard
 */

import express from "express";
import cors from "cors";
import { createServer } from "http";
import { Server as SocketIO } from "socket.io";
import { WebSocket } from "ws";
import fetch from "node-fetch";
import { ethers } from "ethers";
import dotenv from "dotenv";
import cron from "node-cron";
import chalk from "chalk";

dotenv.config();

// ── Config ────────────────────────────────────────────────────────────────────
const PORT        = process.env.PORT || 3001;
const GAMMA_API   = "https://gamma-api.polymarket.com";
const DATA_API    = "https://data-api.polymarket.com";
const CLOB_API    = "https://clob.polymarket.com";
const CLOB_WS     = "wss://clob.polymarket.com/ws";

// Trading config — set in .env
const PRIVATE_KEY     = process.env.PRIVATE_KEY || "";        // Your wallet private key
const FUNDER_ADDRESS  = process.env.FUNDER_ADDRESS || "";     // Your Polymarket proxy wallet
const API_KEY         = process.env.POLY_API_KEY || "";       // Polymarket API key
const API_SECRET      = process.env.POLY_API_SECRET || "";
const API_PASSPHRASE  = process.env.POLY_PASSPHRASE || "";
const MAX_TRADE_USDC  = Number(process.env.MAX_TRADE_USDC || 100);  // Max per auto-trade
const MIN_WALLETS     = Number(process.env.MIN_WALLETS || 3);       // Consensus threshold
const SCAN_INTERVAL   = Number(process.env.SCAN_INTERVAL || 60);    // Seconds

// Known smart-money seed wallets
const SEED_WALLETS = (process.env.WATCH_WALLETS || "").split(",").filter(Boolean).concat([
  "0x6af75d4e4aaf700450efbac3708cce1665810ff1",
  "0xe05a5621d2e7b95a28ea82b169f2c0c99a2a0d43",
  "0x1a6cfd2e8d50c40f0dc54abce64d7dfc5d8af847",
  "0x7741a5c5e0dcbe34bf72c7a5e6320d05b39c5a4d",
  "0x9d6c22c7a3a5c0abf7119837e07c2211fb9f3306",
  "0xa17dc35e0f4c64fc9b6c03e94a17bc2c03f4ddd0",
  "0x22de14f7c84ce87bb4741bcc609c2a2d53c9a1fe",
  "0x88bc0f8d69d2a94ca00c4b37cfb27f0b7a2f44f7",
]).map(a => a.toLowerCase().trim());

// ── State ─────────────────────────────────────────────────────────────────────
const state = {
  wallets: new Map(),   // addr -> wallet data
  markets: [],
  signals: [],
  autoTrades: [],
  autoEnabled: false,
  lastScan: null,
  polyWs: null,
};

// ── Logger ────────────────────────────────────────────────────────────────────
const log = {
  info:  (...a) => console.log(chalk.cyan(`[${ts()}]`), ...a),
  ok:    (...a) => console.log(chalk.green(`[${ts()}] ✓`), ...a),
  warn:  (...a) => console.log(chalk.yellow(`[${ts()}] ⚠`), ...a),
  error: (...a) => console.log(chalk.red(`[${ts()}] ✗`), ...a),
  trade: (...a) => console.log(chalk.magenta(`[${ts()}] 🤖`), ...a),
};
const ts = () => new Date().toISOString().slice(11, 19);

// ── Express + Socket.IO setup ─────────────────────────────────────────────────
const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json());

const httpServer = createServer(app);
const io = new SocketIO(httpServer, { cors: { origin: "*" } });

const emit = (event, data) => io.emit(event, data);

// ── Polymarket CLOB auth headers ──────────────────────────────────────────────
function getClobHeaders() {
  if (!API_KEY) return {};
  return {
    "POLY-API-KEY":      API_KEY,
    "POLY-API-SECRET":   API_SECRET,
    "POLY-API-PASSPHRASE": API_PASSPHRASE,
    "POLY-TIMESTAMP":    String(Math.floor(Date.now() / 1000)),
  };
}

// ── Fetch helpers ─────────────────────────────────────────────────────────────
async function apiFetch(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
    timeout: 10000,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}

// ── Score calculator ──────────────────────────────────────────────────────────
function calcScore(trades = [], positions = []) {
  if (trades.length === 0) return { score: 0, winRate: 0, roi: 0, timing: 0 };
  const buys  = trades.filter(t => t.side === "BUY");
  const sells = trades.filter(t => t.side === "SELL");
  const wins   = sells.filter(t => t.price > 0.6).length;
  const losses = sells.filter(t => t.price < 0.4).length;
  const total  = wins + losses;
  const winRate = total > 0 ? (wins / total) * 100 : 50;
  const avgBuy  = buys.length  ? buys.reduce((s,t)=>s+t.price,0)/buys.length  : 0.5;
  const avgSell = sells.length ? sells.reduce((s,t)=>s+t.price,0)/sells.length : 0.5;
  const roi     = avgBuy > 0 ? ((avgSell - avgBuy) / avgBuy) * 100 : 0;
  const earlyBuys = buys.filter(t => t.price < 0.35).length;
  const timing = buys.length > 0 ? Math.min((earlyBuys / buys.length) * 100, 100) : 50;
  const score  = Math.round(winRate * 0.40 + Math.min(Math.max(roi,-20),80) * 0.35 + timing * 0.25);
  return {
    score:   Math.max(0, Math.min(100, score)),
    winRate: Math.round(winRate * 10) / 10,
    roi:     Math.round(roi * 10) / 10,
    timing:  Math.round(timing),
  };
}

// ── Load a single wallet ──────────────────────────────────────────────────────
async function loadWallet(addr) {
  const [trades, positions] = await Promise.all([
    apiFetch(`${DATA_API}/activity?user=${addr}&type=TRADE&limit=100`).catch(()=>[]),
    apiFetch(`${DATA_API}/positions?user=${addr}&sizeThreshold=1`).catch(()=>[]),
  ]);
  const { score, winRate, roi, timing } = calcScore(
    Array.isArray(trades) ? trades : [],
    Array.isArray(positions) ? positions : [],
  );
  const totalVol = (Array.isArray(trades) ? trades : []).reduce((s,t)=>s+(t.usdcSize||0),0);
  const tier = score > 70 ? "ELITE" : score > 45 ? "PRO" : "BASIC";
  return {
    addr,
    score, winRate, roi, timing,
    volume:       totalVol,
    trades:       Array.isArray(trades) ? trades.length : 0,
    positions:    Array.isArray(positions) ? positions : [],
    recentTrades: Array.isArray(trades) ? trades.slice(0, 8) : [],
    tier,
    updatedAt:    Date.now(),
  };
}

// ── Signal detector ───────────────────────────────────────────────────────────
function detectSignals() {
  const elites = [...state.wallets.values()].filter(w => w.tier === "ELITE");
  const newSignals = [];

  for (const event of state.markets) {
    for (const m of (event.markets || [])) {
      const yesWallets = elites.filter(w =>
        (w.positions||[]).some(p => p.conditionId === m.conditionId && p.outcome === "Yes" && (p.size||0) > 0)
      );
      const noWallets = elites.filter(w =>
        (w.positions||[]).some(p => p.conditionId === m.conditionId && p.outcome === "No"  && (p.size||0) > 0)
      );

      const dir   = yesWallets.length >= MIN_WALLETS ? "YES" : noWallets.length >= MIN_WALLETS ? "NO" : null;
      if (!dir) continue;

      const count = dir === "YES" ? yesWallets.length : noWallets.length;
      const sig   = { conditionId: m.conditionId, title: m.question || event.title, dir, count, ts: Date.now(), market: m };
      newSignals.push(sig);
      log.ok(`Signal: [${dir}] "${sig.title.slice(0,50)}" — ${count} ELITE wallets`);

      // Auto-trade
      if (state.autoEnabled) {
        const exists = state.autoTrades.find(t => t.conditionId === m.conditionId && t.dir === dir);
        if (!exists) {
          executeCopyTrade(sig).catch(e => log.error("Auto-trade failed:", e.message));
        }
      }
    }
  }

  state.signals = newSignals;
  emit("signals", newSignals);
  return newSignals;
}

// ── Main scan loop ────────────────────────────────────────────────────────────
async function runScan() {
  log.info("Starting wallet scan…");
  emit("scan:start", {});

  try {
    // Fetch markets
    const events = await apiFetch(`${GAMMA_API}/events?active=true&closed=false&order=volume_24hr&ascending=false&limit=20`);
    state.markets = (Array.isArray(events) ? events : []).slice(0, 15).map(e => ({
      id: e.id, slug: e.slug, title: e.title, volume: e.volume,
      markets: (e.markets || []).map(m => ({
        id: m.id, conditionId: m.conditionId, question: m.question,
        outcomePrices: m.outcomePrices, tokens: m.tokens,
      })),
    }));
    emit("markets", state.markets);
    log.ok(`Loaded ${state.markets.length} markets`);

    // Discover leaderboard wallets
    let watchList = [...new Set(SEED_WALLETS)];
    try {
      const lb = await apiFetch(`${DATA_API}/leaderboard?window=7d&limit=20`);
      const lbAddrs = (Array.isArray(lb) ? lb : [])
        .map(u => (u.proxyWallet || u.address || "").toLowerCase())
        .filter(Boolean);
      watchList = [...new Set([...lbAddrs, ...watchList])].slice(0, 20);
      log.ok(`Watch list: ${watchList.length} wallets (${lbAddrs.length} from leaderboard)`);
    } catch { log.warn("Leaderboard fetch failed, using seed wallets"); }

    // Load each wallet with rate limiting
    for (const addr of watchList) {
      try {
        emit("scan:wallet", { addr, status: "loading" });
        const w = await loadWallet(addr);
        state.wallets.set(addr, w);
        emit("wallet:update", w);
        log.ok(`${addr.slice(0,8)}… score=${w.score} tier=${w.tier} trades=${w.trades}`);
      } catch (e) {
        log.warn(`${addr.slice(0,8)}… failed: ${e.message}`);
        emit("scan:wallet", { addr, status: "error", message: e.message });
      }
      await sleep(300); // 300ms between requests
    }

    detectSignals();
    state.lastScan = new Date();
    emit("scan:complete", { wallets: state.wallets.size, signals: state.signals.length, ts: state.lastScan });
    log.ok(`Scan complete. ${state.wallets.size} wallets, ${state.signals.length} signals`);

  } catch (e) {
    log.error("Scan failed:", e.message);
    emit("scan:error", { message: e.message });
  }
}

// ── EIP-712 Auto-copy trade execution ─────────────────────────────────────────
async function executeCopyTrade(signal) {
  if (!PRIVATE_KEY || !FUNDER_ADDRESS) {
    log.warn("Auto-trade skipped: PRIVATE_KEY or FUNDER_ADDRESS not set in .env");
    const trade = { ...signal, size: MAX_TRADE_USDC, status: "SIMULATED", simulatedAt: Date.now() };
    state.autoTrades.unshift(trade);
    state.autoTrades = state.autoTrades.slice(0, 50);
    emit("trade:executed", trade);
    return trade;
  }

  log.trade(`Executing copy trade: [${signal.dir}] ${signal.title.slice(0,40)}`);
  try {
    const wallet = new ethers.Wallet(PRIVATE_KEY);

    // Step 1: Get the token ID for this market
    const { conditionId, dir, market } = signal;
    const tokenId = dir === "YES"
      ? market?.tokens?.[0]?.token_id
      : market?.tokens?.[1]?.token_id;

    if (!tokenId) throw new Error("Could not resolve token ID for market");

    // Step 2: Get current mid-price
    const priceData = await apiFetch(`${CLOB_API}/midpoint?token_id=${tokenId}`).catch(() => null);
    const price = priceData?.mid ? Math.round(Number(priceData.mid) * 100) / 100 : 0.5;

    // Step 3: Build EIP-712 order
    const size  = Math.floor(MAX_TRADE_USDC / price); // token amount
    const nonce = Math.floor(Date.now() / 1000);

    const domain = {
      name:              "Polymarket CTF Exchange",
      version:           "1",
      chainId:           137, // Polygon
      verifyingContract: "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982e",
    };

    const types = {
      Order: [
        { name: "salt",          type: "uint256" },
        { name: "maker",         type: "address" },
        { name: "signer",        type: "address" },
        { name: "taker",         type: "address" },
        { name: "tokenId",       type: "uint256" },
        { name: "makerAmount",   type: "uint256" },
        { name: "takerAmount",   type: "uint256" },
        { name: "expiration",    type: "uint256" },
        { name: "nonce",         type: "uint256" },
        { name: "feeRateBps",    type: "uint256" },
        { name: "side",          type: "uint8"   },
        { name: "signatureType", type: "uint8"   },
      ],
    };

    const makerAmount = BigInt(Math.round(MAX_TRADE_USDC * 1e6));  // USDC (6 decimals)
    const takerAmount = BigInt(Math.round(size * 1e6));             // Outcome tokens (6 decimals)

    const orderData = {
      salt:          BigInt(nonce),
      maker:         FUNDER_ADDRESS,
      signer:        wallet.address,
      taker:         "0x0000000000000000000000000000000000000000",
      tokenId:       BigInt(tokenId),
      makerAmount,
      takerAmount,
      expiration:    BigInt(0),
      nonce:         BigInt(nonce),
      feeRateBps:    BigInt(0),
      side:          0,  // 0 = BUY
      signatureType: 0,  // EOA
    };

    // Step 4: Sign the order
    const signature = await wallet.signTypedData(domain, types, orderData);

    // Step 5: Submit to CLOB
    const orderPayload = {
      order: {
        salt:          orderData.salt.toString(),
        maker:         orderData.maker,
        signer:        orderData.signer,
        taker:         orderData.taker,
        tokenId:       orderData.tokenId.toString(),
        makerAmount:   orderData.makerAmount.toString(),
        takerAmount:   orderData.takerAmount.toString(),
        expiration:    orderData.expiration.toString(),
        nonce:         orderData.nonce.toString(),
        feeRateBps:    orderData.feeRateBps.toString(),
        side:          "BUY",
        signatureType: 0,
        signature,
      },
      orderType: "FOK", // Fill-or-kill
    };

    const response = await fetch(`${CLOB_API}/order`, {
      method:  "POST",
      headers: { "Content-Type": "application/json", ...getClobHeaders() },
      body:    JSON.stringify(orderPayload),
    });

    const result = await response.json();
    log.trade(`Order response:`, JSON.stringify(result).slice(0, 120));

    const trade = {
      ...signal,
      size:       MAX_TRADE_USDC,
      price,
      tokenId,
      orderId:    result.orderID || result.id,
      status:     result.status || (response.ok ? "SUBMITTED" : "FAILED"),
      txHash:     result.transactionHash,
      executedAt: Date.now(),
    };

    state.autoTrades.unshift(trade);
    state.autoTrades = state.autoTrades.slice(0, 50);
    emit("trade:executed", trade);
    return trade;

  } catch (e) {
    log.error("Trade execution error:", e.message);
    const trade = { ...signal, size: MAX_TRADE_USDC, status: "ERROR", error: e.message, executedAt: Date.now() };
    state.autoTrades.unshift(trade);
    emit("trade:executed", trade);
    throw e;
  }
}

// ── Polymarket WebSocket relay ─────────────────────────────────────────────────
function connectPolyWs(tokenIds = []) {
  if (state.polyWs) { try { state.polyWs.close(); } catch {} }
  if (tokenIds.length === 0) return;

  log.info(`Connecting to Polymarket WebSocket for ${tokenIds.length} tokens…`);
  const ws = new WebSocket(CLOB_WS);
  state.polyWs = ws;

  ws.on("open", () => {
    const sub = { auth: {}, type: "market", markets: tokenIds.slice(0, 10) };
    ws.send(JSON.stringify(sub));
    log.ok("Polymarket WebSocket connected");
    emit("ws:status", { connected: true });
  });

  ws.on("message", raw => {
    try {
      const msg = JSON.parse(raw.toString());
      // Relay price / trade events to frontend
      if (msg.event_type === "price_change" || msg.event_type === "trade") {
        emit("market:update", msg);
      }
    } catch {}
  });

  ws.on("close", () => {
    log.warn("Polymarket WebSocket disconnected, reconnecting in 5s…");
    emit("ws:status", { connected: false });
    setTimeout(() => connectPolyWs(tokenIds), 5000);
  });

  ws.on("error", e => log.error("WS error:", e.message));
}

// ── REST API routes ───────────────────────────────────────────────────────────

// Health check
app.get("/health", (_, res) => res.json({
  ok: true,
  wallets: state.wallets.size,
  signals: state.signals.length,
  autoEnabled: state.autoEnabled,
  lastScan: state.lastScan,
  hasPrivateKey: !!PRIVATE_KEY,
  version: "1.0.0",
}));

// CORS proxy for any Polymarket endpoint
app.get("/proxy", async (req, res) => {
  const { url } = req.query;
  if (!url || !["gamma-api.polymarket.com","data-api.polymarket.com","clob.polymarket.com"]
    .some(d => url.includes(d))) {
    return res.status(400).json({ error: "Invalid or disallowed proxy target" });
  }
  try {
    const data = await apiFetch(url);
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Get all loaded wallets
app.get("/wallets", (_, res) => {
  res.json([...state.wallets.values()].sort((a,b) => b.score - a.score));
});

// Add a wallet to the watch list
app.post("/wallets", async (req, res) => {
  const { addr } = req.body;
  if (!addr || !/^0x[0-9a-fA-F]{40}$/.test(addr)) {
    return res.status(400).json({ error: "Invalid address" });
  }
  try {
    log.info(`Adding wallet: ${addr}`);
    const w = await loadWallet(addr.toLowerCase());
    state.wallets.set(addr.toLowerCase(), w);
    detectSignals();
    emit("wallet:update", w);
    res.json(w);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get active markets
app.get("/markets", (_, res) => res.json(state.markets));

// Get current signals
app.get("/signals", (_, res) => res.json(state.signals));

// Get auto-trade log
app.get("/trades", (_, res) => res.json(state.autoTrades));

// Toggle auto-copy
app.post("/auto", (req, res) => {
  state.autoEnabled = !!req.body.enabled;
  log.info(`Auto-copy ${state.autoEnabled ? "ENABLED" : "DISABLED"}`);
  emit("auto:status", { enabled: state.autoEnabled });
  res.json({ enabled: state.autoEnabled });
});

// Manual trigger: force scan
app.post("/scan", async (req, res) => {
  res.json({ ok: true, message: "Scan started" });
  runScan();
});

// Manual trigger: copy a specific signal
app.post("/trade", async (req, res) => {
  const { conditionId, dir } = req.body;
  const signal = state.signals.find(s => s.conditionId === conditionId && s.dir === dir);
  if (!signal) return res.status(404).json({ error: "Signal not found" });
  try {
    const trade = await executeCopyTrade(signal);
    res.json(trade);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Socket.IO: client connects ────────────────────────────────────────────────
io.on("connection", sock => {
  log.info(`Frontend connected: ${sock.id}`);
  // Send current state immediately
  sock.emit("init", {
    wallets:     [...state.wallets.values()],
    markets:     state.markets,
    signals:     state.signals,
    autoTrades:  state.autoTrades,
    autoEnabled: state.autoEnabled,
    lastScan:    state.lastScan,
    hasPrivateKey: !!PRIVATE_KEY,
  });
  sock.on("auto:toggle",  ({ enabled }) => {
    state.autoEnabled = enabled;
    emit("auto:status", { enabled });
    log.info(`Auto-copy ${enabled ? "ON" : "OFF"} via socket`);
  });
  sock.on("wallet:add",   ({ addr }) => {
    loadWallet(addr.toLowerCase()).then(w => {
      state.wallets.set(addr.toLowerCase(), w);
      detectSignals();
      emit("wallet:update", w);
    }).catch(e => sock.emit("error", { message: e.message }));
  });
  sock.on("scan:trigger", () => runScan());
  sock.on("disconnect",   () => log.info(`Frontend disconnected: ${sock.id}`));
});

// ── Scheduled scan ────────────────────────────────────────────────────────────
cron.schedule(`*/${SCAN_INTERVAL} * * * * *`, () => {
  if (state.wallets.size > 0) {
    log.info("Scheduled refresh scan…");
    runScan();
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
httpServer.listen(PORT, async () => {
  console.log(chalk.bold.green(`\n🚀 POLYTRACK server running on http://localhost:${PORT}\n`));
  console.log(chalk.cyan("Config:"));
  console.log(`  Auto-copy:      ${state.autoEnabled ? chalk.green("ON") : chalk.gray("OFF")}`);
  console.log(`  Max trade:      ${chalk.yellow("$" + MAX_TRADE_USDC + " USDC")}`);
  console.log(`  Signal threshold: ${chalk.yellow(MIN_WALLETS + "+ ELITE wallets")}`);
  console.log(`  Scan interval:  ${chalk.yellow(SCAN_INTERVAL + "s")}`);
  console.log(`  Private key:    ${PRIVATE_KEY ? chalk.green("SET ✓") : chalk.red("NOT SET (simulated trades only)")}`);
  console.log(`  Funder address: ${FUNDER_ADDRESS ? chalk.green(FUNDER_ADDRESS.slice(0,12)+"…") : chalk.red("NOT SET")}\n`);

  // Initial scan on startup
  await runScan();

  // Connect WS after first scan
  const tokenIds = state.markets.flatMap(e =>
    (e.markets || []).flatMap(m => (m.tokens || []).map(t => t.token_id))
  ).filter(Boolean).slice(0, 10);
  connectPolyWs(tokenIds);
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────
process.on("SIGINT", () => {
  log.info("Shutting down…");
  if (state.polyWs) state.polyWs.close();
  httpServer.close(() => process.exit(0));
});

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
