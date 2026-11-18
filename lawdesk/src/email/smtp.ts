// A minimal SMTP client: enough to hand one message to the firm's mail server.
//
//   RFC 5321  SMTP (EHLO, MAIL, RCPT, DATA, dot-stuffing §4.5.2, reply codes §4.2)
//             https://www.rfc-editor.org/rfc/rfc5321
//   RFC 3207  STARTTLS                    https://www.rfc-editor.org/rfc/rfc3207
//   RFC 8314  implicit TLS (port 465)     https://www.rfc-editor.org/rfc/rfc8314
//   RFC 4954  AUTH                        https://www.rfc-editor.org/rfc/rfc4954
//   RFC 4616  SASL PLAIN                  https://www.rfc-editor.org/rfc/rfc4616
//   AUTH LOGIN (draft-murchison-sasl-login) https://datatracker.ietf.org/doc/html/draft-murchison-sasl-login-00
//   XOAUTH2   Google: https://developers.google.com/gmail/imap/xoauth2-protocol
//             Microsoft: https://learn.microsoft.com/en-us/exchange/client-developer/legacy-protocols/how-to-authenticate-an-imap-pop-smtp-application-by-using-oauth
//
// Secrets (passwords, tokens) are only ever written to the socket. Error messages quote
// the server's replies, never what we sent.

import net from "node:net";
import tls from "node:tls";
import { hostname } from "node:os";

export type Security = "tls" | "starttls" | "none";
export type AuthMethod = "auto" | "plain" | "login" | "xoauth2";

export interface SmtpAuth {
  user: string;
  pass?: string | null;
  /** OAuth 2.0 access token, for XOAUTH2. */
  accessToken?: string | null;
  method?: AuthMethod;
}

export interface SmtpOptions {
  host: string;
  port: number;
  /** "tls": TLS from the first byte (port 465). "starttls": plain, then upgrade (port 587; required, never optional). "none": no encryption. */
  security: Security;
  auth?: SmtpAuth | null;
  /** Name sent in EHLO. Default: this machine's host name. */
  heloName?: string;
  timeoutMs?: number;
  /** Extra TLS options (a test CA, for example). Certificates are always checked unless rejectUnauthorized is false here. */
  tlsOptions?: tls.ConnectionOptions;
  /** Allow sending a password over an unencrypted connection. Default: only to localhost. */
  allowInsecureAuth?: boolean;
}

export interface SmtpResult {
  /** The server's reply to the end of DATA, e.g. "250 2.0.0 Ok: queued as 12345". */
  response: string;
  accepted: string[];
  rejected: { address: string; reply: string }[];
}

export class SmtpError extends Error {
  code: number | null;
  /** 5xx replies (and bad settings) are permanent: retrying will not help. */
  permanent: boolean;
  constructor(message: string, code: number | null = null, permanent = code !== null && code >= 500) {
    super(message);
    this.code = code;
    this.permanent = permanent;
  }
}

interface Reply {
  code: number;
  lines: string[];
  text: string;
}

/** The XOAUTH2 initial client response: base64("user=" user ^A "auth=Bearer " token ^A ^A). */
export function xoauth2String(user: string, accessToken: string): string {
  return Buffer.from(`user=${user}\x01auth=Bearer ${accessToken}\x01\x01`, "utf8").toString("base64");
}

/** SASL PLAIN (RFC 4616): base64(authzid NUL authcid NUL passwd), with an empty authzid. */
export function plainString(user: string, pass: string): string {
  return Buffer.from(`\0${user}\0${pass}`, "utf8").toString("base64");
}

/** Dot-stuff a CRLF message for DATA and add the terminating ".". */
export function dotStuff(raw: Buffer): Buffer {
  let s = raw.toString("latin1").replace(/\r?\n/g, "\r\n");
  if (!s.endsWith("\r\n")) s += "\r\n";
  s = s.replace(/^\./gm, "..");
  return Buffer.from(s + ".\r\n", "latin1");
}

class Connection {
  private sock!: net.Socket;
  private buf = "";
  private replies: Reply[] = [];
  private waiting: { resolve: (r: Reply) => void; reject: (e: Error) => void } | null = null;
  private failure: Error | null = null;
  private pending: string[] = [];
  private onData = (d: Buffer) => this.feed(d.toString("latin1"));
  private onError = (e: Error) => this.fail(new SmtpError(`Connection error: ${e.message}`));
  private onClose = () => this.fail(new SmtpError("The mail server closed the connection"));
  private onTimeout = () => {
    this.fail(new SmtpError("The mail server did not answer in time"));
    this.sock.destroy();
  };

  private timeoutMs: number;
  constructor(timeoutMs: number) {
    this.timeoutMs = timeoutMs;
  }

  attach(sock: net.Socket) {
    if (this.sock) this.detach();
    this.sock = sock;
    sock.setTimeout(this.timeoutMs);
    sock.on("data", this.onData);
    sock.on("error", this.onError);
    sock.on("close", this.onClose);
    sock.on("timeout", this.onTimeout);
  }

  detach(): net.Socket {
    const s = this.sock;
    s.off("data", this.onData);
    s.off("error", this.onError);
    s.off("close", this.onClose);
    s.off("timeout", this.onTimeout);
    s.setTimeout(0);
    return s;
  }

  get socket() {
    return this.sock;
  }

  private fail(e: Error) {
    if (this.failure) return;
    this.failure = e;
    if (this.waiting) {
      this.waiting.reject(e);
      this.waiting = null;
    }
  }

  private feed(chunk: string) {
    this.buf += chunk;
    if (this.buf.length > 1_000_000) return this.fail(new SmtpError("The mail server sent an over-long reply"));
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i).replace(/\r$/, "");
      this.buf = this.buf.slice(i + 1);
      const m = /^(\d{3})([ -]?)(.*)$/.exec(line);
      if (!m) {
        this.fail(new SmtpError(`Unexpected reply from the mail server: ${line.slice(0, 200)}`));
        return;
      }
      this.pending.push(m[3]);
      if (m[2] !== "-") {
        const r = { code: Number(m[1]), lines: this.pending, text: `${m[1]} ${this.pending.join(" / ")}`.slice(0, 500) };
        this.pending = [];
        if (this.waiting) {
          const w = this.waiting;
          this.waiting = null;
          w.resolve(r);
        } else this.replies.push(r);
      }
    }
  }

  read(): Promise<Reply> {
    if (this.replies.length) return Promise.resolve(this.replies.shift()!);
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => (this.waiting = { resolve, reject }));
  }

  write(data: string | Buffer) {
    if (this.failure) throw this.failure;
    this.sock.write(data);
  }

  async command(line: string, expect: number[], what = line.split(" ")[0]): Promise<Reply> {
    this.write(line + "\r\n");
    const r = await this.read();
    if (!expect.includes(r.code)) throw new SmtpError(`The mail server refused ${what}: ${r.text}`, r.code);
    return r;
  }

  close() {
    try {
      this.sock?.end();
    } catch {
      /* already closed */
    }
    this.sock?.destroy();
  }
}

function ehloName(o: SmtpOptions): string {
  const n = (o.heloName || hostname() || "localhost").replace(/[^A-Za-z0-9.-]/g, "");
  return n || "localhost";
}

function extensions(r: Reply): Map<string, string> {
  const m = new Map<string, string>();
  for (const line of r.lines.slice(1)) {
    const [k, ...rest] = line.trim().split(/\s+/);
    if (k) m.set(k.toUpperCase(), rest.join(" ").toUpperCase());
  }
  return m;
}

function connect(o: SmtpOptions): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const timeout = o.timeoutMs ?? 30_000;
    let s: net.Socket;
    const done = () => {
      clearTimeout(timer);
      s.off("error", onErr);
      resolve(s);
    };
    const onErr = (e: Error) => {
      clearTimeout(timer);
      reject(new SmtpError(`Could not connect to ${o.host}:${o.port}: ${e.message}`));
    };
    if (o.security === "tls") {
      s = tls.connect({ host: o.host, port: o.port, servername: net.isIP(o.host) ? undefined : o.host, ...o.tlsOptions }, done);
    } else s = net.connect({ host: o.host, port: o.port }, done);
    const timer = setTimeout(() => {
      s.destroy();
      reject(new SmtpError(`Timed out connecting to ${o.host}:${o.port}`));
    }, timeout);
    s.once("error", onErr);
  });
}

function upgrade(plain: net.Socket, o: SmtpOptions): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const s = tls.connect({ socket: plain, servername: net.isIP(o.host) ? undefined : o.host, ...o.tlsOptions }, () => {
      s.off("error", onErr);
      resolve(s);
    });
    const onErr = (e: Error) => reject(new SmtpError(`Could not start an encrypted connection: ${e.message}`, null, true));
    s.once("error", onErr);
  });
}

const isLocal = (host: string) => host === "localhost" || host === "127.0.0.1" || host === "::1";

/** Send one message. `raw` is the complete RFC 5322 message (see mime.ts). */
export async function sendSmtp(o: SmtpOptions, envelope: { from: string; to: string[] }, raw: Buffer): Promise<SmtpResult> {
  if (!o.host) throw new SmtpError("No mail server is set", null, true);
  if (!Number.isInteger(o.port) || o.port <= 0 || o.port > 65535) throw new SmtpError("The mail server port is not valid", null, true);
  if (!envelope.to.length) throw new SmtpError("No recipients", null, true);
  for (const a of [envelope.from, ...envelope.to]) if (/[\r\n<>]/.test(a)) throw new SmtpError("Bad address", null, true);

  const conn = new Connection(o.timeoutMs ?? 30_000);
  conn.attach(await connect(o));
  try {
    let r = await conn.read();
    if (r.code !== 220) throw new SmtpError(`The mail server did not greet us: ${r.text}`, r.code);
    let ehlo = await conn.command(`EHLO ${ehloName(o)}`, [250], "EHLO");
    let ext = extensions(ehlo);
    let encrypted = o.security === "tls";

    if (o.security === "starttls") {
      if (!ext.has("STARTTLS")) throw new SmtpError("The mail server does not offer STARTTLS, so the connection would not be encrypted", null, true);
      await conn.command("STARTTLS", [220]);
      const plain = conn.detach();
      conn.attach(await upgrade(plain, o));
      encrypted = true;
      ehlo = await conn.command(`EHLO ${ehloName(o)}`, [250], "EHLO");
      ext = extensions(ehlo);
    }

    if (o.auth && o.auth.user) {
      if (!encrypted && !o.allowInsecureAuth && !isLocal(o.host)) {
        throw new SmtpError("Refusing to send the password over an unencrypted connection; use TLS or STARTTLS", null, true);
      }
      const offered = (ext.get("AUTH") ?? "").split(/\s+/).filter(Boolean);
      let method = o.auth.method ?? "auto";
      if (method === "auto") {
        if (o.auth.accessToken) method = "xoauth2";
        else if (offered.includes("PLAIN") || !offered.length) method = "plain";
        else if (offered.includes("LOGIN")) method = "login";
        else throw new SmtpError(`The mail server offers no sign-in method we support (${offered.join(", ")})`, null, true);
      }
      await authenticate(conn, method, o.auth);
    }

    await conn.command(`MAIL FROM:<${envelope.from}>`, [250], "the sender");
    const accepted: string[] = [];
    const rejected: { address: string; reply: string }[] = [];
    let lastReject: Reply | null = null;
    for (const to of envelope.to) {
      conn.write(`RCPT TO:<${to}>\r\n`);
      r = await conn.read();
      if (r.code === 250 || r.code === 251) accepted.push(to);
      else {
        rejected.push({ address: to, reply: r.text });
        lastReject = r;
      }
    }
    if (!accepted.length) throw new SmtpError(`The mail server refused every recipient: ${lastReject!.text}`, lastReject!.code);
    await conn.command("DATA", [354]);
    conn.write(dotStuff(raw));
    r = await conn.read();
    if (r.code !== 250) throw new SmtpError(`The mail server refused the message: ${r.text}`, r.code);
    const response = r.text;
    try {
      conn.write("QUIT\r\n");
      await Promise.race([conn.read(), new Promise((res) => setTimeout(res, 1000))]);
    } catch {
      /* the message is already accepted */
    }
    return { response, accepted, rejected };
  } finally {
    conn.close();
  }
}

async function authenticate(conn: Connection, method: AuthMethod, auth: SmtpAuth) {
  const bad = (r: Reply) => new SmtpError(`The mail server did not accept the sign-in: ${r.text}`, r.code, r.code === 535 || r.code >= 500);
  if (method === "xoauth2") {
    if (!auth.accessToken) throw new SmtpError("No OAuth access token", null, true);
    conn.write(`AUTH XOAUTH2 ${xoauth2String(auth.user, auth.accessToken)}\r\n`);
    let r = await conn.read();
    if (r.code === 334) {
      // The server sent a base64 JSON error; an empty line ends the exchange (Google's XOAUTH2 doc).
      conn.write("\r\n");
      r = await conn.read();
    }
    if (r.code !== 235) throw bad(r);
    return;
  }
  if (!auth.pass) throw new SmtpError("No password is set for the mail server", null, true);
  if (method === "plain") {
    conn.write(`AUTH PLAIN ${plainString(auth.user, auth.pass)}\r\n`);
    const r = await conn.read();
    if (r.code !== 235) throw bad(r);
    return;
  }
  if (method === "login") {
    conn.write("AUTH LOGIN\r\n");
    let r = await conn.read();
    if (r.code !== 334) throw bad(r);
    conn.write(Buffer.from(auth.user, "utf8").toString("base64") + "\r\n");
    r = await conn.read();
    if (r.code !== 334) throw bad(r);
    conn.write(Buffer.from(auth.pass, "utf8").toString("base64") + "\r\n");
    r = await conn.read();
    if (r.code !== 235) throw bad(r);
    return;
  }
  throw new SmtpError(`Unknown sign-in method ${method}`, null, true);
}
