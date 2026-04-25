import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { setToken, hasToken } from "../api/client.js";

/**
 * Username/password gate. Shown when:
 *   1. No JWT in localStorage on first mount
 *   2. Any API call dispatches "polytrack:auth-required" (HTTP 401)
 *
 * On successful login we save the JWT, close, and reset every cached
 * query so all pages refetch with the new token.
 */
export default function LoginModal() {
  const qc = useQueryClient();
  const [open, setOpen]     = useState(() => !hasToken());
  const [username, setU]    = useState("");
  const [password, setP]    = useState("");
  const [error, setError]   = useState("");
  const [busy, setBusy]     = useState(false);

  useEffect(() => {
    function onAuthRequired(e) {
      // Only flash the red error when the modal is reopening because a
      // token was rejected mid-session. If the user just signed out (or
      // any caller without a reason), no error message — the modal opens
      // clean.
      const reason = e?.detail?.reason;
      if (reason === "session") {
        setError("Session expired or invalid — please sign in again.");
      } else {
        setError("");
      }
      setOpen(true);
    }
    window.addEventListener("polytrack:auth-required", onAuthRequired);
    return () => window.removeEventListener("polytrack:auth-required", onAuthRequired);
  }, []);

  async function submit(e) {
    e.preventDefault();
    if (!username.trim() || !password) {
      setError("Username and password are required.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: username.trim(), password }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.error || `Login failed (HTTP ${res.status})`);
        setBusy(false);
        return;
      }
      setToken(body.token);

      // Belt + suspenders against the "login twice" race. The primary fix
      // lives in api/client.js (request() no longer dispatches
      // auth-required for 401s on no-token requests, so background queries
      // that flew off before login can't reopen us). cancelQueries kills
      // anything still in-flight; removeQueries clears any queries that
      // already resolved into error state with the old token.
      await qc.cancelQueries();
      qc.removeQueries();

      setOpen(false);
      setU(""); setP(""); setBusy(false);
    } catch (e) {
      setError(`Network error: ${e.message}`);
      setBusy(false);
    }
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm animate-fade-in">
      <form
        onSubmit={submit}
        className="card w-full max-w-md mx-4 space-y-4 border border-surface-700"
      >
        <div>
          <h2 className="font-display text-lg font-bold tracking-wider text-primary">
            ◆ SIGN IN
          </h2>
          <p className="text-2xs text-surface-500 mt-1">
            Username and password set by your admin.
          </p>
        </div>

        <div className="space-y-1">
          <label className="text-2xs uppercase tracking-wider text-surface-400">Username</label>
          <input
            type="text"
            value={username}
            onChange={(e) => setU(e.target.value)}
            autoFocus
            disabled={busy}
            autoComplete="username"
            className="w-full px-3 py-2 rounded-md bg-surface-900 border border-surface-700 text-surface-100 text-sm focus:outline-none focus:border-primary disabled:opacity-50"
          />
        </div>

        <div className="space-y-1">
          <label className="text-2xs uppercase tracking-wider text-surface-400">Password</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setP(e.target.value)}
            disabled={busy}
            autoComplete="current-password"
            className="w-full px-3 py-2 rounded-md bg-surface-900 border border-surface-700 text-surface-100 text-sm focus:outline-none focus:border-primary disabled:opacity-50"
          />
        </div>

        {error && (
          <div className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2">
            <p className="text-xs text-danger">{error}</p>
          </div>
        )}

        <button
          type="submit"
          disabled={busy || !username.trim() || !password}
          className="w-full px-4 py-2 rounded-md bg-primary text-surface-950 font-semibold text-sm hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {busy ? "Signing in…" : "Sign in"}
        </button>

        <p className="text-2xs text-surface-600 text-center">
          No account? Ask the admin for an invite link.
        </p>
      </form>
    </div>
  );
}
