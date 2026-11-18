// Password hashing with scrypt (node:crypto), a random 16-byte salt per password and a
// constant-time comparison. Stored as "scrypt$N$r$p$salt$hash" so the cost can be raised
// later without breaking existing passwords.

import { randomBytes, scrypt as scryptCb, timingSafeEqual, createHash } from "node:crypto";

const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 64;

function scrypt(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scryptCb(password.normalize("NFKC"), salt, KEYLEN, { N: n, r, p, maxmem: 256 * n * r }, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, N, R, P);
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = String(stored).split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [n, r, p] = parts.slice(1, 4).map(Number);
  if (![n, r, p].every((x) => Number.isInteger(x) && x > 0) || n > 1 << 20) return false;
  const salt = Buffer.from(parts[4], "base64");
  const want = Buffer.from(parts[5], "base64");
  const got = await scrypt(password, salt, n, r, p);
  return got.length === want.length && timingSafeEqual(got, want);
}

/** A hash that never matches, used so an unknown email costs as much time as a wrong password. */
let dummy: string | null = null;
export async function burnTime(password: string) {
  dummy ??= await hashPassword(randomBytes(12).toString("hex"));
  await verifyPassword(password, dummy);
}

export const MIN_LENGTH = 12;

/**
 * Length is what matters; no "one capital, one symbol" rules (NIST SP 800-63B, section
 * 5.1.1.2, recommends against composition rules and for a minimum length).
 */
export function passwordProblem(password: unknown, email?: string | null): string | null {
  if (typeof password !== "string" || password.length < MIN_LENGTH) return `Choose a password of at least ${MIN_LENGTH} characters`;
  if (password.length > 200) return "That password is too long (200 characters at most)";
  const p = password.toLowerCase();
  if (email && p === email.toLowerCase()) return "The password can't be your email address";
  if (/^(.)\1+$/.test(p)) return "Choose a password that isn't one character repeated";
  // A well-known password with a few characters tacked on ("password1234").
  if (COMMON.some((c) => p.includes(c) && p.split(c).join("").length < 8)) return "That password is too easy to guess; add a few more words";
  return null;
}

const COMMON = ["password", "123456789", "qwertyuiop", "letmein", "lawdesk", "welcome", "abc123", "iloveyou", "admin"];

/** SHA-256 hex of a high-entropy random token (session ids, reset links, recovery codes). */
export function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function newToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}
