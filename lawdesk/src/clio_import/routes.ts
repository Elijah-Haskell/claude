// API routes for importing from Clio, mounted under /api/clio-import.

import type { DB } from "../db.ts";
import { EngineError } from "../engine.ts";
import { type Ctx, type Route, intParam } from "../http.ts";
import { ClioClient, configFromEnv, type ClientDeps, type ClioConfig } from "./api.ts";
import { ApiImport } from "./api_job.ts";
import { toCsv } from "./csv.ts";
import { KIND_DEFS, KINDS, type Kind } from "./fields.ts";
import { ClioImporter } from "./importer.ts";
import { reconciliation } from "./report.ts";

/** How the API connection is set up. Tests replace these to point at a fake Clio. */
export const clioSetup: { config: () => ClioConfig | null; deps: ClientDeps } = {
  config: () => configFromEnv(),
  deps: {},
};

const apiImports = new WeakMap<DB, ApiImport>();

function apiImport(ctx: Ctx): ApiImport {
  const cfg = clioSetup.config();
  if (!cfg) throw new EngineError("The Clio connection is not set up on this server (see the note on the import page)", 400);
  let a = apiImports.get(ctx.db);
  if (!a || a.client.cfg.clientId !== cfg.clientId || a.client.cfg.host !== cfg.host) {
    a = new ApiImport(ctx.db, ctx.engine, new ClioClient(ctx.db, cfg, clioSetup.deps), { now: clioSetup.deps.now ? () => new Date(clioSetup.deps.now!()) : undefined });
    apiImports.set(ctx.db, a);
  }
  return a;
}

const importer = (ctx: Ctx) => new ClioImporter(ctx.db, ctx.engine);
const body = (ctx: Ctx) => (ctx.body && typeof ctx.body === "object" ? ctx.body : {});

function kindOf(v: unknown): Kind {
  if (typeof v !== "string" || !KINDS.includes(v as Kind)) throw new EngineError(`Choose what the file holds (${KINDS.join(", ")})`);
  return v as Kind;
}

function csvOf(v: unknown): string {
  if (typeof v !== "string" || !v.trim()) throw new EngineError("The file is empty");
  return v;
}

function dateOrder(v: unknown): "mdy" | "dmy" {
  if (v == null || v === "" || v === "mdy") return "mdy";
  if (v === "dmy") return "dmy";
  throw new EngineError("Date order must be mdy or dmy");
}

function fileName(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim().slice(0, 200) : null;
}

export const routes: Route[] = [
  {
    method: "GET",
    path: "/clio-import/kinds",
    handler: () =>
      KINDS.map((k) => ({
        kind: k,
        label: KIND_DEFS[k].label,
        about: KIND_DEFS[k].about,
        after: KIND_DEFS[k].after,
        fields: KIND_DEFS[k].fields.map((f) => ({ key: f.key, label: f.label, required: f.required ?? false, help: f.help ?? null })),
      })),
  },
  {
    method: "POST",
    path: "/clio-import/preview",
    handler: (ctx) => {
      const b = body(ctx);
      return importer(ctx).preview(kindOf(b.kind), csvOf(b.csv), b.mapping, { dateOrder: dateOrder(b.dateOrder) });
    },
  },
  {
    method: "POST",
    path: "/clio-import/import",
    handler: (ctx) => {
      const b = body(ctx);
      return importer(ctx).importCsv(kindOf(b.kind), csvOf(b.csv), {
        mapping: b.mapping,
        dryRun: b.dryRun === true,
        fileName: fileName(b.fileName),
        userId: ctx.userId,
        dateOrder: dateOrder(b.dateOrder),
        createMissingPeople: b.createMissingPeople !== false,
      });
    },
  },
  { method: "GET", path: "/clio-import/runs", handler: (ctx) => importer(ctx).listRuns() },
  { method: "GET", path: "/clio-import/runs/:id", handler: (ctx) => importer(ctx).getRun(intParam(ctx, "id")) },
  {
    method: "GET",
    path: "/clio-import/runs/:id/problems.csv",
    handler: (ctx) => {
      const run = importer(ctx).getRun(intParam(ctx, "id"));
      const r = run.report;
      const rows: unknown[][] = [["What", "Line", "Record", "Reason"]];
      for (const s of r?.skipped ?? []) rows.push(["Skipped", s.line ?? "", `${s.type}: ${s.ref}`, s.reason]);
      for (const w of r?.warnings ?? []) rows.push(["Check", w.line ?? "", w.ref ?? "", w.message]);
      return {
        __raw: true,
        contentType: "text/csv; charset=utf-8",
        headers: { "Content-Disposition": `attachment; filename="clio-import-${run.id}-problems.csv"` },
        body: toCsv(rows),
      };
    },
  },
  { method: "GET", path: "/clio-import/reconciliation", handler: (ctx) => reconciliation(ctx.db) },

  // ---------------------------------------------------------------- the API
  {
    method: "GET",
    path: "/clio-import/api/status",
    handler: (ctx) => {
      const cfg = clioSetup.config();
      if (!cfg) return { configured: false };
      const a = apiImport(ctx);
      const tok = a.client.tokens.get();
      return {
        configured: true,
        region: cfg.region,
        redirectUri: cfg.redirectUri,
        encrypted: !!cfg.tokenKey,
        connected: !!tok,
        connectedAt: tok?.connectedAt ?? null,
        job: a.status(),
      };
    },
  },
  { method: "POST", path: "/clio-import/api/connect", handler: (ctx) => ({ url: apiImport(ctx).client.authorizeUrl(ctx.userId) }) },
  {
    method: "GET",
    path: "/clio-import/oauth/callback",
    handler: async (ctx) => {
      // Clio sends the browser here after sign-in; answer with a redirect back to the import page.
      let to = "/#/settings/import-clio?connected=1";
      try {
        await apiImport(ctx).client.completeAuthorization({ code: ctx.query.get("code"), state: ctx.query.get("state"), error: ctx.query.get("error") }, ctx.userId);
        ctx.engine.log("clio_connected", "Connected Lawdesk to Clio for importing", { userId: ctx.userId });
      } catch (e: any) {
        to = `/#/settings/import-clio?error=${encodeURIComponent(e?.message ?? "Sign-in failed")}`;
      }
      return { __raw: true, status: 303, contentType: "text/plain; charset=utf-8", headers: { Location: to }, body: "Returning to Lawdesk" };
    },
  },
  {
    method: "POST",
    path: "/clio-import/api/disconnect",
    handler: async (ctx) => {
      const a = apiImport(ctx);
      const job = a.status();
      if (job && job.active) await a.pause(job.id);
      await a.client.disconnect();
      ctx.engine.log("clio_disconnected", "Disconnected Lawdesk from Clio", { userId: ctx.userId });
      return { ok: true };
    },
  },
  {
    method: "POST",
    path: "/clio-import/api/jobs",
    handler: (ctx) => {
      const a = apiImport(ctx);
      const id = a.create(ctx.userId);
      a.start(id);
      return a.status(id);
    },
  },
  {
    method: "POST",
    path: "/clio-import/api/jobs/:id/pause",
    handler: async (ctx) => {
      const a = apiImport(ctx);
      await a.pause(intParam(ctx, "id"));
      return a.status(intParam(ctx, "id"));
    },
  },
  {
    method: "POST",
    path: "/clio-import/api/jobs/:id/resume",
    handler: (ctx) => {
      const a = apiImport(ctx);
      const id = intParam(ctx, "id");
      const s = a.status(id);
      if (!s) throw new EngineError("Import not found", 404);
      if (s.status === "done") throw new EngineError("That import has finished");
      if (s.error === "Cancelled") throw new EngineError("That import was cancelled; start a new one");
      a.start(id);
      return a.status(id);
    },
  },
  {
    method: "POST",
    path: "/clio-import/api/jobs/:id/cancel",
    handler: async (ctx) => {
      const a = apiImport(ctx);
      await a.cancel(intParam(ctx, "id"));
      return a.status(intParam(ctx, "id"));
    },
  },
];
