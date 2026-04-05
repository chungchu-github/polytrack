<div align="center">

<img src="https://img.shields.io/badge/Polymarket-Smart%20Wallet%20Tracker-00ff9d?style=for-the-badge&logo=ethereum&logoColor=white"/>

# POLYTRACK

**Real-time smart wallet intelligence & auto-copy trading bot for Polymarket**

[![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?style=flat-square&logo=node.js)](https://nodejs.org)
[![Ethers.js](https://img.shields.io/badge/Ethers.js-v6-3C3C3D?style=flat-square&logo=ethereum)](https://ethers.org)
[![Socket.IO](https://img.shields.io/badge/Socket.IO-4.x-010101?style=flat-square&logo=socket.io)](https://socket.io)
[![Polygon](https://img.shields.io/badge/Polygon-Mainnet-8247E5?style=flat-square&logo=polygon)](https://polygon.technology)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow?style=flat-square)](LICENSE)

[Features](#-features) · [Architecture](#-architecture) · [Quick Start](#-quick-start) · [Configuration](#-configuration) · [API Reference](#-api-reference) · [Scoring](#-scoring-algorithm)

</div>

---

## 📌 Overview

POLYTRACK is a Node.js backend that solves two problems:

1. **Browser CORS** — Polymarket's APIs can't be called directly from a browser. POLYTRACK proxies all requests server-side.
2. **Auto-copy trading** — When 3 or more top-ranked ("ELITE") wallets enter the same position simultaneously, POLYTRACK automatically builds an EIP-712 signed order and submits it to the Polymarket CLOB.

It pairs with a React dashboard (`frontend/App.jsx`) that receives live updates over Socket.IO.

> **No private key required** — run in read-only mode to monitor signals without placing any trades.

---

## ✨ Features

- 🔍 **Live wallet scanner** — pulls real positions & trade history from `data-api.polymarket.com`
- 📊 **Performance scoring** — ranks every wallet 0–100 by win rate, ROI, and entry timing
- ⚡ **Consensus signal detection** — fires when 3+ ELITE wallets align on the same YES or NO
- 🤖 **Auto-copy execution** — EIP-712 signing via ethers.js → direct POST to Polymarket CLOB
- 📡 **WebSocket relay** — proxies Polymarket's real-time price stream to your frontend
- 🔄 **60-second cron refresh** — positions are re-scanned automatically
- 🛡️ **Read-only / simulation mode** — safe to run without a private key
- 🖥️ **REST + Socket.IO API** — connect any frontend or trading system

---

## 🏗 Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                     FRONTEND (React)                          │
│      Dashboard · Wallet Table · Signals · Trade Log           │
│                      socket.io-client                         │
└────────────────────────┬─────────────────────────────────────┘
                         │  WebSocket + REST
┌────────────────────────▼─────────────────────────────────────┐
│                 POLYTRACK SERVER  (Node.js)                   │
│                                                               │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────────────┐   │
│  │ CORS Proxy  │  │ Scan Engine  │  │  Signal Detector   │   │
│  │ /proxy?url= │  │  (60s cron)  │  │  (3+ ELITE rule)   │   │
│  └──────┬──────┘  └──────┬───────┘  └─────────┬──────────┘   │
│         │                │                     │               │
│  ┌──────▼──────┐  ┌──────▼───────┐  ┌─────────▼──────────┐   │
│  │  REST API   │  │  WS Relay    │  │  Auto-Copy Engine   │   │
│  │  /wallets   │  │ clob.poly.ws │  │  EIP-712 Signing    │   │
│  │  /signals   │  └──────────────┘  │  CLOB Order POST    │   │
│  │  /trades    │                    └────────────────────┘   │
│  └─────────────┘                                              │
└─────────────────────┬────────────────────────────────────────┘
                      │  Direct HTTP  (no CORS, server-side)
         ┌────────────┼──────────────────┐
         ▼            ▼                  ▼
   gamma-api      data-api          clob.polymarket.com
   .polymarket    .polymarket       (order placement)
   .com           .com
   (markets)      (positions/trades)
```

---

## 🚀 Quick Start

### Prerequisites

- Node.js 18+
- A Polygon wallet funded with USDC *(only needed for real trades)*

### Option A — Interactive setup wizard

```bash
git clone https://github.com/chungchu-github/polytrack.git
cd polytrack
npm install
node setup.js
```

### Option B — Manual setup

```bash
git clone https://github.com/chungchu-github/polytrack.git
cd polytrack
npm install
cp .env.example .env
# Edit .env with your values (see Configuration below)
npm start
```

The server starts at **`http://localhost:3001`**.  
Confirm it's running:

```bash
curl http://localhost:3001/health
```

### Connect the frontend

```bash
# In your React project
npm install socket.io-client

# Copy frontend/App.jsx into your src/
# Verify SERVER at the top of App.jsx points to http://localhost:3001
```

---

## ⚙️ Configuration

Copy `.env.example` to `.env` and fill in the values:

```env
# ── Server ────────────────────────────────────────────
PORT=3001

# ── Trading wallet (leave blank for read-only mode) ───
PRIVATE_KEY=0xYourEthPrivateKey
FUNDER_ADDRESS=0xYourPolymarketProxyWallet

# ── Polymarket API credentials (optional) ─────────────
POLY_API_KEY=
POLY_API_SECRET=
POLY_PASSPHRASE=

# ── Auto-copy settings ─────────────────────────────────
MAX_TRADE_USDC=100      # Max USDC per auto-trade
MIN_WALLETS=3           # ELITE wallets needed for signal
SCAN_INTERVAL=60        # Seconds between wallet scans

# ── Extra wallets to always watch ─────────────────────
WATCH_WALLETS=0xWallet1,0xWallet2
```

### How to find your Funder Address

1. Go to [polymarket.com](https://polymarket.com) and connect your wallet
2. Click **Deposit → Deposit Address** — that is your `FUNDER_ADDRESS`
3. To export your signing key: **Balance → More → Export Private Key**

### One-time allowance setup (real trades only)

Before the first real trade you must approve Polymarket's contracts to spend your USDC:

```bash
pip install "web3==7.12.1"
# Follow: https://github.com/Polymarket/py-clob-client#allowances
```

---

## 📡 API Reference

### REST Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Server status, config, wallet count |
| `GET` | `/wallets` | All tracked wallets sorted by score |
| `POST` | `/wallets` | Add a wallet `{ addr }` |
| `GET` | `/markets` | Top active Polymarket markets |
| `GET` | `/signals` | Active consensus signals |
| `GET` | `/trades` | Auto-trade execution log |
| `POST` | `/auto` | Toggle auto-copy `{ enabled: true\|false }` |
| `POST` | `/scan` | Trigger an immediate wallet scan |
| `POST` | `/trade` | Manually copy a signal `{ conditionId, dir }` |
| `GET` | `/proxy?url=` | CORS proxy for any Polymarket API URL |

### Socket.IO Events

**Server → Frontend**

| Event | Payload | When |
|-------|---------|------|
| `init` | Full state snapshot | On connect |
| `wallet:update` | Wallet object | Wallet loaded or refreshed |
| `markets` | `Market[]` | Market list updated |
| `signals` | `Signal[]` | Signal list updated |
| `trade:executed` | Trade object | Auto-trade fired |
| `auto:status` | `{ enabled }` | Toggle changed |
| `scan:start` | `{}` | Scan began |
| `scan:complete` | `{ wallets, signals, ts }` | Scan finished |
| `market:update` | Price event | Real-time Polymarket WS relay |
| `ws:status` | `{ connected }` | Polymarket WebSocket status |

**Frontend → Server**

| Event | Payload | Action |
|-------|---------|--------|
| `auto:toggle` | `{ enabled }` | Enable/disable auto-copy |
| `wallet:add` | `{ addr }` | Add wallet to watch list |
| `scan:trigger` | — | Force immediate scan |

---

## 🧮 Scoring Algorithm

Every wallet is scored **0–100** based on its full on-chain trade history from `data-api.polymarket.com`:

```
Score = (WinRate × 40%) + (ROI × 35%) + (TimingScore × 25%)
```

| Metric | Definition |
|--------|-----------|
| **WinRate** | % of closed positions that exited at price > 0.60 |
| **ROI** | `(avgSellPrice − avgBuyPrice) / avgBuyPrice × 100` |
| **TimingScore** | % of buys executed below 0.35 (early entry before the crowd) |

**Tiers**

| Tier | Score | Role in signals |
|------|-------|-----------------|
| 🟢 ELITE | > 70 | Counted toward consensus signals |
| 🟡 PRO | 45–70 | Tracked, not counted for signals |
| ⚪ BASIC | < 45 | Tracked only |

A **consensus signal** fires when **≥ 3 ELITE wallets** hold the same outcome (YES or NO) in the same market simultaneously.

---

## 🤖 Auto-Copy Trade Execution

When a signal fires and `AUTO-COPY` is enabled, the server:

1. Resolves the market's outcome token ID from the CLOB
2. Fetches the current mid-price
3. Builds an **EIP-712 typed-data order** (Polymarket CTF Exchange format)
4. Signs it with your private key via `ethers.js`
5. POSTs the signed order to `clob.polymarket.com/order` as FOK (Fill-or-Kill)
6. Records the result and pushes it to the frontend in real time

> If `PRIVATE_KEY` is not set, trades are recorded as **SIMULATED** — nothing is sent on-chain.

---

## 🔒 Security

| Rule | Why |
|------|-----|
| Never commit `.env` | Contains your private key |
| Add `.env` to `.gitignore` | Prevent accidental exposure |
| Start with `MAX_TRADE_USDC=10` | Limit blast radius while testing |
| Use `MIN_WALLETS=5` for production | Higher confidence signals |
| Run behind a firewall or VPN | Protect the server endpoint |

---

## 📁 Project Structure

```
polytrack/
├── server.js           # Main server: proxy · scan engine · signal detector · trade execution
├── setup.js            # Interactive setup wizard
├── package.json        # Dependencies
├── .env.example        # Configuration template
├── .gitignore          # Excludes .env and node_modules
└── frontend/
    └── App.jsx         # React dashboard (Socket.IO client)
```

---

## 🗺 Roadmap

- [ ] Webhook alerts (Discord / Telegram)
- [ ] Per-wallet P&L tracking over time
- [ ] Configurable scoring weights via UI
- [ ] Stop-loss / take-profit on auto-copy positions
- [ ] Docker Compose deployment

---

## ⚠️ Disclaimer

This software is for educational purposes only. Prediction market trading involves significant financial risk. Always do your own research. This is not financial advice.

---

## 📄 License

MIT © 2026 chungchu-github — see [LICENSE](LICENSE) for details.
