import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { setToken } from "../api/client.js";

/**
 * Invite-gated registration page. Reads ?invite=<token> from the URL,
 * collects username + password, posts to /auth/register, stores the JWT,
 * and redirects to the dashboard.
 */
export default function RegisterPage() {
  const navigate = useNavigate();
  const [search] = useSearchParams();
  const inviteToken = search.get("invite") || "";

  const [username, setU] = useState("");
  const [password, setP] = useState("");
  const [confirm,  setC] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy]   = useState(false);

  async function submit(e) {
    e.preventDefault();
    setError("");
    if (!inviteToken)  return setError("This page requires an ?invite=… URL.");
    if (!username.trim() || !password) return setError("All fields required.");
    if (password.length < 8)           return setError("Password must be at least 8 characters.");
    if (password !== confirm)          return setError("Passwords do not match.");

    setBusy(true);
    try {
      const res = await fetch("/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          invite_token: inviteToken,
          username: username.trim(),
          password,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.error || `Registration failed (HTTP ${res.status})`);
        setBusy(false);
        return;
      }
      setToken(body.token);
      navigate("/", { replace: true });
    } catch (e) {
      setError(`Network error: ${e.message}`);
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-surface-950 p-4">
      <form onSubmit={submit} className="card w-full max-w-md space-y-4 border border-surface-700">
        <div>
          <h1 className="font-display text-xl font-bold tracking-wider text-primary">
            ◆ POLYTRACK · REGISTER
          </h1>
          <p className="text-2xs text-surface-500 mt-1">
            {inviteToken
              ? <>Invite token: <code className="text-surface-400">{inviteToken.slice(0, 8)}…</code></>
              : <span className="text-danger">No invite token in URL.</span>}
          </p>
        </div>

        <Field label="Username" type="text"     value={username} onChange={setU} disabled={busy} autoFocus />
        <Field label="Password" type="password" value={password} onChange={setP} disabled={busy} hint="at least 8 characters" />
        <Field label="Confirm"  type="password" value={confirm}  onChange={setC} disabled={busy} />

        {error && (
          <div className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2">
            <p className="text-xs text-danger">{error}</p>
          </div>
        )}

        <button
          type="submit"
          disabled={busy || !inviteToken}
          className="w-full px-4 py-2 rounded-md bg-primary text-surface-950 font-semibold text-sm hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {busy ? "Creating account…" : "Create account"}
        </button>
      </form>
    </div>
  );
}

function Field({ label, type, value, onChange, disabled, autoFocus, hint }) {
  return (
    <div className="space-y-1">
      <label className="text-2xs uppercase tracking-wider text-surface-400">{label}</label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        autoFocus={autoFocus}
        className="w-full px-3 py-2 rounded-md bg-surface-900 border border-surface-700 text-surface-100 text-sm focus:outline-none focus:border-primary disabled:opacity-50"
      />
      {hint && <p className="text-2xs text-surface-600">{hint}</p>}
    </div>
  );
}
