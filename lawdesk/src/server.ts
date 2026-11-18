// The web server: serves the single-page app from public/ and every module's API under /api.
//
//   PORT=3000 LAWDESK_DB=lawdesk.db npm start
//
// There is no sign-in yet. The app sends the person it is "working as" in the
// X-Lawdesk-User header so the activity log can say who did what; that is attribution,
// not security, and the server must not be exposed beyond the firm's own machine until
// real sign-in exists.

import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb, type DB } from "./db.ts";
import { Engine, EngineError } from "./engine.ts";
import { matchPath, type Ctx, type Route } from "./http.ts";
import type { ISODate } from "./dates.ts";
import { modules, type Module } from "./modules.ts";

const PUBLIC_DIR = resolve(fileURLToPath(new URL("../public", import.meta.url)));
// Document uploads arrive as base64 JSON (25 MiB decoded), so the limit is about 34 MiB.
const BODY_LIMIT = 34 * 1024 * 1024;

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'",
};

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Open the database file and create every module's tables. */
export function openDatabase(path: string): DB {
  const db = openDb(path);
  for (const m of modules) if (m.schema) db.exec(m.schema);
  return db;
}

interface Mounted extends Route {
  module: string;
}

export function createServer(
  db: DB,
  opts: { today?: () => ISODate; log?: (...a: unknown[]) => void; modules?: Module[] } = {},
) {
  const mods = opts.modules ?? modules;
  for (const m of mods) if (m.schema) db.exec(m.schema);
  const engine = new Engine(db, opts.today ? { today: opts.today } : {});
  const log = opts.log ?? ((...a: unknown[]) => console.error(...a));
  const routes: Mounted[] = mods.flatMap((m) => m.routes.map((r) => ({ ...r, module: m.name })));

  async function handleApi(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
    const path = url.pathname.slice(4) || "/";
    let params: Record<string, string> | null = null;
    let route: Mounted | undefined;
    let pathMatched = false;
    // Routes are tried in array order and the first match wins, so a module can put
    // "/documents/search" ahead of "/documents/:id".
    for (const r of routes) {
      const p = matchPath(r.path, path);
      if (!p) continue;
      pathMatched = true;
      if (r.method === req.method) {
        route = r;
        params = p;
        break;
      }
    }
    if (!route) throw new HttpError(pathMatched ? 405 : 404, pathMatched ? "Method not allowed" : "No such API route");
    const body = req.method === "GET" || req.method === "DELETE" ? await readBody(req, true) : await readBody(req, false);
    const ctx: Ctx = { db, engine, params: params!, query: url.searchParams, body, userId: actingUser(db, req) };
    const out: any = await route.handler(ctx);
    if (out && typeof out === "object" && out.__raw === true) return sendRaw(res, out);
    sendJson(res, 200, out === undefined ? { ok: true } : out);
  }

  const server = http.createServer(async (req, res) => {
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://localhost");
    } catch {
      return sendJson(res, 400, { error: "Bad URL" });
    }
    try {
      if (url.pathname === "/api" || url.pathname.startsWith("/api/")) await handleApi(req, res, url);
      else await serveStatic(req, res, url.pathname);
    } catch (err: any) {
      const status = statusOf(err);
      if (status) sendJson(res, status, { error: err.message });
      else {
        log(`[lawdesk] ${req.method} ${url.pathname} failed:`, err);
        sendJson(res, 500, { error: "Something went wrong on the server. The change was not saved." });
      }
    }
  });
  return server;
}

/** 4xx errors carry their own message to the user; anything else is a server fault. */
function statusOf(err: any): number | null {
  if (err instanceof EngineError || err instanceof HttpError) return err.status;
  // intParam() in http.ts throws a plain Error with a 400 status.
  if (err && typeof err.status === "number" && err.status >= 400 && err.status < 500) return err.status;
  return null;
}

function actingUser(db: DB, req: http.IncomingMessage): number | null {
  const raw = req.headers["x-lawdesk-user"];
  const id = Number(Array.isArray(raw) ? raw[0] : raw);
  if (!Number.isInteger(id) || id <= 0) return null;
  return db.prepare("SELECT id FROM users WHERE id = ?").get(id) ? id : null;
}

function readBody(req: http.IncomingMessage, optional: boolean): Promise<any> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    req.on("data", (c: Buffer) => {
      if (failed) return;
      size += c.length;
      if (size > BODY_LIMIT) {
        failed = true;
        reject(new HttpError(413, "That request is too large (limit 34 MB)"));
        req.resume();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (failed) return;
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (!text) return resolveBody({});
      try {
        const v = JSON.parse(text);
        if (v === null || typeof v !== "object" || Array.isArray(v)) throw new Error("not an object");
        resolveBody(v);
      } catch {
        if (optional) resolveBody({});
        else reject(new HttpError(400, "The request body must be a JSON object"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, value: unknown) {
  if (res.headersSent) return res.end();
  const body = JSON.stringify(value);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...SECURITY_HEADERS });
  res.end(body);
}

/**
 * A handler can skip JSON by returning
 * { __raw: true, status?, contentType, headers?, body } (e.g. the calendar's .ics feed).
 */
function sendRaw(
  res: http.ServerResponse,
  out: { status?: number; contentType?: string; headers?: Record<string, string>; body?: string | Uint8Array },
) {
  const body = out.body ?? "";
  res.writeHead(out.status ?? 200, {
    "Cache-Control": "no-store",
    ...SECURITY_HEADERS,
    ...(out.headers ?? {}),
    "Content-Type": out.contentType ?? "application/octet-stream",
    "Content-Length": typeof body === "string" ? Buffer.byteLength(body) : body.byteLength,
  });
  res.end(body);
}

async function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, pathname: string) {
  if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "Method not allowed");
  let rel: string;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    throw new HttpError(400, "Bad path");
  }
  if (rel.includes("\0")) throw new HttpError(400, "Bad path");
  if (rel === "/" || rel === "") rel = "/index.html";
  const file = normalize(join(PUBLIC_DIR, rel));
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + sep)) throw new HttpError(404, "Not found");
  let data: Buffer;
  try {
    const s = await stat(file);
    if (!s.isFile()) throw new Error("not a file");
    data = await readFile(file);
  } catch {
    throw new HttpError(404, "Not found");
  }
  res.writeHead(200, {
    "Content-Type": TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
    "Content-Length": data.length,
    "Cache-Control": "no-cache",
    ...SECURITY_HEADERS,
  });
  res.end(req.method === "HEAD" ? undefined : data);
}

// Run directly: `node src/server.ts`
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 3000);
  const dbPath = process.env.LAWDESK_DB ?? "lawdesk.db";
  const db = openDatabase(dbPath);
  const server = createServer(db);
  // Local machine only by default: there is no sign-in yet.
  const host = process.env.HOST ?? "127.0.0.1";
  server.listen(port, host, () => {
    console.log(`Lawdesk on http://localhost:${port}  (database: ${dbPath})`);
  });
  const stop = () => server.close(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
