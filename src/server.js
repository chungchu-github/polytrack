/**
 * POLYTRACK — Server v2.1
 * ───────────────────────
 * Thin orchestrator: Express routes, Socket.IO, WebSocket relay, cron scan.
 * All business logic lives in dedicated modules.
 * Phase 2: Pino logging, SQLite persistence, enhanced health check.
 */

import express from "express";
import cors from "cors";
import { createServer } from "http";
import { Server as SocketIO } from "socket.io";
import { WebSocket } from "ws";
import dotenv from "dotenv";
import cron from "node-cron";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import rateLimit from "express-rate-limit";
import pinoHttp from "pino-http";

import {
  fetchMarkets, fetchWalletTrades, fetchWalletPositions,
  fetchLeaderboard, proxyFetch, cancelOrder, fetchMidPrice, fetchOrderBook,
  submitOrder, fetchOrderStatus, CLOB_WS,
} from "./polymarket-api.js";
import { loadConfig, saveConfig } from "./config.js";
import { scoreWallet } from "./scoring.js";
import {
  executeCopyTrade, resolveTokenId, preflightCheck,
  buildUnsignedOrder, signOrder, wrapOrderPayload,
  classifyClobOrderStatus, evaluateExit,
} from "./trading.js";
import { checkResolutions, getSignalAccuracy } from "./resolution.js";
import { checkRiskLimits, getRiskSnapshot } from "./risk.js";
import {
  alertTradeExecuted, alertTradeFailed, alertBreakerTripped,
  alertRiskBlocked, alertScanError, alertStartup,
} from "./alerts.js";
import {
  createState, hydrateFromDB, getWalletList, getSignals,
  addTrade, setWallet, beginScan, endScan,
} from "./state.js";
import {
  initDB, closeDB, getStats as getDBStats, getStalePendingTrades,
  updateTradeStatus, getDataCaptureStats, vacuumDB,
  getOpenFilledTrades, markTradeExited, getLatestSnapshotForToken,
} from "./db.js";
import log, { logger } from "./logger.js";
import { initMonitoring, captureException, flushMonitoring } from "./monitoring.js";
import { checkClockSkew } from "./time-check.js";
import { captureMarketSnapshot, captureWalletPositions, pruneOldSnapshots } from "./datacapture.js";
import { HistoryReader } from "./backtest/history.js";
import { runBacktest } from "./backtest/engine.js";
import {
  insertBacktest, completeBacktest, getBacktest, listBacktests, deleteBacktest,
  getTradesPnlByStrategy, getWalletDegradationCandidates,
  createUser, getUserByUsername, getUserById, updateUserLastLogin, countUsers,
  createInvitationRow, getInvitation, markInvitationUsed, deleteInvitation,
  listInvitationsByAdmin,
} from "./db.js";
import {
  hashPassword, verifyPassword, signJwt, verifyJwt, getJwtSecret,
  generateInviteToken, inviteExpiry,
} from "./auth.js";
import { ethers } from "ethers";

dotenv.config();

// ── Config ───────────────────────────────────────────────────────────────────
const PORT            = Number(process.env.PORT || 3001);
// HOST defaults to 0.0.0.0 only when explicitly opted in via env. Default to
// 127.0.0.1 so a misconfigured deployment doesn't expose the dashboard
// publicly — safer when ufw isn't in front.
const HOST            = process.env.HOST || "127.0.0.1";
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "http://localhost:5173,http://localhost:3000,http://localhost:3001").split(",").map(s => s.trim());
const PRIVATE_KEY     = process.env.PRIVATE_KEY || "";
const FUNDER_ADDRESS  = process.env.FUNDER_ADDRESS || "";
// NOTE: POLY_API_KEY / POLY_API_SECRET / POLY_PASSPHRASE are reserved for a
// future L2 HMAC auth implementation. CLOB V2 order submission is authenticated
// by the on-chain EIP-712 signature in the order body, so no L2 headers are
// currently needed — they would be sent unsigned, which Polymarket would reject.
const MAX_TRADE_USDC  = Number(process.env.MAX_TRADE_USDC || 100);
const MIN_WALLETS     = Number(process.env.MIN_WALLETS || 3);
const SLIPPAGE_PCT    = Number(process.env.SLIPPAGE_PCT || 2);
const SCAN_INTERVAL   = Number(process.env.SCAN_INTERVAL || 60);
const FAILURE_BREAKER_THRESHOLD = Number(process.env.FAILURE_BREAKER_THRESHOLD || 3);

// Startup safety — refuse to run in production without a JWT secret.
// Phase 1 multi-user auth signs every session token with this secret; if
// it's missing, login still "works" but tokens are valid only for this
// boot and silently fall back to a dev constant — definitely not what
// you want on a server controlling money.
try {
  getJwtSecret(); // throws in production when JWT_SECRET is missing
} catch (e) {
  // eslint-disable-next-line no-console
  console.error(`[polytrack] FATAL: ${e.message}`);
  process.exit(1);
}

// Trade execution circuit breaker — trips autoEnabled=false after N consecutive failures
let tradeFailureStreak = 0;

const SEED_WALLETS = (process.env.WATCH_WALLETS || "").split(",").filter(Boolean).concat([
  "0x63ce342161250d705dc0b16df89036c8e5f9ba9a",
  "0xde17f7144fbd0eddb2679132c10ff5e74b120988",
  "0x1f0ebc543b2d411f66947041625c0aa1ce61cf86",
]).map(a => a.toLowerCase().trim());

// ── Initialize DB & State ────────────────────────────────────────────────────
initDB();
const state = createState({ minWallets: MIN_WALLETS });
hydrateFromDB(state);
log.db(`Database initialized. Hydrated ${state.wallets.size} wallets, ${state.autoTrades.length} trades from disk.`);

// ── Auth Middleware ───────────────────────────────────────────────────────────
// Bearer JWT carries { userId, role }. On success, req.user is populated.
function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  const payload = verifyJwt(token);
  if (!payload) return res.status(401).json({ error: "Unauthorized" });
  req.user = payload;
  next();
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== "admin") {
    return res.status(403).json({ error: "Forbidden — admin role required" });
  }
  next();
}

// ── Express Setup ────────────────────────────────────────────────────────────
const app = express();
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (ALLOWED_ORIGINS.includes("*") || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    cb(new Error("CORS blocked"));
  },
}));
app.use(express.json());
app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === "/health" } }));

// Rate limiting
const proxyLimiter = rateLimit({ windowMs: 60_000, max: 60, message: { error: "Rate limited" } });
const tradeLimiter = rateLimit({ windowMs: 60_000, max: 5,  message: { error: "Rate limited" } });
const scanLimiter  = rateLimit({ windowMs: 60_000, max: 2,  message: { error: "Rate limited" } });

// Global safety net — blunts brute-force token guessing and runaway clients.
// /health stays unlimited so uptime monitors can poll freely; /assets/* is
// skipped so the SPA keeps loading even if the API is under pressure.
const globalLimiter = rateLimit({
  windowMs: 60_000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path === "/health" || req.path.startsWith("/assets/"),
  message: { error: "Rate limited" },
});
app.use(globalLimiter);

// ── Auth endpoints (V8 — Phase 1) ────────────────────────────────────────────
// Login attempts get a stricter limiter to slow brute-force.
const loginLimiter = rateLimit({
  windowMs: 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many login attempts" },
});

app.post("/auth/login", loginLimiter, async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: "username and password required" });
  }
  const user = getUserByUsername(username);
  if (!user || !(await verifyPassword(password, user.password_hash))) {
    // Same response for both cases — no user enumeration.
    return res.status(401).json({ error: "Invalid username or password" });
  }
  updateUserLastLogin(user.id);
  const token = signJwt({ userId: user.id, role: user.role });
  res.json({
    token,
    user: { id: user.id, username: user.username, role: user.role },
  });
});

app.post("/auth/logout", (_req, res) => {
  // Stateless JWT — client just drops the token. We respond 200 so the UI
  // gets a clear acknowledgement and can clear local state.
  res.json({ ok: true });
});

app.get("/auth/me", requireAuth, (req, res) => {
  const user = getUserById(req.user.userId);
  if (!user) return res.status(401).json({ error: "User not found" });
  res.json({ user });
});

app.post("/auth/invite", requireAuth, requireAdmin, (req, res) => {
  const token = generateInviteToken();
  const expiresAt = inviteExpiry();
  createInvitationRow({ token, createdBy: req.user.userId, expiresAt });
  res.json({
    token,
    expiresAt,
    url: `/register?invite=${token}`,
  });
});

app.get("/auth/invitations", requireAuth, requireAdmin, (req, res) => {
  res.json(listInvitationsByAdmin(req.user.userId));
});

app.delete("/auth/invitations/:token", requireAuth, requireAdmin, (req, res) => {
  const changed = deleteInvitation(req.params.token);
  res.json({ deleted: changed });
});

app.post("/auth/register", loginLimiter, async (req, res) => {
  const { invite_token, username, password } = req.body || {};
  if (!invite_token || !username || !password) {
    return res.status(400).json({ error: "invite_token, username, password required" });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters" });
  }
  const inv = getInvitation(invite_token);
  if (!inv) return res.status(400).json({ error: "Invalid invite" });
  if (inv.used_by)               return res.status(400).json({ error: "Invite already used" });
  if (inv.expires_at < Date.now()) return res.status(400).json({ error: "Invite expired" });

  if (getUserByUsername(username)) {
    return res.status(400).json({ error: "Username already taken" });
  }
  let userId;
  try {
    const hash = await hashPassword(password);
    userId = createUser({ username, passwordHash: hash, role: "user" });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  markInvitationUsed(invite_token, userId);
  updateUserLastLogin(userId);
  const token = signJwt({ userId, role: "user" });
  res.json({ token, user: { id: userId, username, role: "user" } });
});

// Serve frontend build in production
const __dirname = dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIST = resolve(__dirname, "..", "frontend", "dist");
app.use(express.static(FRONTEND_DIST));

const httpServer = createServer(app);
const io = new SocketIO(httpServer, {
  cors: {
    origin: (origin, cb) => {
      if (!origin || ALLOWED_ORIGINS.includes("*") || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
      cb(new Error("CORS blocked"));
    },
  },
});

const emit = (event, data) => io.emit(event, data);

// ── Wallet Loading ───────────────────────────────────────────────────────────
// On API failure, returns existing cached wallet (preserves score/tier).
// Only rescores when fresh data is available.
async function loadWallet(addr) {
  let trades, positions;
  const existing = state.wallets.get(addr);

  try {
    [trades, positions] = await Promise.all([
      fetchWalletTrades(addr, { limit: 200 }),
      fetchWalletPositions(addr),
    ]);
  } catch (e) {
    log.warn(`API fetch failed for ${addr.slice(0, 10)}…: ${e.message}`);
    if (existing) {
      log.scan(`Keeping cached score=${existing.score} tier=${existing.tier} for ${addr.slice(0, 10)}…`);
      return { ...existing, updatedAt: existing.updatedAt }; // don't bump timestamp
    }
    throw e; // no cached data — propagate error
  }

  const result = scoreWallet(trades, positions);

  return {
    addr,
    score:           result.score,
    tier:            result.tier,
    winRate:         result.winRate,
    roi:             result.totalROI,
    sharpe:          result.sharpe,
    maxDrawdown:     result.maxDrawdown,
    timing:          result.timing,
    consistency:     result.consistency,
    totalPnL:        result.totalPnL,
    volume:          result.totalVolume,
    closedPositions: result.closedPositions,
    openPositions:   result.openPositions,
    trades:          trades.length,
    positions,
    recentTrades:    trades.slice(0, 20),
    updatedAt:       Date.now(),
  };
}

// ── Main Scan Loop ───────────────────────────────────────────────────────────
async function runScan() {
  if (state.scanning) {
    log.warn("Scan already in progress, skipping");
    return;
  }
  state.scanning = true;
  const scanStart = Date.now();
  const scanId = beginScan();
  let walletsScanned = 0;
  let tradesExecuted = 0;

  log.scan("Starting wallet scan…");
  emit("scan:start", {});

  try {
    // 1. Fetch markets
    state.markets = await fetchMarkets({ limit: 20 });
    emit("markets", state.markets);
    log.scan(`Loaded ${state.markets.length} markets`);

    // 2. Build watch list: seed + leaderboard
    let watchList = [...new Set(SEED_WALLETS)];
    try {
      const lbAddrs = await fetchLeaderboard({ time: "weekly", limit: 20 });
      watchList = [...new Set([...lbAddrs, ...watchList])].slice(0, 25);
      log.scan(`Watch list: ${watchList.length} wallets`);
    } catch { log.warn("Leaderboard fetch failed, using seed wallets"); }

    // 3. Load each wallet sequentially with rate limiting
    for (const addr of watchList) {
      try {
        emit("scan:wallet", { addr, status: "loading" });
        const w = await loadWallet(addr);
        setWallet(state, w);  // persists to DB
        emit("wallet:update", w);
        walletsScanned++;
        log.scan(`${addr.slice(0,10)}… score=${w.score} tier=${w.tier} pnl=$${w.totalPnL}`);
      } catch (e) {
        log.warn(`${addr.slice(0,10)}… failed: ${e.message}`);
        emit("scan:wallet", { addr, status: "error", message: e.message });
      }
      await sleep(300);
    }

    // 4. Detect signals (multi-strategy via StrategyEngine)
    const walletList = getWalletList(state);
    const detectCtx = {
      wallets: walletList,
      markets: state.markets,
      history: new HistoryReader(),
      now: Date.now(),
      log,
    };
    const signals = state.strategyEngine.detectAll(detectCtx);
    state.signals = signals;
    emit("signals", signals);

    for (const sig of signals) {
      if (sig.status === "NEW") {
        log.ok(`Signal: [${sig.direction}] "${sig.title.slice(0,50)}" — ${sig.walletCount} ELITE wallets, strength=${sig.strength}`);
      }
    }

    // 5. Auto-trade on NEW/CONFIRMED signals
    if (state.autoEnabled) {
      for (const sig of signals) {
        if (sig.status !== "NEW" && sig.status !== "CONFIRMED") continue;
        const strategyName = sig.strategy || "consensus";
        if (state.strategyEngine.isTraded(strategyName, sig.conditionId, sig.direction)) continue;

        // Load live config (trade size, slippage, signal threshold)
        const cfg = loadConfig();
        const stratCfg = cfg.strategies?.[strategyName] || {};
        if (stratCfg.enabled === false) continue;
        const minStrength = stratCfg.minStrength ?? cfg.minSignalStrength ?? 0;
        if (sig.strength < minStrength) continue;

        // Cross-strategy conflict guard — block momentum YES + meanrev NO on
        // the same market. Without this we'd burn spread + fee on a guaranteed
        // self-hedged pair. Whoever marked the market first holds; the late
        // opposite signal is dropped.
        const opposing = state.strategyEngine.hasOpposingTrade(sig.conditionId, sig.direction);
        if (opposing) {
          log.warn(`Cross-strategy conflict — ${strategyName} ${sig.direction} blocked: ${opposing.strategy} already ${opposing.direction} on ${sig.conditionId.slice(0, 10)}…`);
          continue;
        }

        // Risk gate — daily loss / exposure / cooldown / V3 live-test cap
        const risk = checkRiskLimits(state, sig.conditionId, cfg.maxTradeUsdc, cfg);
        if (!risk.ok) {
          log.warn(`Risk gate blocked [${sig.direction}] ${sig.title?.slice(0,40)}: ${risk.reason}`);
          alertRiskBlocked(sig, risk.reason);
          continue;
        }

        // Concurrency lock — mark traded BEFORE execute to prevent double-fire
        state.strategyEngine.markTraded(strategyName, sig.conditionId, sig.direction);

        try {
          const trade = await executeCopyTrade(sig, {
            privateKey: PRIVATE_KEY,
            funderAddress: FUNDER_ADDRESS,
            maxTradeUsdc: stratCfg.maxTradeUsdc || cfg.maxTradeUsdc,
            slippagePct: cfg.slippagePct,
          });
          trade.strategy = strategyName;
          addTrade(state, trade);  // persists to DB
          emit("trade:executed", trade);
          alertTradeExecuted(trade);
          tradesExecuted++;
          log.trade(`Executed: [${trade.direction}] ${trade.title?.slice(0,40)} — $${trade.size} — ${trade.status}`);

          // Circuit breaker: reset streak on success; count FAILED/UNKNOWN as failures
          if (trade.status === "FILLED" || trade.status === "PARTIAL" || trade.status === "SIMULATED") {
            tradeFailureStreak = 0;
          } else {
            tradeFailureStreak++;
          }
        } catch (e) {
          // Rollback concurrency lock so signal can be retried later (after cooldown)
          state.strategyEngine.unmarkTraded(strategyName, sig.conditionId, sig.direction);
          tradeFailureStreak++;
          log.error("Auto-trade failed:", e.message);
          captureException(e, { scope: "auto-trade", conditionId: sig.conditionId, direction: sig.direction });
          alertTradeFailed({ title: sig.title, conditionId: sig.conditionId, direction: sig.direction, size: cfg.maxTradeUsdc }, e.message);
          addTrade(state, {
            conditionId: sig.conditionId,
            title: sig.title,
            direction: sig.direction,
            size: cfg.maxTradeUsdc,
            status: "ERROR",
            error: e.message,
            executedAt: Date.now(),
          });
        }

        // Trip breaker
        if (tradeFailureStreak >= FAILURE_BREAKER_THRESHOLD) {
          state.autoEnabled = false;
          log.error(`Circuit breaker tripped — ${tradeFailureStreak} consecutive failures. Auto-copy DISABLED.`);
          emit("auto:disabled", { reason: `${tradeFailureStreak} consecutive trade failures` });
          alertBreakerTripped(tradeFailureStreak, FAILURE_BREAKER_THRESHOLD);
          break;
        }
      }
    }

    // 6. Check signal resolutions (track accuracy)
    try {
      const res = await checkResolutions(state.markets);
      if (res.resolved > 0) log.scan(`Resolved ${res.resolved}/${res.checked} signals`);
    } catch (e) {
      log.warn(`Resolution check failed: ${e.message}`);
    }

    // 7. Data capture — persist snapshots for F2/F3 (best-effort, non-fatal).
    //    Cache the result on state so /health can surface it to the V1 gate UI.
    try {
      const capResult = await captureMarketSnapshot(state.markets);
      const posRows   = captureWalletPositions(state);
      state.lastCaptureResult = {
        at:       Date.now(),
        inserted: capResult?.inserted ?? 0,
        failed:   capResult?.failed   ?? 0,
        positionsInserted: posRows || 0,
      };
      log.db(
        `Data capture: ${state.lastCaptureResult.inserted} market snapshots, ` +
        `${state.lastCaptureResult.failed} failed, ` +
        `${state.lastCaptureResult.positionsInserted} position rows`
      );
    } catch (e) {
      state.lastCaptureResult = { at: Date.now(), inserted: 0, failed: 0, error: e.message };
      log.warn(`Data capture failed: ${e.message}`);
    }

    state.lastScan = new Date();
    const durationMs = Date.now() - scanStart;
    endScan(scanId, { walletsScanned, signalsFound: signals.length, tradesExecuted, durationMs });
    emit("scan:complete", { wallets: state.wallets.size, signals: signals.length, ts: state.lastScan });
    log.scan(`Scan complete in ${durationMs}ms. ${state.wallets.size} wallets, ${signals.length} signals`);

  } catch (e) {
    log.error("Scan failed:", e.message);
    captureException(e, { scope: "scan" });
    endScan(scanId, { walletsScanned, signalsFound: 0, tradesExecuted: 0, durationMs: Date.now() - scanStart, error: e.message });
    emit("scan:error", { message: e.message });
    alertScanError(e.message);
  } finally {
    state.scanning = false;
  }
}

// ── Polymarket WebSocket Relay ────────────────────────────────────────────────
let wsReconnectDelay = 5000;

// V2 cutover changed the WS endpoint and the legacy /ws path returns 404.
// Until we verify the new path, allow operators to silence the noise via
// POLY_WS_DISABLE=true in .env. The 60s scan loop is the source of truth
// either way; the WS feed only powers sub-second dashboard updates.
const WS_DISABLED = process.env.POLY_WS_DISABLE === "true";

function connectPolyWs(tokenIds = []) {
  if (WS_DISABLED) return;
  if (state.polyWs) { try { state.polyWs.close(); } catch {} }
  if (tokenIds.length === 0) return;

  log.ws(`Connecting to Polymarket WS for ${tokenIds.length} tokens…`);
  const ws = new WebSocket(CLOB_WS);
  state.polyWs = ws;

  ws.on("open", () => {
    wsReconnectDelay = 5000;
    // 2025-05 change: Markets channel no longer caps subscriptions at 100 tokens.
    // initial_dump=true asks the server to seed us with the current book state so
    // downstream consumers don't need a separate REST warm-up.
    ws.send(JSON.stringify({
      auth: {},
      type: "market",
      markets: tokenIds,
      initial_dump: true,
    }));
    log.ws(`Polymarket WebSocket connected (${tokenIds.length} tokens subscribed)`);
    emit("ws:status", { connected: true, subscribedTokens: tokenIds.length });
  });

  ws.on("message", raw => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.event_type === "price_change" || msg.event_type === "trade") {
        emit("market:update", msg);
      }
    } catch (e) {
      log.warn("WS message parse error:", e.message);
    }
  });

  ws.on("close", () => {
    log.ws(`Polymarket WS disconnected, reconnecting in ${wsReconnectDelay / 1000}s…`);
    emit("ws:status", { connected: false });
    setTimeout(() => connectPolyWs(tokenIds), wsReconnectDelay);
    wsReconnectDelay = Math.min(wsReconnectDelay * 1.5, 60_000);
  });

  ws.on("error", e => log.error("WS error:", e.message));
}

// ── REST API Routes ──────────────────────────────────────────────────────────

// Enhanced health check with DB stats
app.get("/health", (_, res) => {
  let dbStats = {};
  try {
    dbStats = getDBStats();
  } catch (e) {
    dbStats = { error: e.message };
  }

  const STRATEGY_NAMES = ["consensus", "momentum", "meanrev", "arbitrage"];
  const signalAccuracyByStrategy = {};
  for (const s of STRATEGY_NAMES) {
    try { signalAccuracyByStrategy[s] = getSignalAccuracy(s); }
    catch { signalAccuracyByStrategy[s] = { total: 0, correct: 0, accuracy: null }; }
  }

  let strategiesCfg = {};
  try { strategiesCfg = loadConfig().strategies || {}; } catch { /* fall through */ }

  let dataCapture = null;
  try {
    dataCapture = getDataCaptureStats();
    // Attach the most recent capture attempt (cached on state by runScan) so
    // the Dashboard V1 card can distinguish "never ran" from "ran, 0 inserted".
    dataCapture.lastCaptureResult = state.lastCaptureResult || null;
  } catch (e) { dataCapture = { error: e.message }; }

  let degradationCandidates = [];
  try {
    degradationCandidates = getWalletDegradationCandidates({ windowDays: 30 });
  } catch (e) { /* keep /health responsive even if query fails */ }

  res.json({
    ok: true,
    version: "2.1.0",
    wallets: state.wallets.size,
    signals: getSignals(state).length,
    autoEnabled: state.autoEnabled,
    lastScan: state.lastScan,
    hasPrivateKey: !!PRIVATE_KEY,
    simulationMode: !PRIVATE_KEY || !FUNDER_ADDRESS,
    scanning: state.scanning,
    uptime: Math.round(process.uptime()),
    memoryMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    signalAccuracy: getSignalAccuracy(),
    signalAccuracyByStrategy,
    strategies: strategiesCfg,
    risk: getRiskSnapshot(state, loadConfig()),
    tradeFailureStreak,
    db: dbStats,
    dataCapture,
    degradationCandidates,
  });
});

// CORS proxy (rate limited)
app.get("/proxy", requireAuth, proxyLimiter, async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: "Missing url parameter" });
  try {
    const data = await proxyFetch(url);
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Get all wallets (public)
app.get("/wallets", requireAuth, (_, res) => {
  res.json(getWalletList(state));
});

// Add a wallet (auth required)
app.post("/wallets", requireAuth, async (req, res) => {
  const { addr } = req.body;
  if (!addr || !/^0x[0-9a-fA-F]{40}$/.test(addr)) {
    return res.status(400).json({ error: "Invalid address" });
  }
  try {
    const w = await loadWallet(addr.toLowerCase());
    setWallet(state, w);
    const signals = state.signalStore.detect(getWalletList(state), state.markets);
    emit("wallet:update", w);
    emit("signals", signals);
    res.json(w);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get markets (public)
app.get("/markets", requireAuth, (_, res) => res.json(state.markets));

// Get signals (public)
app.get("/signals", requireAuth, (_, res) => res.json(getSignals(state)));

// Get trade log (public)
app.get("/trades", requireAuth, (_, res) => res.json(state.autoTrades));

// F2 — realized PnL + open exposure broken out by strategy
app.get("/stats/pnl-by-strategy", requireAuth, (_, res) => {
  try {
    res.json(getTradesPnlByStrategy());
  } catch (e) {
    log.warn(`getTradesPnlByStrategy failed: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// Toggle auto-copy (auth required)
app.post("/auto", requireAuth, (req, res) => {
  state.autoEnabled = !!req.body.enabled;
  log.info(`Auto-copy ${state.autoEnabled ? "ENABLED" : "DISABLED"}`);
  emit("auto:status", { enabled: state.autoEnabled });
  res.json({ enabled: state.autoEnabled });
});

// Manual scan trigger (auth required, rate limited)
app.post("/scan", requireAuth, scanLimiter, async (req, res) => {
  res.json({ ok: true, message: "Scan started" });
  runScan();
});

// Manual data-capture trigger — useful for verifying the V1 pipeline is
// healthy without waiting for the next scheduled scan. Runs ONLY the capture
// step against the markets currently in state.markets (so it's fast and
// doesn't refresh wallets).
app.post("/datacapture/trigger", requireAuth, async (req, res) => {
  try {
    if (!state.markets || state.markets.length === 0) {
      return res.status(409).json({ error: "state.markets empty — run /scan first" });
    }
    const capResult = await captureMarketSnapshot(state.markets);
    const posRows   = captureWalletPositions(state);
    state.lastCaptureResult = {
      at:                Date.now(),
      inserted:          capResult?.inserted ?? 0,
      failed:            capResult?.failed   ?? 0,
      positionsInserted: posRows || 0,
      trigger:           "manual",
    };
    log.db(`Manual capture: ${state.lastCaptureResult.inserted} markets, ${state.lastCaptureResult.positionsInserted} positions`);
    res.json({ ok: true, ...state.lastCaptureResult });
  } catch (e) {
    log.warn(`Manual capture failed: ${e.message}`);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Manual trade (auth required, rate limited)
app.post("/trade", requireAuth, tradeLimiter, async (req, res) => {
  const { conditionId, dir } = req.body;
  const signals = getSignals(state);
  const signal = signals.find(s => s.conditionId === conditionId && s.direction === dir);
  if (!signal) return res.status(404).json({ error: "Signal not found" });
  try {
    const cfg = loadConfig();
    const trade = await executeCopyTrade(signal, {
      privateKey: PRIVATE_KEY,
      funderAddress: FUNDER_ADDRESS,
      maxTradeUsdc: Number(req.body.size) || cfg.maxTradeUsdc,
      slippagePct: cfg.slippagePct,
    });
    addTrade(state, trade);
    emit("trade:executed", trade);
    res.json(trade);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// F1 non-custodial trade flow ─────────────────────────────────────────────────
// `POST /trade/prepare` — build an unsigned V2 order struct + EIP-712 typed-data
//   envelope. Caller (future frontend with wagmi/viem) signs locally and
//   submits via `POST /trade/submit`. No PRIVATE_KEY touched here.
//
// `POST /trade/submit` — take a signed order (from the frontend) and forward it
//   to the CLOB. Server never sees the signer's private key.
//
// These endpoints are ADDITIVE — existing custodial `POST /trade` is untouched.

function serialiseOrderData(o) {
  // BigInt → decimal string so the response survives JSON.stringify and the
  // browser can hand the identical object back to signTypedData.
  return {
    salt:          o.salt.toString(),
    maker:         o.maker,
    signer:        o.signer,
    tokenId:       o.tokenId.toString(),
    makerAmount:   o.makerAmount.toString(),
    takerAmount:   o.takerAmount.toString(),
    side:          o.side,
    signatureType: o.signatureType,
    timestamp:     o.timestamp.toString(),
    metadata:      o.metadata,
    builder:       o.builder,
  };
}

function deserialiseOrderData(o) {
  return {
    salt:          BigInt(o.salt),
    maker:         o.maker,
    signer:        o.signer,
    tokenId:       BigInt(o.tokenId),
    makerAmount:   BigInt(o.makerAmount),
    takerAmount:   BigInt(o.takerAmount),
    side:          Number(o.side),
    signatureType: Number(o.signatureType),
    timestamp:     BigInt(o.timestamp),
    metadata:      o.metadata,
    builder:       o.builder,
  };
}

app.post("/trade/prepare", requireAuth, async (req, res) => {
  const {
    conditionId, direction, size,
    signerAddress, funderAddress,
    negRisk, signatureType, builderCode,
  } = req.body || {};

  if (!conditionId) return res.status(400).json({ error: "conditionId required" });
  if (!direction || !["YES", "NO"].includes(direction)) {
    return res.status(400).json({ error: "direction must be YES or NO" });
  }
  if (!signerAddress) return res.status(400).json({ error: "signerAddress required" });
  if (!funderAddress) return res.status(400).json({ error: "funderAddress required" });

  try {
    const cfg = loadConfig();
    const signals = getSignals(state);
    const signal = signals.find(s => s.conditionId === conditionId && s.direction === direction);
    if (!signal) return res.status(404).json({ error: "Signal not found" });

    const tokenId = resolveTokenId(signal.market, direction);
    if (!tokenId) return res.status(400).json({ error: "Could not resolve tokenId for outcome" });

    const sizeUsdc = Number(size) || cfg.maxTradeUsdc;
    const pre = await preflightCheck(signal, tokenId, sizeUsdc);
    if (!pre.ok) return res.status(409).json({ error: `Preflight failed: ${pre.reason}` });

    // Apply slippage — same math as the custodial path (executeCopyTrade).
    const tick = pre.tickSize && pre.tickSize > 0 ? pre.tickSize : 0.01;
    const raw  = pre.midPrice * (1 + (cfg.slippagePct || 2) / 100);
    const limitPrice = Math.round(Math.ceil(raw / tick) * tick * 1e6) / 1e6;

    const negRiskResolved = !!(negRisk ?? signal?.market?.negRisk ?? pre.negRisk);

    const { orderData, domain, types } = buildUnsignedOrder({
      signerAddress, funderAddress, tokenId,
      price: limitPrice,
      maxUsdc: sizeUsdc,
      negRisk: negRiskResolved,
      signatureType,
      builderCode,
    });

    res.json({
      orderData: serialiseOrderData(orderData),
      domain,
      types,
      meta: {
        conditionId, direction, tokenId,
        midPrice: pre.midPrice,
        limitPrice,
        sizeUsdc,
        negRisk: negRiskResolved,
      },
    });
  } catch (e) {
    log.warn(`/trade/prepare failed: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

app.post("/trade/submit", requireAuth, async (req, res) => {
  const { orderData, signature, orderType = "FOK" } = req.body || {};
  if (!orderData || !signature) {
    return res.status(400).json({ error: "orderData + signature required" });
  }
  try {
    const deser = deserialiseOrderData(orderData);
    const payload = wrapOrderPayload({ orderData: deser, signature, orderType });
    const { ok, status, data } = await submitOrder(payload, {});
    res.status(ok ? 200 : status || 502).json({ ok, status, data });
  } catch (e) {
    log.warn(`/trade/submit failed: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// F3: Backtest endpoints ──────────────────────────────────────────────────────
app.post("/backtest", requireAuth, async (req, res) => {
  const { dateStart, dateEnd, strategy, strategyConfig, sizeUsdc,
          slippagePct, initialCash, stepMinutes, name, walletAddresses } = req.body || {};
  if (!strategy || !dateStart || !dateEnd) {
    return res.status(400).json({ error: "Missing dateStart, dateEnd, or strategy" });
  }
  const id = insertBacktest({
    name, dateStart: Number(dateStart), dateEnd: Number(dateEnd), strategy,
    config: { strategyConfig, sizeUsdc, slippagePct, initialCash, stepMinutes, walletAddresses },
  });
  res.json({ id, status: "RUNNING" });

  // Run async — don't block the request
  setImmediate(async () => {
    try {
      const result = await runBacktest({
        dateStart: Number(dateStart), dateEnd: Number(dateEnd),
        strategy, strategyConfig: strategyConfig || {},
        sizeUsdc: Number(sizeUsdc) || 100,
        slippagePct: Number(slippagePct) || 2,
        initialCash: Number(initialCash) || 10000,
        stepMinutes: Number(stepMinutes) || 60,
        walletAddresses,
      });
      completeBacktest(id, {
        metrics: result.metrics,
        trades: result.trades,
        equityCurve: result.equityCurve,
        status: "DONE",
      });
      log.info(`Backtest ${id} (${strategy}) complete: PnL=$${result.metrics.totalPnL}`);
    } catch (e) {
      completeBacktest(id, { status: "FAILED", error: e.message });
      captureException(e, { scope: "backtest", id });
      log.error(`Backtest ${id} failed: ${e.message}`);
    }
  });
});

app.get("/backtests", requireAuth, (_req, res) => res.json(listBacktests(50)));

app.get("/backtest/:id", requireAuth, (req, res) => {
  const bt = getBacktest(Number(req.params.id));
  if (!bt) return res.status(404).json({ error: "Not found" });
  res.json(bt);
});

app.delete("/backtest/:id", requireAuth, (req, res) => {
  const changed = deleteBacktest(Number(req.params.id));
  res.json({ deleted: changed });
});

// V2 Edge Validation Gate ─────────────────────────────────────────────────────
// Runs a backtest for every enabled strategy over the trailing window and
// grades each one against the V2 gate thresholds:
//   - Sharpe > 1.0
//   - Win rate > 55%
//   - Trade count ≥ 10 (statistical floor — fewer trades is not meaningful)
// Returns one verdict per strategy. Not persisted — use POST /backtest if you
// want an audited run; /validate-edge is a live check.
const V2_GATE_DEFAULTS = {
  minSharpe:     1.0,
  minWinRatePct: 55,
  minTradeCount: 10,
};

app.post("/validate-edge", requireAuth, async (req, res) => {
  const {
    days = 30,
    stepMinutes = 60,
    sizeUsdc = 100,
    initialCash = 10000,
    gates = {},
  } = req.body || {};

  const g = { ...V2_GATE_DEFAULTS, ...gates };
  const dateEnd = Date.now();
  const dateStart = dateEnd - Number(days) * 86_400_000;

  const cfg = loadConfig();
  const strategies = ["consensus", "momentum", "meanrev", "arbitrage"];

  const runOne = async (name) => {
    const stratCfg = cfg.strategies?.[name] || {};
    try {
      const { metrics } = await runBacktest({
        dateStart, dateEnd,
        strategy: name,
        strategyConfig: { ...stratCfg, enabled: true }, // force-enable for validation
        sizeUsdc: Number(sizeUsdc),
        initialCash: Number(initialCash),
        stepMinutes: Number(stepMinutes),
      });
      const sharpe   = Number(metrics.sharpe || 0);
      const winRate  = Number(metrics.winRate || 0);
      const trades   = Number(metrics.tradeCount || 0);
      const pass     = sharpe > g.minSharpe && winRate > g.minWinRatePct && trades >= g.minTradeCount;
      return {
        strategy: name,
        pass,
        reasons: pass ? [] : [
          sharpe  <= g.minSharpe      && `sharpe ${sharpe} ≤ ${g.minSharpe}`,
          winRate <= g.minWinRatePct  && `winRate ${winRate}% ≤ ${g.minWinRatePct}%`,
          trades  <  g.minTradeCount  && `trades ${trades} < ${g.minTradeCount}`,
        ].filter(Boolean),
        metrics: {
          sharpe, winRate, tradeCount: trades,
          totalPnL: metrics.totalPnL,
          maxDrawdownPct: metrics.maxDrawdownPct,
          finalEquity: metrics.finalEquity,
        },
      };
    } catch (e) {
      return { strategy: name, pass: false, reasons: [`error: ${e.message}`], metrics: null };
    }
  };

  const results = await Promise.all(strategies.map(runOne));
  const summary = {
    days,
    dateStart, dateEnd,
    gates: g,
    evaluatedAt: Date.now(),
    allPass: results.every(r => r.pass),
    passCount: results.filter(r => r.pass).length,
    results,
  };
  res.json(summary);
});

// D1: Signal context — supporting wallets with their per-market performance
app.get("/signals/:conditionId/:direction/context", requireAuth, (req, res) => {
  const { conditionId, direction } = req.params;
  const signals = getSignals(state);
  const signal = signals.find(s => s.conditionId === conditionId && s.direction === direction);
  if (!signal) return res.status(404).json({ error: "Signal not found" });

  const supporting = (signal.wallets || []).map(w => {
    const fullWallet = state.wallets.get(w.addr);
    const marketTrades = (fullWallet?.recentTrades || []).filter(t => t.conditionId === conditionId);
    return {
      addr:       w.addr,
      score:      fullWallet?.score ?? w.score,
      tier:       fullWallet?.tier ?? "—",
      winRate:    fullWallet?.winRate ?? null,
      totalPnL:   fullWallet?.totalPnL ?? null,
      posValue:   w.posValue,
      avgPrice:   w.avgPrice,
      tradeCount: marketTrades.length,
      lastTradeTs: marketTrades[0]?.timestamp ?? null,
    };
  });

  res.json({
    conditionId,
    direction,
    title: signal.title,
    strength: signal.strength,
    status: signal.status,
    supporting,
    opposingCount: signal.opposingCount || 0,
    firstSeenAt: signal.firstSeenAt,
    lastConfirmedAt: signal.lastConfirmedAt,
  });
});

// D2: Trade preview — runs preflight and returns estimated price/depth
app.get("/preview", requireAuth, async (req, res) => {
  const { conditionId, direction, size } = req.query;
  const signals = getSignals(state);
  const signal = signals.find(s => s.conditionId === conditionId && s.direction === direction);
  if (!signal) return res.status(404).json({ error: "Signal not found" });

  const tokenId = resolveTokenId(signal.market, direction);
  if (!tokenId) return res.status(400).json({ error: "Cannot resolve token" });

  const cfg = loadConfig();
  const sizeUsdc = Number(size) || cfg.maxTradeUsdc;
  const slippagePct = cfg.slippagePct;

  const pre = await preflightCheck(signal, tokenId, sizeUsdc);
  const midPrice = pre.midPrice ?? await fetchMidPrice(tokenId);
  const limitPrice = midPrice ? Math.round(midPrice * (1 + slippagePct / 100) * 100) / 100 : null;

  res.json({
    conditionId,
    direction,
    tokenId,
    sizeUsdc,
    slippagePct,
    midPrice,
    limitPrice,
    availableDepth: pre.availableDepth,
    ok: pre.ok,
    reason: pre.reason,
    simulationMode: !PRIVATE_KEY || !FUNDER_ADDRESS,
  });
});

// D5: Runtime config
app.get("/config", requireAuth, (_, res) => res.json(loadConfig()));
app.post("/config", requireAuth, (req, res) => {
  const next = saveConfig(req.body || {});
  log.info(`Config updated: ${Object.keys(req.body || {}).join(", ")}`);
  res.json(next);
});

// D6: CSV export of trade history
app.get("/trades.csv", requireAuth, (_, res) => {
  const rows = state.autoTrades;
  const cols = ["executedAt","direction","title","conditionId","size","filledSize","midPrice","limitPrice","filledPrice","status","orderId","error"];
  const escape = (v) => {
    if (v == null) return "";
    const s = String(v).replace(/"/g, '""');
    return /[,"\n]/.test(s) ? `"${s}"` : s;
  };
  const lines = [cols.join(",")];
  for (const t of rows) {
    const row = cols.map(c => {
      if (c === "executedAt" && t[c]) return new Date(t[c]).toISOString();
      return escape(t[c]);
    });
    lines.push(row.join(","));
  }
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="polytrack-trades-${Date.now()}.csv"`);
  res.send(lines.join("\n"));
});

// SPA fallback — serve index.html for client-side routes
app.get("*", (req, res) => {
  res.sendFile(resolve(FRONTEND_DIST, "index.html"));
});

// ── Socket.IO ────────────────────────────────────────────────────────────────
// JWT auth — same secret as REST endpoints. Frontend passes the token via
// io.connect's `auth: { token }` handshake.
io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  const payload = verifyJwt(token);
  if (!payload) return next(new Error("Unauthorized"));
  socket.user = payload;
  next();
});

io.on("connection", sock => {
  log.info(`Frontend connected: ${sock.id}`);

  sock.emit("init", {
    wallets:      getWalletList(state),
    markets:      state.markets,
    signals:      getSignals(state),
    autoTrades:   state.autoTrades,
    autoEnabled:  state.autoEnabled,
    lastScan:     state.lastScan,
    hasPrivateKey: !!PRIVATE_KEY,
  });

  sock.on("auto:toggle", ({ enabled }) => {
    state.autoEnabled = enabled;
    emit("auto:status", { enabled });
    log.info(`Auto-copy ${enabled ? "ON" : "OFF"} via socket`);
  });

  sock.on("wallet:add", ({ addr }) => {
    if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) {
      return sock.emit("error", { message: "Invalid address" });
    }
    loadWallet(addr.toLowerCase()).then(w => {
      setWallet(state, w);
      const signals = state.signalStore.detect(getWalletList(state), state.markets);
      emit("wallet:update", w);
      emit("signals", signals);
    }).catch(e => sock.emit("error", { message: e.message }));
  });

  sock.on("scan:trigger", () => runScan());
  sock.on("disconnect", () => log.info(`Frontend disconnected: ${sock.id}`));
});

// ── Stale Order Reconciliation ───────────────────────────────────────────────
// On boot we may see trades still marked PENDING/SUBMITTED because the process
// died after placing the order but before recording the fill. Read CLOB first,
// then decide — a filled order that we blindly "cancel" leaves the DB saying
// "we never traded" while the position lives on-chain (phantom exposure).
async function sweepStaleOrders() {
  const stale = getStalePendingTrades(5 * 60_000);
  if (stale.length === 0) return;
  log.info(`Reconciling ${stale.length} stale pending trade(s)…`);
  for (const t of stale) {
    try {
      const order = await fetchOrderStatus(t.order_id);
      const classified = classifyClobOrderStatus(order?.status);

      let newStatus;
      if (classified === "FILLED" || classified === "PARTIAL") {
        newStatus = classified;
      } else if (classified === "CANCELLED" || classified === "EXPIRED" || classified === "REJECTED") {
        newStatus = classified;
      } else if (classified === "OPEN") {
        const res = await cancelOrder(t.order_id, {});
        newStatus = res.ok ? "CANCELLED" : "STALE";
      } else {
        // UNKNOWN — CLOB API unreachable or returned something we don't
        // recognise. Leave DB alone rather than guess.
        log.warn(`  #${t.id} ${t.order_id?.slice(0, 10)}… unresolved (CLOB returned ${order?.status ?? "null"}) — keeping as-is`);
        continue;
      }

      updateTradeStatus(t.id, newStatus, Date.now());
      log.info(`  #${t.id} ${t.order_id?.slice(0, 10)}… → ${newStatus}`);
    } catch (e) {
      log.warn(`  #${t.id} reconcile failed: ${e.message}`);
    }
  }
}

// ── Auto-Exit / Stop-Loss (P0 #4) ─────────────────────────────────────────────
// For every FILLED trade with no exitedAt: check policy. If we should exit,
// build a SELL order at the latest best_bid and submit it. Marks the trade
// EXITED in the DB regardless of fill outcome — the SELL has an order_id we
// can reconcile later if the FOK didn't take.
//
// Disabled by default (config.exitPolicy.enabled=false). Operator must opt
// in once they're confident in the SELL signing path. Until then, this
// function is a no-op.
async function runExits() {
  const cfg = loadConfig();
  const policy = cfg.exitPolicy;
  if (!policy?.enabled) return;
  if (!PRIVATE_KEY || !FUNDER_ADDRESS) return;  // simulation mode — never sell

  const open = getOpenFilledTrades();
  if (open.length === 0) return;
  const now = Date.now();

  for (const t of open) {
    const tokenId = t.token_id;
    const fillSize = Number(t.fill_size) || 0;
    if (!tokenId || !(fillSize > 0)) {
      // Pre-V9 trades or partial DB writes — can't sell what we don't track.
      continue;
    }

    const snap = getLatestSnapshotForToken(tokenId);
    const latestMidPrice = snap?.mid_price ?? null;

    const decision = evaluateExit({
      trade: {
        status:    t.status,
        fillPrice: Number(t.fill_price) || Number(t.limit_price) || null,
        filledAt:  Number(t.filled_at) || 0,
        exitedAt:  t.exited_at,
        direction: t.direction,
      },
      latestMidPrice,
      now,
      policy,
    });
    if (!decision.shouldExit) continue;

    const exitPrice = snap?.best_bid ?? snap?.mid_price;
    if (!(exitPrice > 0)) {
      log.warn(`Auto-exit #${t.id} skipped — no fresh bid for ${tokenId.slice(0, 10)}…`);
      continue;
    }

    try {
      const signerAddress = new ethers.Wallet(PRIVATE_KEY).address;
      const { orderData, domain } = buildUnsignedOrder({
        signerAddress,
        funderAddress: FUNDER_ADDRESS,
        tokenId,
        price:    exitPrice,
        side:     1,             // SELL
        tokenQty: fillSize,
        negRisk:  !!t.neg_risk,  // honour the original exchange routing
      });
      const signature = await signOrder({ privateKey: PRIVATE_KEY, orderData, domain });
      const payload = wrapOrderPayload({ orderData, signature, orderType: "FOK" });
      const submission = await submitOrder(payload, {});

      const exitOrderId = submission?.data?.orderID || submission?.data?.id || null;
      markTradeExited(t.id, {
        exitReason:  decision.reason,
        exitPrice,
        exitOrderId,
      });
      const pnlStr = decision.currentPnLPct == null
        ? "n/a"
        : `${(decision.currentPnLPct * 100).toFixed(1)}%`;
      log.info(`Auto-exit #${t.id} (${decision.reason}) — ${t.direction} sold at ${exitPrice}, M2M PnL ${pnlStr}`);
    } catch (e) {
      log.warn(`Auto-exit #${t.id} failed: ${e.message}`);
    }
  }
}

// ── Scheduled Scan ───────────────────────────────────────────────────────────
cron.schedule(`*/${SCAN_INTERVAL} * * * * *`, () => {
  if (state.wallets.size > 0 && !state.scanning) {
    log.scan("Scheduled refresh scan…");
    runScan().then(() => runExits()).catch(() => {});
  } else {
    // Even when there's nothing to scan, still evaluate exits — held
    // positions don't care about new market data, only time + price drift.
    runExits().catch(() => {});
  }
});

// Daily snapshot retention — prune rows older than 90 days at 03:17 local time
cron.schedule("17 3 * * *", () => {
  try { pruneOldSnapshots(90); }
  catch (e) { log.warn(`pruneOldSnapshots failed: ${e.message}`); }
});

// Daily SQLite backup at 03:00 local time — WAL-safe via sqlite3 .backup
// Runs scripts/backup-db.sh (keeps 30 days by default, gzipped in data/backups/).
cron.schedule("0 3 * * *", () => {
  import("node:child_process").then(({ spawn }) => {
    const proc = spawn("bash", ["scripts/backup-db.sh"], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "", err = "";
    proc.stdout.on("data", (b) => { out += b.toString(); });
    proc.stderr.on("data", (b) => { err += b.toString(); });
    proc.on("close", (code) => {
      if (code === 0) log.db(`backup-db ok: ${out.trim()}`);
      else log.warn(`backup-db failed (code ${code}): ${err.trim() || out.trim()}`);
    });
  }).catch((e) => log.warn(`backup-db spawn error: ${e.message}`));
});

// Weekly VACUUM at Sun 04:00 — reclaims disk space left behind by pruned
// snapshot rows. Sits after the 03:00 backup and 03:17 prune so it operates
// on a freshly-pruned, already-backed-up DB.
cron.schedule("0 4 * * 0", () => {
  try {
    const r = vacuumDB();
    const mbBefore = (r.bytesBefore / 1048576).toFixed(1);
    const mbAfter  = (r.bytesAfter  / 1048576).toFixed(1);
    const mbFreed  = (r.freedBytes  / 1048576).toFixed(1);
    log.db(`VACUUM ok — ${mbBefore} MB → ${mbAfter} MB (freed ${mbFreed} MB) in ${r.durationMs}ms`);
  } catch (e) {
    log.warn(`VACUUM failed: ${e.message}`);
  }
});

// ── Error Handlers ───────────────────────────────────────────────────────────
process.on("unhandledRejection", (reason) => {
  log.error("Unhandled rejection:", String(reason));
});

process.on("uncaughtException", (err) => {
  log.error("Uncaught exception:", err.message);
});

// ── Start ────────────────────────────────────────────────────────────────────
httpServer.listen(PORT, HOST, async () => {
  log.info(`POLYTRACK v2.1.0 — listening on http://${HOST}:${PORT}`);
  log.info(`Auto-copy: ${state.autoEnabled ? "ON" : "OFF"} | Max trade: $${MAX_TRADE_USDC} | Slippage: ${SLIPPAGE_PCT}% | Threshold: ${MIN_WALLETS}+ ELITE | Interval: ${SCAN_INTERVAL}s`);
  log.info(`Private key: ${PRIVATE_KEY ? "SET" : "NOT SET (simulated)"} | Auth: JWT (${countUsers()} users) | CORS: ${ALLOWED_ORIGINS.join(", ")}`);
  if (!PRIVATE_KEY || !FUNDER_ADDRESS) {
    log.warn("⚠ SIMULATION MODE — PRIVATE_KEY or FUNDER_ADDRESS not set. All trades will be simulated, no real orders will be placed.");
  }

  await initMonitoring({ release: "polytrack@2.1.0", environment: process.env.NODE_ENV || "production" });
  await checkClockSkew();
  await sweepStaleOrders();
  alertStartup(PRIVATE_KEY && FUNDER_ADDRESS ? "LIVE" : "SIMULATION", "2.1.0");
  await runScan();

  const tokenIds = state.markets.flatMap(e =>
    (e.markets || []).flatMap(m => (m.tokens || []).map(t => t.token_id))
  ).filter(Boolean).slice(0, 20);
  connectPolyWs(tokenIds);
});

// ── Graceful Shutdown ────────────────────────────────────────────────────────
async function gracefulShutdown(sig) {
  log.info(`${sig} received, shutting down…`);
  if (state.polyWs) { try { state.polyWs.close(); } catch {} }
  await flushMonitoring(3000);
  closeDB();
  httpServer.close(() => process.exit(0));
  // Hard exit if close hangs
  setTimeout(() => process.exit(0), 8000).unref();
}
process.on("SIGINT",  () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
