/**
 * Monitoring / Error Tracking
 * ───────────────────────────
 * Optional Sentry integration. Activates only when SENTRY_DSN env var is set —
 * otherwise all helpers are safe no-ops, and @sentry/node is not required at
 * install time (dynamic import on demand).
 *
 * Also provides a process-wide safety net: uncaughtException and
 * unhandledRejection handlers that log + capture without crashing the
 * trade loop. The last-resort fatal path still exits (via PM2/Docker restart)
 * for errors that Node cannot safely recover from.
 */

import log from "./logger.js";

let Sentry = null;
let enabled = false;

/**
 * Initialize Sentry if SENTRY_DSN is configured. Safe to call multiple times.
 * Returns true if Sentry is active, false if running in no-op mode.
 */
export async function initMonitoring({ release, environment } = {}) {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    log.info("Monitoring: Sentry disabled (no SENTRY_DSN)");
    installProcessHandlers();
    return false;
  }

  try {
    Sentry = await import("@sentry/node");
    Sentry.init({
      dsn,
      environment: environment || process.env.NODE_ENV || "production",
      release: release || process.env.npm_package_version,
      tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE || 0.1),
      // Don't send health-check noise
      beforeSend(event, hint) {
        const err = hint?.originalException;
        if (err && /ECONNRESET|ETIMEDOUT|ENETUNREACH/.test(String(err.message))) {
          // Transient network errors to Polymarket — already counted by circuit breaker
          return null;
        }
        return event;
      },
    });
    enabled = true;
    log.info(`Monitoring: Sentry initialized (env=${environment || process.env.NODE_ENV})`);
  } catch (e) {
    log.warn({ err: e.message }, "Monitoring: Sentry init failed, continuing without");
    Sentry = null;
    enabled = false;
  }

  installProcessHandlers();
  return enabled;
}

/**
 * Capture a non-fatal exception. Always logs; forwards to Sentry if enabled.
 */
export function captureException(err, context = {}) {
  log.error({ err: err?.message, stack: err?.stack, ...context }, "Captured exception");
  if (enabled && Sentry) {
    try {
      Sentry.captureException(err, { extra: context });
    } catch {/* never throw from telemetry */}
  }
}

/**
 * Capture a structured message (warning or info-level alert).
 */
export function captureMessage(message, level = "info", context = {}) {
  log[level === "error" ? "error" : level === "warn" ? "warn" : "info"]({ ...context }, message);
  if (enabled && Sentry) {
    try {
      Sentry.captureMessage(message, { level, extra: context });
    } catch {/* swallow */}
  }
}

/**
 * Tag the current scope with a persistent context key (e.g. wallet address,
 * trade ID) so subsequent captures carry this metadata.
 */
export function setContext(key, value) {
  if (enabled && Sentry) {
    try { Sentry.setContext(key, value); } catch {/* swallow */}
  }
}

/**
 * Flush in-flight Sentry events before shutdown. Should be awaited in SIGINT
 * handler. Returns within `timeoutMs` regardless of completion.
 */
export async function flushMonitoring(timeoutMs = 3000) {
  if (!enabled || !Sentry) return;
  try { await Sentry.flush(timeoutMs); } catch {/* swallow */}
}

// ── Process-level safety net ─────────────────────────────────────────────────

let handlersInstalled = false;
function installProcessHandlers() {
  if (handlersInstalled) return;
  handlersInstalled = true;

  process.on("uncaughtException", (err) => {
    captureException(err, { source: "uncaughtException" });
    // Give Sentry a moment to flush, then exit so PM2/Docker restarts us.
    setTimeout(() => process.exit(1), 1500);
  });

  process.on("unhandledRejection", (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    captureException(err, { source: "unhandledRejection" });
    // Unhandled rejections don't auto-crash the process; we log + continue.
  });
}
