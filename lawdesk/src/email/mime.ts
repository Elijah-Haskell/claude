// Building Internet messages.
//
//   RFC 5322  Internet Message Format (headers, Date, Message-ID, address syntax)
//             https://www.rfc-editor.org/rfc/rfc5322
//   RFC 2045  MIME part one (Content-Transfer-Encoding: quoted-printable §6.7, base64 §6.8)
//             https://www.rfc-editor.org/rfc/rfc2045
//   RFC 2046  MIME part two (multipart/mixed, multipart/alternative, boundaries §5.1)
//             https://www.rfc-editor.org/rfc/rfc2046
//   RFC 2047  Encoded words for non-ASCII header text ("=?UTF-8?B?...?=", 75-character limit §2)
//             https://www.rfc-editor.org/rfc/rfc2047
//   RFC 2231  Non-ASCII parameter values (filename*=UTF-8''...)
//             https://www.rfc-editor.org/rfc/rfc2231
//
// Everything is emitted as 7-bit text with CRLF line ends, so no SMTP extension
// (8BITMIME, SMTPUTF8) is needed to carry it.

import { randomBytes } from "node:crypto";
import { EngineError } from "../engine.ts";

export interface Address {
  name?: string | null;
  address: string;
}

export interface Attachment {
  filename: string;
  contentType?: string;
  data: Buffer;
}

export interface MessageInput {
  from: Address;
  to: Address[];
  cc?: Address[];
  /** Recipients who get the message without being listed in its headers. */
  bcc?: Address[];
  replyTo?: Address | null;
  subject: string;
  text: string;
  html?: string | null;
  attachments?: Attachment[];
  inReplyTo?: string | null;
  date?: Date;
  messageId?: string;
  /** Extra headers (names must be plain tokens; values may not contain line breaks). */
  headers?: Record<string, string>;
}

export interface BuiltMessage {
  raw: Buffer;
  messageId: string;
  envelope: { from: string; to: string[] };
}

const CRLF = "\r\n";

// Deliberately conservative: ASCII only, no quoted local parts, a dot in the domain.
// International addresses (RFC 6531 SMTPUTF8) are not supported yet.
const ADDRESS_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

export function isValidAddress(s: unknown): s is string {
  return typeof s === "string" && s.length <= 254 && ADDRESS_RE.test(s) && !s.startsWith(".") && !s.includes("..") && !s.split("@")[0].endsWith(".");
}

export function checkAddress(a: Address, what = "Email address"): Address {
  const address = typeof a?.address === "string" ? a.address.trim() : "";
  if (!isValidAddress(address)) throw new EngineError(`${what} "${address || "(blank)"}" is not a valid email address`);
  const name = typeof a.name === "string" ? a.name.replace(/[\r\n\t]+/g, " ").trim() : "";
  return { name: name || null, address };
}

const isAscii = (s: string) => /^[\x00-\x7f]*$/.test(s);

// ------------------------------------------------------------------ RFC 2047

/** Encode header text as one or more B encoded words, each at most 75 characters (RFC 2047 §2). */
export function encodeWords(text: string): string {
  const words: string[] = [];
  let chunk = "";
  // "=?UTF-8?B?" + "?=" is 12 characters, leaving 63; 45 bytes of UTF-8 make 60 base64 characters.
  for (const ch of text) {
    if (Buffer.byteLength(chunk + ch) > 45) {
      words.push(chunk);
      chunk = "";
    }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w, "utf8").toString("base64")}?=`).join(CRLF + " ");
}

/** Header text: as-is if ASCII, otherwise encoded words. */
export function headerText(text: string): string {
  const clean = text.replace(/[\r\n]+/g, " ");
  return isAscii(clean) ? clean : encodeWords(clean);
}

const ATEXT_PHRASE = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~ -]+$/;

export function formatAddress(a: Address): string {
  const { name, address } = checkAddress(a);
  if (!name) return address;
  if (!isAscii(name)) return `${encodeWords(name)} <${address}>`;
  if (ATEXT_PHRASE.test(name)) return `${name} <${address}>`;
  return `"${name.replace(/(["\\])/g, "\\$1")}" <${address}>`;
}

/** Fold a header line at spaces so lines stay under 78 characters where possible (RFC 5322 §2.2.3). */
export function foldHeader(name: string, value: string): string {
  const out: string[] = [];
  for (const [i, segment] of value.split(CRLF + " ").entries()) {
    let line = i === 0 ? `${name}: ` : " ";
    const words = segment.split(" ");
    let first = true;
    for (const w of words) {
      if (!first && line.length + 1 + w.length > 76) {
        out.push(line);
        line = " " + w;
      } else line += (first ? "" : " ") + w;
      first = false;
    }
    out.push(line);
  }
  return out.join(CRLF);
}

function addressHeader(name: string, list: Address[]): string {
  return `${name}: ` + list.map(formatAddress).join("," + CRLF + " ");
}

// ------------------------------------------------------------------ encodings

/** Quoted-printable (RFC 2045 §6.7). Line breaks in the input become CRLF hard breaks. */
export function encodeQuotedPrintable(text: string): string {
  const lines = text.replace(/\r\n|\r|\n/g, "\n").split("\n");
  const out: string[] = [];
  for (const line of lines) {
    const bytes = Buffer.from(line, "utf8");
    let cur = "";
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      const last = i === bytes.length - 1;
      let tok: string;
      if ((b === 0x20 || b === 0x09) && !last) tok = String.fromCharCode(b);
      else if (b >= 33 && b <= 126 && b !== 61) tok = String.fromCharCode(b);
      else tok = "=" + b.toString(16).toUpperCase().padStart(2, "0");
      // A line may be 76 characters including the "=" of a soft break.
      if (cur.length + tok.length > 75) {
        out.push(cur + "=");
        cur = "";
      }
      cur += tok;
    }
    out.push(cur);
  }
  return out.join(CRLF);
}

/** Base64 in lines of 76 characters (RFC 2045 §6.8). */
export function encodeBase64Lines(data: Buffer): string {
  const b = data.toString("base64");
  const out: string[] = [];
  for (let i = 0; i < b.length; i += 76) out.push(b.slice(i, i + 76));
  return out.join(CRLF);
}

/** RFC 5322 date-time, e.g. "Wed, 18 Nov 2026 15:04:05 +0000". */
export function formatDate(d: Date): string {
  const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const p = (n: number) => String(n).padStart(2, "0");
  return `${DAYS[d.getUTCDay()]}, ${p(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0000`;
}

export function makeMessageId(fromAddress: string): string {
  const domain = fromAddress.split("@")[1] || "lawdesk.invalid";
  return `<${randomBytes(12).toString("hex")}.${Date.now().toString(36)}@${domain}>`;
}

function boundary(): string {
  return "=_lawdesk_" + randomBytes(12).toString("hex");
}

// ------------------------------------------------------------------ parameters

/** A MIME parameter, with RFC 2231 encoding when the value is not plain ASCII. */
function param(name: string, value: string): string {
  const v = value.replace(/[\r\n"\\]/g, "_");
  if (isAscii(v)) return `${name}="${v}"`;
  const pct = encodeURIComponent(value).replace(/['()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
  return `${name}*=UTF-8''${pct}`;
}

function safeFilename(name: string): string {
  const n = String(name || "attachment").replace(/[\x00-\x1f\x7f/\\]+/g, "_").trim();
  return n.slice(0, 200) || "attachment";
}

// ------------------------------------------------------------------ build

interface Part {
  headers: string[];
  body: string;
}

function textPart(type: "plain" | "html", text: string): Part {
  return {
    headers: [`Content-Type: text/${type}; charset=utf-8`, "Content-Transfer-Encoding: quoted-printable"],
    body: encodeQuotedPrintable(text),
  };
}

function attachmentPart(a: Attachment): Part {
  const filename = safeFilename(a.filename);
  const type = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(a.contentType ?? "") ? a.contentType! : "application/octet-stream";
  // Older readers look at name= on Content-Type; RFC 2231 readers use filename*=.
  const nameParam = isAscii(filename) ? param("name", filename) : `name="${encodeWords(filename).replace(/\r\n /g, " ")}"`;
  return {
    headers: [
      `Content-Type: ${type}; ${nameParam}`,
      "Content-Transfer-Encoding: base64",
      `Content-Disposition: attachment; ${param("filename", filename)}`,
    ],
    body: encodeBase64Lines(a.data),
  };
}

function multipart(subtype: "mixed" | "alternative", parts: Part[]): Part {
  const b = boundary();
  const body = parts.map((p) => `--${b}${CRLF}${p.headers.join(CRLF)}${CRLF}${CRLF}${p.body}${CRLF}`).join("") + `--${b}--`;
  return { headers: [`Content-Type: multipart/${subtype}; boundary="${b}"`], body };
}

function checkHeaderValue(name: string, value: string): string {
  if (/[\r\n]/.test(value)) throw new EngineError(`The ${name} cannot contain line breaks`);
  return value;
}

/** Build a complete RFC 5322 message, ready to hand to SMTP DATA. */
export function buildMessage(input: MessageInput): BuiltMessage {
  const from = checkAddress(input.from, "From address");
  const to = (input.to ?? []).map((a) => checkAddress(a));
  const cc = (input.cc ?? []).map((a) => checkAddress(a));
  const bcc = (input.bcc ?? []).map((a) => checkAddress(a));
  if (!to.length && !cc.length && !bcc.length) throw new EngineError("Add at least one recipient");
  const messageId = input.messageId ?? makeMessageId(from.address);
  if (!/^<[^<>\s@]+@[^<>\s@]+>$/.test(messageId)) throw new EngineError("Bad Message-ID");

  const headers: string[] = [
    addressHeader("From", [from]),
    to.length ? addressHeader("To", to) : "To: undisclosed-recipients:;",
  ];
  if (cc.length) headers.push(addressHeader("Cc", cc));
  if (input.replyTo) headers.push(addressHeader("Reply-To", [checkAddress(input.replyTo, "Reply-To address")]));
  headers.push(foldHeader("Subject", headerText(checkHeaderValue("subject", input.subject ?? ""))));
  headers.push(`Date: ${formatDate(input.date ?? new Date())}`);
  headers.push(`Message-ID: ${messageId}`);
  if (input.inReplyTo) {
    const r = checkHeaderValue("In-Reply-To", input.inReplyTo);
    headers.push(`In-Reply-To: ${r}`, `References: ${r}`);
  }
  for (const [k, v] of Object.entries(input.headers ?? {})) {
    if (!/^[A-Za-z0-9-]+$/.test(k)) throw new EngineError(`Bad header name ${k}`);
    headers.push(foldHeader(k, headerText(checkHeaderValue(k, v))));
  }
  headers.push("MIME-Version: 1.0");

  let body: Part = input.html ? multipart("alternative", [textPart("plain", input.text ?? ""), textPart("html", input.html)]) : textPart("plain", input.text ?? "");
  if (input.attachments?.length) body = multipart("mixed", [body, ...input.attachments.map(attachmentPart)]);

  const raw = Buffer.from([...headers, ...body.headers].join(CRLF) + CRLF + CRLF + body.body + CRLF, "utf8");
  return { raw, messageId, envelope: { from: from.address, to: [...to, ...cc, ...bcc].map((a) => a.address) } };
}

// ------------------------------------------------------------------ address lists

/**
 * Parse "Ann Smith <ann@example.test>, bob@example.test" into addresses. Commas inside
 * quotes are kept; encoded words in names are left for the caller to decode.
 */
export function parseAddressList(s: string): Address[] {
  const out: Address[] = [];
  let cur = "";
  let quoted = false;
  let angle = 0;
  const flush = () => {
    const t = cur.trim();
    cur = "";
    if (!t) return;
    const m = /^(.*?)<([^<>]*)>\s*$/.exec(t);
    if (m) {
      let name = m[1].trim();
      if (name.startsWith('"') && name.endsWith('"') && name.length >= 2) name = name.slice(1, -1).replace(/\\(.)/g, "$1");
      out.push({ name: name || null, address: m[2].trim() });
    } else {
      // "addr (Comment Name)" form
      const c = /^([^\s()]+)\s*\((.*)\)\s*$/.exec(t);
      if (c) out.push({ name: c[2].trim() || null, address: c[1] });
      else out.push({ name: null, address: t.replace(/^"|"$/g, "") });
    }
  };
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\" && quoted) {
      cur += ch + (s[i + 1] ?? "");
      i++;
      continue;
    }
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === "<") angle++;
    else if (!quoted && ch === ">") angle = Math.max(0, angle - 1);
    if ((ch === "," || ch === ";") && !quoted && angle === 0) flush();
    else cur += ch;
  }
  flush();
  // Group syntax ("undisclosed-recipients:;") leaves a bare "name:" behind.
  return out.filter((a) => !/:$/.test(a.address) && a.address !== "");
}

/** Plain text to simple, safe HTML (escaped, paragraphs and line breaks kept). */
export function textToHtml(text: string): string {
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
  const paras = text
    .replace(/\r\n?/g, "\n")
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 1em">${esc(p).replace(/\n/g, "<br>")}</p>`)
    .join("\n");
  return `<!doctype html><html><body style="font-family:Georgia,'Times New Roman',serif;font-size:15px;line-height:1.5;color:#23262b">\n${paras}\n</body></html>`;
}
