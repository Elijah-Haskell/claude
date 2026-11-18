// HTTP routes for documents and document assembly (all under /api).
//
// Uploads are JSON for now: { filename, contentBase64, ... }. The decoded file may be at most
// LAWDESK_MAX_UPLOAD_BYTES (default 25 MiB); base64 makes the request body about a third larger,
// so the server's JSON body limit must allow roughly 34 MiB for this route.
// Downloads return { filename, mime, size, sha256, version, base64 }.

import type { DB } from "../db.ts";
import { EngineError } from "../engine.ts";
import { type Ctx, type Route, intParam } from "../http.ts";
import { Documents, decodeBase64 } from "./documents.ts";

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

export const routes: Route[] = [
  // Search is listed before /documents/:id so "search" is never read as an id.
  {
    method: "GET",
    path: "/documents/search",
    handler: (ctx) =>
      documentsFor(ctx).search({
        q: ctx.query.get("q"),
        matterId: optInt(ctx.query.get("matter"), "matter"),
        name: ctx.query.get("name"),
        tag: ctx.query.get("tag"),
        category: ctx.query.get("category"),
        folder: ctx.query.get("folder"),
        includeDeleted: ctx.query.get("deleted") === "1",
        limit: optInt(ctx.query.get("limit"), "limit") ?? undefined,
      }),
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
  { method: "GET", path: "/documents/:id", handler: (ctx) => documentsFor(ctx).get(intParam(ctx, "id")) },
  {
    method: "PATCH",
    path: "/documents/:id",
    handler: (ctx) => {
      const b = bodyObj(ctx);
      return documentsFor(ctx).update(intParam(ctx, "id"), { name: b.name, folder: b.folder, category: b.category, tags: b.tags }, ctx.userId);
    },
  },
  { method: "DELETE", path: "/documents/:id", handler: (ctx) => documentsFor(ctx).delete(intParam(ctx, "id"), ctx.userId) },
  { method: "POST", path: "/documents/:id/restore", handler: (ctx) => documentsFor(ctx).restore(intParam(ctx, "id"), ctx.userId) },
  { method: "GET", path: "/documents/:id/versions", handler: (ctx) => documentsFor(ctx).versions(intParam(ctx, "id")) },
  {
    method: "POST",
    path: "/documents/:id/versions",
    handler: (ctx) => {
      const docs = documentsFor(ctx);
      const b = bodyObj(ctx);
      return docs.addVersion(intParam(ctx, "id"), { filename: b.filename, data: decodeBase64(b.contentBase64, docs.maxBytes), userId: ctx.userId });
    },
  },
  {
    method: "POST",
    path: "/documents/:id/versions/:version/restore",
    handler: (ctx) => documentsFor(ctx).restoreVersion(intParam(ctx, "id"), intParam(ctx, "version"), ctx.userId),
  },
  {
    method: "GET",
    path: "/documents/:id/download",
    handler: (ctx) =>
      fileOut(documentsFor(ctx).download(intParam(ctx, "id"), { version: optInt(ctx.query.get("version"), "version"), userId: ctx.userId })),
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
