// API for the contact book and the conflict-check screens. Mounted under /api.
// The conflict search itself and the decision/link endpoints live in src/conflicts/;
// these add the plain-English wording, the history filters and the printable report.

import { type Ctx, type Route, intParam } from "../http.ts";
import { EngineError } from "../engine.ts";
import { getCheck, runCheck } from "../conflicts/search.ts";
import { addDetail, checkHistory, deleteDetail, directory, profile, updateDetail } from "./contacts.ts";
import { bandCounts, withPlain } from "./plain.ts";
import { renderReport } from "./report.ts";

function optInt(v: unknown, what: string): number | null {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new EngineError(`Bad ${what}`);
  return n;
}

function fullCheck(ctx: Ctx, id: number) {
  const k: any = getCheck(ctx.db, id);
  if (k.matterId) {
    const m = ctx.db.prepare("SELECT number FROM matters WHERE id = ?").get(k.matterId) as any;
    k.matterNumber = m?.number ?? null;
  }
  k.results = withPlain(k.results);
  k.counts = bandCounts(k.results);
  return k;
}

export const routes: Route[] = [
  {
    method: "GET",
    path: "/directory",
    handler: (ctx) =>
      directory(ctx.db, {
        q: ctx.query.get("q"),
        kind: ctx.query.get("kind"),
        limit: ctx.query.get("limit") ? Math.min(2000, Math.max(1, Number(ctx.query.get("limit")) || 500)) : undefined,
      }),
  },
  { method: "GET", path: "/contacts/:id/profile", handler: (ctx) => profile(ctx.db, intParam(ctx, "id")) },
  { method: "POST", path: "/contacts/:id/details", handler: (ctx) => addDetail(ctx.db, intParam(ctx, "id"), ctx.body ?? {}, ctx.userId) },
  { method: "PATCH", path: "/contact-details/:id", handler: (ctx) => updateDetail(ctx.db, intParam(ctx, "id"), ctx.body ?? {}, ctx.userId) },
  {
    method: "DELETE",
    path: "/contact-details/:id",
    handler: (ctx) => (deleteDetail(ctx.db, intParam(ctx, "id"), ctx.userId), { ok: true }),
  },

  // Saved checks, with filters: decision=pending|cleared|waived|declined, q, from, to,
  // matterId, linked=yes|no, hits=any|strong|none.
  {
    method: "GET",
    path: "/conflict-checks",
    handler: (ctx) => {
      const g = (k: string) => ctx.query.get(k) || null;
      const linked = g("linked");
      const hits = g("hits");
      return checkHistory(ctx.db, {
        decision: g("decision"),
        q: g("q"),
        from: g("from"),
        to: g("to"),
        matterId: optInt(g("matterId"), "matterId"),
        linked: linked === "yes" || linked === "no" ? linked : null,
        hits: hits === "any" || hits === "strong" || hits === "none" ? hits : null,
        limit: g("limit") ? Number(g("limit")) : undefined,
      });
    },
  },
  // Run and save a check; the reply is the saved check with plain-English reasons.
  {
    method: "POST",
    path: "/conflict-checks",
    handler: (ctx) => {
      const b = ctx.body ?? {};
      const r = runCheck(ctx.db, { terms: b.terms, matterId: optInt(b.matterId, "matterId") }, ctx.userId);
      return fullCheck(ctx, r.checkId);
    },
  },
  { method: "GET", path: "/conflict-checks/:id", handler: (ctx) => fullCheck(ctx, intParam(ctx, "id")) },
  {
    method: "GET",
    path: "/conflict-checks/:id/report",
    handler: (ctx) => {
      const { html, filename } = renderReport(ctx.db, intParam(ctx, "id"));
      const headers: Record<string, string> = {
        // The report has no scripts and carries its own styles.
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
      };
      if (ctx.query.get("download") === "1") headers["Content-Disposition"] = `attachment; filename="${filename}"`;
      return { __raw: true, contentType: "text/html; charset=utf-8", headers, body: html };
    },
  },
];
