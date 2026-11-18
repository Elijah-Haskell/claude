// Shared contract for API routes. Each module exports `routes: Route[]` from
// src/<module>/routes.ts and the server mounts them all under /api.

import type { DB } from "./db.ts";
import type { Engine } from "./engine.ts";

export interface Ctx {
  db: DB;
  engine: Engine;
  /** Path parameters, e.g. { id: "12" } for "/matters/:id". */
  params: Record<string, string>;
  query: URLSearchParams;
  /** Parsed JSON body (or {} when there is none). */
  body: any;
  /** The signed-in user's id (from the session cookie), or null on a public route with nobody signed in. */
  userId: number | null;
  /** The signed-in account's access level: admin, attorney, staff or client (see src/auth/access.ts). */
  role?: string | null;
  /** The current session's id, for "sign out" and "this device" (auth routes use it). */
  sessionId?: number | null;
  /** About the request: caller's address, browser, whether it came over https. */
  client?: { ip: string | null; userAgent: string | null; secure: boolean };
}

export interface Route {
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  /** Path under /api, with :name parameters, e.g. "/matters/:id/tasks". */
  path: string;
  /** Return any JSON-serialisable value. Throw EngineError(message, status) for 4xx. */
  handler: (ctx: Ctx) => unknown | Promise<unknown>;
  /**
   * Open without signing in. Only for sign-in screens and URLs whose token is their own
   * secret (the calendar .ics feed). Everything else needs a signed-in staff account.
   */
  public?: boolean;
  /** Only these access levels may call it, e.g. ADMIN or ATTORNEYS from src/auth/access.ts. Default: admin, attorney, staff. */
  roles?: string[];
  /**
   * false skips the X-Requested-With check on POST/PATCH/PUT/DELETE. Only for public
   * machine-to-machine routes (a payment processor's webhook) that verify a signature.
   */
  csrf?: false;
}

export function matchPath(pattern: string, path: string): Record<string, string> | null {
  const p = pattern.split("/").filter(Boolean);
  const a = path.split("/").filter(Boolean);
  if (p.length !== a.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    if (p[i].startsWith(":")) params[p[i].slice(1)] = decodeURIComponent(a[i]);
    else if (p[i] !== a[i]) return null;
  }
  return params;
}

export function intParam(ctx: Ctx, name: string): number {
  const n = Number(ctx.params[name]);
  if (!Number.isInteger(n) || n <= 0) throw Object.assign(new Error(`Bad ${name}`), { status: 400 });
  return n;
}
