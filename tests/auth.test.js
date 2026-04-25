import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { unlinkSync } from "fs";

import {
  initDB, closeDB, getDB,
  createUser, getUserByUsername, getUserById, updateUserLastLogin,
  countUsers, listUsers,
  createInvitationRow, getInvitation, markInvitationUsed, deleteInvitation,
  listInvitationsByAdmin,
} from "../src/db.js";

import {
  hashPassword, verifyPassword, signJwt, verifyJwt,
  generateInviteToken, inviteExpiry, getJwtSecret,
} from "../src/auth.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_DB = resolve(__dirname, "..", "data", "test-auth.db");

// Force a known JWT secret so signJwt doesn't throw in production-like tests.
process.env.JWT_SECRET = "test-secret-32-chars-aaaaaaaaaaaaaaa";

before(() => { initDB(TEST_DB); });
after(() => { closeDB(); try { unlinkSync(TEST_DB); } catch {} });

beforeEach(() => {
  const db = getDB();
  db.exec("DELETE FROM invitations; DELETE FROM users;");
});

// ── Pure auth.js helpers ────────────────────────────────────────────────────

describe("auth.js — password hashing", () => {
  it("hashPassword + verifyPassword round-trip", async () => {
    const hash = await hashPassword("correctpassword");
    assert.equal(await verifyPassword("correctpassword", hash), true);
    assert.equal(await verifyPassword("wrongpassword",   hash), false);
  });

  it("hashPassword rejects short passwords", async () => {
    await assert.rejects(() => hashPassword("short"), /at least 8/);
  });

  it("verifyPassword returns false on null/undefined inputs", async () => {
    assert.equal(await verifyPassword(null, "x"),  false);
    assert.equal(await verifyPassword("x",  null), false);
    assert.equal(await verifyPassword("",   ""),   false);
  });
});

describe("auth.js — JWT", () => {
  it("signJwt + verifyJwt round-trip preserves userId and role", () => {
    const token = signJwt({ userId: 42, role: "admin" });
    const payload = verifyJwt(token);
    assert.equal(payload.userId, 42);
    assert.equal(payload.role,   "admin");
  });

  it("verifyJwt returns null on tampered token", () => {
    const token = signJwt({ userId: 1, role: "user" });
    const bad   = token.slice(0, -1) + (token.endsWith("a") ? "b" : "a");
    assert.equal(verifyJwt(bad), null);
  });

  it("verifyJwt returns null on garbage", () => {
    assert.equal(verifyJwt("nope"), null);
    assert.equal(verifyJwt(""),     null);
    assert.equal(verifyJwt(null),   null);
  });

  it("signJwt rejects missing fields", () => {
    assert.throws(() => signJwt({ userId: 1 }), /requires userId and role/);
    assert.throws(() => signJwt({ role: "admin" }), /requires userId and role/);
  });
});

describe("auth.js — invitation tokens", () => {
  it("generateInviteToken returns a 32-char hex string", () => {
    const t = generateInviteToken();
    assert.ok(/^[0-9a-f]{32}$/.test(t), `token shape: ${t}`);
  });

  it("inviteExpiry is 7 days ahead", () => {
    const now = 1_000_000_000_000;
    const exp = inviteExpiry(now);
    assert.equal(exp - now, 7 * 24 * 60 * 60 * 1000);
  });
});

// ── DB CRUD ─────────────────────────────────────────────────────────────────

describe("db — users", () => {
  it("createUser returns id, getUserByUsername returns the row", async () => {
    const hash = await hashPassword("testpass1");
    const id = createUser({ username: "alice", passwordHash: hash, role: "admin" });
    assert.ok(id > 0);

    const u = getUserByUsername("alice");
    assert.equal(u.id,           id);
    assert.equal(u.username,     "alice");
    assert.equal(u.role,         "admin");
    assert.equal(u.password_hash, hash);
  });

  it("UNIQUE username enforced", async () => {
    const hash = await hashPassword("testpass1");
    createUser({ username: "alice", passwordHash: hash });
    assert.throws(() => createUser({ username: "alice", passwordHash: hash }), /UNIQUE/);
  });

  it("getUserById omits password_hash", async () => {
    const hash = await hashPassword("testpass1");
    const id = createUser({ username: "alice", passwordHash: hash });
    const u = getUserById(id);
    assert.equal(u.password_hash, undefined, "password_hash must not leak");
    assert.equal(u.username, "alice");
  });

  it("countUsers counts correctly", async () => {
    assert.equal(countUsers(), 0);
    const hash = await hashPassword("testpass1");
    createUser({ username: "alice", passwordHash: hash });
    createUser({ username: "bob",   passwordHash: hash });
    assert.equal(countUsers(), 2);
  });

  it("updateUserLastLogin sets last_login", async () => {
    const hash = await hashPassword("testpass1");
    const id = createUser({ username: "alice", passwordHash: hash });
    updateUserLastLogin(id, 1234567890);
    assert.equal(getUserById(id).last_login, 1234567890);
  });
});

describe("db — invitations", () => {
  it("create / get / mark-used / delete", async () => {
    const hash = await hashPassword("testpass1");
    const adminId = createUser({ username: "admin", passwordHash: hash, role: "admin" });
    const userId  = createUser({ username: "alice", passwordHash: hash });

    const token = generateInviteToken();
    createInvitationRow({ token, createdBy: adminId, expiresAt: inviteExpiry() });

    const inv = getInvitation(token);
    assert.equal(inv.token,      token);
    assert.equal(inv.created_by, adminId);
    assert.equal(inv.used_by,    null);

    markInvitationUsed(token, userId);
    assert.equal(getInvitation(token).used_by, userId);

    const deleted = deleteInvitation(token);
    assert.equal(deleted, 1);
    assert.equal(getInvitation(token), null);
  });

  it("listInvitationsByAdmin filters to that admin", async () => {
    const hash = await hashPassword("testpass1");
    const a1 = createUser({ username: "admin1", passwordHash: hash, role: "admin" });
    const a2 = createUser({ username: "admin2", passwordHash: hash, role: "admin" });

    createInvitationRow({ token: "aaaa", createdBy: a1, expiresAt: inviteExpiry() });
    createInvitationRow({ token: "bbbb", createdBy: a2, expiresAt: inviteExpiry() });
    createInvitationRow({ token: "cccc", createdBy: a1, expiresAt: inviteExpiry() });

    const a1List = listInvitationsByAdmin(a1).map(i => i.token).sort();
    assert.deepEqual(a1List, ["aaaa", "cccc"]);
    assert.equal(listInvitationsByAdmin(a2).length, 1);
  });
});
