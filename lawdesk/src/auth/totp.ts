// Time-based one-time codes for two-factor sign-in, the kind authenticator apps show.
// HOTP is RFC 4226, TOTP is RFC 6238 (HMAC-SHA1, 30-second steps, 6 digits), and the
// secret is written in base32 (RFC 4648, section 6) because that is what the apps expect.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) throw new Error("Not a base32 key");
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** RFC 4226 section 5.3: HMAC the counter, dynamic truncation, keep the last `digits`. */
export function hotp(key: Uint8Array, counter: number, digits = 6): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac("sha1", key).update(msg).digest();
  const off = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[off] & 0x7f) << 24) | (mac[off + 1] << 16) | (mac[off + 2] << 8) | mac[off + 3];
  return String(bin % 10 ** digits).padStart(digits, "0");
}

export const STEP_SECONDS = 30;

export function totpStep(nowMs: number): number {
  return Math.floor(nowMs / 1000 / STEP_SECONDS);
}

export function totp(secretBase32: string, nowMs: number, digits = 6): string {
  return hotp(base32Decode(secretBase32), totpStep(nowMs), digits);
}

/**
 * Check a 6-digit code, allowing one step either side for clock drift. Returns the step
 * that matched (store it to refuse a replay of the same code), or null.
 */
export function verifyTotp(secretBase32: string, code: string, nowMs: number, lastStep: number | null = null): number | null {
  const c = String(code ?? "").replace(/\s/g, "");
  if (!/^\d{6}$/.test(c)) return null;
  const key = base32Decode(secretBase32);
  const now = totpStep(nowMs);
  let found: number | null = null;
  for (const step of [now - 1, now, now + 1]) {
    // Compare every candidate so timing doesn't say which one matched.
    const ok = timingSafeEqual(Buffer.from(hotp(key, step)), Buffer.from(c));
    if (ok && found === null && (lastStep === null || step > lastStep)) found = step;
  }
  return found;
}

export function newTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** The otpauth:// link authenticator apps read (Google Authenticator "Key URI Format"). */
export function otpauthUri(secretBase32: string, account: string, issuer = "Lawdesk"): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secretBase32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${STEP_SECONDS}`;
}

/** The key grouped in fours, easier to type into a phone. */
export function groupKey(secretBase32: string): string {
  return secretBase32.replace(/(.{4})/g, "$1 ").trim();
}
