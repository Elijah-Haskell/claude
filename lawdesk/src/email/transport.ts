// How a finished message leaves Lawdesk.
//
//   DevTransport   writes each message to a folder as a .eml file (the default; used in tests)
//   SmtpTransport  hands it to a mail server (password, or OAuth through a TokenProvider)
//
// Gmail and Microsoft 365 both accept SMTP with OAuth 2.0 (the XOAUTH2 mechanism). The
// TokenProvider interface is where that plugs in; RefreshTokenProvider is a working
// implementation that swaps a long-lived refresh token for short-lived access tokens.
// Registering the OAuth app itself needs the firm's own Google or Microsoft admin account;
// the steps are in src/email/README.md.

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { type SmtpOptions, type SmtpResult, SmtpError, sendSmtp } from "./smtp.ts";

export interface Envelope {
  from: string;
  to: string[];
}

export interface SendResult {
  response: string;
  rejected?: { address: string; reply: string }[];
}

export interface Transport {
  readonly name: string;
  send(envelope: Envelope, raw: Buffer): Promise<SendResult>;
}

/** Writes messages to a folder instead of sending them. Open the .eml files in any mail program. */
export class DevTransport implements Transport {
  readonly name = "dev";
  readonly dir: string;
  constructor(dir: string) {
    this.dir = resolve(dir);
  }
  async send(envelope: Envelope, raw: Buffer): Promise<SendResult> {
    mkdirSync(this.dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = join(this.dir, `${stamp}-${randomBytes(4).toString("hex")}.eml`);
    // Some mail programs show the envelope recipients if they are noted at the top.
    writeFileSync(file, Buffer.concat([Buffer.from(`X-Lawdesk-Envelope-To: ${envelope.to.join(", ")}\r\n`), raw]));
    return { response: `Saved to ${file}` };
  }
}

/** Something that can hand out a current OAuth 2.0 access token for the sending account. */
export interface TokenProvider {
  readonly name: string;
  accessToken(): Promise<string>;
}

export interface RefreshTokenOptions {
  name: string;
  tokenUrl: string;
  clientId: string;
  clientSecret?: string | null;
  refreshToken: string;
  scope?: string | null;
  fetch?: typeof fetch;
}

/**
 * Exchanges a refresh token for access tokens (RFC 6749 §6, https://www.rfc-editor.org/rfc/rfc6749#section-6)
 * and caches each one until shortly before it expires.
 *   Google:    tokenUrl https://oauth2.googleapis.com/token, scope https://mail.google.com/
 *              (https://developers.google.com/identity/protocols/oauth2/web-server#offline)
 *   Microsoft: tokenUrl https://login.microsoftonline.com/<tenant>/oauth2/v2.0/token,
 *              scope https://outlook.office.com/SMTP.Send offline_access
 *              (https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow#refresh-the-access-token)
 */
export class RefreshTokenProvider implements TokenProvider {
  readonly name: string;
  private cached: { token: string; until: number } | null = null;
  private opts: RefreshTokenOptions;
  constructor(opts: RefreshTokenOptions) {
    this.opts = opts;
    this.name = opts.name;
  }
  async accessToken(): Promise<string> {
    if (this.cached && this.cached.until > Date.now()) return this.cached.token;
    const form = new URLSearchParams({ grant_type: "refresh_token", refresh_token: this.opts.refreshToken, client_id: this.opts.clientId });
    if (this.opts.clientSecret) form.set("client_secret", this.opts.clientSecret);
    if (this.opts.scope) form.set("scope", this.opts.scope);
    const res = await (this.opts.fetch ?? fetch)(this.opts.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok || typeof data.access_token !== "string") {
      // The error code is safe to show; the request body (with the secrets) is never echoed.
      throw new SmtpError(`Could not get a sign-in token from ${this.name}: ${String(data.error ?? res.status).slice(0, 100)}`, null, res.status === 400 || res.status === 401);
    }
    const life = Number(data.expires_in) > 0 ? Number(data.expires_in) : 3600;
    this.cached = { token: data.access_token, until: Date.now() + Math.max(30, life - 60) * 1000 };
    return data.access_token;
  }
}

/** Known mail services. Values from each provider's published SMTP settings. */
export const PROVIDERS = {
  // https://support.google.com/a/answer/176600
  gmail: { label: "Google Workspace / Gmail", host: "smtp.gmail.com", port: 587, security: "starttls" as const },
  // https://learn.microsoft.com/en-us/exchange/mail-flow-best-practices/how-to-set-up-a-multifunction-device-or-application-to-send-email-using-microsoft-365-or-office-365
  microsoft365: { label: "Microsoft 365", host: "smtp.office365.com", port: 587, security: "starttls" as const },
};

export class SmtpTransport implements Transport {
  readonly name = "smtp";
  private opts: SmtpOptions;
  private tokens: TokenProvider | null;
  constructor(opts: SmtpOptions, tokens: TokenProvider | null = null) {
    this.opts = opts;
    this.tokens = tokens;
  }
  async send(envelope: Envelope, raw: Buffer): Promise<SendResult> {
    let o = this.opts;
    if (this.tokens && o.auth) o = { ...o, auth: { ...o.auth, method: "xoauth2", accessToken: await this.tokens.accessToken() } };
    const r: SmtpResult = await sendSmtp(o, envelope, raw);
    return { response: r.response, rejected: r.rejected };
  }
}
