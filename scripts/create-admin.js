#!/usr/bin/env node
/**
 * Bootstrap an admin user. Bypasses the invite flow because there's no
 * admin yet to send an invite. Idempotent on (username) — fails if it
 * already exists rather than silently overwriting.
 *
 * Usage:
 *   node scripts/create-admin.js <username> <password>
 *
 * Requires JWT_SECRET in .env when run with NODE_ENV=production (so the
 * very first hash uses the real secret) — otherwise the dev fallback is
 * fine for local DBs.
 */
import "dotenv/config";
import { initDB, closeDB, createUser, getUserByUsername, countUsers } from "../src/db.js";
import { hashPassword } from "../src/auth.js";

async function main() {
  const [, , username, password] = process.argv;
  if (!username || !password) {
    console.error("Usage: node scripts/create-admin.js <username> <password>");
    process.exit(1);
  }
  if (password.length < 8) {
    console.error("Password must be at least 8 characters.");
    process.exit(1);
  }

  initDB();

  if (getUserByUsername(username)) {
    console.error(`User "${username}" already exists. Pick a different name or delete it from the DB.`);
    closeDB();
    process.exit(1);
  }

  const role = countUsers() === 0 ? "admin" : "admin"; // always admin via this script
  const hash = await hashPassword(password);
  const id = createUser({ username, passwordHash: hash, role });

  console.log(`✓ Created admin user "${username}" (id ${id}). You can now log in.`);
  closeDB();
}

main().catch(e => {
  console.error("Failed:", e.message);
  process.exit(1);
});
