// Binary file transfer for documents: reading an upload straight off the request (raw bytes
// or multipart/form-data, parsed here without dependencies) and building download responses
// with the right Content-Type, Content-Length and Content-Disposition.

import { EngineError } from "../engine.ts";
import { MIME } from "./files.ts";
import { fmtBytes } from "./documents.ts";

/** What a raw route hands us: the request stream with its headers (http.IncomingMessage fits). */
export interface UploadSource extends AsyncIterable<Buffer | Uint8Array | string> {
  headers: Record<string, string | string[] | undefined>;
  resume?: () => unknown;
}

export interface UploadedFile {
  filename: string;
  /** The Content-Type the browser claimed. Informational only: the type is detected from the bytes. */
  contentType: string | null;
  data: Buffer;
}

export interface Upload {
  /** Text fields: multipart form fields, or for a raw upload the URL query. */
  fields: Record<string, string>;
  file: UploadedFile;
}

/** Room for multipart boundaries and the small text fields around the file. */
const MULTIPART_OVERHEAD = 256 * 1024;

function header(src: UploadSource, name: string): string {
  const v = src.headers[name];
  return (Array.isArray(v) ? v[0] : v) ?? "";
}

/**
 * Read the request body as it streams in, refusing it as soon as it passes the limit
 * (or straight away when Content-Length already says it is too big).
 */
export async function readStream(src: UploadSource, limit: number): Promise<Buffer> {
  const declared = Number(header(src, "content-length"));
  const tooBig = () => new EngineError(`File is larger than the ${fmtBytes(limit)} limit`, 413);
  if (Number.isFinite(declared) && declared > limit) {
    src.resume?.();
    throw tooBig();
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of src) {
    const b = Buffer.isBuffer(c) ? c : Buffer.from(c as any);
    size += b.length;
    if (size > limit) {
      src.resume?.();
      throw tooBig();
    }
    chunks.push(b);
  }
  return Buffer.concat(chunks, size);
}

/** Parse `a=b; c="d"` header parameters (RFC 7578 / 6266, with filename* per RFC 5987). */
export function headerParams(value: string): { value: string; params: Record<string, string> } {
  const params: Record<string, string> = {};
  const re = /;\s*([A-Za-z0-9_.*-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;]*))/g;
  const first = value.split(";", 1)[0].trim().toLowerCase();
  for (const m of value.matchAll(re)) {
    const key = m[1].toLowerCase();
    let v = m[2] !== undefined ? m[2].replace(/\\(.)/g, "$1") : (m[3] ?? "").trim();
    if (key.endsWith("*")) {
      const ext = /^([A-Za-z0-9_-]*)'[^']*'(.*)$/.exec(v);
      if (ext) {
        try {
          v = ext[1].toLowerCase() === "utf-8" ? decodeURIComponent(ext[2]) : unescape(ext[2]);
        } catch {
          continue;
        }
      }
      params[key.slice(0, -1)] = v;
    } else if (!(key in params)) params[key] = v;
  }
  return { value: first, params };
}

/**
 * Parse a multipart/form-data body. Returns the text fields and every file part.
 * Browsers send file names as UTF-8 inside the quotes; that is how they are read here.
 */
export function parseMultipart(body: Buffer, contentType: string): { fields: Record<string, string>; files: (UploadedFile & { field: string })[] } {
  const { value, params } = headerParams(contentType);
  if (value !== "multipart/form-data" || !params.boundary) throw new EngineError("Expected multipart/form-data with a boundary");
  if (params.boundary.length > 200) throw new EngineError("Bad multipart boundary");
  const delim = Buffer.from("--" + params.boundary);
  const fields: Record<string, string> = {};
  const files: (UploadedFile & { field: string })[] = [];
  let pos = body.indexOf(delim);
  if (pos < 0) throw new EngineError("The upload is not valid multipart/form-data");
  const CRLF2 = Buffer.from("\r\n\r\n");
  const next = Buffer.from("\r\n--" + params.boundary);
  for (let parts = 0; ; parts++) {
    if (parts > 100) throw new EngineError("Too many parts in the upload");
    pos += delim.length;
    if (body[pos] === 0x2d && body[pos + 1] === 0x2d) break; // closing "--"
    if (body[pos] === 0x0d && body[pos + 1] === 0x0a) pos += 2;
    else throw new EngineError("The upload is not valid multipart/form-data");
    const headEnd = body.indexOf(CRLF2, pos);
    if (headEnd < 0) throw new EngineError("The upload is not valid multipart/form-data");
    const headers: Record<string, string> = {};
    for (const line of body.toString("utf8", pos, headEnd).split("\r\n")) {
      const i = line.indexOf(":");
      if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
    }
    const end = body.indexOf(next, headEnd + 4);
    if (end < 0) throw new EngineError("The upload was cut off before it finished");
    const data = body.subarray(headEnd + 4, end);
    const disp = headerParams(headers["content-disposition"] ?? "");
    const name = disp.params.name;
    if (disp.value === "form-data" && name !== undefined) {
      if (disp.params.filename !== undefined) {
        files.push({ field: name, filename: disp.params.filename, contentType: headers["content-type"] ?? null, data: Buffer.from(data) });
      } else if (data.length <= 64 * 1024) fields[name] = data.toString("utf8");
      else throw new EngineError(`The form field "${name}" is too long`);
    }
    pos = end + 2; // skip CRLF; pos now points at the delimiter
  }
  return { fields, files };
}

/**
 * Read one uploaded file from a raw route's request.
 *  - multipart/form-data: the first file part is the file; other parts are fields.
 *  - anything else: the body is the file; fields come from the query (name= gives the file name).
 */
export async function readUpload(src: UploadSource, query: URLSearchParams, maxBytes: number): Promise<Upload> {
  const ct = header(src, "content-type");
  if (/^multipart\/form-data\b/i.test(ct)) {
    const body = await readStream(src, maxBytes + MULTIPART_OVERHEAD);
    const { fields, files } = parseMultipart(body, ct);
    if (!files.length) throw new EngineError("No file was attached");
    const f = files[0];
    if (f.data.length > maxBytes) throw new EngineError(`File is larger than the ${fmtBytes(maxBytes)} limit`, 413);
    for (const [k, v] of query) if (!(k in fields)) fields[k] = v;
    return { fields, file: { filename: fields.filename || fields.name || f.filename, contentType: f.contentType, data: f.data } };
  }
  const data = await readStream(src, maxBytes);
  const fields = Object.fromEntries(query);
  const filename = fields.name || fields.filename || headerParams(header(src, "content-disposition")).params.filename || "";
  if (!filename) throw new EngineError("Say what the file is called: add ?name=<file name> to the upload address");
  return { fields, file: { filename, contentType: ct || null, data } };
}

/** "a, b" or a JSON list -> ["a", "b"]; undefined when the field was not sent. */
export function tagsField(v: string | undefined): string[] | undefined {
  if (v === undefined) return undefined;
  const t = v.trim();
  if (t.startsWith("[")) {
    try {
      const a = JSON.parse(t);
      if (Array.isArray(a)) return a;
    } catch {}
    throw new EngineError("Tags must be a list");
  }
  return t ? t.split(",").map((s) => s.trim()).filter(Boolean) : [];
}

// ------------------------------------------------------------------ downloads

/** Types a browser may show inline. Anything else is always sent as an attachment. */
export const PREVIEWABLE = new Set<string>([MIME.pdf, MIME.png, MIME.jpg, MIME.gif]);

/** Content-Disposition with an ASCII fallback and the exact UTF-8 name (RFC 6266). */
export function contentDisposition(kind: "attachment" | "inline", filename: string): string {
  const ascii = filename
    .normalize("NFKD")
    .replace(/[^\x20-\x7e]/g, "")
    .replace(/["\\]/g, "")
    .trim() || "download";
  const star = encodeURIComponent(filename).replace(/['()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${star}`;
}

/** Text types get an explicit charset so they never fall back to the browser's guess. */
function typeHeader(mime: string): string {
  return mime.startsWith("text/") ? `${mime}; charset=utf-8` : mime;
}

/**
 * The raw response the server sends for a file. inline is honoured only for PDFs and images
 * (detected from the bytes); the page that frames them must be our own.
 */
export function fileResponse(f: { filename: string; mime: string; data: Buffer; sha256?: string; version?: number }, inline: boolean) {
  const show = inline && PREVIEWABLE.has(f.mime);
  const headers: Record<string, string> = {
    "Content-Disposition": contentDisposition(show ? "inline" : "attachment", f.filename),
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, no-store",
  };
  if (f.sha256) headers["X-Lawdesk-SHA256"] = f.sha256;
  if (f.version) headers["X-Lawdesk-Version"] = String(f.version);
  if (show) {
    // Our own pages may frame a preview; nothing else may, and the file gets no scripts.
    headers["X-Frame-Options"] = "SAMEORIGIN";
    headers["Content-Security-Policy"] =
      f.mime === MIME.pdf ? "frame-ancestors 'self'" : "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'self'; sandbox";
  } else {
    headers["Content-Security-Policy"] = "default-src 'none'; frame-ancestors 'none'; sandbox";
  }
  return { __raw: true as const, contentType: typeHeader(f.mime), headers, body: f.data };
}
