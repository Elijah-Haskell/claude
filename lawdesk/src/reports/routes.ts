// API routes for reports and the firm overview, mounted under /api.
//
//   GET /reports                    the list of reports, their filters, people and matters to pick from
//   GET /reports/dashboard          the firm overview
//   GET /reports/:key               one report as JSON  (?from=&to=&userId=&matterId=&<option>=)
//   GET /reports/:key/csv           the same report as a CSV download

import { type Ctx, type Route } from "../http.ts";
import { EngineError } from "../engine.ts";
import { isISODate } from "../dates.ts";
import { dashboard } from "./dashboard.ts";
import { REPORTS, defaultRange, kindLabel, reportInfo, runReport, type Filters } from "./reports.ts";
import { toCsv } from "./csv.ts";
import { all, hasTables, BILLING_TABLES } from "./util.ts";

function qDate(ctx: Ctx, name: string, what: string) {
  const v = ctx.query.get(name);
  if (v == null || v === "") return undefined;
  if (!isISODate(v)) throw new EngineError(`${what} must be a date like 2026-01-31`);
  return v;
}

function qId(ctx: Ctx, name: string, what: string) {
  const v = ctx.query.get(name);
  if (v == null || v === "") return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new EngineError(`Bad ${what}`);
  return n;
}

function filters(ctx: Ctx, key: string): Filters {
  const info = reportInfo(key);
  const options: Record<string, string> = {};
  for (const o of info.options ?? []) {
    const v = ctx.query.get(o.key);
    if (v != null && v !== "") {
      if (o.choices.length && !o.choices.some((c) => c.value === v)) throw new EngineError(`${o.label}: not a choice`);
      if (v.length > 100) throw new EngineError(`${o.label} is too long`);
      options[o.key] = v;
    }
  }
  if (info.search) {
    const q = ctx.query.get("q");
    if (q) {
      if (q.length > 200) throw new EngineError("The search is too long");
      options.q = q;
    }
  }
  return {
    from: qDate(ctx, "from", "From"),
    to: qDate(ctx, "to", info.uses.asOf ? "As-of date" : "To"),
    userId: qId(ctx, "userId", "person"),
    matterId: qId(ctx, "matterId", "matter"),
    options,
  };
}

/** `all=1` asks for no default range (every date). */
function run(ctx: Ctx) {
  const key = ctx.params.key;
  return runReport({ db: ctx.db, today: ctx.engine.today() }, key, filters(ctx, key), { useDefaults: ctx.query.get("all") !== "1" });
}

export const routes: Route[] = [
  {
    method: "GET",
    path: "/reports",
    handler: (ctx) => {
      const today = ctx.engine.today();
      const billing = hasTables(ctx.db, ...BILLING_TABLES);
      const kinds = all(ctx.db, "SELECT DISTINCT kind FROM activity ORDER BY kind").map((r) => ({ value: r.kind, label: kindLabel(r.kind) }));
      let firmName = "";
      if (billing) firmName = String(all(ctx.db, "SELECT firm_name FROM billing_settings WHERE id = 1")[0]?.firm_name ?? "");
      return {
        today,
        billing,
        firmName,
        reports: REPORTS.map((r) => ({
          key: r.key,
          title: r.title,
          summary: r.summary,
          uses: r.uses,
          periodLabel: r.periodLabel ?? null,
          personLabel: r.personLabel ?? null,
          search: r.search ?? null,
          needsBilling: !!r.needsBilling,
          defaults: defaultRange(r, today),
          options: (r.options ?? []).map((o) =>
            o.key === "kind" && r.key === "activity" ? { ...o, choices: [{ value: "", label: "Any" }, ...kinds] } : o,
          ),
        })),
        people: all(ctx.db, "SELECT id, name, active FROM users ORDER BY active DESC, name"),
        matters: all(ctx.db, "SELECT id, number, name, status FROM matters ORDER BY status DESC, name"),
      };
    },
  },
  { method: "GET", path: "/reports/dashboard", handler: (ctx) => dashboard(ctx.db, ctx.engine.today()) },
  { method: "GET", path: "/reports/:key", handler: (ctx) => run(ctx) },
  {
    method: "GET",
    path: "/reports/:key/csv",
    handler: (ctx) => {
      const r = run(ctx);
      const f = r.filters;
      const span = f.from && f.to ? `-${f.from}-to-${f.to}` : f.to ? `-as-of-${f.to}` : "";
      return {
        __raw: true,
        contentType: "text/csv; charset=utf-8",
        headers: { "Content-Disposition": `attachment; filename="lawdesk-${r.key}${span}.csv"` },
        body: toCsv(r),
      };
    },
  },
];
