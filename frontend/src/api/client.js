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
    // Only broadcast "your session is invalid" if we actually attached a
    // token. A 401 on a request that sent no token just means the user
    // isn't logged in yet — the modal is already visible from initial
    // mount, no need to flash an error.
    //
    // Critical: this also fixes the "login twice" race. Background queries
    // started before the user typed their password fly off without a token,
    // come back 401 *after* setToken/login completes, and used to reopen
    // the freshly-closed modal. Suppressing the event when there was no
    // token kills that race without needing AbortSignal plumbing.
    if (token) {
      window.dispatchEvent(new CustomEvent(AUTH_EVENT, {
        detail: { reason: "session" },
      }));
    }
    throw new UnauthorizedError();
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

/**
 * Programmatic logout — clears the token and tells the LoginModal to open
 * with a clean (non-error) state. Use this instead of dispatching the
 * auth-required event yourself, otherwise the modal flashes "Session
 * expired" even though the user just clicked Sign out.
 */
export function signOutAndPromptLogin() {
  setToken("");
  window.dispatchEvent(new CustomEvent(AUTH_EVENT, {
    detail: { reason: "logout" },
  }));
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
  deleteWallet:    (addr)  => request(`/wallets/${addr}`, { method: "DELETE" }),
  restoreWallet:   (addr)  => request(`/wallets/${addr}/restore`, { method: "POST" }),
  listBlacklisted: ()      => request("/wallets/blacklisted"),
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

  // PR B — auto-import via cron (admin only)
  runAutoImport:    ()      => request("/import/run", { method: "POST" }),

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
