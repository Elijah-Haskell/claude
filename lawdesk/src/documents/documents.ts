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

  private log(kind: string, detail: object, matterId: number | null, userId: number | null | undefined) {
    this.run(
      "INSERT INTO activity (at, user_id, matter_id, task_id, kind, detail) VALUES (?,?,?,NULL,?,?)",
      this.now(),
      userId ?? null,
      matterId,
      kind,
      JSON.stringify(detail),
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
    const folders = this.all("SELECT DISTINCT folder FROM doc_documents WHERE matter_id = ? AND deleted_at IS NULL AND folder != '' ORDER BY folder", matterId).map(
      (r) => r.folder,
    );
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
  download(documentId: number, opts: { version?: number | null; userId?: number | null } = {}) {
    const d = this.liveDoc(documentId);
    const v = opts.version
      ? this.one("SELECT * FROM doc_versions WHERE document_id = ? AND version = ?", d.id, opts.version)
      : this.one("SELECT * FROM doc_versions WHERE id = ?", d.current_version_id);
    if (!v) throw new EngineError("Version not found", 404);
    const data = this.store.get(v.sha256);
    const isCurrent = v.id === d.current_version_id;
    const ext = extensionOf(v.filename);
    const filename = isCurrent ? d.name : `${splitExt(d.name)[0]} (version ${v.version})${ext ? "." + ext : ""}`;
    this.log("document_downloaded", { documentId: d.id, version: v.version }, d.matter_id, opts.userId);
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
      this.log("document_version_restored", { documentId: d.id, from: version, version: s.version }, d.matter_id, uid);
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
        this.log("document_updated", { documentId: d.id, ...changes }, d.matter_id, uid);
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
          `SELECT d.*, snippet(doc_fts, 1, '[', ']', '…', 12) AS snippet, bm25(doc_fts, 10.0, 1.0, 5.0) AS rank
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
      }
    } else {
      rows = this.all(
        `SELECT d.* FROM doc_documents d ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY d.updated_at DESC, d.id DESC LIMIT ?`,
        ...params,
        limit,
      );
    }
    return { results: rows.map((r) => ({ ...this.summary(r), snippet: r.snippet ?? null })), fts: this.ftsAvailable };
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
        this.log("template_updated", { templateId: id, changed }, null, uid);
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

  /** Fill a template for a matter and save the result as a new document on the matter. */
  generate(input: GenerateInput) {
    const t = this.templateRow(input.templateId);
    const uid = this.checkUser(input.userId);
    const data = this.mergeData(input.matterId, uid, input.custom);
    const src = this.store.get(t.sha256);
    let out: Buffer;
    let unknown: string[];
    let empty: string[];
    if (t.kind === "docx") ({ output: out, unknown, empty } = fillDocx(src, data));
    else {
      const r = fillText(src.toString("utf8"), data, { html: t.kind === "html" });
      out = Buffer.from(r.output, "utf8");
      ({ unknown, empty } = r);
    }
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
      this.log("document_generated", { documentId: doc.id, templateId: t.id, template: t.name, unknown, empty }, input.matterId, uid);
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
