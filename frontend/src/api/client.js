const BASE = "";

function getToken() {
  return localStorage.getItem("polytrack_token") || "";
}

export function setToken(token) {
  localStorage.setItem("polytrack_token", token);
}

async function request(path, opts = {}) {
  const token = getToken();
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(opts.headers || {}),
    },
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

export const api = {
  getHealth:   ()          => request("/health"),
  getWallets:  ()          => request("/wallets"),
  addWallet:   (addr)      => request("/wallets", { method: "POST", body: JSON.stringify({ addr }) }),
  getMarkets:  ()          => request("/markets"),
  getSignals:  ()          => request("/signals"),
  getTrades:   ()          => request("/trades"),
  setAuto:     (enabled)   => request("/auto", { method: "POST", body: JSON.stringify({ enabled }) }),
  triggerScan: ()          => request("/scan", { method: "POST" }),
  manualTrade: (conditionId, dir, size) => request("/trade", { method: "POST", body: JSON.stringify({ conditionId, dir, size }) }),

  // Phase D additions
  getSignalContext: (cid, dir)     => request(`/signals/${cid}/${dir}/context`),
  previewTrade:     (cid, dir, size) => request(`/preview?conditionId=${encodeURIComponent(cid)}&direction=${encodeURIComponent(dir)}&size=${size || ""}`),
  getConfig:        ()              => request("/config"),
  saveConfig:       (patch)         => request("/config", { method: "POST", body: JSON.stringify(patch) }),
  // F3 Backtest endpoints
  runBacktest:     (params) => request("/backtest", { method: "POST", body: JSON.stringify(params) }),
  listBacktests:   ()       => request("/backtests"),
  getBacktest:     (id)     => request(`/backtest/${id}`),
  deleteBacktest:  (id)     => request(`/backtest/${id}`, { method: "DELETE" }),

  // V2 Gate — edge validation across all strategies
  validateEdge:    (params = {}) => request("/validate-edge", {
    method: "POST",
    body: JSON.stringify(params),
  }),

  downloadTradesCsv: async () => {
    const token = getToken();
    const res = await fetch("/trades.csv", {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `polytrack-trades-${Date.now()}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  },
};
