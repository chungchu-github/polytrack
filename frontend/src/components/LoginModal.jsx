import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { setToken, hasToken } from "../api/client.js";

/**
 * Token gate. Shown when:
 *   1. No token in localStorage on first mount
 *   2. Any API call dispatches "polytrack:auth-required" (HTTP 401)
 *
 * After a successful save, invalidates every React Query cache so all
 * pages refetch with the new token rather than reloading the whole app.
 */
export default function LoginModal() {
  const qc = useQueryClient();
  const [open, setOpen]       = useState(() => !hasToken());
  const [value, setValue]     = useState("");
  const [error, setError]     = useState("");
  const [busy, setBusy]       = useState(false);

  useEffect(() => {
    function onAuthRequired() {
      setError("Token rejected — re-enter the API_TOKEN from your VPS .env.");
      setOpen(true);
    }
    window.addEventListener("polytrack:auth-required", onAuthRequired);
    return () => window.removeEventListener("polytrack:auth-required", onAuthRequired);
  }, []);

  async function submit(e) {
    e.preventDefault();
    const trimmed = value.trim();
    if (!trimmed) {
      setError("Token is required.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      // Probe a protected endpoint to validate before we commit.
      const res = await fetch("/wallets", {
        headers: { Authorization: `Bearer ${trimmed}` },
      });
      if (res.status === 401) {
        setError("Server rejected the token. Check it matches .env on the VPS.");
        setBusy(false);
        return;
      }
      if (!res.ok) {
        setError(`Server returned HTTP ${res.status}. Try again.`);
        setBusy(false);
        return;
      }
      setToken(trimmed);
      setOpen(false);
      setValue("");
      // Refresh every cached query so the UI redraws with authorised data.
      qc.invalidateQueries();
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
            ◆ AUTHENTICATE
          </h2>
          <p className="text-2xs text-surface-500 mt-1">
            Paste the API_TOKEN from your server's <code>.env</code>.
          </p>
        </div>

        <div className="space-y-1">
          <label className="text-2xs uppercase tracking-wider text-surface-400">
            API Token
          </label>
          <input
            type="password"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            autoFocus
            disabled={busy}
            placeholder="64-character hex string"
            className="w-full px-3 py-2 rounded-md bg-surface-900 border border-surface-700 text-surface-100 font-mono text-sm focus:outline-none focus:border-primary disabled:opacity-50"
          />
        </div>

        {error && (
          <div className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2">
            <p className="text-xs text-danger">{error}</p>
          </div>
        )}

        <button
          type="submit"
          disabled={busy || !value.trim()}
          className="w-full px-4 py-2 rounded-md bg-primary text-surface-950 font-semibold text-sm hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {busy ? "Verifying…" : "Sign in"}
        </button>

        <p className="text-2xs text-surface-600 text-center">
          Token is stored in localStorage. Clear it via DevTools to log out.
        </p>
      </form>
    </div>
  );
}
