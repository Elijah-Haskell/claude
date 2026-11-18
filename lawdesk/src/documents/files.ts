// File names, folder paths, type detection and the content-addressed blob store.

import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { EngineError } from "../engine.ts";
import { looksLikeZip, zipEntryNames } from "./zip.ts";

// ------------------------------------------------------------------ names

const BAD_CHARS = /[\/\\:*?"<>|\u0000-\u001f\u007f]/;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
export const MAX_NAME_LENGTH = 200;

/**
 * Check a file name and return it in NFC form. Rejects anything that could act as a path
 * or that Windows cannot store, so a downloaded file always saves cleanly.
 */
export function checkFilename(name: unknown, what = "File name"): string {
  if (typeof name !== "string") throw new EngineError(`${what} is required`);
  const n = name.normalize("NFC");
  if (!n.trim()) throw new EngineError(`${what} is required`);
  if (n.length > MAX_NAME_LENGTH) throw new EngineError(`${what} is longer than ${MAX_NAME_LENGTH} characters`);
  if (BAD_CHARS.test(n)) throw new EngineError(`${what} cannot contain / \\ : * ? " < > | or control characters`);
  if (n === "." || n === "..") throw new EngineError(`${what} cannot be . or ..`);
  if (n !== n.trim()) throw new EngineError(`${what} cannot start or end with a space`);
  if (n.endsWith(".")) throw new EngineError(`${what} cannot end with a dot`);
  if (RESERVED.test(n)) throw new EngineError(`${what} "${n}" is reserved by Windows`);
  return n;
}

/** Folder paths are virtual ("Pleadings/Drafts"). "" means the matter's top level. */
export function checkFolder(folder: unknown): string {
  if (folder === undefined || folder === null || folder === "") return "";
  if (typeof folder !== "string") throw new EngineError("Folder must be text");
  const parts = folder.split("/").filter((p) => p !== "");
  if (parts.length > 10) throw new EngineError("Folders can be at most 10 levels deep");
  return parts.map((p) => checkFilename(p, "Folder name")).join("/");
}

export function extensionOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : "";
}

// ------------------------------------------------------------------ types

export const MIME = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  png: "image/png",
  jpg: "image/jpeg",
  gif: "image/gif",
  zip: "application/zip",
  ole: "application/x-ole-storage",
  doc: "application/msword",
  xls: "application/vnd.ms-excel",
  rtf: "application/rtf",
  txt: "text/plain",
  md: "text/markdown",
  html: "text/html",
  csv: "text/csv",
  eml: "message/rfc822",
  bin: "application/octet-stream",
} as const;

/** What each extension must contain. Extensions not listed here are accepted as-is. */
const EXPECTED: Record<string, string[]> = {
  pdf: [MIME.pdf],
  docx: [MIME.docx],
  xlsx: [MIME.xlsx],
  pptx: [MIME.pptx],
  png: [MIME.png],
  jpg: [MIME.jpg],
  jpeg: [MIME.jpg],
  gif: [MIME.gif],
  zip: [MIME.zip, MIME.docx, MIME.xlsx, MIME.pptx],
  doc: [MIME.doc],
  xls: [MIME.xls],
  rtf: [MIME.rtf],
  txt: [MIME.txt],
  md: [MIME.md],
  html: [MIME.html],
  htm: [MIME.html],
  csv: [MIME.csv],
};

const TEXT_EXT: Record<string, string> = {
  txt: MIME.txt,
  md: MIME.md,
  markdown: MIME.md,
  html: MIME.html,
  htm: MIME.html,
  csv: MIME.csv,
  eml: MIME.eml,
};

function startsWith(buf: Buffer, bytes: number[], at = 0): boolean {
  if (buf.length < at + bytes.length) return false;
  return bytes.every((b, i) => buf[at + i] === b);
}

function isUtf8Text(buf: Buffer): boolean {
  const sample = buf.subarray(0, 64 * 1024);
  if (sample.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(sample.length < buf.length ? trimPartialUtf8(sample) : sample);
    return true;
  } catch {
    return false;
  }
}

/** Drop a multi-byte character cut in half at the end of a sample. */
function trimPartialUtf8(b: Buffer): Buffer {
  let end = b.length;
  for (let i = 1; i <= 3 && end - i >= 0; i++) {
    const c = b[end - i];
    if ((c & 0xc0) === 0x80) continue; // continuation byte
    if (c >= 0xc0) return b.subarray(0, end - i); // lead byte of a cut sequence
    break;
  }
  return b;
}

/**
 * Work out a file's type from its bytes. The extension is only used to tell apart formats
 * that share a container (OLE .doc vs .xls) and to label plain text.
 */
export function detectMime(data: Buffer, filename: string): string {
  const ext = extensionOf(filename);
  if (startsWith(data, [0x25, 0x50, 0x44, 0x46, 0x2d])) return MIME.pdf; // %PDF-
  if (startsWith(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return MIME.png;
  if (startsWith(data, [0xff, 0xd8, 0xff])) return MIME.jpg;
  if (startsWith(data, [0x47, 0x49, 0x46, 0x38]) && (data[4] === 0x37 || data[4] === 0x39) && data[5] === 0x61) return MIME.gif;
  if (startsWith(data, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
    if (ext === "doc") return MIME.doc;
    if (ext === "xls") return MIME.xls;
    return MIME.ole;
  }
  if (startsWith(data, [0x7b, 0x5c, 0x72, 0x74, 0x66])) return MIME.rtf; // {\rtf
  if (looksLikeZip(data)) {
    let names: string[] = [];
    try {
      names = zipEntryNames(data);
    } catch {
      return MIME.bin;
    }
    const has = (n: string) => names.includes(n);
    if (has("[Content_Types].xml")) {
      if (has("word/document.xml")) return MIME.docx;
      if (has("xl/workbook.xml")) return MIME.xlsx;
      if (has("ppt/presentation.xml")) return MIME.pptx;
    }
    return MIME.zip;
  }
  if (isUtf8Text(data)) return TEXT_EXT[ext] ?? MIME.txt;
  return MIME.bin;
}

/** Throw if the bytes are not what the extension says (a .pdf that is really HTML, say). */
export function checkTypeMatchesName(mime: string, filename: string) {
  const ext = extensionOf(filename);
  const expected = EXPECTED[ext];
  if (expected && !expected.includes(mime)) {
    throw new EngineError(`The file's contents (${mime}) do not match its .${ext} extension`, 415);
  }
}

// ------------------------------------------------------------------ store

const HASH_RE = /^[0-9a-f]{64}$/;

export function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Files on disk named by their SHA-256, under dir/ab/cd/<hash>. The same bytes are stored once.
 * Paths are built only from validated hex hashes, so no input can reach outside dir.
 */
export class BlobStore {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = resolve(dir);
  }

  private pathFor(hash: string): string {
    if (!HASH_RE.test(hash)) throw new EngineError("Bad file hash", 500);
    return join(this.dir, hash.slice(0, 2), hash.slice(2, 4), hash);
  }

  /** Store bytes and return their hash. */
  put(data: Buffer): string {
    const hash = sha256(data);
    const path = this.pathFor(hash);
    if (existsSync(path)) return hash;
    const folder = join(this.dir, hash.slice(0, 2), hash.slice(2, 4));
    mkdirSync(folder, { recursive: true });
    const tmp = join(folder, `.${hash}.${randomBytes(6).toString("hex")}.tmp`);
    writeFileSync(tmp, data, { flag: "wx" });
    try {
      renameSync(tmp, path);
    } catch (e) {
      try {
        unlinkSync(tmp);
      } catch {}
      if (!existsSync(path)) throw e;
    }
    return hash;
  }

  has(hash: string): boolean {
    return existsSync(this.pathFor(hash));
  }

  /** Read bytes back, checking they still hash to their name. */
  get(hash: string): Buffer {
    const path = this.pathFor(hash);
    if (!existsSync(path)) throw new EngineError("The stored file is missing", 500);
    const data = readFileSync(path);
    if (sha256(data) !== hash) throw new EngineError("The stored file is damaged (hash mismatch)", 500);
    return data;
  }
}
