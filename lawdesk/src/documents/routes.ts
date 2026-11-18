// HTTP routes for documents and document assembly (all under /api).
//
// Files move as bytes. Uploads go to the `.../upload` routes (raw routes: the body is the file,
// with ?name=<file name>&folder=..., or multipart/form-data with a file part and text fields).
// Downloads come from `.../file` with Content-Disposition: attachment (?inline=1 shows PDFs and
// images in the browser instead). A file may be at most LAWDESK_MAX_UPLOAD_BYTES (default 25 MiB).
//
// The older JSON forms still work for scripts: { filename, contentBase64, ... } uploads, and
// GET .../download returning { filename, mime, size, sha256, version, base64 }.

import type { DB } from "../db.ts";
import { EngineError } from "../engine.ts";
import { type Ctx, type Route, intParam } from "../http.ts";
import { Documents, decodeBase64 } from "./documents.ts";
import { fileResponse, readUpload, tagsField } from "./transfer.ts";
import { assertCanSeeRow, filterVisible } from "../auth/access.ts";

const instances = new WeakMap<DB, Documents>();

/** One Documents service per database; creates the doc_ tables on first use. */
export function documentsFor(ctx: Pick<Ctx, "db" | "engine">): Documents {
  let d = instances.get(ctx.db);
  if (!d) {
    d = new Documents(ctx.db, { today: () => ctx.engine.today() });
    instances.set(ctx.db, d);
  }
  return d;
}

/** The instance already set for a database, if any (the demo seed uses it). */
export function existingDocuments(db: DB): Documents | undefined {
  return instances.get(db);
}

/** Use a specific Documents instance for a database (tests, or a server with custom options). */
export function setDocuments(db: DB, docs: Documents) {
  instances.set(db, docs);
}

function optInt(v: string | null, what: string): number | null {
  if (v === null || v === "") return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new EngineError(`Bad ${what}`);
  return n;
}

function bodyObj(ctx: Ctx): Record<string, any> {
  const b = ctx.body;
  if (!b || typeof b !== "object" || Array.isArray(b)) throw new EngineError("Expected a JSON object");
  return b;
}

function fileOut(f: { filename: string; mime: string; data: Buffer; [k: string]: unknown }) {
  const { data, ...rest } = f;
  return { ...rest, base64: data.toString("base64") };
}

/** A document id from the path, refused (404) when the document's matter is hidden from this person. */
function docId(ctx: Ctx): number {
  const id = intParam(ctx, "id");
  assertCanSeeRow(ctx.db, ctx.userId, "doc_documents", id, "Document");
  return id;
}

/** Search results without documents on matters hidden from this person. */
function searchVisible<T extends { results: { matterId: number }[] }>(ctx: Ctx, r: T): T {
  return { ...r, results: filterVisible(ctx.db, ctx.userId, r.results, "matterId") };
}

/** The request of a raw route (the server sets it). */
function source(ctx: Ctx) {
  if (!ctx.req) throw new EngineError("This route needs the request body", 500);
  return ctx.req;
}

export const routes: Route[] = [
  // Binary transfer. Listed first so "facets" is never read as an id.
  {
    method: "POST",
    path: "/matters/:id/documents/upload",
    raw: true,
    handler: async (ctx) => {
      const docs = documentsFor(ctx);
      const matterId = intParam(ctx, "id");
      const { fields, file } = await readUpload(source(ctx), ctx.query, docs.maxBytes);
      return docs.upload({
        matterId,
        filename: file.filename,
        data: file.data,
        folder: fields.folder,
        category: fields.category,
        tags: tagsField(fields.tags),
        onConflict: fields.onConflict as any,
        userId: ctx.userId,
      });
    },
  },
  {
    method: "POST",
    path: "/documents/:id/versions/upload",
    raw: true,
    handler: async (ctx) => {
      const docs = documentsFor(ctx);
      const id = docId(ctx);
      const { fields, file } = await readUpload(source(ctx), ctx.query, docs.maxBytes);
      return docs.addVersion(id, { filename: file.filename, data: file.data, userId: ctx.userId, note: fields.note || null });
    },
  },
  {
    method: "GET",
    path: "/documents/:id/file",
    handler: (ctx) => {
      const inline = ctx.query.get("inline") === "1";
      const f = documentsFor(ctx).download(docId(ctx), {
        version: optInt(ctx.query.get("version"), "version"),
        userId: ctx.userId,
        action: inline ? "view" : "download",
      });
      return fileResponse(f, inline);
    },
  },
  { method: "GET", path: "/documents/:id/text", handler: (ctx) => documentsFor(ctx).text(docId(ctx)) },
  { method: "GET", path: "/documents/facets", handler: (ctx) => documentsFor(ctx).facets() },
  {
    method: "POST",
    path: "/matters/:id/folders",
    handler: (ctx) => documentsFor(ctx).createFolder(intParam(ctx, "id"), bodyObj(ctx).path, ctx.userId),
  },
  {
    method: "PATCH",
    path: "/matters/:id/folders",
    handler: (ctx) => {
      const b = bodyObj(ctx);
      return documentsFor(ctx).renameFolder(intParam(ctx, "id"), b.from, b.to, ctx.userId);
    },
  },
  {
    method: "DELETE",
    path: "/matters/:id/folders",
    handler: (ctx) => documentsFor(ctx).deleteFolder(intParam(ctx, "id"), ctx.query.get("path"), ctx.userId),
  },
  {
    method: "GET",
    path: "/matters/:id/templates/:templateId/check",
    handler: (ctx) => documentsFor(ctx).checkTemplate(intParam(ctx, "templateId"), intParam(ctx, "id"), ctx.userId),
  },
  { method: "GET", path: "/document-templates/fields", handler: (ctx) => documentsFor(ctx).fieldCatalog() },
  {
    method: "POST",
    path: "/document-templates/upload",
    raw: true,
    handler: async (ctx) => {
      const docs = documentsFor(ctx);
      const { fields, file } = await readUpload(source(ctx), ctx.query, docs.maxBytes);
      return docs.createTemplate(
        {
          name: fields.templateName || file.filename.replace(/\.[^.]+$/, ""),
          filename: file.filename,
          data: file.data,
          description: fields.description,
          category: fields.category,
        },
        ctx.userId,
      );
    },
  },
  {
    method: "POST",
    path: "/document-templates/:id/upload",
    raw: true,
    handler: async (ctx) => {
      const docs = documentsFor(ctx);
      const id = intParam(ctx, "id");
      const { file } = await readUpload(source(ctx), ctx.query, docs.maxBytes);
      return docs.updateTemplate(id, { filename: file.filename, data: file.data }, ctx.userId);
    },
  },
  {
    method: "GET",
    path: "/document-templates/:id/file",
    handler: (ctx) => fileResponse(documentsFor(ctx).downloadTemplate(intParam(ctx, "id")), false),
  },

  // Search is listed before /documents/:id so "search" is never read as an id.
  {
    method: "GET",
    path: "/documents/search",
    handler: (ctx) =>
      searchVisible(ctx, documentsFor(ctx).search({
        q: ctx.query.get("q"),
        matterId: optInt(ctx.query.get("matter"), "matter"),
        name: ctx.query.get("name"),
        tag: ctx.query.get("tag"),
        category: ctx.query.get("category"),
        folder: ctx.query.get("folder"),
        includeDeleted: ctx.query.get("deleted") === "1",
        limit: optInt(ctx.query.get("limit"), "limit") ?? undefined,
      })),
  },
  {
    method: "GET",
    path: "/matters/:id/documents",
    handler: (ctx) => {
      const deleted = ctx.query.get("deleted");
      return documentsFor(ctx).list(intParam(ctx, "id"), {
        folder: ctx.query.get("folder"),
        deleted: deleted === "only" ? "only" : deleted === "include" ? "include" : "exclude",
      });
    },
  },
  {
    method: "POST",
    path: "/matters/:id/documents",
    handler: (ctx) => {
      const docs = documentsFor(ctx);
      const b = bodyObj(ctx);
      return docs.upload({
        matterId: intParam(ctx, "id"),
        filename: b.filename,
        data: decodeBase64(b.contentBase64, docs.maxBytes),
        folder: b.folder,
        category: b.category,
        tags: b.tags,
        onConflict: b.onConflict,
        userId: ctx.userId,
      });
    },
  },
  {
    method: "POST",
    path: "/matters/:id/documents/generate",
    handler: (ctx) => {
      const b = bodyObj(ctx);
      if (!Number.isInteger(b.templateId)) throw new EngineError("templateId is required");
      return documentsFor(ctx).generate({
        matterId: intParam(ctx, "id"),
        templateId: b.templateId,
        filename: b.filename,
        folder: b.folder,
        category: b.category,
        tags: b.tags,
        custom: b.custom,
        strict: b.strict === true,
        userId: ctx.userId,
      });
    },
  },
  {
    method: "GET",
    path: "/matters/:id/merge-fields",
    handler: (ctx) => documentsFor(ctx).mergeData(intParam(ctx, "id"), ctx.userId),
  },
  { method: "GET", path: "/documents/:id", handler: (ctx) => documentsFor(ctx).get(docId(ctx)) },
  {
    method: "PATCH",
    path: "/documents/:id",
    handler: (ctx) => {
      const b = bodyObj(ctx);
      return documentsFor(ctx).update(docId(ctx), { name: b.name, folder: b.folder, category: b.category, tags: b.tags }, ctx.userId);
    },
  },
  { method: "DELETE", path: "/documents/:id", handler: (ctx) => documentsFor(ctx).delete(docId(ctx), ctx.userId) },
  { method: "POST", path: "/documents/:id/restore", handler: (ctx) => documentsFor(ctx).restore(docId(ctx), ctx.userId) },
  { method: "GET", path: "/documents/:id/versions", handler: (ctx) => documentsFor(ctx).versions(docId(ctx)) },
  {
    method: "POST",
    path: "/documents/:id/versions",
    handler: (ctx) => {
      const docs = documentsFor(ctx);
      const b = bodyObj(ctx);
      return docs.addVersion(docId(ctx), { filename: b.filename, data: decodeBase64(b.contentBase64, docs.maxBytes), userId: ctx.userId });
    },
  },
  {
    method: "POST",
    path: "/documents/:id/versions/:version/restore",
    handler: (ctx) => documentsFor(ctx).restoreVersion(docId(ctx), intParam(ctx, "version"), ctx.userId),
  },
  {
    method: "GET",
    path: "/documents/:id/download",
    handler: (ctx) =>
      fileOut(documentsFor(ctx).download(docId(ctx), { version: optInt(ctx.query.get("version"), "version"), userId: ctx.userId })),
  },

  // Templates
  {
    method: "GET",
    path: "/document-templates",
    handler: (ctx) => documentsFor(ctx).listTemplates({ category: ctx.query.get("category"), includeDeleted: ctx.query.get("deleted") === "1" }),
  },
  {
    method: "POST",
    path: "/document-templates",
    handler: (ctx) => {
      const docs = documentsFor(ctx);
      const b = bodyObj(ctx);
      return docs.createTemplate(
        { name: b.name, filename: b.filename, data: decodeBase64(b.contentBase64, docs.maxBytes), description: b.description, category: b.category },
        ctx.userId,
      );
    },
  },
  { method: "GET", path: "/document-templates/:id", handler: (ctx) => documentsFor(ctx).getTemplate(intParam(ctx, "id")) },
  {
    method: "PATCH",
    path: "/document-templates/:id",
    handler: (ctx) => {
      const docs = documentsFor(ctx);
      const b = bodyObj(ctx);
      return docs.updateTemplate(
        intParam(ctx, "id"),
        {
          name: b.name,
          description: b.description,
          category: b.category,
          filename: b.filename,
          data: b.contentBase64 === undefined ? undefined : decodeBase64(b.contentBase64, docs.maxBytes),
        },
        ctx.userId,
      );
    },
  },
  { method: "DELETE", path: "/document-templates/:id", handler: (ctx) => documentsFor(ctx).deleteTemplate(intParam(ctx, "id"), ctx.userId) },
  { method: "POST", path: "/document-templates/:id/restore", handler: (ctx) => documentsFor(ctx).restoreTemplate(intParam(ctx, "id"), ctx.userId) },
  { method: "GET", path: "/document-templates/:id/download", handler: (ctx) => fileOut(documentsFor(ctx).downloadTemplate(intParam(ctx, "id"))) },
];
