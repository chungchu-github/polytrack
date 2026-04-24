/**
 * PM2 Process Config — Polytrack
 * ──────────────────────────────
 * Usage:
 *   pm2 start ecosystem.config.cjs                        # start
 *   pm2 logs polytrack                                    # tail logs
 *   pm2 restart polytrack                                 # restart
 *   pm2 save && pm2 startup                               # persist across reboots
 *
 * Notes:
 *  - cluster mode is NOT used: polytrack holds an in-memory signal store and
 *    a single Polymarket WebSocket connection, so multiple instances would
 *    duplicate trades. Fork mode with 1 instance is correct.
 *  - max_memory_restart guards against runaway memory (e.g. SQLite WAL bloat).
 *  - PM2 restarts on crash automatically; exponential_backoff_restart_delay
 *    prevents tight crash loops from thrashing the Polymarket APIs.
 */

module.exports = {
  apps: [
    {
      name: "polytrack",
      script: "src/server.js",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_memory_restart: "512M",
      exponential_backoff_restart_delay: 2000,
      kill_timeout: 10000,       // give SIGINT 10s to flush DB and close sockets
      wait_ready: false,
      env: {
        NODE_ENV: "production",
        PORT: 3000,
        HOST: "0.0.0.0",
      },
      env_development: {
        NODE_ENV: "development",
        LOG_LEVEL: "debug",
      },
      error_file: "./data/logs/err.log",
      out_file:   "./data/logs/out.log",
      merge_logs: true,
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
    },
  ],
};
