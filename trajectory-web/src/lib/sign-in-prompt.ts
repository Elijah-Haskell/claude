/**
 * What the tRPC client does with a refusal from the server. It cannot render UI or touch the session itself, so it
 * emits here and the app listens. No dependencies: a Set of listeners and a time-window debounce, pure and testable.
 *
 *  - "The session is gone" (the file's old job was a sign-in prompt, hence its name). An account is required
 *    (lib/features.ts), so a 401 on a call that carried this iPhone's session means the server no longer accepts
 *    it: expired, or the account was deleted. The root listener (app/_layout.tsx) has the server asked once more
 *    (lib/session-store.ts sessionRefused), then drops that session, and the guard there shows the sign-in screen
 *    with "You've been signed out". The plan on the iPhone is never touched.
 *  - "This needs Trajectory Pro": the paywall prompt further down works the same way.
 */
import {
  appErrorCodeFromError,
  FREE_SYLLABUS_LIMIT_ERR_MSG,
  PRO_GATE_CODES,
  PRO_REQUIRED_ERR_MSG,
  SIGN_IN_REQUIRED_CODE,
  type AppErrorCode,
  type ProGateCode,
} from "../shared/pro";
import type { ProRefusalOutcome } from "./pro-identity";

export interface SessionEndedEvent {
  /**
   * The session token the refused request carried. The listener only drops the session if this is still the one
   * the iPhone holds: an answer that arrives after a new sign-in must not end the new session.
   */
  token: string;
}

type Listener = (event: SessionEndedEvent) => void;

const listeners = new Set<Listener>();

export function subscribeSessionEnded(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function emitSessionEnded(event: SessionEndedEvent): void {
  listeners.forEach((listener) => {
    try {
      listener(event);
    } catch {
      // one bad listener must not stop the others
    }
  });
}

/** Test hook: forget every listener. */
export function resetSessionEndedForTests(): void {
  listeners.clear();
}

// ── Debounce ──────────────────────────────────────────────────────────────────

export const PROMPT_DEBOUNCE_MS = 4_000;

/**
 * One alert per window. A tRPC batch of five AI calls that are all refused produces five events
 * within milliseconds; only the first shows an alert until `windowMs` has passed.
 */
export function createPromptDebouncer(options: { windowMs?: number; now?: () => number } = {}) {
  const windowMs = options.windowMs ?? PROMPT_DEBOUNCE_MS;
  const now = options.now ?? (() => Date.now());
  let lastShownAt: number | null = null;
  return {
    /** Returns true when the caller should show the alert now (and records that it did). */
    shouldShow(): boolean {
      const t = now();
      if (lastShownAt !== null && t - lastShownAt < windowMs) return false;
      lastShownAt = t;
      return true;
    },
    /** Called when the user dismisses the alert so a later failure can prompt again straight away. */
    reset(): void {
      lastShownAt = null;
    },
  };
}

// ── Detecting UNAUTHORIZED in a tRPC HTTP response ─────────────────────────────

type ErrorData = { code?: unknown; httpStatus?: unknown };

/**
 * tRPC error envelopes, one per procedure in a batch. The app's client uses the superjson transformer, which wraps
 * the error: `{ error: { json: { message, code, data: { code, httpStatus } } } }`; without a transformer it is
 * `{ error: { data: { code, httpStatus } } }`. Both are read.
 */
function envelopeIsUnauthorized(item: unknown): boolean {
  if (!item || typeof item !== "object") return false;
  const error = (item as { error?: { data?: ErrorData; json?: { data?: ErrorData } } }).error;
  if (!error || typeof error !== "object") return false;
  const data = error.json?.data ?? error.data;
  return Boolean(data && (data.code === "UNAUTHORIZED" || data.httpStatus === 401));
}

/**
 * Did Trajectory's server answer this tRPC request with "not signed in"?
 *  - Sign-in procedures themselves (`auth.*`) are excluded: a failed Apple sign-in shows its own message, and a
 *    refused sign-in is not a session that ended.
 *  - Only an UNAUTHORIZED tRPC envelope in the body counts: on a 401 (every call refused) or in a 207 (mixed batch,
 *    inspected envelope by envelope). A bare 401 without one did not come from the server's own session check (a
 *    proxy or the hosting edge answered), and signing a student out on that would be wrong.
 * Whether that means "the session is gone" also depends on the request having carried one (bearerTokenOf below).
 */
export function responseSaysSignedOut(input: { url: string; status: number; body?: unknown }): boolean {
  if (/\/api\/trpc\/[^?]*\bauth\./.test(input.url)) return false;
  if (input.status !== 401 && input.status !== 207) return false;
  const body = input.body;
  if (Array.isArray(body)) return body.some(envelopeIsUnauthorized);
  return envelopeIsUnauthorized(body);
}

// ── The session a request carries ─────────────────────────────────────────────

type HeadersLike = unknown;

/** Whether request headers (a plain object, a [name, value] list or a Headers instance) carry Authorization. */
export function hasAuthorizationHeader(headers: HeadersLike): boolean {
  if (!headers || typeof headers !== "object") return false;
  if (typeof (headers as { get?: unknown }).get === "function") return Boolean((headers as Headers).get("authorization"));
  const entries: unknown[] = Array.isArray(headers) ? headers : Object.entries(headers as Record<string, unknown>);
  return entries.some((entry) => Array.isArray(entry) && String(entry[0]).toLowerCase() === "authorization" && Boolean(entry[1]));
}

/** The same headers plus `Authorization: Bearer <token>`, in the shape they came in (plain object by default). */
export function withAuthorizationHeader(headers: HeadersLike, token: string): HeadersLike {
  const value = `Bearer ${token}`;
  if (headers && typeof headers === "object" && typeof (headers as { set?: unknown }).set === "function") {
    const copy = new Headers(headers as Headers);
    copy.set("Authorization", value);
    return copy;
  }
  if (Array.isArray(headers)) return [...headers, ["Authorization", value]];
  return { ...((headers as Record<string, string> | null | undefined) ?? {}), Authorization: value };
}

/** The session token in request headers (`Authorization: Bearer <token>`, in any of the three shapes), else null. */
export function bearerTokenOf(headers: HeadersLike): string | null {
  if (!headers || typeof headers !== "object") return null;
  let value: unknown = null;
  if (typeof (headers as { get?: unknown }).get === "function") value = (headers as Headers).get("authorization");
  else {
    const entries: unknown[] = Array.isArray(headers) ? headers : Object.entries(headers as Record<string, unknown>);
    const found = entries.find((entry) => Array.isArray(entry) && String(entry[0]).toLowerCase() === "authorization");
    value = Array.isArray(found) ? found[1] : null;
  }
  const match = typeof value === "string" ? /^Bearer\s+(\S+)$/i.exec(value.trim()) : null;
  return match ? match[1]! : null;
}

/**
 * For the tRPC client's fetch wrapper (lib/trpc.ts): the server answered "not signed in" to a request that carried
 * this session token, so that session is gone. A request that carried none (the browser preview's cookie sessions,
 * or a call made while signed out) ends nothing.
 */
export function noteSignedOutResponse(input: { url: string; status: number; body?: unknown; sentToken: string | null }): void {
  if (input.sentToken && responseSaysSignedOut(input)) emitSessionEnded({ token: input.sentToken });
}

// ── Paywall prompt (server said "this needs Pro") ─────────────────────────────
// Same pattern as the session bus: the tRPC client notices a FORBIDDEN answer carrying one of the Pro-gate codes
// (shared/pro.ts) and emits here; lib/subscription-context.tsx shows one alert that opens the paywall.

export interface PaywallPromptEvent {
  code: ProGateCode;
  /**
   * Set when this iPhone holds Pro but the server refused anyway (see reconcileProRefusal): "confirmed" = the
   * server agrees now, try again; "unconfirmed" = it still does not, offer Restore Purchases. Absent = needs Pro.
   */
  outcome?: Exclude<ProRefusalOutcome, "needs-pro">;
}

const paywallListeners = new Set<(event: PaywallPromptEvent) => void>();

export function subscribePaywallPrompt(listener: (event: PaywallPromptEvent) => void): () => void {
  paywallListeners.add(listener);
  return () => {
    paywallListeners.delete(listener);
  };
}

export function emitPaywallPrompt(event: PaywallPromptEvent): void {
  paywallListeners.forEach((listener) => {
    try {
      listener(event);
    } catch {
      // one bad listener must not stop the others
    }
  });
}

/** Test hook: forget every paywall listener. */
export function resetPaywallPromptForTests(): void {
  paywallListeners.clear();
}

/** The app error code in a tRPC error envelope (plain or superjson-wrapped `{ error: { json: ... } }`), else null. */
function envelopeAppCode(item: unknown): AppErrorCode | null {
  if (!item || typeof item !== "object") return null;
  const error = (item as { error?: unknown }).error;
  if (!error || typeof error !== "object") return null;
  const inner = (error as { json?: unknown }).json;
  return appErrorCodeFromError(error) ?? appErrorCodeFromError(inner);
}

/**
 * The app error code (a Pro-gate code, or SIGN_IN_REQUIRED_CODE for a session that is not an account's) in a tRPC
 * HTTP response body, single or batched, else null. Only FORBIDDEN (403) and mixed-batch (207) responses can carry one.
 */
export function responseAppErrorCode(input: { status: number; body?: unknown }): AppErrorCode | null {
  return responseAppErrorCodes(input).find((code): code is AppErrorCode => code !== null) ?? null;
}

/**
 * The app error code of EVERY item in a tRPC HTTP response body, in order (null for an item without one: a result,
 * or an error of another kind). Empty unless the response is FORBIDDEN (403) or a mixed batch (207).
 */
export function responseAppErrorCodes(input: { status: number; body?: unknown }): Array<AppErrorCode | null> {
  if (input.status !== 403 && input.status !== 207) return [];
  const items = Array.isArray(input.body) ? input.body : [input.body];
  return items.map(envelopeAppCode);
}

/** Just the Pro-gate part of responseAppErrorCode. */
export function responseProGate(input: { status: number; body?: unknown }): ProGateCode | null {
  const code = responseAppErrorCode(input);
  return code === SIGN_IN_REQUIRED_CODE ? null : code;
}

async function appCodesOfResponse(response: Response): Promise<Array<AppErrorCode | null>> {
  if (response.status !== 403 && response.status !== 207) return [];
  try {
    return responseAppErrorCodes({ status: response.status, body: await response.clone().json() });
  } catch {
    return [];
  }
}

const firstCode = (codes: ReadonlyArray<AppErrorCode | null>): AppErrorCode | null =>
  codes.find((code): code is AppErrorCode => code !== null) ?? null;

// What to do when the server says "needs Pro" (registered by lib/subscription-context.tsx, which knows whether
// this iPhone holds Pro). Without a handler every refusal opens the paywall.
let proRefusalHandler: (() => Promise<ProRefusalOutcome>) | null = null;

/** Registers the Pro-refusal handler; returns an unregister function. */
export function setProRefusalHandler(handler: () => Promise<ProRefusalOutcome>): () => void {
  proRefusalHandler = handler;
  return () => {
    if (proRefusalHandler === handler) proRefusalHandler = null;
  };
}

/**
 * A refused request may be sent again only when nothing in it ran and nothing was thrown away: the whole request
 * was refused (403, not a mixed 207 batch where other calls already ran) and EVERY call in it was refused by the
 * Pro gate of a Pro feature (`codes`: each item's code, see responseAppErrorCodes). A batch holding a refused free
 * syllabus import is never re-sent: the server deletes its uploaded file, so the screen's own "Try again" (which
 * uploads again) is the way forward. Neither is one holding any other refusal.
 */
export function canResendRefusal(status: number, codes: ReadonlyArray<AppErrorCode | null>): boolean {
  return status === 403 && codes.length > 0 && codes.every((code) => code === PRO_GATE_CODES.proRequired);
}

/**
 * For the tRPC client's fetch wrapper (lib/trpc.ts), next to the 401 check:
 *   if (response.status === 403 || response.status === 207) response = await noteForbiddenResponse(response, resend, sentToken);
 * - A refusal that asks for an account (SIGN_IN_REQUIRED) means the session the request carried is not a Sign in
 *   with Apple account's (a guest session from a build before accounts were required): it is ended like a 401, so
 *   the student signs in.
 * - A Pro-gate refusal asks the registered handler first. If this iPhone holds Pro, the handler links the purchase
 *   again (RevenueCat logIn + syncPurchases) and has the server re-check; when the server agrees and the request
 *   can be re-sent, it is sent once more and that answer is returned instead. Otherwise one prompt says what
 *   happened: the paywall (no Pro here), "Pro confirmed, try again", or "couldn't confirm, Restore Purchases".
 * The refused response is returned readable (inspected from a clone), so the calling screen still gets its error.
 */
export async function noteForbiddenResponse(response: Response, resend?: () => Promise<Response>, sentToken?: string | null): Promise<Response> {
  const codes = await appCodesOfResponse(response);
  const code = firstCode(codes);
  if (!code) return response;
  if (code === SIGN_IN_REQUIRED_CODE) {
    if (sentToken) emitSessionEnded({ token: sentToken });
    return response;
  }
  const outcome = proRefusalHandler ? await proRefusalHandler().catch((): ProRefusalOutcome => "needs-pro") : "needs-pro";
  if (outcome === "needs-pro") {
    emitPaywallPrompt({ code });
    return response;
  }
  if (outcome === "confirmed" && resend && canResendRefusal(response.status, codes)) {
    const again = await resend().catch(() => null);
    if (again) {
      if (firstCode(await appCodesOfResponse(again)) === null) return again; // through (or failed for another reason)
      emitPaywallPrompt({ code, outcome: "unconfirmed" });
      return again;
    }
  }
  emitPaywallPrompt({ code, outcome });
  return response;
}

/** Alert copy for a Pro-gate refusal. */
export function paywallPromptCopy(code: ProGateCode): { title: string; message: string } {
  return code === PRO_GATE_CODES.freeSyllabusLimit
    ? { title: "Your free syllabus is used", message: FREE_SYLLABUS_LIMIT_ERR_MSG }
    : { title: "Trajectory Pro", message: PRO_REQUIRED_ERR_MSG };
}

/** Alert copy when this iPhone holds Pro but the server refused (never the "buy Pro" paywall). */
export function proMismatchCopy(outcome: Exclude<ProRefusalOutcome, "needs-pro">): { title: string; message: string } {
  return outcome === "confirmed"
    ? { title: "Trajectory Pro is active", message: "Your purchase is confirmed now. Tap Try again." }
    : {
        title: "We couldn't confirm your Pro purchase yet",
        message: "This iPhone shows Trajectory Pro, but our server couldn't confirm it yet. Tap Restore Purchases, then try again.",
      };
}
