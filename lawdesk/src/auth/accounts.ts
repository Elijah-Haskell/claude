// Accounts, sign-in, sessions, two-factor, recovery codes and password resets.
// Every event a lawyer or auditor would ask about is written to the activity log through
// engine.log (kinds start with "auth_").

import { tx, type DB } from "../db.ts";
import { EngineError, type Engine } from "../engine.ts";
import { randomBytes } from "node:crypto";
import { hashPassword, verifyPassword, burnTime, passwordProblem, tokenHash, newToken } from "./passwords.ts";
import { base32Encode, newTotpSecret, otpauthUri, groupKey, verifyTotp } from "./totp.ts";
import { ROLES, ROLE_LABELS, type Role } from "./access.ts";

type Row = Record<string, any>;

/** Replaceable clock, for tests. */
export const clock = { now: () => Date.now() };

export const LIMITS = {
  /** Signed out after this long without using the app. */
  idleMs: 8 * 60 * 60 * 1000,
  /** Signed out this long after signing in, however busy. */
  absoluteMs: 24 * 60 * 60 * 1000,
  /** Wrong passwords in a row before the account is locked. */
  lockAfter: 5,
  lockMs: 15 * 60 * 1000,
  /** Failed sign-ins from one address within the window before it is refused. */
  perIpFailures: 20,
  perIpWindowMs: 15 * 60 * 1000,
  challengeMs: 5 * 60 * 1000,
  challengeTries: 5,
  resetLinkMs: 24 * 60 * 60 * 1000,
  recoveryCodes: 10,
};

export class AuthError extends EngineError {}

const fail = (message: string, status = 400): never => {
  throw new AuthError(message, status);
};

const one = (db: DB, sql: string, ...p: any[]) => db.prepare(sql).get(...p) as Row | undefined;
const all = (db: DB, sql: string, ...p: any[]) => db.prepare(sql).all(...p) as Row[];

export interface ClientInfo {
  ip?: string | null;
  userAgent?: string | null;
}

// ------------------------------------------------------------------ accounts

export function accountCount(db: DB): number {
  return one(db, "SELECT COUNT(*) AS n FROM auth_accounts WHERE role <> 'client'")!.n;
}

export function getAccount(db: DB, userId: number): Row | undefined {
  return one(db, "SELECT a.*, u.name, u.active FROM auth_accounts a JOIN users u ON u.id = a.user_id WHERE a.user_id = ?", userId);
}

/** What the app may show about an account: never hashes or secrets. */
export function publicAccount(a: Row) {
  return {
    userId: a.user_id,
    name: a.name,
    email: a.email,
    role: a.role as Role,
    roleLabel: ROLE_LABELS[a.role as Role],
    twoFactor: !!a.totp_secret,
    mustChangePassword: !!a.must_change_password,
    disabled: !!a.disabled,
    locked: !!(a.locked_until && a.locked_until > clock.now()),
    lastSignInAt: a.last_sign_in_at ? new Date(a.last_sign_in_at).toISOString() : null,
    passwordChangedAt: a.password_changed_at ? new Date(a.password_changed_at).toISOString() : null,
  };
}

export function checkEmail(v: unknown): string {
  const e = typeof v === "string" ? v.trim() : "";
  if (!e) fail("Enter an email address");
  if (e.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) fail("That doesn't look like an email address");
  return e;
}

export function checkRole(v: unknown): Role {
  if (typeof v !== "string" || !ROLES.includes(v as Role)) fail("Pick an access level");
  return v as Role;
}

function enabledAdmins(db: DB): number {
  return one(db, "SELECT COUNT(*) AS n FROM auth_accounts a JOIN users u ON u.id = a.user_id WHERE a.role = 'admin' AND a.disabled = 0 AND u.active = 1")!.n;
}

/** Give an existing person in `users` a sign-in account. */
export async function createAccount(
  db: DB,
  engine: Engine,
  input: { userId: number; email: string; role: Role; password: string; mustChangePassword?: boolean },
  byUserId: number | null = null,
): Promise<Row> {
  const email = checkEmail(input.email);
  const role = checkRole(input.role);
  const problem = passwordProblem(input.password, email);
  if (problem) fail(problem);
  const user = one(db, "SELECT * FROM users WHERE id = ?", input.userId);
  if (!user) fail("Person not found", 404);
  const hash = await hashPassword(input.password);
  tx(db, () => {
    if (one(db, "SELECT 1 FROM auth_accounts WHERE user_id = ?", input.userId)) fail(`${user!.name} already has an account`, 409);
    if (one(db, "SELECT 1 FROM auth_accounts WHERE email = ?", email)) fail("Another account already uses that email address", 409);
    const now = clock.now();
    db.prepare(
      "INSERT INTO auth_accounts (user_id, email, role, password_hash, must_change_password, created_at, password_changed_at) VALUES (?,?,?,?,?,?,?)",
    ).run(input.userId, email, role, hash, input.mustChangePassword ? 1 : 0, now, now);
    if (!user!.email) db.prepare("UPDATE users SET email = ? WHERE id = ?").run(email, input.userId);
    engine.log("auth_account_created", `Sign-in account created for ${user!.name} (${ROLE_LABELS[role]})`, { userId: byUserId });
  });
  return getAccount(db, input.userId)!;
}

/**
 * First run: there are no accounts yet, so whoever opens the app creates the first
 * administrator. Links to an existing person with the same email (e.g. from the demo
 * data or a Clio import), otherwise adds the person.
 */
export async function setupFirstAdmin(db: DB, engine: Engine, input: { name: unknown; email: unknown; password: unknown }): Promise<Row> {
  if (accountCount(db) > 0) fail("Lawdesk is already set up. Sign in instead.", 409);
  const email = checkEmail(input.email);
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) fail("Enter your name");
  if (name.length > 200) fail("That name is too long");
  const problem = passwordProblem(input.password, email);
  if (problem) fail(problem);
  const existing = one(db, "SELECT id FROM users WHERE email = ? COLLATE NOCASE ORDER BY id LIMIT 1", email);
  const userId = existing ? existing.id : engine.addUser(name, "attorney", email);
  if (accountCount(db) > 0) fail("Lawdesk is already set up. Sign in instead.", 409);
  return createAccount(db, engine, { userId, email, role: "admin", password: input.password as string }, userId);
}

export function updateAccount(db: DB, engine: Engine, byUserId: number | null, userId: number, patch: { role?: unknown; email?: unknown; disabled?: unknown }) {
  const a = getAccount(db, userId);
  if (!a) fail("That person has no sign-in account", 404);
  tx(db, () => {
    if (patch.email !== undefined) {
      const email = checkEmail(patch.email);
      if (one(db, "SELECT 1 FROM auth_accounts WHERE email = ? AND user_id <> ?", email, userId)) fail("Another account already uses that email address", 409);
      if (email.toLowerCase() !== String(a!.email).toLowerCase()) {
        db.prepare("UPDATE auth_accounts SET email = ? WHERE user_id = ?").run(email, userId);
        engine.log("auth_email_changed", `Sign-in email for ${a!.name} changed`, { userId: byUserId });
      }
    }
    if (patch.role !== undefined) {
      const role = checkRole(patch.role);
      if (role !== a!.role) {
        if (a!.role === "admin" && enabledAdmins(db) <= 1) fail("Lawdesk needs at least one administrator. Make someone else an administrator first.", 409);
        db.prepare("UPDATE auth_accounts SET role = ? WHERE user_id = ?").run(role, userId);
        engine.log("auth_role_changed", `${a!.name}: access changed from ${ROLE_LABELS[a!.role as Role]} to ${ROLE_LABELS[role]}`, { userId: byUserId });
      }
    }
    if (patch.disabled !== undefined) {
      const disabled = patch.disabled ? 1 : 0;
      if (disabled !== a!.disabled) {
        if (disabled && userId === byUserId) fail("You can't turn off your own account", 409);
        if (disabled && a!.role === "admin" && enabledAdmins(db) <= 1) fail("Lawdesk needs at least one administrator", 409);
        db.prepare("UPDATE auth_accounts SET disabled = ?, failed_count = 0, locked_until = NULL WHERE user_id = ?").run(disabled, userId);
        if (disabled) revokeAllSessions(db, userId);
        engine.log(disabled ? "auth_account_disabled" : "auth_account_enabled", `${disabled ? "Turned off" : "Turned on"} sign-in for ${a!.name}`, { userId: byUserId });
      }
    }
  });
  return getAccount(db, userId)!;
}

export function unlockAccount(db: DB, engine: Engine, byUserId: number | null, userId: number) {
  const a = getAccount(db, userId);
  if (!a) fail("That person has no sign-in account", 404);
  db.prepare("UPDATE auth_accounts SET failed_count = 0, locked_until = NULL WHERE user_id = ?").run(userId);
  engine.log("auth_unlocked", `Unlocked sign-in for ${a!.name}`, { userId: byUserId });
}

// ------------------------------------------------------------------ sessions

export function createSession(db: DB, userId: number, client: ClientInfo = {}): { id: number; token: string } {
  const token = newToken(32);
  const now = clock.now();
  const id = Number(
    db
      .prepare("INSERT INTO auth_sessions (token_hash, user_id, created_at, last_seen_at, ip, user_agent) VALUES (?,?,?,?,?,?)")
      .run(tokenHash(token), userId, now, now, client.ip ?? null, (client.userAgent ?? "").slice(0, 300) || null).lastInsertRowid,
  );
  return { id, token };
}

export interface SessionInfo {
  sessionId: number;
  userId: number;
  role: Role;
  mustChangePassword: boolean;
}

/** Look up a session token from the cookie; expired sessions are deleted. */
export function sessionFromToken(db: DB, token: string | null | undefined): SessionInfo | null {
  if (!token || token.length > 100) return null;
  const s = one(
    db,
    `SELECT s.*, a.role, a.disabled, a.must_change_password, u.active FROM auth_sessions s
     JOIN auth_accounts a ON a.user_id = s.user_id JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`,
    tokenHash(token),
  );
  if (!s) return null;
  const now = clock.now();
  if (s.disabled || !s.active || now - s.last_seen_at > LIMITS.idleMs || now - s.created_at > LIMITS.absoluteMs) {
    db.prepare("DELETE FROM auth_sessions WHERE id = ?").run(s.id);
    return null;
  }
  // Touch at most once a minute, to keep writes down.
  if (now - s.last_seen_at > 60_000) db.prepare("UPDATE auth_sessions SET last_seen_at = ? WHERE id = ?").run(now, s.id);
  return { sessionId: s.id, userId: s.user_id, role: s.role, mustChangePassword: !!s.must_change_password };
}

export function listSessions(db: DB, userId: number, currentId: number | null = null) {
  const now = clock.now();
  return all(db, "SELECT * FROM auth_sessions WHERE user_id = ? ORDER BY last_seen_at DESC", userId)
    .filter((s) => now - s.last_seen_at <= LIMITS.idleMs && now - s.created_at <= LIMITS.absoluteMs)
    .map((s) => ({
      id: s.id,
      current: s.id === currentId,
      signedInAt: new Date(s.created_at).toISOString(),
      lastSeenAt: new Date(s.last_seen_at).toISOString(),
      ip: s.ip,
      device: describeAgent(s.user_agent),
    }));
}

/** "Chrome on Windows" from a user-agent string; good enough to recognise your own devices. */
export function describeAgent(ua: string | null): string {
  if (!ua) return "Unknown device";
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const os = /iPhone|iPad/.test(ua) ? "iPhone or iPad" : /Android/.test(ua) ? "Android" : /Windows/.test(ua) ? "Windows" : /Mac OS X/.test(ua) ? "Mac" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser;
}

export function revokeSession(db: DB, userId: number, sessionId: number): boolean {
  return db.prepare("DELETE FROM auth_sessions WHERE id = ? AND user_id = ?").run(sessionId, userId).changes > 0;
}

/** Sign a person out everywhere (optionally keeping one session, the one in use). */
export function revokeAllSessions(db: DB, userId: number, exceptId: number | null = null): number {
  return Number(db.prepare("DELETE FROM auth_sessions WHERE user_id = ? AND id IS NOT ?").run(userId, exceptId).changes);
}

// ------------------------------------------------------------------- sign-in

/** Failed sign-ins per address, kept in memory per database (a restart forgets them). */
const ipFailures = new WeakMap<DB, Map<string, number[]>>();

function ipBlocked(db: DB, ip: string | null | undefined): boolean {
  if (!ip) return false;
  const list = ipFailures.get(db)?.get(ip) ?? [];
  const since = clock.now() - LIMITS.perIpWindowMs;
  return list.filter((t) => t > since).length >= LIMITS.perIpFailures;
}

function noteIpFailure(db: DB, ip: string | null | undefined) {
  if (!ip) return;
  let m = ipFailures.get(db);
  if (!m) ipFailures.set(db, (m = new Map()));
  const since = clock.now() - LIMITS.perIpWindowMs;
  const list = (m.get(ip) ?? []).filter((t) => t > since);
  list.push(clock.now());
  m.set(ip, list);
  if (m.size > 10_000) m.delete(m.keys().next().value!);
}

const WRONG = "That email and password don't match an account. Check them and try again.";

function lockedMessage(until: number) {
  const mins = Math.max(1, Math.ceil((until - clock.now()) / 60_000));
  return `Too many unsuccessful attempts. Try again in ${mins} minute${mins === 1 ? "" : "s"}, or ask an administrator to unlock your account.`;
}

function noteFailure(db: DB, engine: Engine, a: Row, why: string) {
  const count = a.failed_count + 1;
  if (count >= LIMITS.lockAfter) {
    db.prepare("UPDATE auth_accounts SET failed_count = 0, locked_until = ? WHERE user_id = ?").run(clock.now() + LIMITS.lockMs, a.user_id);
    engine.log("auth_locked", `Sign-in locked for ${Math.round(LIMITS.lockMs / 60000)} minutes after ${count} unsuccessful attempts (${a.name})`, { userId: a.user_id });
  } else {
    db.prepare("UPDATE auth_accounts SET failed_count = ? WHERE user_id = ?").run(count, a.user_id);
  }
  engine.log("auth_sign_in_failed", `Unsuccessful sign-in: ${why} (${a.name})`, { userId: a.user_id });
}

export type SignInResult =
  | { status: "signed_in"; token: string; sessionId: number; userId: number }
  | { status: "two_factor"; challenge: string };

function finishSignIn(db: DB, engine: Engine, a: Row, client: ClientInfo, how: string): SignInResult {
  db.prepare("UPDATE auth_accounts SET failed_count = 0, locked_until = NULL, last_sign_in_at = ? WHERE user_id = ?").run(clock.now(), a.user_id);
  const s = createSession(db, a.user_id, client);
  engine.log("auth_sign_in", `Signed in${how}${client.ip ? ` from ${client.ip}` : ""}`, { userId: a.user_id });
  return { status: "signed_in", token: s.token, sessionId: s.id, userId: a.user_id };
}

export async function signIn(db: DB, engine: Engine, input: { email: unknown; password: unknown }, client: ClientInfo = {}): Promise<SignInResult> {
  if (ipBlocked(db, client.ip)) fail("Too many unsuccessful sign-ins from this network. Wait 15 minutes and try again.", 429);
  const email = typeof input.email === "string" ? input.email.trim() : "";
  const password = typeof input.password === "string" ? input.password : "";
  if (!email || !password) fail("Enter your email address and password");
  const a = one(db, "SELECT a.*, u.name, u.active FROM auth_accounts a JOIN users u ON u.id = a.user_id WHERE a.email = ?", email);
  if (!a) {
    await burnTime(password);
    noteIpFailure(db, client.ip);
    engine.log("auth_sign_in_failed", "Unsuccessful sign-in with an email address that has no account", { userId: null });
    fail(WRONG, 401);
  }
  if (a!.locked_until && a!.locked_until > clock.now()) {
    noteIpFailure(db, client.ip);
    fail(lockedMessage(a!.locked_until), 429);
  }
  if (!(await verifyPassword(password, a!.password_hash))) {
    noteIpFailure(db, client.ip);
    noteFailure(db, engine, a!, "wrong password");
    fail(WRONG, 401);
  }
  if (a!.disabled || !a!.active) {
    engine.log("auth_sign_in_failed", `Refused sign-in: the account is turned off (${a!.name})`, { userId: a!.user_id });
    fail("This account is turned off. Ask an administrator if you need access.", 403);
  }
  if (a!.totp_secret) {
    const challenge = newToken(32);
    db.prepare("DELETE FROM auth_challenges WHERE user_id = ? OR expires_at < ?").run(a!.user_id, clock.now());
    db.prepare("INSERT INTO auth_challenges (token_hash, user_id, expires_at) VALUES (?,?,?)").run(tokenHash(challenge), a!.user_id, clock.now() + LIMITS.challengeMs);
    return { status: "two_factor", challenge };
  }
  return finishSignIn(db, engine, a!, client, "");
}

/** Second step: the six-digit code from the app, or one of the recovery codes. */
export function completeTwoFactor(db: DB, engine: Engine, input: { challenge: unknown; code: unknown }, client: ClientInfo = {}): SignInResult {
  const token = typeof input.challenge === "string" ? input.challenge : "";
  const ch = token ? one(db, "SELECT * FROM auth_challenges WHERE token_hash = ?", tokenHash(token)) : undefined;
  if (!ch || ch.expires_at < clock.now()) fail("That sign-in has expired. Enter your email and password again.", 401);
  const a = getAccount(db, ch!.user_id);
  if (!a || !a.totp_secret || a.disabled || !a.active) fail("That sign-in has expired. Enter your email and password again.", 401);
  if (a!.locked_until && a!.locked_until > clock.now()) fail(lockedMessage(a!.locked_until), 429);
  const code = String(input.code ?? "").trim();
  let how = "";
  const step = verifyTotp(a!.totp_secret, code, clock.now(), a!.totp_last_step ?? null);
  if (step !== null) {
    db.prepare("UPDATE auth_accounts SET totp_last_step = ? WHERE user_id = ?").run(step, a!.user_id);
  } else if (useRecoveryCode(db, a!.user_id, code)) {
    const left = one(db, "SELECT COUNT(*) AS n FROM auth_recovery_codes WHERE user_id = ? AND used_at IS NULL", a!.user_id)!.n;
    engine.log("auth_recovery_used", `Signed in with a recovery code (${left} left)`, { userId: a!.user_id });
    how = " with a recovery code";
  } else {
    noteIpFailure(db, client.ip);
    const tries = ch!.attempts + 1;
    if (tries >= LIMITS.challengeTries) db.prepare("DELETE FROM auth_challenges WHERE token_hash = ?").run(ch!.token_hash);
    else db.prepare("UPDATE auth_challenges SET attempts = ? WHERE token_hash = ?").run(tries, ch!.token_hash);
    noteFailure(db, engine, a!, "wrong two-step code");
    fail(tries >= LIMITS.challengeTries ? "Too many wrong codes. Enter your email and password again." : "That code didn't work. Check the time on your phone and try the newest code.", 401);
  }
  db.prepare("DELETE FROM auth_challenges WHERE token_hash = ?").run(ch!.token_hash);
  return finishSignIn(db, engine, a!, client, how || " with two-step sign-in");
}

export function signOut(db: DB, engine: Engine, userId: number, sessionId: number) {
  revokeSession(db, userId, sessionId);
  engine.log("auth_sign_out", "Signed out", { userId });
}

// ----------------------------------------------------------------- passwords

async function setPassword(db: DB, userId: number, password: string, mustChange: boolean) {
  const hash = await hashPassword(password);
  db.prepare(
    "UPDATE auth_accounts SET password_hash = ?, must_change_password = ?, password_changed_at = ?, failed_count = 0, locked_until = NULL WHERE user_id = ?",
  ).run(hash, mustChange ? 1 : 0, clock.now(), userId);
}

/** The person changes their own password; their other sessions are signed out. */
export async function changePassword(db: DB, engine: Engine, userId: number, current: unknown, next: unknown, keepSessionId: number | null) {
  const a = getAccount(db, userId);
  if (!a) fail("Account not found", 404);
  if (typeof current !== "string" || !(await verifyPassword(current, a!.password_hash))) fail("Your current password isn't right", 400);
  const problem = passwordProblem(next, a!.email);
  if (problem) fail(problem);
  if (await verifyPassword(next as string, a!.password_hash)) fail("Choose a new password, different from the current one");
  await setPassword(db, userId, next as string, false);
  const n = revokeAllSessions(db, userId, keepSessionId);
  engine.log("auth_password_changed", `Changed their password${n ? `; signed out ${n} other session${n === 1 ? "" : "s"}` : ""}`, { userId });
}

/**
 * An admin sets a temporary password (the person must choose a new one when they next
 * sign in). Signs them out everywhere and clears any lock. Optionally turns off
 * two-factor, for someone who lost their phone and their recovery codes.
 */
export async function adminSetPassword(
  db: DB,
  engine: Engine,
  byUserId: number | null,
  userId: number,
  temporary: unknown,
  opts: { turnOffTwoFactor?: boolean } = {},
) {
  const a = getAccount(db, userId);
  if (!a) fail("That person has no sign-in account", 404);
  const problem = passwordProblem(temporary, a!.email);
  if (problem) fail(problem);
  await setPassword(db, userId, temporary as string, true);
  revokeAllSessions(db, userId);
  db.prepare("DELETE FROM auth_reset_tokens WHERE user_id = ? AND used_at IS NULL").run(userId);
  engine.log("auth_password_reset", `Set a temporary password for ${a!.name}`, { userId: byUserId });
  if (opts.turnOffTwoFactor && a!.totp_secret) {
    clearTwoFactor(db, userId);
    engine.log("auth_2fa_off", `Two-step sign-in turned off for ${a!.name} by an administrator`, { userId: byUserId });
  }
}

/**
 * A one-time link to choose a new password. Returns the raw token; only its hash is
 * stored. The email module can call this and send `${baseUrl}/#/reset/${token}`.
 */
export function createResetToken(db: DB, userId: number, opts: { createdBy?: number | null; ttlMs?: number; engine?: Engine } = {}): string {
  const a = getAccount(db, userId);
  if (!a) fail("That person has no sign-in account", 404);
  const token = newToken(32);
  const now = clock.now();
  db.prepare("DELETE FROM auth_reset_tokens WHERE user_id = ? AND used_at IS NULL").run(userId);
  db.prepare("INSERT INTO auth_reset_tokens (token_hash, user_id, created_by, created_at, expires_at) VALUES (?,?,?,?,?)").run(
    tokenHash(token),
    userId,
    opts.createdBy ?? null,
    now,
    now + (opts.ttlMs ?? LIMITS.resetLinkMs),
  );
  opts.engine?.log("auth_reset_link", `Created a password reset link for ${a!.name}`, { userId: opts.createdBy ?? null });
  return token;
}

export async function useResetToken(db: DB, engine: Engine, token: unknown, password: unknown) {
  const t = typeof token === "string" && token.length < 100 ? one(db, "SELECT * FROM auth_reset_tokens WHERE token_hash = ?", tokenHash(token)) : undefined;
  if (!t || t.used_at || t.expires_at < clock.now()) fail("This reset link has expired or was already used. Ask an administrator for a new one.", 400);
  const a = getAccount(db, t!.user_id);
  if (!a || a.disabled) fail("This reset link has expired or was already used. Ask an administrator for a new one.", 400);
  const problem = passwordProblem(password, a!.email);
  if (problem) fail(problem);
  await setPassword(db, t!.user_id, password as string, false);
  db.prepare("UPDATE auth_reset_tokens SET used_at = ? WHERE token_hash = ?").run(clock.now(), t!.token_hash);
  revokeAllSessions(db, t!.user_id);
  engine.log("auth_password_changed", "Chose a new password from a reset link", { userId: t!.user_id });
}

// ---------------------------------------------------------------- two-factor

/** Step 1: make a secret to show; nothing changes until a code from it is confirmed. */
export function beginTwoFactor(db: DB, userId: number) {
  const a = getAccount(db, userId);
  if (!a) fail("Account not found", 404);
  const secret = newTotpSecret();
  db.prepare("UPDATE auth_accounts SET totp_pending_secret = ? WHERE user_id = ?").run(secret, userId);
  return { key: groupKey(secret), uri: otpauthUri(secret, a!.email) };
}

/** Step 2: the first code proves the app is set up. Returns the recovery codes (shown once). */
export function enableTwoFactor(db: DB, engine: Engine, userId: number, code: unknown): string[] {
  const a = getAccount(db, userId);
  if (!a?.totp_pending_secret) fail("Start setting up two-step sign-in again");
  const step = verifyTotp(a!.totp_pending_secret, String(code ?? ""), clock.now());
  if (step === null) fail("That code didn't work. Check the time on your phone and try the newest code.");
  return tx(db, () => {
    db.prepare("UPDATE auth_accounts SET totp_secret = totp_pending_secret, totp_pending_secret = NULL, totp_last_step = ? WHERE user_id = ?").run(step, userId);
    engine.log("auth_2fa_on", "Turned on two-step sign-in", { userId });
    return replaceRecoveryCodes(db, userId);
  });
}

function clearTwoFactor(db: DB, userId: number) {
  db.prepare("UPDATE auth_accounts SET totp_secret = NULL, totp_pending_secret = NULL, totp_last_step = NULL WHERE user_id = ?").run(userId);
  db.prepare("DELETE FROM auth_recovery_codes WHERE user_id = ?").run(userId);
}

export async function disableTwoFactor(db: DB, engine: Engine, userId: number, password: unknown) {
  const a = getAccount(db, userId);
  if (!a) fail("Account not found", 404);
  if (typeof password !== "string" || !(await verifyPassword(password, a!.password_hash))) fail("Your password isn't right");
  if (!a!.totp_secret) return;
  clearTwoFactor(db, userId);
  engine.log("auth_2fa_off", "Turned off two-step sign-in", { userId });
}

export async function regenerateRecoveryCodes(db: DB, engine: Engine, userId: number, password: unknown): Promise<string[]> {
  const a = getAccount(db, userId);
  if (!a?.totp_secret) fail("Two-step sign-in isn't on");
  if (typeof password !== "string" || !(await verifyPassword(password, a!.password_hash))) fail("Your password isn't right");
  const codes = replaceRecoveryCodes(db, userId);
  engine.log("auth_recovery_new", "Made new recovery codes (the old ones no longer work)", { userId });
  return codes;
}

export function recoveryCodesLeft(db: DB, userId: number): number {
  return one(db, "SELECT COUNT(*) AS n FROM auth_recovery_codes WHERE user_id = ? AND used_at IS NULL", userId)!.n;
}

const normCode = (c: string) => c.toLowerCase().replace(/[^a-z0-9]/g, "");

function replaceRecoveryCodes(db: DB, userId: number): string[] {
  db.prepare("DELETE FROM auth_recovery_codes WHERE user_id = ?").run(userId);
  const codes: string[] = [];
  for (let i = 0; i < LIMITS.recoveryCodes; i++) {
    // 12 base32 characters = 60 random bits each.
    const raw = base32Encode(randomBytes(8)).slice(0, 12).toLowerCase();
    codes.push(`${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8)}`);
    db.prepare("INSERT INTO auth_recovery_codes (user_id, code_hash) VALUES (?,?)").run(userId, tokenHash(raw));
  }
  return codes;
}

function useRecoveryCode(db: DB, userId: number, code: string): boolean {
  const c = normCode(code);
  if (c.length !== 12) return false;
  const r = db
    .prepare("UPDATE auth_recovery_codes SET used_at = ? WHERE user_id = ? AND code_hash = ? AND used_at IS NULL")
    .run(clock.now(), userId, tokenHash(c));
  return r.changes > 0;
}

