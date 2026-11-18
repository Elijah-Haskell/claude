// Intake API, mounted under /api. Routes marked `public: true` are for people outside the
// firm (the intake form and booking pages) and need no sign-in; everything else is staff-only.

import { type Ctx, type Route, intParam } from "../http.ts";
import { EngineError } from "../engine.ts";
import { documentsFor } from "../documents/routes.ts";
import { Intake, NOT_HIRED_REASONS, dueEmails } from "./leads.ts";
import { FIELD_MAPS, FIELD_TYPES, SOURCES, STATUSES } from "./schema.ts";
import { createForm, defaultFields, deleteForm, getForm, listForms, newFormLink, publicForm, submitForm, updateForm } from "./forms.ts";
import { book, cancelConsultation, listAvailability, openSlots, publicBook, publicBooking, setAvailability, slotsByDay } from "./booking.ts";
import { intakeReport } from "./reports.ts";
import { hiddenMatterIds } from "../auth/access.ts";

const intake = (ctx: Ctx) => new Intake(ctx.db, ctx.engine, { documents: documentsFor(ctx) });

/** Who is acting: the signed-in user, or (until sign-in exists) body.userId. */
function actor(ctx: Ctx): number | null {
  if (ctx.userId != null) return ctx.userId;
  const n = Number(ctx.body?.userId);
  if (Number.isInteger(n) && n > 0 && ctx.db.prepare("SELECT id FROM users WHERE id = ?").get(n)) return n;
  return null;
}

function optInt(v: unknown, what: string): number | null {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new EngineError(`Bad ${what}`);
  return n;
}

const ipOf = (ctx: Ctx) => (ctx as Ctx & { ip?: string | null }).ip ?? null;

const intakeRoutes: Route[] = [
  // ------------------------------------------------------------ public pages
  { method: "GET", path: "/intake/public/forms/:token", public: true, handler: (ctx) => publicForm(intake(ctx), ctx.params.token) },
  { method: "POST", path: "/intake/public/forms/:token", public: true, handler: (ctx) => submitForm(intake(ctx), ctx.params.token, ctx.body ?? {}, ipOf(ctx)) },
  {
    method: "GET",
    path: "/intake/public/booking/:token",
    public: true,
    handler: (ctx) => publicBooking(intake(ctx), ctx.params.token, { lead: ctx.query.get("lead"), userId: optInt(ctx.query.get("person"), "person") }),
  },
  { method: "POST", path: "/intake/public/booking/:token", public: true, handler: (ctx) => publicBook(intake(ctx), ctx.params.token, ctx.body ?? {}, ipOf(ctx)) },

  // --------------------------------------------------------------- options
  {
    method: "GET",
    path: "/intake/options",
    handler: (ctx) => ({
      statuses: STATUSES,
      sources: SOURCES,
      notHiredReasons: NOT_HIRED_REASONS,
      fieldTypes: FIELD_TYPES,
      fieldMaps: FIELD_MAPS,
      defaultFields: defaultFields(),
      settings: intake(ctx).publicSettings(),
    }),
  },
  { method: "GET", path: "/intake/settings", handler: (ctx) => intake(ctx).publicSettings() },
  { method: "PATCH", path: "/intake/settings", handler: (ctx) => intake(ctx).updateSettings(ctx.body ?? {}, actor(ctx)) },

  // ----------------------------------------------------------------- leads
  {
    method: "GET",
    path: "/intake/leads",
    handler: (ctx) =>
      intake(ctx).listLeads({
        status: ctx.query.get("status"),
        ownerId: optInt(ctx.query.get("owner"), "owner"),
        q: ctx.query.get("q"),
        open: ctx.query.get("open") === "1",
      }),
  },
  { method: "POST", path: "/intake/leads", handler: (ctx) => intake(ctx).createLead(ctx.body ?? {}, actor(ctx)) },
  { method: "GET", path: "/intake/leads/:id", handler: (ctx) => intake(ctx).getLead(intParam(ctx, "id")) },
  { method: "PATCH", path: "/intake/leads/:id", handler: (ctx) => intake(ctx).updateLead(intParam(ctx, "id"), ctx.body ?? {}, actor(ctx)) },
  { method: "DELETE", path: "/intake/leads/:id", handler: (ctx) => (intake(ctx).deleteLead(intParam(ctx, "id"), actor(ctx)), { ok: true }) },
  {
    method: "POST",
    path: "/intake/leads/:id/status",
    handler: (ctx) =>
      intake(ctx).setStatus(intParam(ctx, "id"), ctx.body?.status, { reason: ctx.body?.reason, note: ctx.body?.note, position: ctx.body?.position }, actor(ctx)),
  },
  { method: "POST", path: "/intake/leads/:id/notes", handler: (ctx) => intake(ctx).addNote(intParam(ctx, "id"), ctx.body?.body, actor(ctx)) },
  { method: "DELETE", path: "/intake/notes/:id", handler: (ctx) => intake(ctx).deleteNote(intParam(ctx, "id"), actor(ctx)) },
  {
    method: "POST",
    path: "/intake/leads/:id/conflict-check",
    handler: (ctx) => {
      const it = intake(ctx);
      it.runConflictCheck(intParam(ctx, "id"), actor(ctx));
      return it.getLead(intParam(ctx, "id"));
    },
  },
  {
    method: "POST",
    path: "/intake/leads/:id/conflict-decision",
    handler: (ctx) => intake(ctx).decideConflict(intParam(ctx, "id"), ctx.body?.decision, ctx.body?.note, actor(ctx)),
  },
  {
    method: "POST",
    path: "/intake/leads/:id/reminders",
    handler: (ctx) => {
      const it = intake(ctx);
      const id = intParam(ctx, "id");
      it.addReminder(id, { title: ctx.body?.title, dueDate: ctx.body?.dueDate || null, assigneeId: optInt(ctx.body?.assigneeId, "assignee") }, actor(ctx));
      return it.getLead(id);
    },
  },
  {
    method: "POST",
    path: "/intake/leads/:id/emails",
    handler: (ctx) => {
      const it = intake(ctx);
      const id = intParam(ctx, "id");
      it.queueEmail(id, { subject: ctx.body?.subject, body: ctx.body?.body, sendAfter: ctx.body?.sendAfter || null, to: ctx.body?.to || null }, actor(ctx));
      return it.getLead(id);
    },
  },
  { method: "POST", path: "/intake/emails/:id/cancel", handler: (ctx) => intake(ctx).cancelEmail(intParam(ctx, "id"), actor(ctx)) },
  // For the email module: queued emails that are due now. (It marks them with markEmailSent in leads.ts.)
  { method: "GET", path: "/intake/emails/due", handler: (ctx) => dueEmails(ctx.db).map(({ ...e }) => e) },

  // ------------------------------------------------------------ engagement
  {
    method: "POST",
    path: "/intake/leads/:id/engagement",
    handler: (ctx) => {
      const templateId = optInt(ctx.body?.templateId, "template");
      if (!templateId) throw new EngineError("Choose a template for the engagement letter");
      return intake(ctx).createEngagement(intParam(ctx, "id"), templateId, actor(ctx));
    },
  },
  {
    method: "GET",
    path: "/intake/engagements/:id/download",
    handler: (ctx) => {
      const f = intake(ctx).engagementFile(intParam(ctx, "id"));
      return { filename: f.filename, mime: f.mime, size: f.data.length, base64: f.data.toString("base64") };
    },
  },
  {
    method: "POST",
    path: "/intake/engagements/:id/send",
    handler: (ctx) => intake(ctx).sendEngagement(intParam(ctx, "id"), { message: ctx.body?.message, queueEmail: ctx.body?.queueEmail !== false }, actor(ctx)),
  },

  // ---------------------------------------------------------- consultations
  {
    method: "GET",
    path: "/intake/slots",
    handler: (ctx) => slotsByDay(openSlots(intake(ctx), { userId: optInt(ctx.query.get("person"), "person"), days: optInt(ctx.query.get("days"), "days") ?? undefined })),
  },
  {
    method: "POST",
    path: "/intake/leads/:id/consultations",
    handler: (ctx) => {
      const it = intake(ctx);
      const id = intParam(ctx, "id");
      const r = book(it, id, { userId: ctx.body?.personId, start: ctx.body?.start, via: "staff", notes: ctx.body?.notes ?? null }, actor(ctx));
      return { ...r, lead: it.getLead(id) };
    },
  },
  { method: "POST", path: "/intake/consultations/:id/cancel", handler: (ctx) => cancelConsultation(intake(ctx), intParam(ctx, "id"), actor(ctx)) },
  { method: "GET", path: "/intake/availability", handler: (ctx) => listAvailability(intake(ctx)) },
  { method: "PUT", path: "/intake/availability/:userId", handler: (ctx) => setAvailability(intake(ctx), intParam(ctx, "userId"), ctx.body ?? {}, actor(ctx)) },

  // --------------------------------------------------------------- convert
  { method: "POST", path: "/intake/leads/:id/convert", handler: (ctx) => intake(ctx).convert(intParam(ctx, "id"), ctx.body ?? {}, actor(ctx)) },

  // ----------------------------------------------------------------- forms
  { method: "GET", path: "/intake/forms", handler: (ctx) => listForms(intake(ctx)) },
  { method: "POST", path: "/intake/forms", handler: (ctx) => createForm(intake(ctx), ctx.body ?? {}, actor(ctx)) },
  { method: "GET", path: "/intake/forms/:id", handler: (ctx) => getForm(intake(ctx), intParam(ctx, "id")) },
  { method: "PUT", path: "/intake/forms/:id", handler: (ctx) => updateForm(intake(ctx), intParam(ctx, "id"), ctx.body ?? {}, actor(ctx)) },
  { method: "DELETE", path: "/intake/forms/:id", handler: (ctx) => (deleteForm(intake(ctx), intParam(ctx, "id"), actor(ctx)), { ok: true }) },
  { method: "POST", path: "/intake/forms/:id/new-link", handler: (ctx) => newFormLink(intake(ctx), intParam(ctx, "id"), actor(ctx)) },

  // --------------------------------------------------------------- reports
  { method: "GET", path: "/intake/reports", handler: (ctx) => intakeReport(intake(ctx), { from: ctx.query.get("from"), to: ctx.query.get("to") }) },
] as Route[];

/**
 * Matter restrictions (src/auth/access.ts): a lead stays on the intake board after it is
 * converted, but once its matter is restricted the lead no longer names or links to it for
 * people who can't see it (`matterRestricted: true` instead).
 */
function hideMatters(hidden: Set<number>, v: any): any {
  if (Array.isArray(v)) return v.map((x) => hideMatters(hidden, x));
  if (!v || typeof v !== "object" || Buffer.isBuffer(v) || v instanceof Uint8Array) return v;
  const out: any = {};
  for (const [k, x] of Object.entries(v)) out[k] = hideMatters(hidden, x);
  if (typeof v.matterId === "number" && hidden.has(v.matterId)) Object.assign(out, { matterId: null, matterName: null, matterNumber: null, matterRestricted: true });
  return out;
}

export const routes: Route[] = intakeRoutes.map((r) =>
  r.public
    ? r
    : {
        ...r,
        handler: async (ctx: Ctx) => {
          const out: any = await r.handler(ctx);
          if (!out || typeof out !== "object" || out.__raw) return out;
          const hidden = hiddenMatterIds(ctx.db, ctx.userId);
          return hidden.size ? hideMatters(hidden, out) : out;
        },
      },
);
