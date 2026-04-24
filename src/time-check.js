/**
 * Clock skew detection.
 *
 * Polymarket CLOB V2 orders use `Date.now()` (ms) as the salt/nonce field —
 * if the server clock drifts more than a few seconds from real time, orders
 * can be silently rejected ("already expired" / "replay protection") without
 * a clear error. This module sanity-checks the system clock once at boot.
 */
import log from "./logger.js";

const SKEW_WARN_THRESHOLD_SEC = 5;

/**
 * Pure helper: classify a skew measurement. Exported for unit testing.
 * @returns {{ skewSec: number, level: "ok" | "warn" }}
 */
export function interpretClockSkew(localMs, serverMs) {
  const skewSec = Math.round((localMs - serverMs) / 1000);
  return {
    skewSec,
    level: Math.abs(skewSec) > SKEW_WARN_THRESHOLD_SEC ? "warn" : "ok",
  };
}

/**
 * Probe a public HTTPS endpoint's `Date` header and compare to local clock.
 * Uses the RTT midpoint (t0+t1)/2 as the local reference to cancel out
 * network latency. Logs a warning above the threshold, info otherwise.
 *
 * Safe to call unconditionally — any network error is logged and swallowed
 * so it never blocks startup.
 */
export async function checkClockSkew(url = "https://www.cloudflare.com/") {
  try {
    const t0 = Date.now();
    const res = await fetch(url, {
      method: "HEAD",
      signal: AbortSignal.timeout(5000),
    });
    const t1 = Date.now();
    const dateHeader = res.headers.get("date");
    if (!dateHeader) {
      log.warn("Clock skew check: probe returned no Date header");
      return null;
    }
    const serverMs = Date.parse(dateHeader);
    if (Number.isNaN(serverMs)) {
      log.warn(`Clock skew check: unparsable Date header "${dateHeader}"`);
      return null;
    }
    const { skewSec, level } = interpretClockSkew((t0 + t1) / 2, serverMs);
    if (level === "warn") {
      log.warn(
        `Clock skew ${skewSec > 0 ? "+" : ""}${skewSec}s detected. ` +
        "Polymarket V2 orders include Date.now() in the signed payload; " +
        "drift >5s can cause silent order rejection. " +
        "Sync NTP (macOS: `sudo sntp -sS pool.ntp.org`, Linux: `sudo chronyc -a makestep`)."
      );
    } else {
      log.info(`Clock skew: ${skewSec}s (ok)`);
    }
    return { skewSec, level };
  } catch (e) {
    log.warn(`Clock skew check failed: ${e.message}`);
    return null;
  }
}
