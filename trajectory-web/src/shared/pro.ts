/**
 * Trajectory Pro, shared by the app and the server (pure, no platform imports).
 *
 * The server refuses Pro-only procedures and extra free syllabus imports with a tRPC FORBIDDEN error whose
 * `data.appCode` is one of PRO_GATE_CODES (see the errorFormatter in server/_core/trpc.ts). The app maps that
 * code to "open the paywall" (proGateReasonFromError) instead of showing a generic error.
 */

/** RevenueCat entitlement identifier (dashboard name) that unlocks Pro. */
export const PRO_ENTITLEMENT_ID = "Trajectory Pro";

/** Free accounts may import this many distinct syllabi; Pro is unlimited. Enforced on the server. */
export const FREE_SYLLABUS_IMPORTS = 1;

export const PRO_GATE_CODES = {
  /** A Pro-only feature was called by an account without an active Pro entitlement. */
  proRequired: "PRO_REQUIRED",
  /** A free account tried to import a second, different syllabus. */
  freeSyllabusLimit: "FREE_SYLLABUS_LIMIT",
} as const;

export type ProGateCode = (typeof PRO_GATE_CODES)[keyof typeof PRO_GATE_CODES];

/**
 * A session that is not a Sign in with Apple account's (a guest session kept by a build from before accounts were
 * required) called something that needs the account. FORBIDDEN with this code means "sign in with Apple" (the app
 * drops that session and shows its sign-in screen), not "open the paywall".
 */
export const SIGN_IN_REQUIRED_CODE = "SIGN_IN_REQUIRED" as const;
export type AppErrorCode = ProGateCode | typeof SIGN_IN_REQUIRED_CODE;

/** User-facing messages that travel with the codes (also used to recognise errors from older servers). */
export const PRO_REQUIRED_ERR_MSG = "This is a Trajectory Pro feature. Upgrade to Pro to keep using it.";
export const FREE_SYLLABUS_LIMIT_ERR_MSG =
  "Your free plan includes one syllabus import, and it has been used. Upgrade to Trajectory Pro to import more syllabi.";
export const SIGN_IN_REQUIRED_ERR_MSG = "Sign in with Apple to use this feature.";

/** The stable code for one of our messages, else null (used by the server's error formatter). */
export function appErrorCodeForMessage(message: unknown): AppErrorCode | null {
  if (message === PRO_REQUIRED_ERR_MSG) return PRO_GATE_CODES.proRequired;
  if (message === FREE_SYLLABUS_LIMIT_ERR_MSG) return PRO_GATE_CODES.freeSyllabusLimit;
  if (message === SIGN_IN_REQUIRED_ERR_MSG) return SIGN_IN_REQUIRED_CODE;
  return null;
}

/** Pro-gate codes only (the sign-in code is not a paywall reason). */
export function proGateCodeForMessage(message: unknown): ProGateCode | null {
  const code = appErrorCodeForMessage(message);
  return code === SIGN_IN_REQUIRED_CODE ? null : code;
}

/**
 * Guest accounts have an openId "guest:<uuid>" and loginMethod "guest". Builds from before accounts were required
 * made them; the app still has to recognise one it kept, to drop it (lib/session-refresh.ts accountSession).
 */
export function isGuestAccount(user: { openId?: string | null; loginMethod?: string | null } | null | undefined): boolean {
  if (!user) return false;
  return user.loginMethod === "guest" || (typeof user.openId === "string" && user.openId.startsWith("guest:"));
}

/**
 * Whether an error from a tRPC call means "this needs Pro". Accepts a TRPCClientError (`data.appCode`), a raw
 * tRPC error envelope (`{ error: { data } }` / `{ data }`), or anything carrying one of the messages.
 */
export function proGateReasonFromError(error: unknown): ProGateCode | null {
  const code = appErrorCodeFromError(error);
  return code === SIGN_IN_REQUIRED_CODE ? null : code;
}

/** Like proGateReasonFromError, but also recognises SIGN_IN_REQUIRED_CODE. */
export function appErrorCodeFromError(error: unknown): AppErrorCode | null {
  if (!error || typeof error !== "object") return null;
  const candidates: unknown[] = [error, (error as { error?: unknown }).error];
  for (const item of candidates) {
    if (!item || typeof item !== "object") continue;
    const data = (item as { data?: { appCode?: unknown } }).data;
    const code = data && typeof data === "object" ? data.appCode : undefined;
    if (code === PRO_GATE_CODES.proRequired || code === PRO_GATE_CODES.freeSyllabusLimit || code === SIGN_IN_REQUIRED_CODE) return code;
    const fromMessage = appErrorCodeForMessage((item as { message?: unknown }).message);
    if (fromMessage) return fromMessage;
  }
  return null;
}

/**
 * The RevenueCat app user id for a Trajectory account. The app logs RevenueCat in with it and the server asks
 * RevenueCat about the same id, so both sides agree on who owns a purchase. Derived from the account's openId
 * ("apple:<sub>"), which never changes for an Apple ID, so a reinstall or a new phone finds the same customer.
 * RevenueCat ids must not contain "/" and should avoid other punctuation: anything outside [A-Za-z0-9._-]
 * becomes "_" ("apple:001.abc" -> "apple_001.abc").
 */
export function revenueCatAppUserId(openId: string): string {
  const safe = openId.trim().replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 100);
  return safe || "unknown";
}
