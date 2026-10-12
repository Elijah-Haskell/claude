/**
 * The syllabus reading that is in flight on the server, remembered in this browser (the iPhone app's
 * lib/pending-extraction.ts, with localStorage for AsyncStorage).
 *
 * The server keeps reading (and has already charged for it) when the browser drops the connection, the tab is
 * closed or the page is reloaded. Remembering the job id lets the syllabus screen pick the result up where it left
 * off instead of uploading and paying again. Only the job id, the uploaded file's URL(s) and the local file's name
 * are stored: never the document or its text. (A picked File itself cannot outlive the page: after a reload the
 * reading is resumed by its id, and a failed one asks for the file again.)
 */
import { appStorage, type AsyncKeyValueStore } from "./storage";

export const PENDING_EXTRACTION_KEY = "trajectory.syllabus.pendingExtraction.v1";
/** The server keeps a finished reading for 2 hours (server/extraction-jobs.ts ttlMs). */
export const PENDING_EXTRACTION_MAX_AGE_MS = 2 * 60 * 60_000;

export interface PendingLocalFile {
  /** An object URL on the web (dead after a reload); kept for the shape the iPhone app stores. */
  uri: string;
  name: string;
  mimeType: string;
  kind: "pdf" | "image" | "docx" | "text";
}

export interface PendingSource {
  kind: "file" | "scan" | "paste";
  input: { pdfUrl?: string; pdfUrls?: string[] };
  local?: PendingLocalFile;
  pageUris?: string[];
}

export interface PendingExtraction {
  version: 1;
  jobId: string;
  /** Epoch ms when the job was started. */
  startedAt: number;
  source: PendingSource;
  courseHint: string;
}

type Store = Pick<AsyncKeyValueStore, "getItem" | "setItem" | "removeItem">;

/** A stored record that is well-formed and young enough for the server to still have the job. */
export function parsePendingExtraction(raw: string | null, now: number): PendingExtraction | null {
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const rec = value as Partial<PendingExtraction> | null;
  if (!rec || rec.version !== 1 || typeof rec.jobId !== "string" || !rec.jobId || typeof rec.startedAt !== "number") return null;
  if (!rec.source || typeof rec.source !== "object" || !["file", "scan", "paste"].includes(String(rec.source.kind))) return null;
  if (now - rec.startedAt > PENDING_EXTRACTION_MAX_AGE_MS || rec.startedAt > now + 60_000) return null;
  return { version: 1, jobId: rec.jobId, startedAt: rec.startedAt, source: rec.source as PendingSource, courseHint: typeof rec.courseHint === "string" ? rec.courseHint : "" };
}

/** Does a stored record belong to this source (same uploaded file(s))? */
export function isSameSource(a: Pick<PendingSource, "input">, b: Pick<PendingSource, "input">): boolean {
  if (a.input.pdfUrl || b.input.pdfUrl) return a.input.pdfUrl === b.input.pdfUrl;
  const x = a.input.pdfUrls ?? [];
  const y = b.input.pdfUrls ?? [];
  return x.length > 0 && x.length === y.length && x.every((url, i) => url === y[i]);
}

export async function savePendingExtraction(record: Omit<PendingExtraction, "version">, store: Store = appStorage): Promise<void> {
  try {
    await store.setItem(PENDING_EXTRACTION_KEY, JSON.stringify({ version: 1, ...record }));
  } catch {
    // best effort: without it the reading simply cannot be resumed after the page is closed
  }
}

/** The remembered reading, or null (an old or damaged record is removed). */
export async function loadPendingExtraction(now: number = Date.now(), store: Store = appStorage): Promise<PendingExtraction | null> {
  try {
    const raw = await store.getItem(PENDING_EXTRACTION_KEY);
    const record = parsePendingExtraction(raw, now);
    if (raw && !record) await store.removeItem(PENDING_EXTRACTION_KEY);
    return record;
  } catch {
    return null;
  }
}

/** Forget the remembered reading; with `jobId`, only if it is still that one (a newer reading is kept). */
export async function clearPendingExtraction(jobId?: string, store: Store = appStorage): Promise<void> {
  try {
    if (jobId) {
      const current = parsePendingExtraction(await store.getItem(PENDING_EXTRACTION_KEY), Date.now());
      if (current && current.jobId !== jobId) return;
    }
    await store.removeItem(PENDING_EXTRACTION_KEY);
  } catch {
    // ignore
  }
}
