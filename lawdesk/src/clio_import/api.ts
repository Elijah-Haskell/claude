// Client for the Clio Manage API v4: OAuth 2 sign-in (authorization-code flow), token storage,
// and a request queue that keeps to Clio's rate limit. Sources for every behaviour here are in
// docs/clio-import.md. In short:
//
//   authorize   GET  {host}/oauth/authorize?response_type=code&client_id&redirect_uri&state
//   token       POST {host}/oauth/token  (form-encoded) grant_type=authorization_code | refresh_token
//   deauthorize POST {host}/oauth/deauthorize  token=<access token>
//   API         {host}/api/v4/<resource>.json, Authorization: Bearer <access token>
//   paging      ?order=id(asc)&limit=200, then follow meta.paging.next until it is absent
//   rate limit  per access token, "50 requests per minute during peak hours" by default; every
//               response carries X-RateLimit-Limit / -Remaining / -Reset (unix time the window
//               ends); a 429 carries Retry-After (seconds).
//   tokens      access tokens last 30 days (expires_in 2592000 in Clio's example); refresh
//               tokens don't expire, so they are stored encrypted when CLIO_TOKEN_KEY is set.

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { DB } from "../db.ts";

export const REGIONS: Record<string, string> = {
  us: "https://app.clio.com",
  eu: "https://eu.app.clio.com",
  ca: "https://ca.app.clio.com",
  au: "https://au.app.clio.com",
};

export interface ClioConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  region: string;
  /** Host to talk to; defaults to the region's host. Tests point this at a fake Clio. */
  host: string;
  /** Secret used to encrypt stored tokens. Without it, tokens are stored as plain text (and the screen says so). */
  tokenKey: string | null;
}

/** Read the Clio app settings from the environment. Returns null when the firm hasn't set them. */
export function configFromEnv(env: Record<string, string | undefined> = process.env): ClioConfig | null {
  const clientId = env.CLIO_CLIENT_ID?.trim();
  const clientSecret = env.CLIO_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  const region = (env.CLIO_REGION ?? "us").trim().toLowerCase();
  if (!REGIONS[region]) throw new Error(`CLIO_REGION must be one of ${Object.keys(REGIONS).join(", ")}`);
  const port = env.PORT ?? "3000";
  return {
    clientId,
    clientSecret,
    region,
    host: REGIONS[region],
    redirectUri: env.CLIO_REDIRECT_URI?.trim() || `http://localhost:${port}/api/clio-import/oauth/callback`,
    tokenKey: env.CLIO_TOKEN_KEY?.trim() || null,
  };
}

export class ClioApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export type FetchFn = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export interface ClientDeps {
  fetch?: FetchFn;
  /** Wait this many milliseconds. Tests replace it so nothing really waits. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Told whenever the client pauses for the rate limit (until = ms timestamp), and again with null when it resumes. */
  onWait?: (until: number | null, why: string) => void;
}

// ------------------------------------------------------------------ token storage

function keyBytes(secret: string) {
  return createHash("sha256").update(secret).digest();
}

export function encrypt(plain: string, secret: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", keyBytes(secret), iv);
  const body = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return ["v1", iv.toString("base64"), c.getAuthTag().toString("base64"), body.toString("base64")].join(":");
}

export function decrypt(stored: string, secret: string): string {
  const [v, iv, tag, body] = stored.split(":");
  if (v !== "v1" || !iv || !tag || body == null) throw new Error("Stored Clio token is not in the expected format");
  const d = createDecipheriv("aes-256-gcm", keyBytes(secret), Buffer.from(iv, "base64"));
  d.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(body, "base64")), d.final()]).toString("utf8");
}

export interface Tokens {
  accessToken: string;
  refreshToken: string | null;
  /** ms timestamp, or null when Clio didn't say. */
  expiresAt: number | null;
}

export class TokenStore {
  db: DB;
  cfg: ClioConfig;
  constructor(db: DB, cfg: ClioConfig) {
    this.db = db;
    this.cfg = cfg;
  }
  get(): (Tokens & { connectedAt: string; encrypted: boolean }) | null {
    const r = this.db.prepare("SELECT * FROM clio_import_tokens WHERE id = 1").get() as any;
    if (!r) return null;
    const open = (v: string | null) => (v == null ? null : r.encrypted ? decrypt(v, this.need()) : v);
    return {
      accessToken: open(r.access_token)!,
      refreshToken: open(r.refresh_token),
      expiresAt: r.expires_at ? Date.parse(r.expires_at) : null,
      connectedAt: r.connected_at,
      encrypted: !!r.encrypted,
    };
  }
  private need(): string {
    if (!this.cfg.tokenKey) throw new ClioApiError("The Clio connection was saved encrypted, but CLIO_TOKEN_KEY is not set now", 500);
    return this.cfg.tokenKey;
  }
  save(t: Tokens, nowMs: number, userId: number | null = null) {
    const enc = !!this.cfg.tokenKey;
    const seal = (v: string | null) => (v == null ? null : enc ? encrypt(v, this.cfg.tokenKey!) : v);
    const prev = this.db.prepare("SELECT connected_at, connected_by FROM clio_import_tokens WHERE id = 1").get() as any;
    this.db
      .prepare(
        `INSERT INTO clio_import_tokens (id, region, access_token, refresh_token, expires_at, encrypted, connected_at, connected_by)
         VALUES (1,?,?,?,?,?,?,?)
         ON CONFLICT (id) DO UPDATE SET region = excluded.region, access_token = excluded.access_token,
           refresh_token = excluded.refresh_token, expires_at = excluded.expires_at, encrypted = excluded.encrypted`,
      )
      .run(
        this.cfg.region,
        seal(t.accessToken),
        seal(t.refreshToken),
        t.expiresAt ? new Date(t.expiresAt).toISOString() : null,
        enc ? 1 : 0,
        prev?.connected_at ?? new Date(nowMs).toISOString(),
        prev?.connected_by ?? userId,
      );
  }
  clear() {
    this.db.prepare("DELETE FROM clio_import_tokens").run();
  }
}

// ------------------------------------------------------------------ the pacer

/**
 * Spaces requests out so they never exceed Clio's limit. Before Clio has told us anything it
 * assumes the documented default (50 a minute) and leaves 1.2 s between requests. After each
 * response it uses the headers: when the window is used up it waits for X-RateLimit-Reset;
 * otherwise it spreads the remaining requests evenly over what is left of the window.
 */
export class Pacer {
  limit = 50;
  remaining: number | null = null;
  resetAt: number | null = null; // ms
  private last = -Infinity;
  /** Keep a couple of requests in hand for the person using Clio at the same time. */
  reserve = 2;

  delay(now: number): number {
    if (this.remaining != null && this.resetAt != null && now < this.resetAt) {
      const usable = this.remaining - this.reserve;
      if (usable <= 0) return this.resetAt - now + 250;
      return Math.max(0, this.last + (this.resetAt - now) / usable - now);
    }
    return Math.max(0, this.last + 60_000 / Math.max(1, this.limit) - now);
  }

  sent(now: number) {
    this.last = now;
  }

  update(h: { get(name: string): string | null }) {
    const n = (k: string) => {
      const v = h.get(k);
      const x = v == null ? NaN : Number(v);
      return Number.isFinite(x) ? x : null;
    };
    const limit = n("X-RateLimit-Limit");
    if (limit != null && limit > 0) this.limit = limit;
    const rem = n("X-RateLimit-Remaining");
    if (rem != null) this.remaining = rem;
    const reset = n("X-RateLimit-Reset");
    if (reset != null) this.resetAt = reset * 1000;
  }
}

// ------------------------------------------------------------------ the client

export class ClioClient {
  db: DB;
  cfg: ClioConfig;
  tokens: TokenStore;
  pacer = new Pacer();
  private fetch: FetchFn;
  private sleep: (ms: number) => Promise<void>;
  private now: () => number;
  onWait: (until: number | null, why: string) => void;
  /** Requests made (for progress and tests). */
  requests = 0;

  constructor(db: DB, cfg: ClioConfig, deps: ClientDeps = {}) {
    this.db = db;
    this.cfg = cfg;
    this.tokens = new TokenStore(db, cfg);
    this.fetch = deps.fetch ?? ((url, init) => fetch(url, init as RequestInit) as any);
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = deps.now ?? (() => Date.now());
    this.onWait = deps.onWait ?? (() => {});
  }

  // ---------------------------------------------------------- OAuth

  /** The Clio sign-in page to send the person to. The state value is saved and checked on return. */
  authorizeUrl(userId: number | null = null): string {
    const state = randomBytes(18).toString("base64url");
    this.db.prepare("DELETE FROM clio_import_oauth_states WHERE created_at < ?").run(new Date(this.now() - 3600_000).toISOString());
    this.db.prepare("INSERT INTO clio_import_oauth_states (state, created_at, user_id) VALUES (?,?,?)").run(state, new Date(this.now()).toISOString(), userId);
    const q = new URLSearchParams({ response_type: "code", client_id: this.cfg.clientId, redirect_uri: this.cfg.redirectUri, state });
    return `${this.cfg.host}/oauth/authorize?${q}`;
  }

  /** Finish sign-in: check the state, swap the code for tokens, store them. */
  async completeAuthorization(params: { code?: string | null; state?: string | null; error?: string | null }, userId: number | null = null) {
    if (params.error) throw new ClioApiError(params.error === "access_denied" ? "Clio access was declined" : `Clio said: ${params.error}`, 400);
    const row = params.state ? (this.db.prepare("SELECT * FROM clio_import_oauth_states WHERE state = ?").get(params.state) as any) : null;
    if (!row) throw new ClioApiError("This Clio sign-in link has expired or was not started here. Start again from Settings.", 400);
    this.db.prepare("DELETE FROM clio_import_oauth_states WHERE state = ?").run(params.state);
    // Clio's authorization code is good for 10 minutes; give up on older round trips.
    if (this.now() - Date.parse(row.created_at) > 15 * 60_000) throw new ClioApiError("The Clio sign-in took too long. Start again.", 400);
    if (!params.code) throw new ClioApiError("Clio did not send an authorization code", 400);
    const t = await this.tokenRequest({
      grant_type: "authorization_code",
      code: params.code,
      redirect_uri: this.cfg.redirectUri,
    });
    if (!t.refreshToken) throw new ClioApiError("Clio did not send a refresh token", 502);
    this.tokens.save(t, this.now(), userId ?? row.user_id ?? null);
  }

  async refresh(): Promise<Tokens> {
    const cur = this.tokens.get();
    if (!cur?.refreshToken) throw new ClioApiError("Not connected to Clio", 401);
    const t = await this.tokenRequest({ grant_type: "refresh_token", refresh_token: cur.refreshToken });
    // Clio's documented refresh response has no new refresh token; keep the one we have.
    const merged = { ...t, refreshToken: t.refreshToken ?? cur.refreshToken };
    this.tokens.save(merged, this.now());
    return merged;
  }

  async disconnect() {
    const cur = this.tokens.get();
    if (cur) {
      try {
        await this.fetch(`${this.cfg.host}/oauth/deauthorize`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Bearer ${cur.accessToken}` },
          body: new URLSearchParams({ token: cur.accessToken }).toString(),
        });
      } catch {
        /* forget the token locally even if Clio can't be reached */
      }
    }
    this.tokens.clear();
  }

  private async tokenRequest(fields: Record<string, string>): Promise<Tokens> {
    const body = new URLSearchParams({ client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret, ...fields }).toString();
    const res = await this.fetch(`${this.cfg.host}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body,
    });
    const text = await res.text();
    let j: any = null;
    try {
      j = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    if (res.status !== 200 || !j?.access_token) {
      const why = j?.error_description ?? j?.error ?? `HTTP ${res.status}`;
      throw new ClioApiError(`Clio refused the sign-in (${why})`, res.status === 200 ? 502 : 400);
    }
    return {
      accessToken: j.access_token,
      refreshToken: j.refresh_token ?? null,
      expiresAt: Number.isFinite(Number(j.expires_in)) ? this.now() + Number(j.expires_in) * 1000 : null,
    };
  }

  // ---------------------------------------------------------- requests

  /** GET a path ("/api/v4/users.json?...") or a full URL Clio gave us (meta.paging.next). */
  async get(pathOrUrl: string): Promise<any> {
    const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${this.cfg.host}${pathOrUrl}`;
    if (!url.startsWith(this.cfg.host + "/")) throw new ClioApiError("Refusing to send the Clio token to another site", 400);
    let refreshed = false;
    let tries429 = 0;
    let tries5xx = 0;
    for (;;) {
      let tok = this.tokens.get();
      if (!tok) throw new ClioApiError("Not connected to Clio", 401);
      if (tok.expiresAt != null && tok.expiresAt - this.now() < 60_000 && !refreshed) {
        tok = { ...tok, ...(await this.refresh()) };
        refreshed = true;
      }
      const wait = this.pacer.delay(this.now());
      if (wait > 0) {
        if (wait > 5000) this.onWait(this.now() + wait, "Keeping to Clio's request limit");
        await this.sleep(wait);
        if (wait > 5000) this.onWait(null, "");
      }
      this.pacer.sent(this.now());
      this.requests++;
      let res;
      try {
        res = await this.fetch(url, { method: "GET", headers: { Authorization: `Bearer ${tok.accessToken}`, Accept: "application/json" } });
      } catch (e: any) {
        if (++tries5xx > 5) throw new ClioApiError(`Can't reach Clio (${e?.message ?? e})`, 502);
        await this.sleep(2 ** tries5xx * 1000);
        continue;
      }
      this.pacer.update(res.headers);
      if (res.status === 200) {
        const text = await res.text();
        try {
          return JSON.parse(text);
        } catch {
          throw new ClioApiError("Clio sent something that isn't JSON", 502);
        }
      }
      if (res.status === 429) {
        if (++tries429 > 8) throw new ClioApiError("Clio kept saying too many requests; try again later", 429);
        const ra = Number(res.headers.get("Retry-After"));
        const ms = (Number.isFinite(ra) && ra > 0 ? ra : 60) * 1000;
        this.pacer.remaining = 0;
        this.pacer.resetAt = this.now() + ms;
        continue; // the pacer now waits out Retry-After
      }
      if (res.status === 401 && !refreshed) {
        await this.refresh();
        refreshed = true;
        continue;
      }
      if (res.status >= 500) {
        if (++tries5xx > 5) throw new ClioApiError(`Clio had a problem (HTTP ${res.status})`, 502);
        await this.sleep(2 ** tries5xx * 1000);
        continue;
      }
      let msg = `HTTP ${res.status}`;
      try {
        const j = JSON.parse(await res.text());
        msg = j?.error?.message ?? j?.message ?? msg;
      } catch {
        /* keep the status */
      }
      throw new ClioApiError(res.status === 401 ? "Clio no longer accepts this connection; connect again" : `Clio refused the request: ${msg}`, res.status === 401 ? 401 : 502);
    }
  }
}
