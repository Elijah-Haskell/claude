// A stand-in for Clio Manage, built from Clio's published API documentation, so the API
// importer can be tested without a real Clio account. It mimics:
//   - OAuth: POST /oauth/token (form-encoded) for authorization_code and refresh_token grants,
//     with the response fields from Clio's example (token_type, access_token, expires_in,
//     refresh_token); the refresh response has no new refresh token, as in Clio's example.
//   - GET /api/v4/<resource>.json with `fields`, cursor paging (order=id(asc), page_token, at most
//     200 per page, meta.paging.next omitted on the last page) and a { data, meta } body.
//   - Rate limiting per access token in a 60-second window, with X-RateLimit-Limit/-Remaining/
//     -Reset headers on every response and 429 + Retry-After when the limit is exceeded.
// All data in it is made up.

import http from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeClioOpts {
  /** Requests allowed per 60-second window (Clio's documented default is 50). */
  limit?: number;
  now: () => number;
  data: Record<string, any[]>;
  /** Access tokens expire after this many seconds (Clio's example: 2592000 = 30 days). */
  expiresIn?: number;
}

export class FakeClio {
  server: http.Server;
  url = "";
  opts: FakeClioOpts;
  codes = new Set(["good-code"]);
  accessTokens = new Set<string>();
  refreshTokens = new Set<string>();
  /** Every API request: path, token and the time it arrived. */
  log: { path: string; at: number; status: number }[] = [];
  tokenCalls: Record<string, string>[] = [];
  private windows = new Map<string, { start: number; count: number }>();
  private n = 0;
  /** Force the next N API requests to be refused with 429. */
  force429 = 0;
  /** Requests whose fields mentioned a field Clio would reject. */
  badFields: string[] = [];

  constructor(opts: FakeClioOpts) {
    this.opts = opts;
    this.server = http.createServer((req, res) => this.handle(req, res));
  }

  async listen() {
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  close() {
    return new Promise<void>((r) => this.server.close(() => r()));
  }

  /** Make the current access tokens stop working (as if revoked or expired). */
  expireAccessTokens() {
    this.accessTokens.clear();
  }

  private send(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
    res.writeHead(status, { "Content-Type": "application/json", ...headers });
    res.end(body === undefined ? "" : JSON.stringify(body));
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url ?? "/", this.url);
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks).toString("utf8");

    if (req.method === "POST" && url.pathname === "/oauth/token") {
      if (!/application\/x-www-form-urlencoded/.test(req.headers["content-type"] ?? "")) return this.send(res, 400, { error: "invalid_request" });
      const f = Object.fromEntries(new URLSearchParams(body));
      this.tokenCalls.push(f);
      if (f.client_id !== "test-client" || f.client_secret !== "test-secret") return this.send(res, 401, { error: "invalid_client" });
      const access = `at-${++this.n}`;
      if (f.grant_type === "authorization_code") {
        if (!this.codes.has(f.code)) return this.send(res, 400, { error: "invalid_grant" });
        this.codes.delete(f.code);
        const refresh = `rt-${this.n}`;
        this.accessTokens.add(access);
        this.refreshTokens.add(refresh);
        return this.send(res, 200, { token_type: "bearer", access_token: access, expires_in: this.opts.expiresIn ?? 2592000, refresh_token: refresh });
      }
      if (f.grant_type === "refresh_token") {
        if (!this.refreshTokens.has(f.refresh_token)) return this.send(res, 400, { error: "invalid_grant" });
        this.accessTokens.add(access);
        return this.send(res, 200, { token_type: "bearer", access_token: access, expires_in: this.opts.expiresIn ?? 2592000 });
      }
      return this.send(res, 400, { error: "unsupported_grant_type" });
    }
    if (req.method === "POST" && url.pathname === "/oauth/deauthorize") {
      this.accessTokens.delete(new URLSearchParams(body).get("token") ?? "");
      return this.send(res, 200, undefined);
    }

    const m = /^\/api\/v4\/([a-z_]+)\.json$/.exec(url.pathname);
    if (req.method !== "GET" || !m) return this.send(res, 404, { error: { message: "Not found" } });
    const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1] ?? "";
    if (!this.accessTokens.has(token)) {
      this.log.push({ path: url.pathname + url.search, at: this.opts.now(), status: 401 });
      return this.send(res, 401, { error: { type: "UnauthorizedError", message: "The access token provided is expired, revoked, malformed or invalid for other reasons." } });
    }

    // Rate limit: a fixed 60-second window per access token.
    const now = this.opts.now();
    const limit = this.opts.limit ?? 50;
    let w = this.windows.get(token);
    if (!w || now >= w.start + 60_000) {
      w = { start: now, count: 0 };
      this.windows.set(token, w);
    }
    const resetSec = Math.ceil((w.start + 60_000) / 1000);
    const over = w.count >= limit || this.force429 > 0;
    if (!over) w.count++;
    const rl = { "X-RateLimit-Limit": String(limit), "X-RateLimit-Remaining": String(Math.max(0, limit - w.count)), "X-RateLimit-Reset": String(resetSec) };
    if (over) {
      if (this.force429 > 0) this.force429--;
      this.log.push({ path: url.pathname + url.search, at: now, status: 429 });
      return this.send(res, 429, { error: { type: "RateLimited", message: "Too many requests" } }, { ...rl, "Retry-After": String(Math.max(1, resetSec - Math.floor(now / 1000))) });
    }
    this.log.push({ path: url.pathname + url.search, at: now, status: 200 });

    const rows = this.opts.data[m[1]];
    if (!rows) return this.send(res, 404, { error: { message: `No resource ${m[1]}` } }, rl);
    if (url.searchParams.get("order") !== "id(asc)") return this.send(res, 422, { error: { message: "Cursor paging needs order=id(asc)" } }, rl);
    const limitN = Math.min(200, Number(url.searchParams.get("limit") ?? 200));
    const after = url.searchParams.get("page_token") ? Number(Buffer.from(url.searchParams.get("page_token")!, "base64url").toString()) : 0;
    const sorted = [...rows].sort((a, b) => a.id - b.id).filter((r) => r.id > after);
    const page = sorted.slice(0, limitN);
    const fields = topLevelFields(url.searchParams.get("fields") ?? "id,etag");
    const data = page.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => fields.includes(k))));
    const meta: any = { paging: {}, records: rows.length };
    if (sorted.length > limitN) {
      const next = new URL(url);
      next.searchParams.set("page_token", Buffer.from(String(page[page.length - 1].id)).toString("base64url"));
      meta.paging.next = next.toString();
    }
    return this.send(res, 200, { data, meta }, rl);
  }
}

/** "id,name,client{id,name}" -> ["id","name","client"] */
function topLevelFields(spec: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of spec) {
    if (ch === "{") depth++;
    if (ch === "}") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur.replace(/\{.*$/, ""));
      cur = "";
    } else cur += ch;
  }
  if (cur) out.push(cur.replace(/\{.*$/, ""));
  return out;
}

/** Made-up firm data in the shape of Clio's API responses. */
export function fakeFirm(nContacts = 450) {
  const users = [
    { id: 11, name: "Jordan Reyes", first_name: "Jordan", last_name: "Reyes", email: "jordan@example.com", enabled: true, subscription_type: "Attorney" },
    { id: 12, name: "Sam Patel", first_name: "Sam", last_name: "Patel", email: "sam@example.com", enabled: true, subscription_type: "NonAttorney" },
    { id: 13, name: "Former Associate", first_name: "Former", last_name: "Associate", email: "former@example.com", enabled: false, subscription_type: "Attorney" },
  ];
  const contacts: any[] = [];
  for (let i = 1; i <= nContacts; i++) {
    const company = i % 5 === 0;
    contacts.push({
      id: 1000 + i,
      type: company ? "Company" : "Person",
      name: company ? `Example Holdings ${i} LLC` : `Person${i} Sample`,
      first_name: company ? null : `Person${i}`,
      last_name: company ? null : "Sample",
      primary_email_address: `c${i}@example.com`,
      primary_phone_number: `785-555-${String(i).padStart(4, "0")}`,
      addresses: i % 7 === 0 ? [{ name: "Work", street: `${i} Sample Rd`, city: "Topeka", province: "KS", postal_code: "66601", country: "US" }] : [],
    });
  }
  const matters = [
    { id: 501, display_number: "00501-Sample", description: "Sample lease", status: "Open", open_date: "2026-01-05", close_date: null, client: { id: 1001, name: "Person1 Sample", type: "Person" }, practice_area: { id: 1, name: "Real Estate" }, responsible_attorney: { id: 11, name: "Jordan Reyes" }, originating_attorney: { id: 13, name: "Former Associate" } },
    { id: 502, display_number: "00502-Holdings", description: "Holdings formation", status: "Closed", open_date: "2025-02-01", close_date: "2025-05-01", client: { id: 1005, name: "Example Holdings 5 LLC", type: "Company" }, practice_area: { id: 2, name: "Business" }, responsible_attorney: { id: 11, name: "Jordan Reyes" } },
    { id: 503, display_number: "00503-Pending", description: "Pending dispute", status: "Pending", open_date: "2026-02-01", pending_date: "2026-02-10", client: { id: 1002, name: "Person2 Sample", type: "Person" }, practice_area: null, responsible_attorney: null },
  ];
  const tasks = [
    { id: 701, name: "Review title", description: "Check exceptions", due_at: "2026-03-20", status: "pending", priority: "High", matter: { id: 501 }, assignee: { id: 12, name: "Sam Patel", type: "User" } },
    { id: 702, name: "File articles", due_at: "2025-02-10", status: "complete", completed_at: "2025-02-09T21:00:00Z", priority: "Normal", matter: { id: 502 }, assignee: { id: 11, name: "Jordan Reyes", type: "User" } },
    { id: 703, name: "Client to send documents", status: "in_review", priority: "Low", matter: { id: 503 }, assignee: { id: 1002, name: "Person2 Sample", type: "Contact" } },
  ];
  const calendar_entries = [
    { id: 801, summary: "Closing", start_at: "2026-03-25T15:00:00Z", end_at: "2026-03-25T16:00:00Z", all_day: false, location: "Office", matter: { id: 501 } },
    { id: 802, summary: "Office closed", start_at: "2026-03-30T05:00:00Z", end_at: "2026-03-31T05:00:00Z", all_day: true },
  ];
  const activities = [
    { id: 901, type: "TimeEntry", date: "2026-03-02", quantity_in_hours: 1.5, quantity: 5400, price: 250.0, total: 375.0, note: "Reviewed lease", billed: false, non_billable: false, matter: { id: 501 }, user: { id: 11, name: "Jordan Reyes" }, activity_description: { name: "Review" } },
    { id: 902, type: "TimeEntry", date: "2026-02-02", quantity_in_hours: 2, quantity: 7200, price: 250.0, total: 500.0, note: "Drafted articles", billed: true, non_billable: false, matter: { id: 502 }, user: { id: 11, name: "Jordan Reyes" } },
    { id: 903, type: "ExpenseEntry", date: "2026-03-03", quantity: 1, price: 35.5, total: 35.5, note: "Recording fee", billed: false, non_billable: false, matter: { id: 501 }, user: { id: 12, name: "Sam Patel" } },
    { id: 904, type: "TimeEntry", date: "2026-03-04", quantity_in_hours: 0.3, quantity: 1080, price: 120.0, total: 36.0, note: "Scheduling", billed: false, non_billable: true, matter: { id: 501 }, user: { id: 12, name: "Sam Patel" } },
    { id: 905, type: "TimeEntry", date: "2026-03-04", quantity_in_hours: 1, quantity: 3600, price: 250, total: 250, note: "No matter", billed: false, matter: null, user: { id: 11, name: "Jordan Reyes" } },
  ];
  return { users, contacts, matters, tasks, calendar_entries, activities };
}
