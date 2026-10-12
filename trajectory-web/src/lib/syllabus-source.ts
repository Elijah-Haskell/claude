/**
 * Getting a syllabus into the app, the pure part (the iPhone app's components/syllabus/use-syllabus-source.ts):
 * what kind of file was picked, the type it is uploaded as, the server's size limit, and what is remembered about a
 * source while its reading runs. The React hook that picks, reads and uploads is
 * src/components/syllabus/use-syllabus-source.ts.
 */
import type { PendingLocalFile, PendingSource } from "./pending-extraction";

export interface ExtractionInput {
  pdfUrl?: string;
  pdfUrls?: string[];
  rawText?: string;
}

/** A file picked in this browser (kept so it can be sent again without picking it again). */
export interface LocalFile extends PendingLocalFile {
  /** The file itself; absent for a file remembered from before a reload (it cannot be sent again). */
  file?: File;
}

export interface ExtractionSource {
  kind: "file" | "scan" | "paste";
  input: ExtractionInput;
  /** The picked file behind a "file" source. */
  local?: LocalFile;
  /** The page photos behind a "scan" source, in order. */
  pageUris?: string[];
}

export interface ScannedPage {
  /** An object URL of the photo: its key here, and its thumbnail. */
  uri: string;
  /** The photo itself; null for a page remembered from before a reload. */
  file: File | null;
  /** null until the page is uploaded (not sent yet, or the upload failed). */
  url: string | null;
}

/** What the server accepts as a file (server/routers.ts ai.uploadFile; it sniffs the content, not this label). */
export type UploadMime = "application/pdf" | "image/jpeg" | "image/png" | "image/webp";

export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/** The server refuses a larger file (10 MB; server/_core/http.ts answers 413 "That request is too large."). */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** What the file picker offers: the kinds the server reads, and the ones read in the browser (Word, text). */
export const FILE_ACCEPT = ["application/pdf", ".pdf", DOCX_MIME, ".docx", "application/msword", ".doc", "text/plain", ".txt", "image/jpeg", ".jpg", ".jpeg", "image/png", ".png", "image/webp", ".webp"].join(",");

/** What the photo picker offers (JPEG, PNG and WebP are what the server reads). */
export const PHOTO_ACCEPT = ["image/jpeg", "image/png", "image/webp", ".jpg", ".jpeg", ".png", ".webp"].join(",");

/** The most photos one reading takes (the iPhone's picker has the same limit). */
export const PHOTO_SELECTION_LIMIT = 20;

export function imageMime(mimeType: string | undefined): UploadMime {
  if (mimeType === "image/png") return "image/png";
  if (mimeType === "image/webp") return "image/webp";
  return "image/jpeg";
}

/** What kind of file the picker handed us (by type, falling back to the name). */
export function classifyPickedFile(mimeType: string | undefined, name: string | undefined): LocalFile["kind"] {
  const mime = mimeType ?? "";
  const lower = (name ?? "").toLowerCase();
  if (mime === DOCX_MIME || mime === "application/msword" || lower.endsWith(".docx") || lower.endsWith(".doc")) return "docx";
  if (mime === "text/plain" || lower.endsWith(".txt")) return "text";
  if (mime === "application/pdf" || lower.endsWith(".pdf")) return "pdf";
  return "image";
}

/** The type a picked file is uploaded as: a PDF as a PDF, anything else as the image it is. */
export function uploadMimeFor(file: Pick<LocalFile, "kind" | "mimeType">): UploadMime {
  return file.kind === "pdf" ? "application/pdf" : imageMime(file.mimeType);
}

/** Whether a file is more than the server takes. */
export function fileTooLarge(bytes: number): boolean {
  return bytes > MAX_UPLOAD_BYTES;
}

/** Said when a picked file is over the limit (before anything is sent). */
export const FILE_TOO_LARGE_MESSAGE = "This file is larger than 10 MB, which is more than Trajectory can read. Export a smaller PDF, choose photos of the pages, or paste the text.";

export function decodeBase64Text(base64: string): string {
  const binary = typeof atob === "function" ? atob(base64) : "";
  try {
    // UTF-8 aware decode
    return decodeURIComponent(binary.split("").map((c) => "%" + c.charCodeAt(0).toString(16).padStart(2, "0")).join(""));
  } catch {
    return binary;
  }
}

/** The bytes of a file as base64 (what ai.uploadFile and ai.extractDocxText take), read in the browser. */
export function readFileAsBase64(file: Blob): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(reader.error ?? new Error("Could not read the file."));
    reader.readAsDataURL(file);
  });
}

/** What is remembered about a source while its reading runs on the server (never the text itself, never the File). */
export function pendingSourceOf(source: ExtractionSource): PendingSource {
  const local = source.local ? { uri: source.local.uri, name: source.local.name, mimeType: source.local.mimeType, kind: source.local.kind } : undefined;
  return {
    kind: source.kind,
    input: { pdfUrl: source.input.pdfUrl, pdfUrls: source.input.pdfUrls },
    ...(local ? { local } : {}),
    ...(source.pageUris ? { pageUris: source.pageUris } : {}),
  };
}

export const FILE_KIND_LABEL = { pdf: "PDF", image: "Image", docx: "Word file", text: "Text file" } as const;

/** What the wait is reading, in words: the file's name, "3 pages", "Pasted text", and the line under it. */
export function sourceWords(input: { kind: ExtractionSource["kind"]; file: Pick<LocalFile, "name" | "kind"> | null; pageCount: number; textLength: number }): { name: string; detail: string } {
  if (input.kind === "paste") return { name: "Pasted text", detail: `${input.textLength.toLocaleString("en-US")} characters` };
  if (input.kind === "scan") return { name: `${input.pageCount} page${input.pageCount === 1 ? "" : "s"}`, detail: "Photos of the pages" };
  return { name: input.file?.name ?? "Your syllabus", detail: input.file ? FILE_KIND_LABEL[input.file.kind] : "Syllabus" };
}
