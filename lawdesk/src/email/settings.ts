// Email settings: stored in email_settings, and any of them can be fixed by an environment
// variable instead (the environment wins, and the screen shows the field as set by the server).
//
//   LAWDESK_MAIL_TRANSPORT   dev | smtp           (default dev: messages are written to LAWDESK_MAIL_DIR)
//   LAWDESK_MAIL_DIR         folder for dev mail   (default ./mail-out)
//   LAWDESK_SMTP_HOST, LAWDESK_SMTP_PORT, LAWDESK_SMTP_SECURITY (tls | starttls | none),
//   LAWDESK_SMTP_USER, LAWDESK_SMTP_PASSWORD, LAWDESK_SMTP_AUTH (auto | plain | login)
//   LAWDESK_MAIL_FROM, LAWDESK_MAIL_FROM_NAME, LAWDESK_APP_URL (for links in emails)
//   LAWDESK_SECRET_KEY       if set, a password saved from the screen is encrypted with it (AES-256-GCM)
//
// The password is never returned by the API or written to the activity log.

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { DB } from "../db.ts";
import { EngineError } from "../engine.ts";
import { isValidAddress } from "./mime.ts";
import { DevTransport, SmtpTransport, type Transport } from "./transport.ts";
import type { AuthMethod, Security } from "./smtp.ts";

type Env = Record<string, string | undefined>;

export interface EmailConfig {
  transport: "dev" | "smtp";
  devDir: string;
  host: string;
  port: number;
  security: Security;
  user: string;
  password: string | null;
  auth: AuthMethod;
  fromAddress: string;
  fromName: string;
  appUrl: string;
}

const FIELDS: { key: string; env: string; prop: keyof EmailConfig }[] = [
  { key: "transport", env: "LAWDESK_MAIL_TRANSPORT", prop: "transport" },
  { key: "smtp_host", env: "LAWDESK_SMTP_HOST", prop: "host" },
  { key: "smtp_port", env: "LAWDESK_SMTP_PORT", prop: "port" },
  { key: "smtp_security", env: "LAWDESK_SMTP_SECURITY", prop: "security" },
  { key: "smtp_user", env: "LAWDESK_SMTP_USER", prop: "user" },
  { key: "smtp_password", env: "LAWDESK_SMTP_PASSWORD", prop: "password" },
  { key: "smtp_auth", env: "LAWDESK_SMTP_AUTH", prop: "auth" },
  { key: "from_address", env: "LAWDESK_MAIL_FROM", prop: "fromAddress" },
  { key: "from_name", env: "LAWDESK_MAIL_FROM_NAME", prop: "fromName" },
  { key: "app_url", env: "LAWDESK_APP_URL", prop: "appUrl" },
];

const DEV_FROM = "lawdesk@localhost.test";

function stored(db: DB): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const r of db.prepare("SELECT key, value FROM email_settings").all() as any[]) out[r.key] = r.value;
  return out;
}

// ------------------------------------------------------------------ secret at rest

function keyFrom(env: Env): Buffer | null {
  const k = env.LAWDESK_SECRET_KEY;
  return k ? createHash("sha256").update(k, "utf8").digest() : null;
}

function sealSecret(plain: string, env: Env): string {
  const key = keyFrom(env);
  if (!key) return "plain:" + plain;
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return ["enc1", iv.toString("base64"), c.getAuthTag().toString("base64"), ct.toString("base64")].join(":");
}

function openSecret(sealed: string | null | undefined, env: Env): string | null {
  if (!sealed) return null;
  if (sealed.startsWith("plain:")) return sealed.slice(6);
  if (sealed.startsWith("enc1:")) {
    const key = keyFrom(env);
    if (!key) throw new EngineError("The saved mail password is encrypted, but LAWDESK_SECRET_KEY is not set on the server", 500);
    const [, iv, tag, ct] = sealed.split(":");
    try {
      const d = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
      d.setAuthTag(Buffer.from(tag, "base64"));
      return Buffer.concat([d.update(Buffer.from(ct, "base64")), d.final()]).toString("utf8");
    } catch {
      throw new EngineError("The saved mail password could not be read with the current LAWDESK_SECRET_KEY; enter it again", 500);
    }
  }
  return sealed;
}

// ------------------------------------------------------------------ read

export function loadConfig(db: DB, env: Env = process.env): EmailConfig {
  const s = stored(db);
  const pick = (key: string, envName: string) => (env[envName] !== undefined && env[envName] !== "" ? env[envName]! : s[key] ?? "");
  const transport = pick("transport", "LAWDESK_MAIL_TRANSPORT") === "smtp" ? "smtp" : "dev";
  const security = (["tls", "starttls", "none"].includes(pick("smtp_security", "LAWDESK_SMTP_SECURITY")) ? pick("smtp_security", "LAWDESK_SMTP_SECURITY") : "starttls") as Security;
  const port = Number(pick("smtp_port", "LAWDESK_SMTP_PORT")) || (security === "tls" ? 465 : 587);
  const auth = (["auto", "plain", "login"].includes(pick("smtp_auth", "LAWDESK_SMTP_AUTH")) ? pick("smtp_auth", "LAWDESK_SMTP_AUTH") : "auto") as AuthMethod;
  const envPass = env.LAWDESK_SMTP_PASSWORD;
  return {
    transport,
    devDir: env.LAWDESK_MAIL_DIR || "mail-out",
    host: pick("smtp_host", "LAWDESK_SMTP_HOST"),
    port,
    security,
    user: pick("smtp_user", "LAWDESK_SMTP_USER"),
    get password() {
      return envPass ? envPass : openSecret(s.smtp_password, env);
    },
    auth,
    fromAddress: pick("from_address", "LAWDESK_MAIL_FROM") || (transport === "dev" ? DEV_FROM : ""),
    fromName: pick("from_name", "LAWDESK_MAIL_FROM_NAME") || "Lawdesk",
    appUrl: (pick("app_url", "LAWDESK_APP_URL") || "http://localhost:3000").replace(/\/+$/, ""),
  } as EmailConfig;
}

/** What the settings screen may see: everything except the password itself. */
export function publicSettings(db: DB, env: Env = process.env) {
  const c = loadConfig(db, env);
  const s = stored(db);
  return {
    transport: c.transport,
    host: c.host,
    port: c.port,
    security: c.security,
    user: c.user,
    auth: c.auth,
    fromAddress: c.fromAddress === DEV_FROM && !s.from_address && !env.LAWDESK_MAIL_FROM ? "" : c.fromAddress,
    fromName: c.fromName,
    appUrl: c.appUrl,
    passwordSet: !!(env.LAWDESK_SMTP_PASSWORD || s.smtp_password),
    passwordEncrypted: !!s.smtp_password?.startsWith("enc1:"),
    devDir: c.transport === "dev" ? c.devDir : null,
    /** Fields fixed by the server's environment; the screen shows them read-only. */
    fromEnvironment: FIELDS.filter((f) => env[f.env] !== undefined && env[f.env] !== "").map((f) => f.prop),
  };
}

// ------------------------------------------------------------------ write

export interface SettingsPatch {
  transport?: string;
  host?: string;
  port?: number | string;
  security?: string;
  user?: string;
  auth?: string;
  fromAddress?: string;
  fromName?: string;
  appUrl?: string;
  /** A new password. Omit to keep the current one. */
  password?: string;
  clearPassword?: boolean;
}

/** Save settings; returns the names of what changed (never the values of secrets). */
export function saveSettings(db: DB, patch: SettingsPatch, env: Env = process.env): string[] {
  if (!patch || typeof patch !== "object") throw new EngineError("Expected settings");
  const set = (key: string, value: string | null) =>
    db.prepare("INSERT INTO email_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  const changed: string[] = [];
  const text = (v: unknown, what: string, max = 300) => {
    if (typeof v !== "string") throw new EngineError(`${what} must be text`);
    const t = v.trim();
    if (t.length > max) throw new EngineError(`${what} is too long`);
    if (/[\r\n\0]/.test(t)) throw new EngineError(`${what} cannot contain line breaks`);
    return t;
  };
  const current = stored(db);
  const put = (key: string, label: string, value: string | null) => {
    if ((current[key] ?? null) !== value) changed.push(label);
    set(key, value);
  };
  if (patch.transport !== undefined) {
    if (patch.transport !== "dev" && patch.transport !== "smtp") throw new EngineError("Sending method must be dev or smtp");
    put("transport", "sending method", patch.transport);
  }
  if (patch.host !== undefined) {
    const h = text(patch.host, "Mail server", 253);
    if (h && !/^[A-Za-z0-9.-]+$|^\[[0-9a-fA-F:.]+\]$/.test(h)) throw new EngineError("Mail server must be a host name like smtp.example.com");
    put("smtp_host", "mail server", h || null);
  }
  if (patch.port !== undefined && patch.port !== "") {
    const p = Number(patch.port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) throw new EngineError("Port must be a number from 1 to 65535");
    put("smtp_port", "port", String(p));
  }
  if (patch.security !== undefined) {
    if (!["tls", "starttls", "none"].includes(patch.security)) throw new EngineError("Encryption must be tls, starttls or none");
    put("smtp_security", "encryption", patch.security);
  }
  if (patch.user !== undefined) put("smtp_user", "user name", text(patch.user, "User name") || null);
  if (patch.auth !== undefined) {
    if (!["auto", "plain", "login"].includes(patch.auth)) throw new EngineError("Sign-in method must be auto, plain or login");
    put("smtp_auth", "sign-in method", patch.auth);
  }
  if (patch.fromAddress !== undefined) {
    const a = text(patch.fromAddress, "From address", 254);
    if (a && !isValidAddress(a)) throw new EngineError(`"${a}" is not a valid email address`);
    put("from_address", "from address", a || null);
  }
  if (patch.fromName !== undefined) put("from_name", "from name", text(patch.fromName, "From name", 100) || null);
  if (patch.appUrl !== undefined) {
    const u = text(patch.appUrl, "Lawdesk address", 300);
    if (u && !/^https?:\/\/[^\s/]+(\/[^\s]*)?$/.test(u)) throw new EngineError("Lawdesk address must start with http:// or https://");
    put("app_url", "Lawdesk address", u || null);
  }
  if (patch.clearPassword) {
    if (current.smtp_password) changed.push("password removed");
    db.prepare("DELETE FROM email_settings WHERE key = 'smtp_password'").run();
  } else if (patch.password !== undefined && patch.password !== "") {
    if (typeof patch.password !== "string" || patch.password.length > 1000) throw new EngineError("Password is not valid");
    set("smtp_password", sealSecret(patch.password, env));
    changed.push("password changed");
  }
  return changed;
}

// ------------------------------------------------------------------ transport

export function transportFor(c: EmailConfig): Transport {
  if (c.transport === "dev") return new DevTransport(c.devDir);
  if (!c.host) throw new EngineError("Set the mail server in Settings > Email before sending");
  if (!c.fromAddress) throw new EngineError("Set the From address in Settings > Email before sending");
  return new SmtpTransport({
    host: c.host,
    port: c.port,
    security: c.security,
    auth: c.user ? { user: c.user, pass: c.password, method: c.auth } : null,
  });
}
