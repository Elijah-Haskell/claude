// What the server checks on every /api request before a handler runs: the session cookie,
// the CSRF header, and whether the route is open to this person's role.

import type http from "node:http";
import type { DB } from "../db.ts";
import { EngineError } from "../engine.ts";
import type { Route } from "../http.ts";
import { sessionFromToken, LIMITS, type SessionInfo } from "./accounts.ts";
import { STAFF } from "./access.ts";

export const COOKIE = "lawdesk_session";
/** Non-GET requests must carry this header. A plain HTML form or a cross-site page can't set it. */
export const CSRF_HEADER = "x-requested-with";
export const CSRF_VALUE = "lawdesk";

export function readCookie(req: http.IncomingMessage, name = COOKIE): string | null {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

const trustProxy = () => process.env.LAWDESK_TRUST_PROXY === "1";

/** Secure cookies when told to, or when the request came over https. */
export function isSecure(req: http.IncomingMessage): boolean {
  if (process.env.LAWDESK_SECURE_COOKIES === "1") return true;
  if ((req.socket as any).encrypted) return true;
  return trustProxy() && String(req.headers["x-forwarded-proto"] ?? "").split(",")[0].trim() === "https";
}

export function clientIp(req: http.IncomingMessage): string | null {
  if (trustProxy()) {
    const fwd = String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim();
    if (fwd) return fwd.slice(0, 64);
  }
  return req.socket.remoteAddress ?? null;
}

export function sessionCookie(token: string, secure: boolean): string {
  // Max-Age matches the absolute limit; the server also enforces idle and absolute expiry.
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(LIMITS.absoluteMs / 1000)}${secure ? "; Secure" : ""}`;
}

export function clearCookie(secure: boolean): string {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`;
}

export interface Who extends SessionInfo {}

export function authenticate(db: DB, req: http.IncomingMessage): Who | null {
  return sessionFromToken(db, readCookie(req));
}

/**
 * Throws 401/403 unless this request may run the route.
 * - public routes: anyone (the handler still sees who is signed in, if anyone);
 * - otherwise a signed-in account whose role is in route.roles (default: admin, attorney, staff);
 * - someone who must change a temporary password can only use the auth routes until they do.
 */
export function authorize(route: Route & { module?: string }, who: Who | null, req: http.IncomingMessage) {
  if (req.method !== "GET" && req.method !== "HEAD" && route.csrf !== false) {
    if (String(req.headers[CSRF_HEADER] ?? "").toLowerCase() !== CSRF_VALUE) {
      throw new EngineError("This request was refused because it didn't come from the Lawdesk app. Reload the page and try again.", 403);
    }
  }
  if (route.public) return;
  if (!who) throw new EngineError("Please sign in.", 401);
  if (who.mustChangePassword && route.module !== "auth") throw new EngineError("Choose a new password before continuing.", 403);
  const roles = route.roles ?? STAFF;
  if (!roles.includes(who.role)) throw new EngineError("Your account doesn't have access to this. Ask an administrator if you need it.", 403);
}
