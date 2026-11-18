// Document management: matter documents with versions, soft delete, tags, search,
// and document assembly from templates. Every change is written to the activity log.

import { type DB, tx } from "../db.ts";
import { EngineError } from "../engine.ts";
import { type ISODate, today as todayIn } from "../dates.ts";
import { type MergeData, fillDocx, fillText, inspectTemplate, longDate } from "./assembly.ts";
import { BlobStore, MIME, checkFilename, checkFolder, checkTypeMatchesName, detectMime, extensionOf } from "./files.ts";
import { extractText } from "./text.ts";
import { SCHEMA } from "./schema.ts";

export const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;

export interface DocumentsOptions {
  /** Where file contents live. Default: env LAWDESK_FILES, else ./files */
  dir?: string;
  /** Largest file accepted, in bytes. Default: env LAWDESK_MAX_UPLOAD_BYTES, else 25 MiB. */
  maxBytes?: number;
  today?: () => ISODate;
  /** Set false to skip FTS5 and use the LIKE fallback (for testing the fallback). */
  fts?: boolean;
}

export type OnConflict = "error" | "version" | "rename";

export interface UploadInput {
  matterId: number;
  filename: string;
  data: Buffer;
  folder?: string | null;
  category?: string | null;
  tags?: string[] | null;
  /** What to do when a live document with the same name is already in that folder. Default "error". */
  onConflict?: OnConflict;
  userId?: number | null;
}

export interface DocumentPatch {
  name?: string;
  folder?: string | null;
  category?: string | null;
  tags?: string[] | null;
}

export interface SearchInput {
  q?: string | null;
  matterId?: number | null;
  name?: string | null;
  tag?: string | null;
  category?: string | null;
  folder?: string | null;
  includeDeleted?: boolean;
  limit?: number;
}

export interface TemplateInput {
  name: string;
  filename: string;
  data: Buffer;
  description?: string | null;
  category?: string | null;
}

export interface GenerateInput {
  templateId: number;
  matterId: number;
  userId?: number | null;
  filename?: string | null;
  folder?: string | null;
  category?: string | null;
  tags?: string[] | null;
  /** Extra values for the template, available as {{custom.<key>}}. */
  custom?: Record<string, unknown> | null;
  /** Refuse to generate when the template uses fields that do not exist. */
  strict?: boolean;
}

type Row = Record<string, any>;

const TAG_RE = /^[\p{L}\p{N}][\p{L}\p{N} _.&'-]{0,49}$/u;

export function configFromEnv(env: Record<string, string | undefined> = process.env): { dir: string; maxBytes: number } {
  const n = Number(env.LAWDESK_MAX_UPLOAD_BYTES);
  return {
    dir: env.LAWDESK_FILES || "./files",
    maxBytes: Number.isInteger(n) && n > 0 ? n : DEFAULT_MAX_BYTES,
  };
}

/** Create the full-text index if this SQLite has FTS5. Returns whether it does. */
export function ensureSearchIndex(db: DB): boolean {
  try {
    db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS doc_fts USING fts5(name, body, tags, tokenize = 'unicode61 remove_diacritics 2')");
    return true;
  } catch {
    return false;
  }
}

/** Decode a base64 upload, refusing junk and anything over the size limit before decoding. */
export function decodeBase64(s: unknown, maxBytes: number, what = "contentBase64"): Buffer {
  if (typeof s !== "string") throw new EngineError(`${what} is required (the file's bytes, base64-encoded)`);
  const clean = s.replace(/\s+/g, "");
  if (Math.floor((clean.length * 3) / 4) - 2 > maxBytes) throw new EngineError(`File is larger than the ${fmtBytes(maxBytes)} limit`, 413);
  if (clean.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) throw new EngineError(`${what} is not valid base64`);
  return Buffer.from(clean, "base64");
}

export function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return `${Math.round((n / 1024 / 1024) * 10) / 10} MB`;
  if (n >= 1024) return `${Math.round(n / 102.4) / 10} KB`;
  return `${n} bytes`;
}

function checkText(v: unknown, what: string, max = 200): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") throw new EngineError(`${what} must be text`);
  const t = v.trim();
  if (t.length > max) throw new EngineError(`${what} is longer than ${max} characters`);
  return t || null;
}

function checkTags(tags: unknown): string[] {
  if (tags === undefined || tags === null) return [];
  if (!Array.isArray(tags)) throw new EngineError("Tags must be a list");
  const out = new Map<string, string>();
  for (const raw of tags) {
    if (typeof raw !== "string") throw new EngineError("Each tag must be text");
    const t = raw.trim().normalize("NFC");
    if (!TAG_RE.test(t)) throw new EngineError(`Tag "${raw}" must be 1-50 letters, digits, spaces or - _ . & '`);
    out.set(t.toLowerCase(), t);
  }
  if (out.size > 30) throw new EngineError("A document can have at most 30 tags");
  return [...out.values()];
}

/** Turn arbitrary text into something checkFilename accepts. */
function safeName(s: string): string {
  const cleaned = s
    .replace(/[\/\\:*?"<>|\u0000-\u001f\u007f]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/, "");
  return cleaned.slice(0, 150) || "Document";
}

function splitExt(name: string): [string, string] {
  const i = name.lastIndexOf(".");
  return i > 0 ? [name.slice(0, i), name.slice(i)] : [name, ""];
}

/** Build a quoted FTS5 query from what a person typed: every word must match (as a prefix). */
function ftsQuery(q: string): string | null {
  const parts: string[] = [];
  const re = /"([^"]+)"|([\p{L}\p{N}_]+)/gu;
  for (const m of q.matchAll(re)) {
    if (m[1]) {
      const words = m[1].match(/[\p{L}\p{N}_]+/gu);
      if (words) parts.push(`"${words.join(" ")}"`);
    } else parts.push(`"${m[2]}"*`);
  }
  return parts.length ? parts.join(" AND ") : null;
}

function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (c) => "\\" + c);
}

export class Documents {
  readonly db: DB;
  readonly store: BlobStore;
  readonly maxBytes: number;
  readonly ftsAvailable: boolean;
  private todayFn: () => ISODate;

  constructor(db: DB, opts: DocumentsOptions = {}) {
    const env = configFromEnv();
    this.db = db;
    db.exec(SCHEMA);
    this.ftsAvailable = opts.fts === false ? false : ensureSearchIndex(db);
    this.store = new BlobStore(opts.dir ?? env.dir);
    this.maxBytes = opts.maxBytes ?? env.maxBytes;
    this.todayFn = opts.today ?? (() => todayIn());
  }

  // ---------------------------------------------------------------- helpers

  private one(sql: string, ...params: any[]): Row | undefined {
    return this.db.prepare(sql).get(...params) as Row | undefined;
  }

  private all(sql: string, ...params: any[]): Row[] {
    return this.db.prepare(sql).all(...params) as Row[];
  }

  private run(sql: string, ...params: any[]): number {
    return Number(this.db.prepare(sql).run(...params).lastInsertRowid);
  }

  private now(): string {
    return new Date().toISOString();
  }

  /** Write to the activity log in plain English, like the rest of the log (see describe()). */
  private log(kind: string, detail: Record<string, any>, matterId: number | null, userId: number | null | undefined) {
    this.run(
      "INSERT INTO activity (at, user_id, matter_id, task_id, kind, detail) VALUES (?,?,?,NULL,?,?)",
      this.now(),
      userId ?? null,
      matterId,
      kind,
      describe(kind, detail),
    );
  }

  private checkUser(userId: number | null | undefined): number | null {
    if (userId === undefined || userId === null) return null;
    if (!this.one("SELECT 1 FROM users WHERE id = ?", userId)) throw new EngineError("User not found", 404);
    return userId;
  }

  private checkSize(data: Buffer) {
    if (!Buffer.isBuffer(data)) throw new EngineError("File contents are required");
    if (data.length === 0) throw new EngineError("The file is empty");
    if (data.length > this.maxBytes) throw new EngineError(`File is larger than the ${fmtBytes(this.maxBytes)} limit`, 413);
  }

  private docRow(id: number, includeDeleted = true): Row {
    const d = this.one("SELECT * FROM doc_documents WHERE id = ?", id);
    if (!d || (!includeDeleted && d.deleted_at)) throw new EngineError("Document not found", 404);
    return d;
  }

  private liveDoc(id: number): Row {
    const d = this.docRow(id);
    if (d.deleted_at) throw new EngineError("That document is in the trash; restore it first", 409);
    return d;
  }

  private nameTaken(matterId: number, folder: string, name: string, exceptId = 0): Row | undefined {
    return this.one(
      "SELECT * FROM doc_documents WHERE matter_id = ? AND folder = ? AND lower(name) = lower(?) AND deleted_at IS NULL AND id != ?",
      matterId,
      folder,
      name,
      exceptId,
    );
  }

  private freeName(matterId: number, folder: string, name: string, exceptId = 0): string {
    if (!this.nameTaken(matterId, folder, name, exceptId)) return name;
    const [base, ext] = splitExt(name);
    for (let n = 2; n < 10000; n++) {
      const candidate = `${base} (${n})${ext}`;
      if (!this.nameTaken(matterId, folder, candidate, exceptId)) return candidate;
    }
    throw new EngineError("Too many documents with that name");
  }

  private setTags(documentId: number, tags: string[]) {
    this.run("DELETE FROM doc_tags WHERE document_id = ?", documentId);
    for (const t of tags) this.run("INSERT INTO doc_tags (document_id, tag) VALUES (?,?)", documentId, t);
  }

  private reindex(documentId: number) {
    if (!this.ftsAvailable) return;
    const d = this.one("SELECT name FROM doc_documents WHERE id = ?", documentId);
    this.run("DELETE FROM doc_fts WHERE rowid = ?", documentId);
    if (!d) return;
    const body = this.one("SELECT body FROM doc_text WHERE document_id = ?", documentId)?.body ?? "";
    const tags = this.all("SELECT tag FROM doc_tags WHERE document_id = ?", documentId).map((r) => r.tag).join(" ");
    this.run("INSERT INTO doc_fts (rowid, name, body, tags) VALUES (?,?,?,?)", documentId, d.name, body, tags);
  }

  /** Store bytes and add them as the next version of a document. Returns the version row id. */
  private addVersionRow(
    documentId: number,
    v: { data: Buffer; mime: string; filename: string; userId: number | null; note?: string | null; restoredFrom?: number | null },
  ): number {
    const hash = this.store.put(v.data);
    const next = (this.one("SELECT MAX(version) AS v FROM doc_versions WHERE document_id = ?", documentId)?.v ?? 0) + 1;
    const now = this.now();
    const vid = this.run(
      `INSERT INTO doc_versions (document_id, version, sha256, size, mime, filename, uploaded_at, uploaded_by, note, restored_from)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      documentId,
      next,
      hash,
      v.data.length,
      v.mime,
      v.filename,
      now,
      v.userId,
      v.note ?? null,
      v.restoredFrom ?? null,
    );
    this.run("UPDATE doc_documents SET current_version_id = ?, updated_at = ? WHERE id = ?", vid, now, documentId);
    const text = extractText(v.data, v.mime);
    if (text === null) this.run("DELETE FROM doc_text WHERE document_id = ?", documentId);
    else this.run("INSERT OR REPLACE INTO doc_text (document_id, version_id, body) VALUES (?,?,?)", documentId, vid, text);
    return vid;
  }

  private summary(d: Row): Row {
    const v = d.current_version_id ? this.one("SELECT * FROM doc_versions WHERE id = ?", d.current_version_id) : undefined;
    const m = this.one("SELECT number, name FROM matters WHERE id = ?", d.matter_id);
    return {
      id: d.id,
      matterId: d.matter_id,
      matterNumber: m?.number ?? null,
      matterName: m?.name ?? null,
      name: d.name,
      folder: d.folder,
      category: d.category,
      tags: this.all("SELECT tag FROM doc_tags WHERE document_id = ? ORDER BY tag", d.id).map((r) => r.tag),
      version: v?.version ?? null,
      size: v?.size ?? null,
      mime: v?.mime ?? null,
      sha256: v?.sha256 ?? null,
      templateId: d.template_id,
      createdAt: d.created_at,
      createdBy: d.created_by,
      updatedAt: d.updated_at,
      deletedAt: d.deleted_at,
      deletedBy: d.deleted_by,
    };
  }

  // ---------------------------------------------------------------- documents

  /** Upload a file to a matter. Makes a new document, or a new version (onConflict "version"). */
  upload(input: UploadInput & { templateId?: number | null; note?: string | null }) {
    return tx(this.db, () => {
      const matter = this.one("SELECT id FROM matters WHERE id = ?", input.matterId);
      if (!matter) throw new EngineError("Matter not found", 404);
      const userId = this.checkUser(input.userId);
      let name = checkFilename(input.filename);
      const folder = checkFolder(input.folder);
      const category = checkText(input.category, "Category", 100);
      const tags = checkTags(input.tags);
      this.checkSize(input.data);
      const mime = detectMime(input.data, name);
      checkTypeMatchesName(mime, name);
      const mode = input.onConflict ?? "error";
      if (!["error", "version", "rename"].includes(mode)) throw new EngineError("onConflict must be error, version or rename");

      const existing = this.nameTaken(input.matterId, folder, name);
      if (existing) {
        if (mode === "error") {
          throw new EngineError(`"${name}" is already in this folder; upload it as a new version or choose another name`, 409);
        }
        if (mode === "version") return this.addVersion(existing.id, { filename: name, data: input.data, userId });
        name = this.freeName(input.matterId, folder, name);
      }

      const now = this.now();
      const id = this.run(
        `INSERT INTO doc_documents (matter_id, name, folder, category, template_id, created_at, created_by, updated_at)
         VALUES (?,?,?,?,?,?,?,?)`,
        input.matterId,
        name,
        folder,
        category,
        input.templateId ?? null,
        now,
        userId,
        now,
      );
      this.setTags(id, tags);
      this.addVersionRow(id, { data: input.data, mime, filename: checkFilename(input.filename), userId, note: input.note ?? null });
      this.reindex(id);
      this.log("document_uploaded", { documentId: id, name, folder, version: 1, size: input.data.length, mime }, input.matterId, userId);
      return this.summary(this.docRow(id));
    });
  }

  /** Upload a new version of an existing document. */
  addVersion(documentId: number, input: { filename: string; data: Buffer; userId?: number | null; note?: string | null }) {
    return tx(this.db, () => {
      const d = this.liveDoc(documentId);
      const userId = this.checkUser(input.userId);
      const filename = checkFilename(input.filename);
      this.checkSize(input.data);
      const mime = detectMime(input.data, filename);
      checkTypeMatchesName(mime, filename);
      // Keep the document's name, but follow the new file's extension (a .docx replaced by a .pdf).
      let name = d.name as string;
      const newExt = extensionOf(filename);
      if (newExt !== extensionOf(name)) {
        name = this.freeName(d.matter_id, d.folder, splitExt(name)[0] + (newExt ? "." + newExt : ""), d.id);
        this.run("UPDATE doc_documents SET name = ? WHERE id = ?", name, d.id);
      }
      this.addVersionRow(d.id, { data: input.data, mime, filename, userId, note: input.note ?? null });
      this.reindex(d.id);
      const s = this.summary(this.docRow(d.id));
      this.log("document_version_added", { documentId: d.id, name, version: s.version, size: input.data.length, mime }, d.matter_id, userId);
      return s;
    });
  }

  get(documentId: number) {
    return this.summary(this.docRow(documentId));
  }

  /** Documents on a matter. folder limits to that folder and its subfolders. */
  list(matterId: number, opts: { folder?: string | null; deleted?: "exclude" | "only" | "include" } = {}) {
    if (!this.one("SELECT 1 FROM matters WHERE id = ?", matterId)) throw new EngineError("Matter not found", 404);
    const where = ["matter_id = ?"];
    const params: any[] = [matterId];
    const deleted = opts.deleted ?? "exclude";
    if (deleted === "exclude") where.push("deleted_at IS NULL");
    else if (deleted === "only") where.push("deleted_at IS NOT NULL");
    if (opts.folder) {
      const f = checkFolder(opts.folder);
      where.push("(folder = ? OR folder LIKE ? ESCAPE '\\')");
      params.push(f, likeEscape(f) + "/%");
    }
    const rows = this.all(`SELECT * FROM doc_documents WHERE ${where.join(" AND ")} ORDER BY folder, lower(name)`, ...params);
    const folders = this.all(
      `SELECT folder FROM doc_documents WHERE matter_id = ? AND deleted_at IS NULL AND folder != ''
       UNION SELECT path FROM doc_folders WHERE matter_id = ? ORDER BY 1`,
      matterId,
      matterId,
    ).map((r) => r.folder);
    return { documents: rows.map((r) => this.summary(r)), folders };
  }

  versions(documentId: number) {
    this.docRow(documentId);
    return this.all(
      `SELECT v.id, v.version, v.sha256, v.size, v.mime, v.filename, v.uploaded_at AS uploadedAt, v.uploaded_by AS uploadedBy,
         u.name AS uploadedByName, v.note, v.restored_from AS restoredFrom
       FROM doc_versions v LEFT JOIN users u ON u.id = v.uploaded_by WHERE v.document_id = ? ORDER BY v.version DESC`,
      documentId,
    );
  }

  /** The file's bytes (newest version unless one is named). Downloads are logged. */
  download(documentId: number, opts: { version?: number | null; userId?: number | null; action?: "download" | "view" } = {}) {
    const d = this.liveDoc(documentId);
    const v = opts.version
      ? this.one("SELECT * FROM doc_versions WHERE document_id = ? AND version = ?", d.id, opts.version)
      : this.one("SELECT * FROM doc_versions WHERE id = ?", d.current_version_id);
    if (!v) throw new EngineError("Version not found", 404);
    const data = this.store.get(v.sha256);
    const isCurrent = v.id === d.current_version_id;
    const ext = extensionOf(v.filename);
    const filename = isCurrent ? d.name : `${splitExt(d.name)[0]} (version ${v.version})${ext ? "." + ext : ""}`;
    this.log(opts.action === "view" ? "document_viewed" : "document_downloaded", { documentId: d.id, name: d.name, version: v.version, current: isCurrent }, d.matter_id, opts.userId);
    return { filename, mime: v.mime, version: v.version, size: v.size, sha256: v.sha256, data };
  }

  /** Make an old version the newest one again (a new version, so nothing is lost). */
  restoreVersion(documentId: number, version: number, userId?: number | null) {
    return tx(this.db, () => {
      const d = this.liveDoc(documentId);
      const uid = this.checkUser(userId);
      const v = this.one("SELECT * FROM doc_versions WHERE document_id = ? AND version = ?", d.id, version);
      if (!v) throw new EngineError("Version not found", 404);
      if (v.id === d.current_version_id) throw new EngineError("That is already the newest version", 409);
      const data = this.store.get(v.sha256);
      const ext = extensionOf(v.filename);
      if (ext !== extensionOf(d.name)) {
        const name = this.freeName(d.matter_id, d.folder, splitExt(d.name)[0] + (ext ? "." + ext : ""), d.id);
        this.run("UPDATE doc_documents SET name = ? WHERE id = ?", name, d.id);
      }
      this.addVersionRow(d.id, { data, mime: v.mime, filename: v.filename, userId: uid, note: `Restored from version ${version}`, restoredFrom: version });
      this.reindex(d.id);
      const s = this.summary(this.docRow(d.id));
      this.log("document_version_restored", { documentId: d.id, name: s.name, from: version, version: s.version }, d.matter_id, uid);
      return s;
    });
  }

  /** Rename, move, re-categorise or re-tag a document. */
  update(documentId: number, patch: DocumentPatch, userId?: number | null) {
    return tx(this.db, () => {
      const d = this.liveDoc(documentId);
      const uid = this.checkUser(userId);
      const changes: Record<string, unknown> = {};
      let name = d.name as string;
      let folder = d.folder as string;
      if (patch.name !== undefined) {
        name = checkFilename(patch.name);
        const mime = this.one("SELECT mime FROM doc_versions WHERE id = ?", d.current_version_id)?.mime;
        if (mime) checkTypeMatchesName(mime, name);
      }
      if (patch.folder !== undefined) folder = checkFolder(patch.folder);
      if (name !== d.name || folder !== d.folder) {
        if (this.nameTaken(d.matter_id, folder, name, d.id)) throw new EngineError(`"${name}" is already in that folder`, 409);
        if (name !== d.name) changes.name = { from: d.name, to: name };
        if (folder !== d.folder) changes.folder = { from: d.folder, to: folder };
        this.run("UPDATE doc_documents SET name = ?, folder = ? WHERE id = ?", name, folder, d.id);
      }
      if (patch.category !== undefined) {
        const c = checkText(patch.category, "Category", 100);
        if (c !== d.category) {
          changes.category = { from: d.category, to: c };
          this.run("UPDATE doc_documents SET category = ? WHERE id = ?", c, d.id);
        }
      }
      if (patch.tags !== undefined) {
        const before = this.all("SELECT tag FROM doc_tags WHERE document_id = ? ORDER BY tag", d.id).map((r) => r.tag);
        const after = checkTags(patch.tags);
        if (JSON.stringify([...after].sort()) !== JSON.stringify(before)) {
          changes.tags = { from: before, to: after };
          this.setTags(d.id, after);
        }
      }
      if (Object.keys(changes).length) {
        this.run("UPDATE doc_documents SET updated_at = ? WHERE id = ?", this.now(), d.id);
        this.reindex(d.id);
        this.log("document_updated", { documentId: d.id, current: name, ...changes }, d.matter_id, uid);
      }
      return this.summary(this.docRow(d.id));
    });
  }

  /** Move a document to the trash. Its files and versions are kept. */
  delete(documentId: number, userId?: number | null) {
    return tx(this.db, () => {
      const d = this.liveDoc(documentId);
      const uid = this.checkUser(userId);
      this.run("UPDATE doc_documents SET deleted_at = ?, deleted_by = ? WHERE id = ?", this.now(), uid, d.id);
      this.log("document_deleted", { documentId: d.id, name: d.name, folder: d.folder }, d.matter_id, uid);
      return this.summary(this.docRow(d.id));
    });
  }

  /** Bring a document back from the trash (renamed if its old name has been reused). */
  restore(documentId: number, userId?: number | null) {
    return tx(this.db, () => {
      const d = this.docRow(documentId);
      if (!d.deleted_at) throw new EngineError("That document is not in the trash", 409);
      const uid = this.checkUser(userId);
      const name = this.freeName(d.matter_id, d.folder, d.name, d.id);
      this.run("UPDATE doc_documents SET deleted_at = NULL, deleted_by = NULL, name = ?, updated_at = ? WHERE id = ?", name, this.now(), d.id);
      this.reindex(d.id);
      this.log("document_restored", { documentId: d.id, name, ...(name !== d.name ? { renamedFrom: d.name } : {}) }, d.matter_id, uid);
      return this.summary(this.docRow(d.id));
    });
  }

  // ---------------------------------------------------------------- search

  /**
   * Find documents. q matches words in the name, tags and text of the newest version (each word
   * must appear; words match as prefixes; "quoted phrases" match exactly). The other fields filter.
   */
  search(input: SearchInput) {
    const where: string[] = [];
    const params: any[] = [];
    if (!input.includeDeleted) where.push("d.deleted_at IS NULL");
    if (input.matterId) {
      where.push("d.matter_id = ?");
      params.push(input.matterId);
    }
    if (input.category) {
      where.push("lower(d.category) = lower(?)");
      params.push(input.category.trim());
    }
    if (input.folder) {
      const f = checkFolder(input.folder);
      where.push("(d.folder = ? OR d.folder LIKE ? ESCAPE '\\')");
      params.push(f, likeEscape(f) + "/%");
    }
    if (input.tag) {
      where.push("EXISTS (SELECT 1 FROM doc_tags t WHERE t.document_id = d.id AND t.tag = ?)");
      params.push(input.tag.trim());
    }
    if (input.name) {
      where.push("d.name LIKE ? ESCAPE '\\'");
      params.push("%" + likeEscape(input.name.trim()) + "%");
    }
    const limit = Math.min(Math.max(Math.trunc(input.limit ?? 50), 1), 200);
    const q = input.q?.trim();
    let rows: Row[];
    if (q) {
      if (this.ftsAvailable) {
        const fq = ftsQuery(q);
        if (!fq) return { results: [], fts: true };
        rows = this.all(
          `SELECT d.*, snippet(doc_fts, 1, '${MARK_ON}', '${MARK_OFF}', '…', 12) AS marked, bm25(doc_fts, 10.0, 1.0, 5.0) AS rank
           FROM doc_fts JOIN doc_documents d ON d.id = doc_fts.rowid
           WHERE doc_fts MATCH ? ${where.length ? "AND " + where.join(" AND ") : ""}
           ORDER BY rank LIMIT ?`,
          fq,
          ...params,
          limit,
        );
      } else {
        const words = q.match(/[\p{L}\p{N}_]+/gu) ?? [];
        if (!words.length) return { results: [], fts: false };
        for (const w of words) {
          where.push(
            `(d.name LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM doc_text x WHERE x.document_id = d.id AND x.body LIKE ? ESCAPE '\\')
              OR EXISTS (SELECT 1 FROM doc_tags t WHERE t.document_id = d.id AND t.tag LIKE ? ESCAPE '\\'))`,
          );
          const pat = "%" + likeEscape(w) + "%";
          params.push(pat, pat, pat);
        }
        rows = this.all(`SELECT d.* FROM doc_documents d WHERE ${where.join(" AND ")} ORDER BY d.updated_at DESC LIMIT ?`, ...params, limit);
        for (const r of rows) {
          const body = this.one("SELECT body FROM doc_text WHERE document_id = ?", r.id)?.body;
          r.marked = body ? likeSnippet(body, words) : null;
        }
      }
    } else {
      rows = this.all(
        `SELECT d.* FROM doc_documents d ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY d.updated_at DESC, d.id DESC LIMIT ?`,
        ...params,
        limit,
      );
    }
    return {
      results: rows.map((r) => {
        const parts = r.marked ? snippetParts(r.marked) : null;
        return {
          ...this.summary(r),
          // Plain text with [brackets] round the matches, and the same as parts for safe display.
          snippet: parts ? parts.map((p) => (p.hit ? `[${p.text}]` : p.text)).join("") : null,
          highlights: parts && parts.some((p) => p.hit) ? parts : null,
        };
      }),
      fts: this.ftsAvailable,
    };
  }

  // ---------------------------------------------------------------- templates

  private templateKind(data: Buffer, filename: string): { kind: "docx" | "txt" | "html"; mime: string } {
    const mime = detectMime(data, filename);
    checkTypeMatchesName(mime, filename);
    if (mime === MIME.docx) return { kind: "docx", mime };
    if (mime === MIME.html) return { kind: "html", mime };
    if (mime === MIME.txt || mime === MIME.md) return { kind: "txt", mime };
    throw new EngineError("Templates must be .docx, .txt, .md or .html files", 415);
  }

  private templateSummary(t: Row) {
    return {
      id: t.id,
      name: t.name,
      description: t.description,
      category: t.category,
      kind: t.kind,
      filename: t.filename,
      size: t.size,
      sha256: t.sha256,
      fields: JSON.parse(t.fields),
      createdAt: t.created_at,
      createdBy: t.created_by,
      updatedAt: t.updated_at,
      updatedBy: t.updated_by,
      deletedAt: t.deleted_at,
    };
  }

  private templateRow(id: number, includeDeleted = false): Row {
    const t = this.one("SELECT * FROM doc_templates WHERE id = ?", id);
    if (!t || (!includeDeleted && t.deleted_at)) throw new EngineError("Template not found", 404);
    return t;
  }

  createTemplate(input: TemplateInput, userId?: number | null) {
    return tx(this.db, () => {
      const uid = this.checkUser(userId);
      const name = checkText(input.name, "Template name");
      if (!name) throw new EngineError("A template needs a name");
      const filename = checkFilename(input.filename);
      this.checkSize(input.data);
      const { kind } = this.templateKind(input.data, filename);
      const { fields } = inspectTemplate(kind, input.data);
      const hash = this.store.put(input.data);
      const now = this.now();
      const id = this.run(
        `INSERT INTO doc_templates (name, description, category, kind, filename, sha256, size, fields, created_at, created_by, updated_at, updated_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        name,
        checkText(input.description, "Description", 1000),
        checkText(input.category, "Category", 100),
        kind,
        filename,
        hash,
        input.data.length,
        JSON.stringify(fields),
        now,
        uid,
        now,
        uid,
      );
      this.log("template_created", { templateId: id, name, filename }, null, uid);
      return this.templateSummary(this.templateRow(id));
    });
  }

  listTemplates(opts: { category?: string | null; includeDeleted?: boolean } = {}) {
    const where: string[] = [];
    const params: any[] = [];
    if (!opts.includeDeleted) where.push("deleted_at IS NULL");
    if (opts.category) {
      where.push("lower(category) = lower(?)");
      params.push(opts.category);
    }
    return this.all(`SELECT * FROM doc_templates ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY lower(name)`, ...params).map((t) =>
      this.templateSummary(t),
    );
  }

  getTemplate(id: number) {
    return this.templateSummary(this.templateRow(id));
  }

  downloadTemplate(id: number) {
    const t = this.templateRow(id);
    const data = this.store.get(t.sha256);
    return { filename: t.filename, mime: detectMime(data, t.filename), data };
  }

  updateTemplate(
    id: number,
    patch: { name?: string; description?: string | null; category?: string | null; filename?: string; data?: Buffer },
    userId?: number | null,
  ) {
    return tx(this.db, () => {
      const t = this.templateRow(id);
      const uid = this.checkUser(userId);
      const changed: string[] = [];
      if (patch.name !== undefined) {
        const name = checkText(patch.name, "Template name");
        if (!name) throw new EngineError("A template needs a name");
        this.run("UPDATE doc_templates SET name = ? WHERE id = ?", name, id);
        changed.push("name");
      }
      if (patch.description !== undefined) {
        this.run("UPDATE doc_templates SET description = ? WHERE id = ?", checkText(patch.description, "Description", 1000), id);
        changed.push("description");
      }
      if (patch.category !== undefined) {
        this.run("UPDATE doc_templates SET category = ? WHERE id = ?", checkText(patch.category, "Category", 100), id);
        changed.push("category");
      }
      if (patch.data !== undefined) {
        const filename = checkFilename(patch.filename ?? t.filename);
        this.checkSize(patch.data);
        const { kind } = this.templateKind(patch.data, filename);
        const { fields } = inspectTemplate(kind, patch.data);
        const hash = this.store.put(patch.data);
        this.run(
          "UPDATE doc_templates SET kind = ?, filename = ?, sha256 = ?, size = ?, fields = ? WHERE id = ?",
          kind,
          filename,
          hash,
          patch.data.length,
          JSON.stringify(fields),
          id,
        );
        changed.push("file");
      } else if (patch.filename !== undefined) throw new EngineError("Send the new file's contents along with its file name");
      if (changed.length) {
        this.run("UPDATE doc_templates SET updated_at = ?, updated_by = ? WHERE id = ?", this.now(), uid, id);
        this.log("template_updated", { templateId: id, name: this.templateRow(id).name, changed }, null, uid);
      }
      return this.templateSummary(this.templateRow(id));
    });
  }

  deleteTemplate(id: number, userId?: number | null) {
    const t = this.templateRow(id);
    const uid = this.checkUser(userId);
    this.run("UPDATE doc_templates SET deleted_at = ?, deleted_by = ? WHERE id = ?", this.now(), uid, id);
    this.log("template_deleted", { templateId: id, name: t.name }, null, uid);
    return this.templateSummary(this.templateRow(id, true));
  }

  restoreTemplate(id: number, userId?: number | null) {
    const t = this.templateRow(id, true);
    if (!t.deleted_at) throw new EngineError("That template is not deleted", 409);
    const uid = this.checkUser(userId);
    this.run("UPDATE doc_templates SET deleted_at = NULL, deleted_by = NULL WHERE id = ?", id);
    this.log("template_restored", { templateId: id, name: t.name }, null, uid);
    return this.templateSummary(this.templateRow(id));
  }

  // ---------------------------------------------------------------- assembly

  /**
   * The values a template can use for a matter:
   *   today, today_iso, user.*, client.*, matter.* (number, name, description, status, opened_on,
   *   closed_on, practice_area, stage), matter.dates.<date field key>, matter.roles.<role>, custom.*
   */
  mergeData(matterId: number, userId?: number | null, custom?: Record<string, unknown> | null): MergeData {
    const m = this.one(
      `SELECT m.*, p.name AS practice_area, s.name AS stage FROM matters m
       LEFT JOIN practice_areas p ON p.id = m.practice_area_id LEFT JOIN stages s ON s.id = m.stage_id WHERE m.id = ?`,
      matterId,
    );
    if (!m) throw new EngineError("Matter not found", 404);
    const c = m.client_id ? this.one("SELECT * FROM contacts WHERE id = ?", m.client_id) : undefined;
    const u = userId ? this.one("SELECT * FROM users WHERE id = ?", userId) : undefined;
    const dates: MergeData = {};
    for (const f of this.all(
      "SELECT f.key, d.value FROM date_fields f LEFT JOIN matter_dates d ON d.field_key = f.key AND d.matter_id = ?",
      matterId,
    )) {
      dates[f.key] = f.value ?? null;
    }
    const roles: MergeData = {};
    for (const r of this.all("SELECT r.role, u.name FROM matter_roles r JOIN users u ON u.id = r.user_id WHERE r.matter_id = ?", matterId)) {
      roles[r.role] = r.name;
    }
    const today = this.todayFn();
    return {
      today: longDate(today),
      today_iso: today,
      user: { name: u?.name ?? null, email: u?.email ?? null },
      client: { name: c?.name ?? null, email: c?.email ?? null, phone: c?.phone ?? null, kind: c?.kind ?? null },
      matter: {
        id: m.id,
        number: m.number,
        name: m.name,
        description: m.description,
        status: m.status,
        opened_on: m.opened_on,
        closed_on: m.closed_on,
        practice_area: m.practice_area,
        stage: m.stage,
        dates,
        roles,
      },
      custom: checkCustom(custom),
    };
  }

  private fill(t: Row, data: MergeData): { out: Buffer; unknown: string[]; empty: string[] } {
    const src = this.store.get(t.sha256);
    if (t.kind === "docx") {
      const r = fillDocx(src, data);
      return { out: r.output, unknown: r.unknown, empty: r.empty };
    }
    const r = fillText(src.toString("utf8"), data, { html: t.kind === "html" });
    return { out: Buffer.from(r.output, "utf8"), unknown: r.unknown, empty: r.empty };
  }

  /**
   * What generating this template for this matter would fill in, without saving anything:
   * each field the template uses with its value, and which will come out blank.
   */
  checkTemplate(templateId: number, matterId: number, userId?: number | null) {
    const t = this.templateRow(templateId);
    const uid = this.checkUser(userId);
    const data = this.mergeData(matterId, uid);
    const { unknown, empty } = this.fill(t, data);
    const catalog = new Map(this.fieldCatalog().flatMap((g) => g.fields).map((f) => [f.field, f.label]));
    const fields = (JSON.parse(t.fields) as string[]).map((field) => {
      const value = resolvePath(data, field);
      const status = unknown.includes(field) || value === undefined ? "unknown" : value === "" ? "empty" : "filled";
      return { field, label: catalog.get(field) ?? labelFor(field), value: value ?? "", status };
    });
    const ext = extensionOf(t.filename);
    const matter = data.matter as MergeData;
    return {
      template: this.templateSummary(t),
      fields,
      unknown,
      empty,
      suggestedName: `${safeName(`${t.name} - ${matter.number || matter.name}`)}${ext ? "." + ext : ""}`,
    };
  }

  /** Every merge field a template can use, grouped, with a plain-English description. */
  fieldCatalog(): { group: string; fields: { field: string; label: string; example?: string; hint?: string }[] }[] {
    const dates = this.all("SELECT key, label FROM date_fields ORDER BY label").map((f) => ({
      field: `matter.dates.${f.key}`,
      label: f.label,
      hint: "Add |long to write the date out, like November 18, 2026",
    }));
    const roleNames = this.all(
      "SELECT role FROM matter_roles UNION SELECT default_role FROM users WHERE default_role IS NOT NULL ORDER BY 1",
    ).map((r) => r.role as string);
    const roles = roleNames
      .filter((r) => /^[A-Za-z0-9_]+$/.test(r))
      .map((r) => ({ field: `matter.roles.${r}`, label: `Name of the matter's ${r.replace(/_/g, " ")}` }));
    return [
      {
        group: "Dates",
        fields: [
          { field: "today", label: "Today's date, written out", example: longDate(this.todayFn()) },
          { field: "today_iso", label: "Today's date as numbers (YYYY-MM-DD)", example: this.todayFn() },
        ],
      },
      {
        group: "Client",
        fields: [
          { field: "client.name", label: "Client's name" },
          { field: "client.email", label: "Client's email address" },
          { field: "client.phone", label: "Client's phone number" },
          { field: "client.kind", label: "Whether the client is a person or a company" },
        ],
      },
      {
        group: "Matter",
        fields: [
          { field: "matter.number", label: "Matter number" },
          { field: "matter.name", label: "Matter name" },
          { field: "matter.description", label: "Matter description" },
          { field: "matter.practice_area", label: "Practice area" },
          { field: "matter.stage", label: "Current stage" },
          { field: "matter.status", label: "Open or closed" },
          { field: "matter.opened_on", label: "Date the matter was opened", hint: "Add |long to write the date out" },
          { field: "matter.closed_on", label: "Date the matter was closed", hint: "Add |long to write the date out" },
        ],
      },
      { group: "Matter dates", fields: dates },
      { group: "People on the matter", fields: roles },
      {
        group: "You",
        fields: [
          { field: "user.name", label: "Your name (the person creating the document)" },
          { field: "user.email", label: "Your email address" },
        ],
      },
    ];
  }

  /** Extracted text of the newest version (for previewing Word and text files). */
  text(documentId: number) {
    const d = this.liveDoc(documentId);
    const row = this.one("SELECT body FROM doc_text WHERE document_id = ?", d.id);
    if (!row) return { text: null, truncated: false };
    const MAX = 200_000;
    return { text: row.body.length > MAX ? row.body.slice(0, MAX) : row.body, truncated: row.body.length > MAX };
  }

  /** Values in use, for search filters, and the upload limit. */
  facets() {
    return {
      maxBytes: this.maxBytes,
      categories: this.all(
        "SELECT DISTINCT category FROM doc_documents WHERE deleted_at IS NULL AND category IS NOT NULL ORDER BY lower(category)",
      ).map((r) => r.category),
      tags: this.all(
        `SELECT MIN(t.tag) AS tag FROM doc_tags t JOIN doc_documents d ON d.id = t.document_id
         WHERE d.deleted_at IS NULL GROUP BY lower(t.tag) ORDER BY lower(t.tag)`,
      ).map((r) => r.tag),
      matters: this.all(
        `SELECT m.id, m.number, m.name, COUNT(d.id) AS documents FROM matters m
         JOIN doc_documents d ON d.matter_id = m.id AND d.deleted_at IS NULL
         GROUP BY m.id ORDER BY m.number, m.name`,
      ).map((r) => ({ id: r.id, number: r.number, name: r.name, documents: r.documents })),
    };
  }

  // ---------------------------------------------------------------- folders

  private within(col: string): string {
    return `(${col} = ? OR ${col} LIKE ? ESCAPE '\\')`;
  }

  private addFolderRows(matterId: number, path: string) {
    const parts = path.split("/");
    for (let i = 1; i <= parts.length; i++) {
      this.run("INSERT OR IGNORE INTO doc_folders (matter_id, path) VALUES (?,?)", matterId, parts.slice(0, i).join("/"));
    }
  }

  /** Make an empty folder (otherwise a folder exists only because documents are in it). */
  createFolder(matterId: number, path: unknown, userId?: number | null) {
    return tx(this.db, () => {
      if (!this.one("SELECT 1 FROM matters WHERE id = ?", matterId)) throw new EngineError("Matter not found", 404);
      const uid = this.checkUser(userId);
      const f = checkFolder(path);
      if (!f) throw new EngineError("Give the folder a name");
      this.addFolderRows(matterId, f);
      this.log("folder_created", { folder: f }, matterId, uid);
      return this.list(matterId);
    });
  }

  /** Rename or move a folder, with every document and folder inside it. */
  renameFolder(matterId: number, from: unknown, to: unknown, userId?: number | null) {
    return tx(this.db, () => {
      if (!this.one("SELECT 1 FROM matters WHERE id = ?", matterId)) throw new EngineError("Matter not found", 404);
      const uid = this.checkUser(userId);
      const a = checkFolder(from);
      const b = checkFolder(to);
      if (!a || !b) throw new EngineError("Folder names can't be empty");
      if (a === b) return this.list(matterId);
      if (b.startsWith(a + "/")) throw new EngineError("A folder can't be moved inside itself");
      const args = [a, likeEscape(a) + "/%"];
      const docs = this.all(`SELECT * FROM doc_documents WHERE matter_id = ? AND ${this.within("folder")}`, matterId, ...args);
      const known = this.all(`SELECT path FROM doc_folders WHERE matter_id = ? AND ${this.within("path")}`, matterId, ...args);
      if (!docs.some((d) => !d.deleted_at) && !known.length) throw new EngineError("Folder not found", 404);
      const moved = (p: string) => b + p.slice(a.length);
      for (const d of docs) {
        const dest = checkFolder(moved(d.folder));
        if (!d.deleted_at && this.nameTaken(matterId, dest, d.name, d.id)) throw new EngineError(`"${d.name}" is already in ${dest}`, 409);
        // Trashed documents move too, so restoring one puts it back in the right place.
        this.run("UPDATE doc_documents SET folder = ? WHERE id = ?", dest, d.id);
        if (!d.deleted_at) this.reindex(d.id);
      }
      for (const r of known) this.run("DELETE FROM doc_folders WHERE matter_id = ? AND path = ?", matterId, r.path);
      for (const r of known) this.addFolderRows(matterId, moved(r.path));
      this.addFolderRows(matterId, b);
      this.log("folder_renamed", { from: a, to: b, documents: docs.filter((d) => !d.deleted_at).length }, matterId, uid);
      return this.list(matterId);
    });
  }

  /** Remove an empty folder. A folder with documents in it can't be removed. */
  deleteFolder(matterId: number, path: unknown, userId?: number | null) {
    return tx(this.db, () => {
      const uid = this.checkUser(userId);
      const f = checkFolder(path);
      if (!f) throw new EngineError("Folder not found", 404);
      const args = [f, likeEscape(f) + "/%"];
      const n = this.one(`SELECT COUNT(*) AS n FROM doc_documents WHERE matter_id = ? AND deleted_at IS NULL AND ${this.within("folder")}`, matterId, ...args)!.n;
      if (n) throw new EngineError(`That folder still has ${n === 1 ? "a document" : n + " documents"} in it; move or delete them first`, 409);
      this.run(`DELETE FROM doc_folders WHERE matter_id = ? AND ${this.within("path")}`, matterId, ...args);
      this.log("folder_deleted", { folder: f }, matterId, uid);
      return this.list(matterId);
    });
  }

  /** Fill a template for a matter and save the result as a new document on the matter. */
  generate(input: GenerateInput) {
    const t = this.templateRow(input.templateId);
    const uid = this.checkUser(input.userId);
    const data = this.mergeData(input.matterId, uid, input.custom);
    const { out, unknown, empty } = this.fill(t, data);
    if (input.strict && unknown.length) throw new EngineError(`The template uses fields that do not exist: ${unknown.join(", ")}`);
    const ext = extensionOf(t.filename);
    const matter = data.matter as MergeData;
    const filename = input.filename
      ? checkFilename(input.filename)
      : checkFilename(`${safeName(`${t.name} - ${matter.number || matter.name}`)}${ext ? "." + ext : ""}`);
    if (extensionOf(filename) !== ext) throw new EngineError(`The file name must end in .${ext}, like the template`);
    return tx(this.db, () => {
      const doc = this.upload({
        matterId: input.matterId,
        filename,
        data: out,
        folder: input.folder,
        category: input.category ?? t.category,
        tags: input.tags,
        onConflict: "rename",
        userId: uid,
        templateId: t.id,
        note: `Generated from template "${t.name}"`,
      });
      this.log("document_generated", { documentId: doc.id, name: doc.name, templateId: t.id, template: t.name, unknown, empty }, input.matterId, uid);
      return { document: doc, unknown, empty };
    });
  }
}

function checkCustom(custom: Record<string, unknown> | null | undefined): MergeData {
  if (custom === undefined || custom === null) return {};
  if (typeof custom !== "object" || Array.isArray(custom)) throw new EngineError("custom must be an object of names to values");
  const walk = (o: Record<string, unknown>, depth: number): MergeData => {
    const out: MergeData = {};
    for (const [k, v] of Object.entries(o)) {
      if (!/^[A-Za-z0-9_]{1,64}$/.test(k)) throw new EngineError(`custom field name "${k}" may use only letters, digits and _`);
      if (v === null || typeof v === "string" || typeof v === "number") {
        if (typeof v === "string" && v.length > 20000) throw new EngineError(`custom.${k} is too long`);
        out[k] = v;
      } else if (typeof v === "boolean") out[k] = v ? "yes" : "";
      else if (typeof v === "object" && !Array.isArray(v) && depth < 3) out[k] = walk(v as Record<string, unknown>, depth + 1);
      else throw new EngineError(`custom.${k} must be text, a number or a nested object`);
    }
    return out;
  };
  return walk(custom, 0);
}

// ------------------------------------------------------------------ search snippets

// SQLite's snippet() marks matches with these. Extracted text never keeps control
// characters as words, and snippetParts() turns them into structured parts.
const MARK_ON = "\u0002";
const MARK_OFF = "\u0003";

/** Split marked snippet text into plain and matched parts. */
function snippetParts(marked: string): { text: string; hit: boolean }[] {
  const out: { text: string; hit: boolean }[] = [];
  const clean = (t: string) => t.replace(/[\u0000-\u0001\u0004-\u001f]/g, " ").replace(/\s+/g, " ");
  marked.split(MARK_ON).forEach((chunk, i) => {
    if (i === 0) {
      if (chunk) out.push({ text: clean(chunk), hit: false });
      return;
    }
    const [hit, rest = ""] = chunk.split(MARK_OFF);
    if (hit) out.push({ text: clean(hit), hit: true });
    if (rest) out.push({ text: clean(rest), hit: false });
  });
  return out;
}

/** A short marked excerpt around the first matching word (used when FTS5 is missing). */
function likeSnippet(body: string, words: string[]): string | null {
  const lower = body.toLowerCase();
  let at = -1;
  for (const w of words) {
    const i = lower.indexOf(w.toLowerCase());
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  if (at < 0) return null;
  const start = Math.max(0, at - 60);
  const end = Math.min(body.length, at + 120);
  const text = (start > 0 ? "…" : "") + body.slice(start, end).replace(/[\u0002\u0003]/g, " ") + (end < body.length ? "…" : "");
  const re = new RegExp(words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "giu");
  return text.replace(re, (m) => MARK_ON + m + MARK_OFF);
}

/** The value at a dotted path, or undefined when there is no such field. */
function resolvePath(data: MergeData, path: string): string | undefined {
  let cur: unknown = data;
  for (const part of path.split(".")) {
    if (cur === null || cur === undefined || typeof cur !== "object" || !Object.hasOwn(cur, part)) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  if (cur !== null && typeof cur === "object") return undefined;
  return cur === null || cur === undefined ? "" : String(cur);
}

/** "custom.buyer_name" -> "Buyer name (typed in ...)" for fields not in the catalog. */
function labelFor(field: string): string {
  const parts = field.split(".");
  const last = parts[parts.length - 1].replace(/_/g, " ");
  const nice = last.charAt(0).toUpperCase() + last.slice(1);
  return parts[0] === "custom" ? `${nice} (typed in when creating the document)` : nice;
}

// ------------------------------------------------------------------ activity wording

const q = (s: unknown) => `“${s}”`;
const where = (f: string) => (f ? f.split("/").join(" › ") : "the top level");
const fieldList = (a: string[]) => a.join(", ");

/** One plain-English line for the activity log. */
export function describe(kind: string, d: Record<string, any>): string {
  switch (kind) {
    case "document_uploaded":
      return `Uploaded ${q(d.name)}${d.folder ? ` to ${where(d.folder)}` : ""}`;
    case "document_version_added":
      return `Uploaded version ${d.version} of ${q(d.name)}`;
    case "document_downloaded":
      return `Downloaded ${q(d.name)}${d.current === false ? ` (version ${d.version})` : ""}`;
    case "document_viewed":
      return `Viewed ${q(d.name)}${d.current === false ? ` (version ${d.version})` : ""}`;
    case "document_version_restored":
      return `Made version ${d.from} of ${q(d.name)} current again (saved as version ${d.version})`;
    case "document_updated": {
      const parts: string[] = [];
      if (d.name) parts.push(`Renamed ${q(d.name.from)} to ${q(d.name.to)}`);
      if (d.folder) parts.push(`Moved ${q(d.current)} from ${where(d.folder.from)} to ${where(d.folder.to)}`);
      if (d.category) parts.push(d.category.to ? `Set the category of ${q(d.current)} to ${d.category.to}` : `Cleared the category of ${q(d.current)}`);
      if (d.tags) parts.push(d.tags.to.length ? `Tagged ${q(d.current)}: ${fieldList(d.tags.to)}` : `Removed the tags from ${q(d.current)}`);
      return parts.join("; ") || `Changed ${q(d.current)}`;
    }
    case "document_deleted":
      return `Deleted ${q(d.name)}`;
    case "document_restored":
      return d.renamedFrom ? `Restored ${q(d.renamedFrom)} as ${q(d.name)} (the old name was in use)` : `Restored ${q(d.name)} from deleted documents`;
    case "document_generated": {
      const blanks = [...(d.empty ?? []), ...(d.unknown ?? [])];
      return `Created ${q(d.name)} from the template ${q(d.template)}${blanks.length ? `; left blank: ${fieldList(blanks)}` : ""}`;
    }
    case "template_created":
      return `Added the document template ${q(d.name)}`;
    case "template_updated":
      return `Changed the document template ${q(d.name)} (${fieldList(d.changed ?? [])})`;
    case "template_deleted":
      return `Deleted the document template ${q(d.name)}`;
    case "template_restored":
      return `Restored the document template ${q(d.name)}`;
    case "folder_created":
      return `Made the folder ${where(d.folder)}`;
    case "folder_renamed":
      return `Renamed the folder ${where(d.from)} to ${where(d.to)}`;
    case "folder_deleted":
      return `Removed the empty folder ${where(d.folder)}`;
    default:
      return kind.replace(/_/g, " ");
  }
}
