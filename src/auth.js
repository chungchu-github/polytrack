/**
 * Auth primitives.
 *
 * Pure functions over bcrypt + JWT — no DB access, no Express coupling.
 * The `requireAuth` middleware lives in server.js; this module just hashes,
 * verifies, signs, and validates tokens.
 *
 * JWT_SECRET must be set in .env when NODE_ENV=production. Tokens carry
 * { userId, role } and expire after 24h. Invitation tokens are random hex
 * (no JWT) — they're claim-once one-time pickups.
 */
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import crypto from "crypto";

const BCRYPT_ROUNDS = 12;
const JWT_EXPIRY    = "24h";
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;     // 7 days

/**
 * Resolve the JWT secret. Throws in production when missing — we'd rather
 * crash at boot than silently sign with a fallback constant.
 */
export function getJwtSecret() {
  const s = process.env.JWT_SECRET;
  if (s && s.length >= 16) return s;
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "JWT_SECRET env var is required in production (min 16 chars). " +
      "Generate with `openssl rand -hex 32`."
    );
  }
  // Dev-only fallback. Tokens issued under this won't validate elsewhere.
  return "dev-secret-not-for-production";
}

export async function hashPassword(plain) {
  if (typeof plain !== "string" || plain.length < 8) {
    throw new Error("Password must be at least 8 characters");
  }
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

export async function verifyPassword(plain, hash) {
  if (!plain || !hash) return false;
  try {
    return await bcrypt.compare(plain, hash);
  } catch {
    return false;
  }
}

export function signJwt({ userId, role }) {
  if (!userId || !role) throw new Error("signJwt requires userId and role");
  return jwt.sign({ userId, role }, getJwtSecret(), { expiresIn: JWT_EXPIRY });
}

/**
 * @returns {{ userId: number, role: string } | null}
 */
export function verifyJwt(token) {
  if (!token) return null;
  try {
    const payload = jwt.verify(token, getJwtSecret());
    if (!payload?.userId || !payload?.role) return null;
    return { userId: payload.userId, role: payload.role };
  } catch {
    return null;
  }
}

/** Random-hex token used for invitations (not a JWT — just an ID). */
export function generateInviteToken() {
  return crypto.randomBytes(16).toString("hex");
}

export function inviteExpiry(now = Date.now()) {
  return now + INVITE_TTL_MS;
}

export const _internals = { BCRYPT_ROUNDS, JWT_EXPIRY, INVITE_TTL_MS };
