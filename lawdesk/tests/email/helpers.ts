// Shared fixtures for the email tests: a fake SMTP server, a throwaway TLS certificate,
// and a database with made-up people and matters.

import net from "node:net";
import tls from "node:tls";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import type { AddressInfo } from "node:net";
import { openDb } from "../../src/db.ts";
import { Engine } from "../../src/engine.ts";
import { SCHEMA as DOCS_SCHEMA } from "../../src/documents/schema.ts";
import { SCHEMA as CAL_SCHEMA } from "../../src/calendar/schema.ts";
import { SCHEMA } from "../../src/email/schema.ts";
import { Documents } from "../../src/documents/documents.ts";
import { setDocuments } from "../../src/documents/routes.ts";
import type { Envelope, SendResult, Transport } from "../../src/email/transport.ts";

export function tempDir(prefix = "lawdesk-email-"): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Env with the dev transport writing into a temp folder, so nothing reads the real environment. */
export function devEnv(dir: string): Record<string, string> {
  return { LAWDESK_MAIL_DIR: dir, LAWDESK_MAIL_FROM: "office@firm.example.test", LAWDESK_MAIL_FROM_NAME: "Example Law Office" };
}

/** Records messages instead of sending; can be told to fail. */
export class MemoryTransport implements Transport {
  readonly name = "memory";
  sent: { envelope: Envelope; raw: string }[] = [];
  failWith: Error | null = null;
  async send(envelope: Envelope, raw: Buffer): Promise<SendResult> {
    if (this.failWith) throw this.failWith;
    this.sent.push({ envelope, raw: raw.toString("utf8") });
    return { response: "250 ok" };
  }
}

export function setup(now = "2026-11-18") {
  const db = openDb();
  db.exec(DOCS_SCHEMA);
  db.exec(CAL_SCHEMA);
  db.exec(SCHEMA);
  const engine = new Engine(db, { today: () => now });
  const avery = engine.addUser("Avery Attorney", "attorney", "avery@firm.example.test");
  const pat = engine.addUser("Pat Paralegal", "paralegal", "pat@firm.example.test");
  const nomail = engine.addUser("Noel Nomail", "assistant");
  const client = engine.addContact("Dana Client (demo)", "person", "dana@client.example.test");
  const other = engine.addContact("Opposing Counsel (demo)", "person", "oc@other.example.test");
  const matterId = engine.createMatter({ name: "Client asset purchase", number: "2026-0042", clientId: client, roles: { attorney: avery, paralegal: pat } } as any) as number;
  const files = tempDir("lawdesk-email-files-");
  const docs = new Documents(db, { dir: files.dir, today: () => now });
  setDocuments(db, docs);
  const mail = tempDir();
  const env = devEnv(mail.dir);
  const cleanup = () => {
    files.cleanup();
    mail.cleanup();
  };
  return { db, engine, docs, avery, pat, nomail, client, other, matterId, env, mailDir: mail.dir, cleanup };
}

// ------------------------------------------------------------------ TLS

let certCache: { key: string; cert: string } | null | undefined;
/** A self-signed certificate for 127.0.0.1, or null when openssl is not installed. */
export function testCert(): { key: string; cert: string } | null {
  if (certCache !== undefined) return certCache;
  const { dir, cleanup } = tempDir("lawdesk-cert-");
  try {
    const r = spawnSync(
      "openssl",
      ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem"), "-days", "2", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"],
      { encoding: "utf8" },
    );
    certCache = r.status === 0 ? { key: readFileSync(join(dir, "k.pem"), "utf8"), cert: readFileSync(join(dir, "c.pem"), "utf8") } : null;
  } catch {
    certCache = null;
  } finally {
    cleanup();
  }
  return certCache;
}

// ------------------------------------------------------------------ fake SMTP server

export interface FakeOptions {
  /** Offer STARTTLS (needs cert). */
  starttls?: boolean;
  /** TLS from the first byte (needs cert). */
  implicitTls?: boolean;
  cert?: { key: string; cert: string } | null;
  /** Require sign-in with these credentials. */
  user?: string;
  pass?: string;
  /** Accept XOAUTH2 with this token. */
  token?: string;
  authMethods?: string[];
  rejectRcpt?: string[];
  /** Reply to the end of DATA with this instead of 250. */
  dataReply?: string;
  /** Reply to MAIL FROM with this instead of 250. */
  mailReply?: string;
}

export interface FakeMessage {
  from: string;
  to: string[];
  data: string;
  auth: string | null;
  tls: boolean;
}

export async function fakeSmtp(o: FakeOptions = {}) {
  const messages: FakeMessage[] = [];
  const transcript: string[] = [];
  const handle = (raw: net.Socket) => {
    let sock: net.Socket = raw;
    let buf = "";
    let mode: "cmd" | "data" | "login-user" | "login-pass" | "xoauth-err" = "cmd";
    let encrypted = !!o.implicitTls;
    let authed: string | null = null;
    let loginUser = "";
    let cur: { from: string; to: string[] } | null = null;
    let data = "";
    const send = (s: string) => sock.write(s + "\r\n");
    const ehlo = () => {
      const ext = ["250-fake.example.test hello", "250-SIZE 10000000", "250-8BITMIME"];
      if (o.starttls && !encrypted) ext.push("250-STARTTLS");
      const methods = o.authMethods ?? ["PLAIN", "LOGIN", ...(o.token ? ["XOAUTH2"] : [])];
      if (o.user || o.token) ext.push(`250-AUTH ${methods.join(" ")}`);
      ext.push("250 HELP");
      sock.write(ext.join("\r\n") + "\r\n");
    };
    const onLine = (line: string) => {
      transcript.push(line);
      if (mode === "login-user") {
        loginUser = Buffer.from(line, "base64").toString();
        mode = "login-pass";
        return send("334 UGFzc3dvcmQ6");
      }
      if (mode === "login-pass") {
        mode = "cmd";
        const pass = Buffer.from(line, "base64").toString();
        if (loginUser === o.user && pass === o.pass) {
          authed = "LOGIN";
          return send("235 2.7.0 Authentication successful");
        }
        return send("535 5.7.8 Authentication credentials invalid");
      }
      if (mode === "xoauth-err") {
        mode = "cmd";
        return send("535 5.7.8 Username and Password not accepted");
      }
      const [verb, ...rest] = line.split(" ");
      const arg = rest.join(" ");
      switch (verb.toUpperCase()) {
        case "EHLO":
          return ehlo();
        case "STARTTLS": {
          if (!o.starttls || !o.cert) return send("502 not supported");
          send("220 2.0.0 Ready to start TLS");
          sock.removeAllListeners("data");
          const t = new tls.TLSSocket(sock, { isServer: true, key: o.cert.key, cert: o.cert.cert });
          sock = t;
          encrypted = true;
          buf = "";
          t.on("data", onData);
          t.on("error", () => {});
          return;
        }
        case "AUTH": {
          const [mech, initial] = arg.split(" ");
          if (mech === "PLAIN") {
            const [, u, p] = Buffer.from(initial ?? "", "base64").toString().split("\0");
            if (u === o.user && p === o.pass) {
              authed = "PLAIN";
              return send("235 2.7.0 Authentication successful");
            }
            return send("535 5.7.8 Authentication credentials invalid");
          }
          if (mech === "LOGIN") {
            mode = "login-user";
            return send("334 VXNlcm5hbWU6");
          }
          if (mech === "XOAUTH2") {
            const s = Buffer.from(initial ?? "", "base64").toString();
            if (o.token && s === `user=${o.user}\x01auth=Bearer ${o.token}\x01\x01`) {
              authed = "XOAUTH2";
              return send("235 2.7.0 Accepted");
            }
            mode = "xoauth-err";
            return send("334 " + Buffer.from('{"status":"401"}').toString("base64"));
          }
          return send("504 unrecognized authentication type");
        }
        case "MAIL":
          if ((o.user || o.token) && !authed) return send("530 5.7.0 Authentication required");
          if (o.mailReply) return send(o.mailReply);
          cur = { from: /<(.*)>/.exec(arg)?.[1] ?? "", to: [] };
          return send("250 2.1.0 Ok");
        case "RCPT": {
          const to = /<(.*)>/.exec(arg)?.[1] ?? "";
          if (o.rejectRcpt?.includes(to)) return send("550 5.1.1 No such user here");
          cur!.to.push(to);
          return send("250 2.1.5 Ok");
        }
        case "DATA":
          mode = "data";
          data = "";
          return send("354 End data with <CR><LF>.<CR><LF>");
        case "RSET":
          cur = null;
          return send("250 Ok");
        case "NOOP":
          return send("250 Ok");
        case "QUIT":
          send("221 2.0.0 Bye");
          return sock.end();
        default:
          return send("500 unknown command");
      }
    };
    const onData = (chunk: Buffer) => {
      buf += chunk.toString("latin1");
      while (true) {
        if (mode === "data") {
          const end = buf.indexOf("\r\n.\r\n");
          const startEnd = data === "" && buf.startsWith(".\r\n") ? 0 : -1;
          if (end < 0 && startEnd < 0) return;
          const body = startEnd === 0 ? "" : buf.slice(0, end + 2);
          buf = buf.slice(startEnd === 0 ? 3 : end + 5);
          mode = "cmd";
          const unstuffed = body.replace(/^\.\./gm, ".");
          if (o.dataReply) send(o.dataReply);
          else {
            messages.push({ from: cur!.from, to: cur!.to, data: unstuffed, auth: authed, tls: encrypted });
            send("250 2.0.0 Ok: queued as FAKE" + messages.length);
          }
          continue;
        }
        const i = buf.indexOf("\r\n");
        if (i < 0) return;
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        onLine(line);
        if (mode === "cmd" && sock !== raw && buf === "" && line.toUpperCase() === "STARTTLS") return;
      }
    };
    sock.on("data", onData);
    sock.on("error", () => {});
    send("220 fake.example.test ESMTP ready");
  };
  const server = o.implicitTls ? tls.createServer({ key: o.cert!.key, cert: o.cert!.cert }, handle) : net.createServer(handle);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    messages,
    transcript,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
