// Shared contract for API routes. Each module exports `routes: Route[]` from
// src/<module>/routes.ts and the server mounts them all under /api.

import type { IncomingMessage } from "node:http";
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
  /** The signed-in user's id, or null until sign-in exists. */
  userId: number | null;
  /** Only on routes with `raw: true`: the request with its body still unread, to stream it. */
  req?: IncomingMessage;
}

export interface Route {
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  /** Path under /api, with :name parameters, e.g. "/matters/:id/tasks". */
  path: string;
  /** Return any JSON-serialisable value. Throw EngineError(message, status) for 4xx. */
  handler: (ctx: Ctx) => unknown | Promise<unknown>;
  /**
   * true: the server does not read or parse the body; the handler streams it from ctx.req
   * (file uploads) and ctx.body is {}. Default false: the body is parsed as JSON.
   */
  raw?: boolean;
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
