import { useState } from "react";
import { Outlet, NavLink, useLocation } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client.js";
import { useLiveCache } from "../hooks/useSocket.js";
import clsx from "clsx";

const NAV_ITEMS = [
  { to: "/",         label: "Dashboard", icon: DashboardIcon },
  { to: "/wallets",  label: "Wallets",   icon: WalletIcon },
  { to: "/markets",  label: "Markets",   icon: MarketIcon },
  { to: "/trades",   label: "Trades",    icon: TradeIcon },
  { to: "/risk",     label: "Risk",      icon: RiskIcon },
  { to: "/backtest", label: "Backtest",  icon: BacktestIcon },
  { to: "/settings", label: "Settings",  icon: SettingsIcon },
];

export default function Layout() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();

  // Phase D3 — live cache invalidation via Socket.IO (one shared connection)
  useLiveCache();

  const { data: health } = useQuery({
    queryKey: ["health"],
    queryFn: api.getHealth,
    refetchInterval: 10_000,
  });

  // Close mobile nav on route change
  const handleNavClick = () => setMobileOpen(false);

  return (
    <div className="flex h-dvh overflow-hidden">
      {/* Mobile backdrop */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/50 backdrop-blur-sm lg:hidden animate-fade-in"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* Sidebar — desktop: always visible, mobile: slide-in drawer */}
      <aside
        className={clsx(
          "fixed inset-y-0 left-0 z-40 flex w-56 flex-col border-r border-surface-700 bg-surface-900 transition-transform duration-200 lg:static lg:translate-x-0",
          mobileOpen ? "translate-x-0" : "-translate-x-full"
        )}
      >
        {/* Logo */}
        <div className="flex items-center justify-between px-5 py-5">
          <div className="flex items-center gap-2">
            <div className="h-3 w-3 rounded-full bg-primary animate-pulse-glow" />
            <span className="font-display text-lg font-bold tracking-wider text-primary">
              POLYTRACK
            </span>
          </div>
          {/* Close button (mobile only) */}
          <button
            onClick={() => setMobileOpen(false)}
            className="rounded p-1 text-surface-400 hover:text-surface-200 lg:hidden"
            aria-label="Close menu"
          >
            <CloseIcon className="h-5 w-5" />
          </button>
        </div>

        {/* Nav */}
        <nav className="flex-1 space-y-0.5 px-3 py-2" aria-label="Main navigation">
          {NAV_ITEMS.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={to === "/"}
              onClick={handleNavClick}
              className={({ isActive }) =>
                clsx(
                  "flex items-center gap-3 rounded-md px-3 py-2.5 text-sm font-medium transition-colors",
                  isActive
                    ? "bg-primary/10 text-primary"
                    : "text-surface-400 hover:bg-surface-800 hover:text-surface-200"
                )
              }
            >
              <Icon className="h-4 w-4 shrink-0" />
              {label}
            </NavLink>
          ))}
        </nav>

        {/* Simulation mode warning */}
        {health?.simulationMode && (
          <div className="mx-3 mb-1 rounded-md bg-amber-500/15 border border-amber-500/30 px-3 py-2">
            <p className="text-2xs font-semibold text-amber-400 uppercase tracking-wider">Simulation</p>
            <p className="text-2xs text-amber-400/70 mt-0.5">No real trades</p>
          </div>
        )}

        {/* Status footer */}
        <div className="border-t border-surface-700 px-4 py-3 space-y-1">
          <div className="flex items-center gap-2 text-2xs text-surface-400">
            <span
              className={clsx(
                "h-2 w-2 rounded-full",
                health?.ok ? "bg-success" : "bg-danger"
              )}
            />
            {health?.ok ? "Online" : "Offline"}
            {health?.scanning && (
              <span className="ml-auto text-primary animate-pulse-glow">Scanning…</span>
            )}
          </div>
          <div className="text-2xs text-surface-500 tabular-nums">
            v{health?.version || "—"} · {health?.wallets ?? 0} wallets
          </div>
        </div>
      </aside>

      {/* Main content */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Mobile top bar */}
        <header className="flex items-center gap-3 border-b border-surface-700 bg-surface-900 px-4 py-3 lg:hidden">
          <button
            onClick={() => setMobileOpen(true)}
            className="rounded p-1 text-surface-400 hover:text-surface-200"
            aria-label="Open menu"
          >
            <MenuIcon className="h-5 w-5" />
          </button>
          <div className="flex items-center gap-2">
            <div className="h-2.5 w-2.5 rounded-full bg-primary animate-pulse-glow" />
            <span className="font-display text-sm font-bold tracking-wider text-primary">
              POLYTRACK
            </span>
          </div>
          <div className="ml-auto flex items-center gap-2">
            {health?.simulationMode && (
              <span className="rounded bg-amber-500/15 border border-amber-500/30 px-1.5 py-0.5 text-2xs font-semibold text-amber-400 uppercase">
                Sim
              </span>
            )}
            <span
              className={clsx(
                "h-2 w-2 rounded-full",
                health?.ok ? "bg-success" : "bg-danger"
              )}
            />
            <span className="text-2xs text-surface-400">
              {health?.ok ? "Online" : "Offline"}
            </span>
          </div>
        </header>

        <main className="flex-1 overflow-y-auto bg-surface-950 p-4 sm:p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

/* ── Inline SVG Icons (Lucide-style) ──────────────────────────────────── */

function MenuIcon({ className }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="4" y1="6" x2="20" y2="6" />
      <line x1="4" y1="12" x2="20" y2="12" />
      <line x1="4" y1="18" x2="20" y2="18" />
    </svg>
  );
}

function CloseIcon({ className }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

function DashboardIcon({ className }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
  );
}

function WalletIcon({ className }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12V7H5a2 2 0 0 1 0-4h14v4" />
      <path d="M3 5v14a2 2 0 0 0 2 2h16v-5" />
      <path d="M18 12a2 2 0 0 0 0 4h4v-4Z" />
    </svg>
  );
}

function MarketIcon({ className }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 3v18h18" />
      <path d="m7 16 4-8 4 5 5-6" />
    </svg>
  );
}

function TradeIcon({ className }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m3 17 6-6 4 4 8-8" />
      <path d="M17 7h4v4" />
    </svg>
  );
}

function RiskIcon({ className }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2 2 22h20L12 2z" />
      <line x1="12" y1="9" x2="12" y2="14" />
      <circle cx="12" cy="18" r="0.5" fill="currentColor" />
    </svg>
  );
}

function BacktestIcon({ className }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 3v18h18" />
      <path d="M7 14v4" />
      <path d="M11 10v8" />
      <path d="M15 6v12" />
      <path d="M19 10v8" />
    </svg>
  );
}

function SettingsIcon({ className }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}
