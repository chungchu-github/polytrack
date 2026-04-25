const BASE = "";
const TOKEN_KEY = "polytrack_token";
const AUTH_EVENT = "polytrack:auth-required";

export function getToken() {
  return localStorage.getItem(TOKEN_KEY) || "";
}

export function setToken(token) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else       localStorage.removeItem(TOKEN_KEY);
}

export function hasToken() {
  return !!getToken();
}

/**
 * Custom error thrown on HTTP 401. Components can `instanceof` against this
 * to distinguish "auth needed" from generic network failures.
 */
export class UnauthorizedError extends Error {
  constructor(message = "Unauthorized") {
    super(message);
    this.name = "UnauthorizedError";
    this.status = 401;
  }
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

  if (res.status === 401) {
    // Broadcast so a global Login modal can prompt for the token without
    // every caller needing to import auth state. Page-level useQuery
    // listeners ignore the event by default — they just see the throw.
    window.dispatchEvent(new CustomEvent(AUTH_EVENT));
    throw new UnauthorizedError();
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

export const api = {
  // Auth (V8 — Phase 1)
  login:           (username, password) => request("/auth/login", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  }),
  logout:          ()          => request("/auth/logout", { method: "POST" }).catch(() => null),
  me:              ()          => request("/auth/me"),
  createInvite:    ()          => request("/auth/invite",       { method: "POST" }),
  listInvites:     ()          => request("/auth/invitations"),
  revokeInvite:    (token)     => request(`/auth/invitations/${token}`, { method: "DELETE" }),

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
  // F2 per-strategy PnL attribution
  getPnlByStrategy: ()      => request("/stats/pnl-by-strategy"),

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
