// HTTP routes for the firm calendar, mounted under /api by the server.
//
// The feed route returns a RawResponse instead of JSON. The server needs to check for
// `__raw === true` and write `body` with the given status, content type and headers as-is
// (see the note in the calendar report / README).

import { EngineError } from "../engine.ts";
import { type Ctx, type Route, intParam } from "../http.ts";
import { Calendar } from "./calendar.ts";

export interface RawResponse {
  __raw: true;
  status: number;
  contentType: string;
  headers?: Record<string, string>;
  body: string;
}

export function raw(body: string, contentType: string, status = 200, headers: Record<string, string> = {}): RawResponse {
  return { __raw: true, status, contentType, headers, body };
}

const cal = (ctx: Ctx) => new Calendar(ctx.db);

function optInt(v: string | null, what: string): number | undefined {
  if (v === null || v === "") return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new EngineError(`Bad ${what}`);
  return n;
}

/** The acting user: the signed-in user, or (until sign-in exists) body.userId / ?user=. */
function actor(ctx: Ctx): number | null {
  if (ctx.userId != null) return ctx.userId;
  const b = ctx.body?.userId;
  if (Number.isInteger(b)) return b;
  return optInt(ctx.query.get("user"), "user") ?? null;
}

export const routes: Route[] = [
  // ---- events
  {
    method: "GET",
    path: "/calendar/events",
    handler: (ctx) =>
      cal(ctx).listEvents({
        matterId: optInt(ctx.query.get("matter"), "matter"),
        source: ctx.query.get("source") ?? undefined,
        sourceRef: ctx.query.get("sourceRef") ?? undefined,
      }),
  },
  { method: "GET", path: "/calendar/events/:id", handler: (ctx) => cal(ctx).getEvent(intParam(ctx, "id")) },
  { method: "POST", path: "/calendar/events", handler: (ctx) => cal(ctx).createEvent(ctx.body, actor(ctx)) },
  { method: "PATCH", path: "/calendar/events/:id", handler: (ctx) => cal(ctx).updateEvent(intParam(ctx, "id"), ctx.body, actor(ctx)) },
  {
    method: "DELETE",
    path: "/calendar/events/:id",
    handler: (ctx) => {
      cal(ctx).deleteEvent(intParam(ctx, "id"), actor(ctx));
      return { ok: true };
    },
  },

  // ---- single occurrences of a repeating event (:key = original start, 20260309T140000Z or 20260309)
  {
    method: "PATCH",
    path: "/calendar/events/:id/occurrences/:key",
    handler: (ctx) => cal(ctx).editOccurrence(intParam(ctx, "id"), ctx.params.key, ctx.body, actor(ctx)),
  },
  {
    method: "DELETE",
    path: "/calendar/events/:id/occurrences/:key",
    handler: (ctx) => {
      cal(ctx).cancelOccurrence(intParam(ctx, "id"), ctx.params.key, actor(ctx));
      return { ok: true };
    },
  },
  {
    method: "POST",
    path: "/calendar/events/:id/occurrences/:key/restore",
    handler: (ctx) => {
      cal(ctx).restoreOccurrence(intParam(ctx, "id"), ctx.params.key, actor(ctx));
      return { ok: true };
    },
  },

  // ---- agenda, availability, reminders
  {
    method: "GET",
    path: "/calendar/agenda",
    handler: (ctx) => {
      const q = ctx.query;
      const matterId = optInt(q.get("matter"), "matter");
      const out = cal(ctx).agenda({
        from: q.get("from") ?? "",
        to: q.get("to") ?? q.get("from") ?? "",
        userId: q.get("scope") === "firm" ? null : (optInt(q.get("user"), "user") ?? ctx.userId ?? null),
        timeZone: q.get("tz") ?? undefined,
        includeTasks: q.get("tasks") !== "0",
        includeDoneTasks: q.get("done") === "1",
      });
      // ?matter= keeps one matter's items (the matter page's "Upcoming" card).
      if (matterId !== undefined) {
        out.items = out.items.filter((i: any) => i.matterId === matterId);
        out.conflicts = [];
      }
      return out;
    },
  },
  {
    method: "GET",
    path: "/calendar/availability",
    handler: (ctx) => {
      const q = ctx.query;
      const users = (q.get("users") ?? "").split(",").filter(Boolean).map((u) => optInt(u, "user")!);
      return cal(ctx).checkAvailability(users, q.get("start") ?? "", q.get("end") ?? "", {
        timeZone: q.get("tz") ?? undefined,
        excludeEventId: optInt(q.get("exclude"), "exclude"),
      });
    },
  },
  {
    method: "GET",
    path: "/calendar/reminders",
    handler: (ctx) => cal(ctx).remindersDue(ctx.query.get("from") ?? "", ctx.query.get("to") ?? ""),
  },

  // ---- import
  {
    method: "POST",
    path: "/calendar/import",
    handler: (ctx) =>
      cal(ctx).importIcs(ctx.body?.ics, {
        userId: actor(ctx),
        matterId: ctx.body?.matterId ?? null,
        attendees: ctx.body?.attendees,
        kind: ctx.body?.kind,
      }),
  },

  // ---- feed links
  {
    method: "GET",
    path: "/calendar/feed-tokens",
    handler: (ctx) => {
      const u = actor(ctx);
      if (u == null) throw new EngineError("Say whose feed links to list (?user=)");
      return cal(ctx).listFeedTokens(u);
    },
  },
  {
    method: "POST",
    path: "/calendar/feed-tokens",
    handler: (ctx) => {
      const u = actor(ctx);
      if (u == null) throw new EngineError("Say whose feed link this is (userId)");
      const t = cal(ctx).createFeedToken(u, { scope: ctx.body?.scope, label: ctx.body?.label }, ctx.userId ?? u);
      // The server mounts routes under /api; the token is shown only this once.
      return { ...t, url: `/api${t.path}` };
    },
  },
  {
    method: "DELETE",
    path: "/calendar/feed-tokens/:id",
    handler: (ctx) => {
      cal(ctx).revokeFeedToken(intParam(ctx, "id"), actor(ctx));
      return { ok: true };
    },
  },
  {
    // GET /api/calendar/feed/<token>.ics — no sign-in; the token is the secret.
    method: "GET",
    path: "/calendar/feed/:file",
    public: true,
    handler: (ctx): RawResponse => {
      const file = ctx.params.file ?? "";
      const token = file.endsWith(".ics") ? file.slice(0, -4) : file;
      const ics = cal(ctx).feedForToken(token);
      if (ics === null) return raw("Not found\n", "text/plain; charset=utf-8", 404);
      return raw(ics, "text/calendar; charset=utf-8", 200, {
        "Cache-Control": "private, max-age=300",
        "Content-Disposition": 'inline; filename="lawdesk.ics"',
      });
    },
  },
];
