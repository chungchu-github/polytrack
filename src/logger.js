/**
 * Structured Logger (Pino)
 * ────────────────────────
 * JSON output in production, pretty-printed in development.
 * Child loggers for subsystems (trading, scanning, ws).
 */

import pino from "pino";

const isDev = process.env.NODE_ENV !== "production";

const logger = pino({
  level: process.env.LOG_LEVEL || (isDev ? "debug" : "info"),
  ...(isDev && {
    transport: {
      target: "pino-pretty",
      options: {
        colorize: true,
        translateTime: "HH:MM:ss",
        ignore: "pid,hostname",
      },
    },
  }),
});

// ── Child Loggers ────────────────────────────────────────────────────────────
export const log = {
  // General purpose
  info:  (...args) => logger.info(args.join(" ")),
  ok:    (...args) => logger.info("✓ " + args.join(" ")),
  warn:  (...args) => logger.warn("⚠ " + args.join(" ")),
  error: (...args) => logger.error("✗ " + args.join(" ")),
  debug: (...args) => logger.debug(args.join(" ")),

  // Subsystem loggers (include module context in JSON output)
  trade: (...args) => logger.child({ module: "trading" }).info(args.join(" ")),
  scan:  (...args) => logger.child({ module: "scan" }).info(args.join(" ")),
  ws:    (...args) => logger.child({ module: "ws" }).info(args.join(" ")),
  db:    (...args) => logger.child({ module: "db" }).info(args.join(" ")),
};

// Export raw pino instance for pino-http middleware
export { logger };
export default log;
