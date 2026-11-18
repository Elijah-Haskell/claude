// HTTP routes for email (all under /api).

import { EngineError } from "../engine.ts";
import { type Ctx, type Route, intParam } from "../http.ts";
import { documentsFor } from "../documents/routes.ts";
import { decodeBase64 } from "../documents/documents.ts";
import { buildMessage, checkAddress, textToHtml } from "./mime.ts";
import { loadConfig, publicSettings, saveSettings, transportFor } from "./settings.ts";
import { cancelOutbox, listOutbox, retryOutbox } from "./outbox.ts";
import { getPrefs, setPrefs } from "./notify.ts";
import { runEmailJobs } from "./worker.ts";
import { PROVIDERS } from "./transport.ts";
import {
  deleteCommunication,
  deleteTemplate,
  getCommunication,
  importEml,
  listCommunications,
  listTemplates,
  logCommunication,
  mergeDraft,
  readRecipients,
  recipientsFor,
  saveTemplate,
  sendFromMatter,
} from "./comms.ts";

function body(ctx: Ctx): Record<string, any> {
  const b = ctx.body;
  if (!b || typeof b !== "object" || Array.isArray(b)) throw new EngineError("Expected a JSON object");
  return b;
}

export const routes: Route[] = [
  // ---------------------------------------------------------------- settings
  { method: "GET", path: "/email/settings", handler: (ctx) => ({ ...publicSettings(ctx.db), providers: PROVIDERS }) },
  {
    method: "PUT",
    path: "/email/settings",
    handler: (ctx) => {
      const changed = saveSettings(ctx.db, body(ctx));
      if (changed.length) ctx.engine.log("email_settings_changed", `Changed email settings: ${changed.join(", ")}`, { userId: ctx.userId });
      return { ...publicSettings(ctx.db), providers: PROVIDERS, changed };
    },
  },
  {
    // Sends straight away (not through the queue) so the screen can say whether it worked.
    method: "POST",
    path: "/email/settings/test",
    handler: async (ctx) => {
      const b = body(ctx);
      const to = checkAddress({ address: String(b.to ?? "").trim() }, "Send the test to");
      const cfg = loadConfig(ctx.db);
      if (!cfg.fromAddress) throw new EngineError("Set the From address first");
      const text =
        "This is a test message from Lawdesk.\n\nIf you are reading it, the firm's email settings work: notices, reminders and emails sent from matters will be delivered.";
      const msg = buildMessage({ from: { name: cfg.fromName, address: cfg.fromAddress }, to: [to], subject: "Lawdesk test email", text, html: textToHtml(text) });
      try {
        const r = await transportFor(cfg).send(msg.envelope, msg.raw);
        ctx.engine.log("email_test", `Sent a test email to ${to.address}`, { userId: ctx.userId });
        return { ok: true, transport: cfg.transport, response: r.response };
      } catch (e: any) {
        return { ok: false, transport: cfg.transport, error: String(e?.message ?? e) };
      }
    },
  },

  // ---------------------------------------------------------------- per-person notices
  { method: "GET", path: "/email/prefs/:userId", handler: (ctx) => getPrefs(ctx.db, intParam(ctx, "userId")) },
  {
    method: "PUT",
    path: "/email/prefs/:userId",
    handler: (ctx) => {
      const p = setPrefs(ctx.db, intParam(ctx, "userId"), body(ctx));
      ctx.engine.log("email_prefs_changed", `Changed email notices for user #${p.userId}`, { userId: ctx.userId });
      return p;
    },
  },

  // ---------------------------------------------------------------- outbox
  {
    method: "GET",
    path: "/email/outbox",
    handler: (ctx) => listOutbox(ctx.db, { status: ctx.query.get("status") || null, limit: Number(ctx.query.get("limit")) || 50 }),
  },
  {
    method: "POST",
    path: "/email/outbox/run",
    handler: async (ctx) => {
      const r = await runEmailJobs(ctx.db);
      return r;
    },
  },
  {
    method: "POST",
    path: "/email/outbox/:id/retry",
    handler: (ctx) => {
      retryOutbox(ctx.db, intParam(ctx, "id"));
      return { ok: true };
    },
  },
  {
    method: "POST",
    path: "/email/outbox/:id/cancel",
    handler: (ctx) => {
      cancelOutbox(ctx.db, intParam(ctx, "id"));
      return { ok: true };
    },
  },

  // ---------------------------------------------------------------- templates
  { method: "GET", path: "/email/templates", handler: (ctx) => listTemplates(ctx.db) },
  {
    method: "POST",
    path: "/email/templates",
    handler: (ctx) => {
      listTemplates(ctx.db);
      const id = saveTemplate(ctx.db, null, body(ctx));
      return { id };
    },
  },
  {
    method: "PUT",
    path: "/email/templates/:id",
    handler: (ctx) => ({ id: saveTemplate(ctx.db, intParam(ctx, "id"), body(ctx)) }),
  },
  {
    method: "DELETE",
    path: "/email/templates/:id",
    handler: (ctx) => {
      deleteTemplate(ctx.db, intParam(ctx, "id"));
      return { ok: true };
    },
  },

  // ---------------------------------------------------------------- matter communications
  {
    method: "GET",
    path: "/matters/:id/communications",
    handler: (ctx) => {
      const id = intParam(ctx, "id");
      return { entries: listCommunications(ctx.db, id), recipients: recipientsFor(ctx.db, id), templates: listTemplates(ctx.db) };
    },
  },
  {
    method: "POST",
    path: "/matters/:id/communications/preview",
    handler: (ctx) => {
      const b = body(ctx);
      const to = readRecipients(b.to, "To");
      return mergeDraft(documentsFor(ctx), intParam(ctx, "id"), ctx.userId, { subject: String(b.subject ?? ""), body: String(b.body ?? ""), recipient: to[0] ?? null });
    },
  },
  {
    method: "POST",
    path: "/matters/:id/communications/email",
    handler: (ctx) => {
      const b = body(ctx);
      return sendFromMatter(ctx.db, ctx.engine, documentsFor(ctx), {
        matterId: intParam(ctx, "id"),
        to: b.to,
        cc: b.cc,
        bcc: b.bcc,
        subject: b.subject,
        body: b.body,
        documentIds: b.documentIds,
        allowEmptyFields: b.allowEmptyFields === true,
        userId: ctx.userId,
      });
    },
  },
  {
    method: "POST",
    path: "/matters/:id/communications/log",
    handler: (ctx) => {
      const b = body(ctx);
      return logCommunication(ctx.db, ctx.engine, {
        matterId: intParam(ctx, "id"),
        kind: b.kind,
        occurredAt: b.occurredAt,
        direction: b.direction ?? null,
        durationMinutes: b.durationMinutes,
        participants: b.participants,
        subject: b.subject,
        notes: b.notes,
        createTimeEntry: b.createTimeEntry === true,
        userId: ctx.userId,
      });
    },
  },
  {
    method: "POST",
    path: "/matters/:id/communications/import",
    handler: (ctx) => {
      const b = body(ctx);
      const docs = documentsFor(ctx);
      const data = decodeBase64(b.contentBase64, docs.maxBytes);
      return importEml(ctx.db, ctx.engine, docs, { matterId: intParam(ctx, "id"), filename: b.filename, data, userId: ctx.userId });
    },
  },
  { method: "GET", path: "/communications/:id", handler: (ctx) => getCommunication(ctx.db, intParam(ctx, "id")) },
  {
    method: "DELETE",
    path: "/communications/:id",
    handler: (ctx) => {
      deleteCommunication(ctx.db, ctx.engine, intParam(ctx, "id"), ctx.userId);
      return { ok: true };
    },
  },
];
