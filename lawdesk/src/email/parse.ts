// Reading a saved email (.eml): headers, multipart bodies, transfer encodings, charsets
// and attachments.
//
//   RFC 5322  message format and header unfolding (§2.2.3)  https://www.rfc-editor.org/rfc/rfc5322
//   RFC 2045  quoted-printable (§6.7) and base64 (§6.8)      https://www.rfc-editor.org/rfc/rfc2045
//   RFC 2046  multipart boundaries (§5.1.1)                   https://www.rfc-editor.org/rfc/rfc2046
//   RFC 2047  encoded words in headers                        https://www.rfc-editor.org/rfc/rfc2047
//   RFC 2183  Content-Disposition                             https://www.rfc-editor.org/rfc/rfc2183
//   RFC 2231  parameter continuations and charsets            https://www.rfc-editor.org/rfc/rfc2231
//
// The parser works on the raw bytes as a latin1 string (one character per byte) so that
// nothing is lost before each part is decoded with its own charset. It never throws on
// malformed mail: it reads what it can.

import { type Address, parseAddressList } from "./mime.ts";
import { htmlToText } from "../documents/text.ts";

export interface ParsedAttachment {
  filename: string;
  contentType: string;
  data: Buffer;
  inline: boolean;
}

export interface ParsedMessage {
  headers: Map<string, string[]>;
  subject: string;
  from: Address[];
  to: Address[];
  cc: Address[];
  replyTo: Address[];
  /** ISO instant, or null when the Date header is missing or unreadable. */
  date: string | null;
  messageId: string | null;
  inReplyTo: string | null;
  text: string;
  html: string | null;
  attachments: ParsedAttachment[];
}

const MAX_DEPTH = 12;
const MAX_PARTS = 500;

// ------------------------------------------------------------------ charsets

/** Decode bytes in a named charset; unknown charsets fall back to UTF-8, then Windows-1252. */
export function decodeCharset(bytes: Buffer, charset: string | null | undefined): string {
  const cs = (charset || "").trim().toLowerCase().replace(/^"|"$/g, "");
  const tryDecode = (label: string, fatal: boolean) => new TextDecoder(label, { fatal }).decode(bytes);
  if (cs && cs !== "utf-8" && cs !== "utf8") {
    try {
      return tryDecode(cs, false);
    } catch {
      /* unknown label: fall through */
    }
  }
  try {
    return tryDecode("utf-8", true);
  } catch {
    // Not valid UTF-8 and no usable label: Windows-1252 (a superset of Latin-1 for text).
    return tryDecode("windows-1252", false);
  }
}

// ------------------------------------------------------------------ encodings

export function decodeQuotedPrintable(s: string): Buffer {
  const noSoft = s.replace(/=[ \t]*\r?\n/g, "");
  const out: number[] = [];
  for (let i = 0; i < noSoft.length; i++) {
    const c = noSoft.charCodeAt(i);
    if (c === 61 /* = */ && /^[0-9A-Fa-f]{2}$/.test(noSoft.slice(i + 1, i + 3))) {
      out.push(parseInt(noSoft.slice(i + 1, i + 3), 16));
      i += 2;
    } else out.push(c & 0xff);
  }
  return Buffer.from(out);
}

function decodeBody(body: string, cte: string): Buffer {
  const enc = cte.trim().toLowerCase();
  if (enc === "base64") return Buffer.from(body.replace(/[^A-Za-z0-9+/=]/g, ""), "base64");
  if (enc === "quoted-printable") return decodeQuotedPrintable(body);
  return Buffer.from(body, "latin1");
}

/** Decode RFC 2047 encoded words; whitespace between two adjacent encoded words is dropped (§6.2). */
export function decodeWords(s: string): string {
  const re = /=\?([^?\s]+)\?([BbQq])\?([^?\s]*)\?=/g;
  let out = "";
  let last = 0;
  let prevWasWord = false;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    const between = s.slice(last, m.index);
    if (!(prevWasWord && /^[ \t\r\n]*$/.test(between))) out += between;
    const charset = m[1].split("*")[0];
    let bytes: Buffer;
    if (m[2].toUpperCase() === "B") bytes = Buffer.from(m[3], "base64");
    else bytes = decodeQuotedPrintable(m[3].replace(/_/g, " "));
    out += decodeCharset(bytes, charset);
    last = re.lastIndex;
    prevWasWord = true;
  }
  return out + s.slice(last);
}

/** Header bytes may carry raw UTF-8 (RFC 6532); otherwise they are Latin-1. */
function headerBytesToString(s: string): string {
  return decodeCharset(Buffer.from(s, "latin1"), null);
}

// ------------------------------------------------------------------ headers

function splitHeadBody(s: string): { head: string; body: string } {
  const m = /\r?\n\r?\n/.exec(s);
  if (!m) return { head: s, body: "" };
  return { head: s.slice(0, m.index), body: s.slice(m.index + m[0].length) };
}

export function parseHeaders(head: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  const unfolded = head.replace(/\r?\n(?=[ \t])/g, "");
  for (const line of unfolded.split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i <= 0) continue;
    const name = line.slice(0, i).trim().toLowerCase();
    if (!/^[\x21-\x39\x3b-\x7e]+$/.test(name)) continue;
    const value = line.slice(i + 1).trim();
    map.set(name, [...(map.get(name) ?? []), value]);
  }
  return map;
}

export interface HeaderValue {
  value: string;
  params: Record<string, string>;
}

/** Parse "text/plain; charset=\"utf-8\"; name*0*=UTF-8''a%20b; name*1=c" (RFC 2045 §5.1, RFC 2231). */
export function parseParams(header: string): HeaderValue {
  const parts: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < header.length; i++) {
    const ch = header[i];
    if (ch === "\\" && quoted) {
      cur += header[++i] ?? "";
      continue;
    }
    if (ch === '"') {
      quoted = !quoted;
      continue;
    }
    if (ch === ";" && !quoted) {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  parts.push(cur);
  const value = (parts.shift() ?? "").trim().toLowerCase();
  const simple: Record<string, string> = {};
  const continued: Record<string, { idx: number; encoded: boolean; text: string }[]> = {};
  for (const p of parts) {
    const eq = p.indexOf("=");
    if (eq <= 0) continue;
    const key = p.slice(0, eq).trim().toLowerCase();
    const val = p.slice(eq + 1).trim();
    const m = /^([^*]+)(?:\*(\d+))?(\*)?$/.exec(key);
    if (!m) continue;
    if (m[2] === undefined && !m[3]) {
      simple[m[1]] = headerBytesToString(val);
      continue;
    }
    (continued[m[1]] ??= []).push({ idx: m[2] === undefined ? 0 : Number(m[2]), encoded: !!m[3], text: val });
  }
  const params: Record<string, string> = { ...simple };
  for (const [name, pieces] of Object.entries(continued)) {
    pieces.sort((a, b) => a.idx - b.idx);
    let charset = "utf-8";
    const bytes: number[] = [];
    for (const [i, piece] of pieces.entries()) {
      let t = piece.text;
      if (piece.encoded) {
        if (i === 0) {
          const q = /^([^']*)'[^']*'(.*)$/.exec(t);
          if (q) {
            charset = q[1] || charset;
            t = q[2];
          }
        }
        for (let j = 0; j < t.length; j++) {
          if (t[j] === "%" && /^[0-9A-Fa-f]{2}$/.test(t.slice(j + 1, j + 3))) {
            bytes.push(parseInt(t.slice(j + 1, j + 3), 16));
            j += 2;
          } else bytes.push(t.charCodeAt(j) & 0xff);
        }
      } else for (const b of Buffer.from(t, "latin1")) bytes.push(b);
    }
    params[name] = decodeCharset(Buffer.from(bytes), charset);
  }
  return { value, params };
}

function first(h: Map<string, string[]>, name: string): string | null {
  return h.get(name)?.[0] ?? null;
}

function addresses(h: Map<string, string[]>, name: string): Address[] {
  const all = (h.get(name) ?? []).map(headerBytesToString).join(", ");
  return parseAddressList(all).map((a) => ({ name: a.name ? decodeWords(a.name) : null, address: a.address.trim() }));
}

function parseDate(s: string | null): string | null {
  if (!s) return null;
  // Drop a trailing "(CST)" comment; Date.parse reads RFC 5322 dates otherwise.
  const ms = Date.parse(s.replace(/\([^)]*\)\s*$/, "").trim());
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

function msgId(s: string | null): string | null {
  if (!s) return null;
  const m = /<[^<>\s]+>/.exec(s);
  return m ? m[0] : s.trim() || null;
}

// ------------------------------------------------------------------ bodies

interface Walk {
  text: string | null;
  html: string | null;
  attachments: ParsedAttachment[];
  parts: number;
}

const EXT: Record<string, string> = {
  "text/plain": "txt",
  "text/html": "html",
  "application/pdf": "pdf",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "message/rfc822": "eml",
  "text/calendar": "ics",
};

function splitMultipart(body: string, b: string): string[] {
  const parts: string[] = [];
  const delim = "--" + b;
  const lines = body.split(/\r?\n/);
  let cur: string[] | null = null;
  for (const line of lines) {
    if (line.startsWith(delim)) {
      const rest = line.slice(delim.length);
      if (rest.startsWith("--")) {
        if (cur) parts.push(cur.join("\r\n"));
        return parts;
      }
      if (/^[ \t]*$/.test(rest)) {
        if (cur) parts.push(cur.join("\r\n"));
        cur = [];
        continue;
      }
    }
    if (cur) cur.push(line);
  }
  if (cur) parts.push(cur.join("\r\n")); // no closing delimiter: keep what we have
  return parts;
}

function walk(entity: string, w: Walk, depth: number, defaultType = "text/plain") {
  if (++w.parts > MAX_PARTS) return;
  const { head, body } = splitHeadBody(entity);
  const h = parseHeaders(head);
  const ct = parseParams(first(h, "content-type") ?? defaultType);
  const type = ct.value.includes("/") ? ct.value : "text/plain";
  const disp = parseParams(first(h, "content-disposition") ?? "");
  const cte = first(h, "content-transfer-encoding") ?? "7bit";

  if (type.startsWith("multipart/") && ct.params.boundary && depth < MAX_DEPTH) {
    const sub = type === "multipart/digest" ? "message/rfc822" : "text/plain";
    for (const p of splitMultipart(body, ct.params.boundary)) walk(p, w, depth + 1, sub);
    return;
  }

  const data = decodeBody(body, cte);
  const rawName = disp.params.filename ?? ct.params.name ?? null;
  const filename = rawName ? decodeWords(rawName) : null;
  const isAttachment = disp.value === "attachment" || (!!filename && type !== "text/plain" && type !== "text/html");

  if (!isAttachment && type === "text/plain" && w.text === null) {
    w.text = decodeCharset(data, ct.params.charset);
    return;
  }
  if (!isAttachment && type === "text/html" && w.html === null) {
    w.html = decodeCharset(data, ct.params.charset);
    return;
  }
  if (!isAttachment && (type === "text/plain" || type === "text/html") && !filename) {
    // A second body part (e.g. a footer some list servers add): append it to the text.
    const t = decodeCharset(data, ct.params.charset);
    if (type === "text/plain") w.text = (w.text ?? "") + "\n\n" + t;
    return;
  }
  let name = filename;
  if (!name && type === "message/rfc822") {
    const inner = parseHeaders(splitHeadBody(data.toString("latin1")).head);
    const subj = decodeWords(headerBytesToString(first(inner, "subject") ?? "")).trim();
    name = (subj || "Forwarded message") + ".eml";
  }
  if (!name) name = `attachment-${w.attachments.length + 1}.${EXT[type] ?? "bin"}`;
  w.attachments.push({ filename: name, contentType: type, data, inline: disp.value === "inline" });
}

export function parseMessage(raw: Buffer): ParsedMessage {
  const s = raw.toString("latin1").replace(/^﻿/, "");
  const { head } = splitHeadBody(s);
  const h = parseHeaders(head);
  const w: Walk = { text: null, html: null, attachments: [], parts: 0 };
  walk(s, w, 0);
  const text = (w.text ?? (w.html ? htmlToText(w.html) : "")).replace(/\r\n?/g, "\n").replace(/\s+$/, "");
  return {
    headers: h,
    subject: decodeWords(headerBytesToString(first(h, "subject") ?? "")).trim(),
    from: addresses(h, "from"),
    to: addresses(h, "to"),
    cc: addresses(h, "cc"),
    replyTo: addresses(h, "reply-to"),
    date: parseDate(first(h, "date")),
    messageId: msgId(first(h, "message-id")),
    inReplyTo: msgId(first(h, "in-reply-to")),
    text,
    html: w.html,
    attachments: w.attachments,
  };
}
