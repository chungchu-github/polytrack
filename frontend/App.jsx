/**
 * POLYTRACK — Frontend Dashboard (connects to backend proxy)
 * Drop this into your React app or run via Vite/CRA
 * Requires: npm install socket.io-client
 */

import { useState, useEffect, useRef, useCallback } from "react";
import { io } from "socket.io-client";

const SERVER = "http://localhost:3001"; // Change to your server URL

// ─── Utilities ────────────────────────────────────────────────────────────────
const fmt = (n, d = 1) => n == null ? "—" : Number(n).toFixed(d);
const fmtUSDC = n => !n ? "$0" : n >= 1e6 ? `$${(n/1e6).toFixed(1)}M` : n >= 1e3 ? `$${(n/1e3).toFixed(0)}k` : `$${Number(n).toFixed(0)}`;
const shortAddr = a => a ? `${a.slice(0,6)}…${a.slice(-4)}` : "—";
const timeAgo = ts => {
  const s = Math.floor((Date.now() - (ts > 1e12 ? ts : ts * 1000)) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s/60)}m ago`;
  return `${Math.floor(s/3600)}h ago`;
};

// ─── Score ring ────────────────────────────────────────────────────────────────
function ScoreRing({ score }) {
  const r = 18, circ = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(score || 0, 100)) / 100;
  const color = score > 70 ? "#00ff9d" : score > 45 ? "#ffc740" : "#ff5f57";
  return (
    <svg width="46" height="46" viewBox="0 0 46 46">
      <circle cx="23" cy="23" r={r} fill="none" stroke="#111d2e" strokeWidth="4"/>
      <circle cx="23" cy="23" r={r} fill="none" stroke={color} strokeWidth="4"
        strokeDasharray={circ} strokeDashoffset={circ * (1 - pct)}
        strokeLinecap="round" transform="rotate(-90 23 23)"
        style={{ transition: "stroke-dashoffset 0.8s ease" }}/>
      <text x="23" y="27" textAnchor="middle" fill={color} fontSize="10" fontWeight="700" fontFamily="monospace">
        {Math.round(score || 0)}
      </text>
    </svg>
  );
}

function Dot({ color, pulse }) {
  return (
    <span style={{ width: 7, height: 7, borderRadius: "50%", background: color,
      boxShadow: `0 0 6px ${color}`, display: "inline-block",
      animation: pulse ? "pulse 1.5s ease-in-out infinite" : "none" }}/>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function App() {
  const [connected, setConnected]         = useState(false);
  const [wsStatus, setWsStatus]           = useState(false);
  const [wallets, setWallets]             = useState([]);
  const [markets, setMarkets]             = useState([]);
  const [signals, setSignals]             = useState([]);
  const [autoTrades, setAutoTrades]       = useState([]);
  const [autoEnabled, setAutoEnabled]     = useState(false);
  const [hasPrivateKey, setHasPrivateKey] = useState(false);
  const [lastScan, setLastScan]           = useState(null);
  const [scanning, setScanning]           = useState(false);
  const [filter, setFilter]               = useState("ALL");
  const [sortBy, setSortBy]               = useState("score");
  const [selectedWallet, setSelectedWallet] = useState(null);
  const [customAddr, setCustomAddr]       = useState("");
  const [log, setLog]                     = useState([]);
  const [tab, setTab]                     = useState("wallets"); // wallets | markets | trades
  const socketRef = useRef(null);

  const addLog = useCallback(msg => {
    setLog(l => [`[${new Date().toLocaleTimeString()}] ${msg}`, ...l].slice(0, 50));
  }, []);

  // ── Socket connection ──────────────────────────────────────────────────────
  useEffect(() => {
    const sock = io(SERVER, { transports: ["websocket"] });
    socketRef.current = sock;

    sock.on("connect",    () => { setConnected(true);  addLog("✓ Connected to POLYTRACK server"); });
    sock.on("disconnect", () => { setConnected(false); addLog("✗ Disconnected from server"); });

    sock.on("init", data => {
      setWallets(data.wallets || []);
      setMarkets(data.markets || []);
      setSignals(data.signals || []);
      setAutoTrades(data.autoTrades || []);
      setAutoEnabled(data.autoEnabled || false);
      setHasPrivateKey(data.hasPrivateKey || false);
      setLastScan(data.lastScan);
      addLog(`Init: ${(data.wallets||[]).length} wallets, ${(data.signals||[]).length} signals`);
    });

    sock.on("wallet:update", w => {
      setWallets(prev => {
        const idx = prev.findIndex(x => x.addr === w.addr);
        return idx >= 0 ? prev.map((x, i) => i === idx ? w : x) : [...prev, w];
      });
      addLog(`↻ ${shortAddr(w.addr)} score=${w.score} tier=${w.tier}`);
    });

    sock.on("markets",  m => setMarkets(m));
    sock.on("signals",  s => { setSignals(s); if (s.length) addLog(`⚡ ${s.length} signal(s) detected`); });
    sock.on("trade:executed", t => {
      setAutoTrades(prev => [t, ...prev].slice(0, 50));
      addLog(`🤖 Trade: [${t.dir}] ${t.title?.slice(0,30)} — $${t.size} — ${t.status}`);
    });
    sock.on("auto:status", ({ enabled }) => setAutoEnabled(enabled));
    sock.on("ws:status",   ({ connected }) => setWsStatus(connected));
    sock.on("scan:start",  () => setScanning(true));
    sock.on("scan:complete", d => {
      setScanning(false);
      setLastScan(new Date(d.ts));
      addLog(`✓ Scan done: ${d.wallets} wallets, ${d.signals} signals`);
    });
    sock.on("scan:wallet", ({ addr, status, message }) => {
      if (status === "error") addLog(`✗ ${shortAddr(addr)}: ${message}`);
    });
    sock.on("scan:error", ({ message }) => {
      setScanning(false);
      addLog(`✗ Scan error: ${message}`);
    });
    sock.on("market:update", msg => addLog(`📊 Price update: ${JSON.stringify(msg).slice(0,60)}`));

    return () => sock.disconnect();
  }, [addLog]);

  const toggleAuto = () => {
    const next = !autoEnabled;
    setAutoEnabled(next);
    socketRef.current?.emit("auto:toggle", { enabled: next });
  };

  const triggerScan = () => {
    socketRef.current?.emit("scan:trigger");
    addLog("Manual scan triggered…");
  };

  const addWallet = () => {
    const addr = customAddr.trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) return;
    socketRef.current?.emit("wallet:add", { addr });
    addLog(`Adding wallet ${shortAddr(addr)}…`);
    setCustomAddr("");
  };

  const manualTrade = async (signal) => {
    try {
      const r = await fetch(`${SERVER}/trade`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conditionId: signal.conditionId, dir: signal.dir }),
      });
      const result = await r.json();
      addLog(`Manual trade submitted: ${result.status}`);
    } catch (e) {
      addLog(`Trade error: ${e.message}`);
    }
  };

  // ─── Sorted wallets ──────────────────────────────────────────────────────
  const sorted = [...wallets]
    .filter(w => filter === "ALL" || w.tier === filter)
    .sort((a, b) =>
      sortBy === "score"   ? b.score - a.score :
      sortBy === "winRate" ? b.winRate - a.winRate :
      sortBy === "roi"     ? b.roi - a.roi :
      b.timing - a.timing
    );

  const tierColor = t => t === "ELITE" ? "#00ff9d" : t === "PRO" ? "#ffc740" : "#4b5563";
  const tradeStatusColor = s =>
    s === "SUBMITTED" || s === "MATCHED" || s === "MINED" ? "#00ff9d" :
    s === "SIMULATED" ? "#ffc740" : "#ff5f57";

  return (
    <div style={{ minHeight: "100vh", background: "#060c16", color: "#e2e8f0",
      fontFamily: "'JetBrains Mono', monospace",
      backgroundImage: "radial-gradient(ellipse at 15% 10%, #091525 0%, #060c16 60%)" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&family=Syne:wght@700;800&display=swap');
        ::-webkit-scrollbar{width:3px}::-webkit-scrollbar-track{background:#060c16}::-webkit-scrollbar-thumb{background:#152035}
        .wrow{transition:background 0.1s;border-left:2px solid transparent;cursor:pointer}
        .wrow:hover{background:#09141f!important}
        .wrow.sel{background:#0b1a2b!important;border-left-color:#00ff9d!important}
        .btn{border:none;cursor:pointer;transition:all 0.15s;font-family:inherit}
        .pill{padding:1px 7px;border-radius:3px;font-size:9px;font-weight:700;letter-spacing:0.5px}
        .tab-btn{background:none;border:none;cursor:pointer;font-family:inherit;font-size:10px;letter-spacing:1px;padding:6px 14px;color:#374151;border-bottom:2px solid transparent;transition:all 0.15s}
        .tab-btn.a{color:#00ff9d;border-bottom-color:#00ff9d}
        .tab-btn:hover{color:#64748b}
        @keyframes spin{to{transform:rotate(360deg)}}
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
        @keyframes slideIn{from{opacity:0;transform:translateX(-8px)}to{opacity:1;transform:translateX(0)}}
        .slide{animation:slideIn 0.3s ease}
        input{background:#080f1c;border:1px solid #1a2540;color:#e2e8f0;font-family:inherit;font-size:11px;padding:6px 10px;border-radius:4px;outline:none;width:100%}
        input:focus{border-color:#00ff9d44}
        input::placeholder{color:#1e3048}
      `}</style>

      {/* ── Header ── */}
      <div style={{ borderBottom: "1px solid #0f1e30", padding: "12px 22px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Dot color={connected ? "#00ff9d" : "#ff5f57"} pulse={connected}/>
            <span style={{ fontFamily: "'Syne', sans-serif", fontSize: 17, fontWeight: 800, letterSpacing: 2, color: "#fff" }}>POLYTRACK</span>
          </div>
          <div style={{ display: "flex", gap: 14, fontSize: 9 }}>
            <span style={{ color: connected ? "#00ff9d" : "#ff5f57" }}>● SERVER {connected ? "LIVE" : "OFFLINE"}</span>
            <span style={{ color: wsStatus ? "#00ff9d" : "#374151" }}>● POLY-WS {wsStatus ? "LIVE" : "—"}</span>
            <span style={{ color: hasPrivateKey ? "#00ff9d" : "#ffc740" }}>
              ● {hasPrivateKey ? "REAL TRADES" : "SIMULATED"}
            </span>
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
          {lastScan && <span style={{ fontSize: 9, color: "#1e3048" }}>scan {timeAgo(new Date(lastScan).getTime())}</span>}
          <button className="btn" onClick={triggerScan} disabled={scanning} style={{
            background: "#0a1525", border: "1px solid #1a2540", color: scanning ? "#374151" : "#64748b",
            padding: "5px 10px", borderRadius: 4, fontSize: 9, letterSpacing: 1,
          }}>
            {scanning ? <><span style={{ display: "inline-block", width: 8, height: 8, border: "2px solid #1a2540", borderTop: "2px solid #00ff9d", borderRadius: "50%", animation: "spin 0.7s linear infinite", marginRight: 4 }}/> SCANNING</> : "↺ RESCAN"}
          </button>

          {/* Stats */}
          {[["WALLETS", wallets.length, "#64748b"], ["SIGNALS", signals.length, signals.length > 0 ? "#00ff9d" : "#374151"], ["TRADES", autoTrades.length, "#ffc740"]].map(([l, v, c]) => (
            <div key={l} style={{ textAlign: "right" }}>
              <div style={{ fontSize: 8, color: "#1e3048", letterSpacing: 1 }}>{l}</div>
              <div style={{ fontSize: 15, fontWeight: 700, color: c }}>{v}</div>
            </div>
          ))}

          {/* Auto-copy toggle */}
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
            <div style={{ fontSize: 8, color: autoEnabled ? "#00ff9d" : "#374151", letterSpacing: 1 }}>AUTO-COPY</div>
            <div onClick={toggleAuto} style={{
              width: 42, height: 22, borderRadius: 11, background: autoEnabled ? "#00ff9d15" : "#090f1c",
              border: `1px solid ${autoEnabled ? "#00ff9d" : "#1a2540"}`,
              cursor: "pointer", position: "relative", transition: "all 0.25s",
              boxShadow: autoEnabled ? "0 0 12px rgba(0,255,157,.2)" : "none",
            }}>
              <div style={{
                position: "absolute", top: 3, left: autoEnabled ? 21 : 3,
                width: 14, height: 14, borderRadius: "50%",
                background: autoEnabled ? "#00ff9d" : "#1e3048",
                transition: "all 0.25s", boxShadow: autoEnabled ? "0 0 6px #00ff9d" : "none",
              }}/>
            </div>
          </div>
        </div>
      </div>

      {/* ── Main layout ── */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 290px", height: "calc(100vh - 57px)" }}>

        {/* LEFT: tabs */}
        <div style={{ display: "flex", flexDirection: "column", overflow: "hidden", borderRight: "1px solid #0f1e30" }}>

          {/* Tab bar + controls */}
          <div style={{ borderBottom: "1px solid #0f1e30", display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 16px" }}>
            <div>
              {[["wallets","WALLETS"], ["markets","MARKETS"], ["trades","TRADES"]].map(([k,l]) => (
                <button key={k} className={`tab-btn ${tab===k?"a":""}`} onClick={() => setTab(k)}>{l}</button>
              ))}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              {tab === "wallets" && (
                <>
                  {["ALL","ELITE","PRO","BASIC"].map(f => (
                    <button key={f} className="btn" onClick={() => setFilter(f)} style={{
                      fontSize: 9, padding: "2px 7px", borderRadius: 3, letterSpacing: 1,
                      background: filter===f ? "#00ff9d12" : "transparent",
                      color: filter===f ? "#00ff9d" : "#374151",
                      border: `1px solid ${filter===f ? "#00ff9d30" : "#0f1e30"}`,
                    }}>{f}</button>
                  ))}
                  <span style={{ color: "#1a2540", fontSize: 9 }}>|</span>
                  {["score","winRate","roi","timing"].map(s => (
                    <button key={s} className="btn" onClick={() => setSortBy(s)} style={{
                      fontSize: 9, padding: "2px 7px", borderRadius: 3,
                      background: sortBy===s ? "#00ff9d12" : "transparent",
                      color: sortBy===s ? "#00ff9d" : "#374151",
                      border: `1px solid ${sortBy===s ? "#00ff9d30" : "#0f1e30"}`,
                    }}>{s.toUpperCase()}</button>
                  ))}
                </>
              )}
            </div>
          </div>

          {/* ── WALLETS tab ── */}
          {tab === "wallets" && (
            <>
              {/* Add wallet */}
              <div style={{ padding: "10px 16px", borderBottom: "1px solid #0f1e30", display: "flex", gap: 8 }}>
                <input value={customAddr} onChange={e => setCustomAddr(e.target.value)} placeholder="Add wallet address: 0x…" onKeyDown={e => e.key === "Enter" && addWallet()} style={{ flex: 1 }}/>
                <button className="btn" onClick={addWallet} style={{ background: "#00ff9d12", border: "1px solid #00ff9d30", color: "#00ff9d", padding: "6px 12px", borderRadius: 4, fontSize: 10 }}>+ ADD</button>
              </div>

              {/* Table header */}
              <div style={{ display: "grid", gridTemplateColumns: "28px 1fr 52px 56px 68px 62px 62px", padding: "6px 16px", fontSize: 8, color: "#1e3048", letterSpacing: 1, borderBottom: "1px solid #0a1424" }}>
                <span>#</span><span>WALLET</span><span>TIER</span><span>SCORE</span><span>WIN%</span><span>ROI%</span><span>TIMING</span>
              </div>

              {/* Rows */}
              <div style={{ overflowY: "auto", flex: 1 }}>
                {sorted.length === 0 && <div style={{ padding: "20px 16px", fontSize: 11, color: "#1a2540" }}>{wallets.length === 0 ? "Connecting to server…" : "No wallets match filter"}</div>}
                {sorted.map((w, i) => (
                  <div key={w.addr} className={`wrow ${selectedWallet?.addr === w.addr ? "sel" : ""}`}
                    onClick={() => setSelectedWallet(selectedWallet?.addr === w.addr ? null : w)}
                    style={{ display: "grid", gridTemplateColumns: "28px 1fr 52px 56px 68px 62px 62px", padding: "8px 16px", borderBottom: "1px solid #07101a", alignItems: "center" }}>
                    <span style={{ fontSize: 9, color: "#1e3048" }}>{i+1}</span>
                    <div>
                      <div style={{ fontSize: 11, color: "#4b5563" }}>{shortAddr(w.addr)}</div>
                      <div style={{ fontSize: 8, color: "#1e3048", marginTop: 1 }}>{w.trades} trades · {fmtUSDC(w.volume)}</div>
                    </div>
                    <span className="pill" style={{ background: `${tierColor(w.tier)}18`, color: tierColor(w.tier) }}>{w.tier}</span>
                    <ScoreRing score={w.score}/>
                    <div style={{ fontSize: 11, color: w.winRate > 60 ? "#00ff9d" : w.winRate > 50 ? "#ffc740" : "#ff5f57" }}>{fmt(w.winRate, 1)}%</div>
                    <div style={{ fontSize: 11, color: w.roi > 0 ? "#00ff9d" : "#ff5f57" }}>{w.roi > 0 ? "+" : ""}{fmt(w.roi, 1)}%</div>
                    <div style={{ fontSize: 11, color: "#4b5563" }}>{w.timing}/100</div>
                  </div>
                ))}
              </div>

              {/* Selected wallet detail */}
              {selectedWallet && (
                <div style={{ background: "#050b15", borderTop: "1px solid #0f1e30", maxHeight: 200, overflowY: "auto" }}>
                  <div style={{ padding: "9px 16px 5px", fontSize: 9, color: "#00ff9d", letterSpacing: 2 }}>▸ {shortAddr(selectedWallet.addr)} — POSITIONS</div>
                  {(selectedWallet.positions || []).length === 0 && <div style={{ padding: "4px 16px 10px", fontSize: 10, color: "#1a2540" }}>No open positions found</div>}
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6, padding: "0 16px 10px" }}>
                    {(selectedWallet.positions || []).slice(0, 12).map((p, i) => (
                      <div key={i} style={{ background: "#080f1c", border: "1px solid #111d2e", borderLeft: `2px solid ${p.outcome==="Yes"?"#00ff9d":"#ff5f57"}`, borderRadius: 4, padding: "5px 8px", minWidth: 128 }}>
                        <div style={{ fontSize: 8, color: "#374151", marginBottom: 3, maxWidth: 130, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.title?.slice(0, 34)}</div>
                        <div style={{ display: "flex", justifyContent: "space-between" }}>
                          <span className="pill" style={{ background: p.outcome==="Yes"?"#00ff9d18":"#ff5f5718", color: p.outcome==="Yes"?"#00ff9d":"#ff5f57" }}>{p.outcome}</span>
                          <span style={{ fontSize: 9, color: "#374151" }}>{fmtUSDC(p.currentValue || p.size)}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                  <div style={{ padding: "4px 16px 3px", fontSize: 8, color: "#1e3048", letterSpacing: 2 }}>RECENT TRADES</div>
                  {(selectedWallet.recentTrades || []).map((t, i) => (
                    <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "2px 16px", fontSize: 8, borderBottom: "1px solid #07101a" }}>
                      <span style={{ color: "#374151", maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.title?.slice(0,34)}</span>
                      <span style={{ color: t.side==="BUY"?"#00ff9d":"#ff5f57" }}>{t.side}</span>
                      <span style={{ color: "#374151" }}>{fmt(t.price, 2)}</span>
                      <span style={{ color: "#1e3048" }}>{timeAgo(t.timestamp)}</span>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}

          {/* ── MARKETS tab ── */}
          {tab === "markets" && (
            <div style={{ overflowY: "auto", flex: 1 }}>
              {markets.length === 0 && <div style={{ padding: "20px 16px", fontSize: 11, color: "#1a2540" }}>Loading markets…</div>}
              {markets.map(event => (
                <div key={event.id} style={{ borderBottom: "1px solid #0a1424", padding: "10px 16px" }}>
                  <div style={{ fontSize: 11, color: "#64748b", marginBottom: 6 }}>{event.title?.slice(0, 60)}</div>
                  <div style={{ fontSize: 9, color: "#1e3048", marginBottom: 8 }}>Vol: {fmtUSDC(event.volume)}</div>
                  {(event.markets || []).map(m => {
                    const prices = m.outcomePrices ? JSON.parse(m.outcomePrices) : [0.5, 0.5];
                    const yesP = Number(prices[0] || 0.5);
                    const signal = signals.find(s => s.conditionId === m.conditionId);
                    return (
                      <div key={m.id} style={{ background: "#080f1c", border: `1px solid ${signal ? "#00ff9d30" : "#111d2e"}`, borderRadius: 5, padding: "7px 10px", marginBottom: 5 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                          <div style={{ fontSize: 9, color: "#374151", maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.question || event.title}</div>
                          {signal && <span className="pill" style={{ background: "#00ff9d18", color: "#00ff9d", flexShrink: 0 }}>⚡ SIGNAL</span>}
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
                          <div style={{ flex: 1, height: 4, background: "#111d2e", borderRadius: 2, overflow: "hidden" }}>
                            <div style={{ width: `${yesP * 100}%`, height: "100%", background: `linear-gradient(90deg, #00ff9d, #ffc740)`, borderRadius: 2 }}/>
                          </div>
                          <span style={{ fontSize: 9, color: "#00ff9d", minWidth: 30 }}>YES {Math.round(yesP * 100)}¢</span>
                          <span style={{ fontSize: 9, color: "#ff5f57", minWidth: 30 }}>NO {Math.round((1-yesP)*100)}¢</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          )}

          {/* ── TRADES tab ── */}
          {tab === "trades" && (
            <div style={{ overflowY: "auto", flex: 1 }}>
              {autoTrades.length === 0 && <div style={{ padding: "20px 16px", fontSize: 11, color: "#1a2540" }}>
                {autoEnabled ? "Waiting for consensus signal…" : "Enable AUTO-COPY in the header to start"}
              </div>}
              {autoTrades.map((t, i) => (
                <div key={i} className="slide" style={{ borderBottom: "1px solid #07101a", padding: "10px 16px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 5 }}>
                    <div style={{ fontSize: 10, color: "#64748b", maxWidth: 360, lineHeight: 1.4 }}>{t.title?.slice(0, 60)}</div>
                    <span style={{ fontSize: 8, color: "#1e3048", flexShrink: 0, marginLeft: 8 }}>{timeAgo(t.executedAt || t.ts)}</span>
                  </div>
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <span className="pill" style={{ background: t.dir==="YES"?"#00ff9d18":"#ff5f5718", color: t.dir==="YES"?"#00ff9d":"#ff5f57" }}>{t.dir}</span>
                    <span style={{ fontSize: 9, color: "#ffc740" }}>${t.size} USDC</span>
                    <span className="pill" style={{ background: "#111d2e", color: tradeStatusColor(t.status) }}>{t.status}</span>
                    {t.txHash && <a href={`https://polygonscan.com/tx/${t.txHash}`} target="_blank" rel="noreferrer" style={{ fontSize: 8, color: "#374151", textDecoration: "none" }}>🔗 tx</a>}
                    <span style={{ fontSize: 8, color: "#1e3048" }}>{t.count} wallets</span>
                  </div>
                  {t.error && <div style={{ fontSize: 8, color: "#ff5f57", marginTop: 4 }}>Error: {t.error}</div>}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* RIGHT: Signals + Log */}
        <div style={{ display: "flex", flexDirection: "column", overflow: "hidden" }}>

          {/* Signals */}
          <div style={{ padding: "12px 14px", borderBottom: "1px solid #0f1e30", flex: 1, overflowY: "auto" }}>
            <div style={{ fontSize: 9, color: "#1e3048", letterSpacing: 2, marginBottom: 10 }}>⚡ LIVE CONSENSUS SIGNALS</div>
            {signals.length === 0 ? (
              <div style={{ fontSize: 10, color: "#111d2e", lineHeight: 1.6 }}>
                Watching for 3+ ELITE wallets<br/>aligned on the same market…
              </div>
            ) : signals.map((s, i) => (
              <div key={i} className="slide" style={{
                background: s.dir==="YES" ? "#00ff9d07" : "#ff5f5707",
                border: `1px solid ${s.dir==="YES"?"#00ff9d22":"#ff5f5722"}`,
                borderRadius: 5, padding: "9px 11px", marginBottom: 8,
              }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                  <div style={{ fontSize: 9, color: "#4b5563", maxWidth: 165, lineHeight: 1.4 }}>{s.title?.slice(0, 55)}</div>
                  <span className="pill" style={{ background: s.dir==="YES"?"#00ff9d20":"#ff5f5720", color: s.dir==="YES"?"#00ff9d":"#ff5f57", flexShrink: 0 }}>{s.dir}</span>
                </div>
                <div style={{ fontSize: 8, color: "#374151", marginTop: 5, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span>{s.count} ELITE wallets · {timeAgo(s.ts)}</span>
                  <button className="btn" onClick={() => manualTrade(s)} style={{
                    background: "#00ff9d12", border: "1px solid #00ff9d30", color: "#00ff9d",
                    padding: "2px 7px", borderRadius: 3, fontSize: 8, letterSpacing: 1,
                  }}>COPY</button>
                </div>
              </div>
            ))}
          </div>

          {/* Log */}
          <div style={{ height: 180, display: "flex", flexDirection: "column", borderTop: "1px solid #0f1e30" }}>
            <div style={{ padding: "7px 14px 3px", fontSize: 9, color: "#1e3048", letterSpacing: 2 }}>SERVER LOG</div>
            <div style={{ overflowY: "auto", flex: 1, padding: "0 14px 8px" }}>
              {log.map((l, i) => (
                <div key={i} style={{ fontSize: 8, color: i===0?"#374151":"#111d2e", padding: "1px 0", fontFamily: "monospace" }}>{l}</div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
