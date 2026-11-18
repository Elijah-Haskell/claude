// A matter's communication log: emails sent from Lawdesk, saved emails filed to the matter,
// and phone calls and meetings logged by hand. Every change is written to the activity log.

import { type DB, tx } from "../db.ts";
import { type Engine, EngineError } from "../engine.ts";
import type { Documents } from "../documents/documents.ts";
import { fillText } from "../documents/assembly.ts";
import { checkFilename } from "../documents/files.ts";
import { type Address, checkAddress, formatAddress, parseAddressList, textToHtml } from "./mime.ts";
import { parseMessage } from "./parse.ts";
import { queueEmail } from "./outbox.ts";
import { loadConfig } from "./settings.ts";

type Env = Record<string, string | undefined>;

export const MAX_BODY_CHARS = 200_000;
export const CORRESPONDENCE_FOLDER = "Correspondence";

const STARTER_TEMPLATES = [
  {
    name: "Status update",
    subject: "{{matter.name}}: status update",
    body:
      "Dear {{recipient.name}},\n\nI am writing to update you on {{matter.name}}.\n\n[Summary of where things stand and next steps.]\n\n" +
      "Please let me know if you have any questions.\n\nSincerely,\n{{user.name}}",
  },
  {
    name: "Request for documents",
    subject: "{{matter.name}}: documents we need",
    body:
      "Dear {{recipient.name}},\n\nTo keep {{matter.name}} moving, we need the following from you:\n\n• [Document]\n• [Document]\n\n" +
      "You can reply to this email with the documents attached, or drop them off at our office.\n\nThank you,\n{{user.name}}",
  },
];

function now(opts: { now?: Date }): string {
  return (opts.now ?? new Date()).toISOString();
}

function checkMatter(db: DB, matterId: number) {
  const m = db.prepare("SELECT id, number, name, client_id FROM matters WHERE id = ?").get(matterId) as any;
  if (!m) throw new EngineError("Matter not found", 404);
  return m;
}

function optText(v: unknown, what: string, max: number): string | null {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string") throw new EngineError(`${what} must be text`);
  const t = v.trim();
  if (t.length > max) throw new EngineError(`${what} is longer than ${max} characters`);
  return t || null;
}

const addrText = (list: Address[]) => list.map((a) => (a.name ? `${a.name} <${a.address}>` : a.address)).join(", ");

// ------------------------------------------------------------------ templates

export function listTemplates(db: DB) {
  if (!(db.prepare("SELECT value FROM email_state WHERE key = 'templates_seeded'").get() as any)) {
    const t = new Date().toISOString();
    for (const s of STARTER_TEMPLATES) {
      db.prepare("INSERT INTO email_templates (name, subject, body, created_at, updated_at) VALUES (?,?,?,?,?)").run(s.name, s.subject, s.body, t, t);
    }
    db.prepare("INSERT OR REPLACE INTO email_state (key, value) VALUES ('templates_seeded', '1')").run();
  }
  return db.prepare("SELECT id, name, subject, body, updated_at FROM email_templates WHERE deleted_at IS NULL ORDER BY name").all();
}

export function saveTemplate(db: DB, id: number | null, input: { name?: unknown; subject?: unknown; body?: unknown }) {
  const name = optText(input.name, "Template name", 200);
  const subject = optText(input.subject, "Subject", 900);
  const body = typeof input.body === "string" ? input.body.replace(/\r\n?/g, "\n") : null;
  if (!name) throw new EngineError("Give the template a name");
  if (!subject) throw new EngineError("Give the template a subject");
  if (!body || !body.trim()) throw new EngineError("Write the template's message");
  if (body.length > 50_000) throw new EngineError("The message is too long");
  const t = new Date().toISOString();
  if (id === null) {
    return Number(db.prepare("INSERT INTO email_templates (name, subject, body, created_at, updated_at) VALUES (?,?,?,?,?)").run(name, subject, body, t, t).lastInsertRowid);
  }
  const r = db.prepare("UPDATE email_templates SET name = ?, subject = ?, body = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL").run(name, subject, body, t, id);
  if (!r.changes) throw new EngineError("Template not found", 404);
  return id;
}

export function deleteTemplate(db: DB, id: number) {
  const r = db.prepare("UPDATE email_templates SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL").run(new Date().toISOString(), id);
  if (!r.changes) throw new EngineError("Template not found", 404);
}

// ------------------------------------------------------------------ recipients

/** Who can be emailed from this matter: its client first, then every other contact with an address. */
export function recipientsFor(db: DB, matterId: number) {
  const m = checkMatter(db, matterId);
  const rows = db.prepare("SELECT id, name, email, kind FROM contacts WHERE email IS NOT NULL AND email <> '' ORDER BY name").all() as any[];
  return rows.map((c) => ({ contactId: c.id, name: c.name, email: c.email, isClient: c.id === m.client_id })).sort((a, b) => Number(b.isClient) - Number(a.isClient));
}

/** Accepts ["Ann <ann@x.test>", "bob@x.test"], "a@x.test, b@x.test" or [{name, address}]. */
export function readRecipients(v: unknown, what: string): Address[] {
  if (v === undefined || v === null || v === "") return [];
  const items: Address[] = [];
  const list = Array.isArray(v) ? v : [v];
  for (const x of list) {
    if (typeof x === "string") items.push(...parseAddressList(x));
    else if (x && typeof x === "object" && typeof (x as any).address === "string") items.push({ name: (x as any).name ?? null, address: (x as any).address });
    else throw new EngineError(`${what} must be email addresses`);
  }
  if (items.length > 50) throw new EngineError(`${what}: at most 50 addresses`);
  return items.map((a) => checkAddress(a, what));
}

// ------------------------------------------------------------------ merge

export interface DraftInput {
  subject: string;
  body: string;
  /** The first To recipient, for {{recipient.name}}. */
  recipient?: Address | null;
}

/** Fill {{merge.fields}} in a subject and body for a matter (same fields as document templates, plus recipient.*). */
export function mergeDraft(docs: Documents, matterId: number, userId: number | null, d: DraftInput) {
  const base = docs.mergeData(matterId, userId);
  const name = d.recipient?.name ?? null;
  const data = { ...base, recipient: { name: name ?? (base.client as any)?.name ?? null, email: d.recipient?.address ?? null } };
  const s = fillText(String(d.subject ?? ""), data);
  const b = fillText(String(d.body ?? ""), data);
  return {
    subject: s.output.replace(/[\r\n]+/g, " ").trim(),
    body: b.output,
    unknown: [...new Set([...s.unknown, ...b.unknown])],
    empty: [...new Set([...s.empty, ...b.empty])],
  };
}

// ------------------------------------------------------------------ send from a matter

export interface SendInput {
  matterId: number;
  to: unknown;
  cc?: unknown;
  bcc?: unknown;
  subject: string;
  body: string;
  documentIds?: number[];
  /** Send even if some merge fields have no value for this matter. */
  allowEmptyFields?: boolean;
  userId?: number | null;
}

export function sendFromMatter(db: DB, engine: Engine, docs: Documents, input: SendInput, opts: { now?: Date; env?: Env } = {}) {
  const m = checkMatter(db, input.matterId);
  const to = readRecipients(input.to, "To");
  const cc = readRecipients(input.cc, "Cc");
  const bcc = readRecipients(input.bcc, "Bcc");
  if (!to.length) throw new EngineError("Add at least one recipient");
  if (typeof input.body !== "string" || !input.body.trim()) throw new EngineError("Write a message");
  if (input.body.length > MAX_BODY_CHARS) throw new EngineError("The message is too long");
  const merged = mergeDraft(docs, m.id, input.userId ?? null, { subject: input.subject, body: input.body, recipient: to[0] });
  if (merged.unknown.length) throw new EngineError(`These merge fields do not exist: ${merged.unknown.map((f) => `{{${f}}}`).join(", ")}`);
  if (merged.empty.length && !input.allowEmptyFields) {
    throw new EngineError(`These merge fields have no value for this matter: ${merged.empty.map((f) => `{{${f}}}`).join(", ")}`, 422);
  }
  const ids = Array.isArray(input.documentIds) ? input.documentIds : [];
  if (ids.length > 20) throw new EngineError("Attach at most 20 documents");
  let total = 0;
  const attachments = ids.map((id) => {
    if (!Number.isInteger(id)) throw new EngineError("Bad document id");
    const d = docs.get(id) as any;
    if (d.matterId !== m.id) throw new EngineError("That document belongs to another matter", 400);
    const f = docs.download(id, { userId: input.userId ?? null }) as any;
    total += f.data.length;
    return { filename: f.filename, contentType: f.mime, data: f.data as Buffer };
  });
  // Most mail servers refuse messages over 25 MB; base64 makes attachments a third larger.
  if (total > 18 * 1024 * 1024) throw new EngineError("The attachments are too large to email (limit about 18 MB in total)");
  const user = input.userId ? (db.prepare("SELECT name, email FROM users WHERE id = ?").get(input.userId) as any) : null;
  const replyTo = user?.email ? { name: user.name, address: user.email } : null;
  const at = now(opts);
  return tx(db, () => {
    const q = queueEmail(
      db,
      { kind: "matter", to, cc, bcc, replyTo, subject: merged.subject, text: merged.body, html: textToHtml(merged.body), attachments, matterId: m.id, userId: input.userId ?? null },
      opts,
    );
    const cfg = loadConfig(db, opts.env);
    const id = Number(
      db
        .prepare(
          `INSERT INTO email_comm_log (matter_id, kind, direction, occurred_at, subject, from_addr, to_addrs, cc_addrs, body, message_id, outbox_id, attachment_ids, created_by, created_at)
           VALUES (?, 'email', 'out', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          m.id,
          at,
          merged.subject,
          formatAddress({ name: cfg.fromName, address: cfg.fromAddress }),
          addrText(to),
          addrText([...cc, ...bcc.map((b) => ({ ...b, name: (b.name ? b.name + " " : "") + "(Bcc)" }))]) || null,
          merged.body,
          q.messageId,
          q.id,
          JSON.stringify(ids),
          input.userId ?? null,
          at,
        ).lastInsertRowid,
    );
    engine.log("email_sent", `Emailed ${addrText(to)}: "${merged.subject}"${ids.length ? ` with ${ids.length} attachment(s)` : ""}`, { userId: input.userId ?? null, matterId: m.id });
    return { id, outboxId: q.id, messageId: q.messageId };
  });
}

// ------------------------------------------------------------------ calls and meetings

export interface LogInput {
  matterId: number;
  kind: "phone" | "meeting" | "note";
  occurredAt?: string;
  direction?: "in" | "out" | null;
  durationMinutes?: number | null;
  participants?: string | null;
  subject?: string | null;
  notes?: string | null;
  userId?: number | null;
  /**
   * TODO(billing): when true, the billing module should create a time entry for
   * durationMinutes on this matter and the user, then set email_comm_log.time_entry_id.
   * Lawdesk does not do this yet; the flag is accepted and ignored.
   */
  createTimeEntry?: boolean;
}

export function logCommunication(db: DB, engine: Engine, input: LogInput, opts: { now?: Date } = {}) {
  const m = checkMatter(db, input.matterId);
  if (!["phone", "meeting", "note"].includes(input.kind)) throw new EngineError("Kind must be phone, meeting or note");
  let occurred = now(opts);
  if (input.occurredAt !== undefined && input.occurredAt !== null && input.occurredAt !== "") {
    const ms = Date.parse(String(input.occurredAt));
    if (Number.isNaN(ms)) throw new EngineError("When must be a date and time");
    occurred = new Date(ms).toISOString();
  }
  let dur: number | null = null;
  if (input.durationMinutes !== undefined && input.durationMinutes !== null && (input.durationMinutes as any) !== "") {
    dur = Number(input.durationMinutes);
    if (!Number.isInteger(dur) || dur < 0 || dur > 24 * 60) throw new EngineError("Length must be a whole number of minutes, up to 24 hours");
  }
  if (input.direction != null && input.direction !== "in" && input.direction !== "out") throw new EngineError("Direction must be in or out");
  const participants = optText(input.participants, "Who", 500);
  const subject = optText(input.subject, "Subject", 300);
  const notes = optText(input.notes, "Notes", MAX_BODY_CHARS);
  if (!participants && !subject && !notes) throw new EngineError("Say who it was with, or add a subject or notes");
  const at = now(opts);
  return tx(db, () => {
    const id = Number(
      db
        .prepare(
          `INSERT INTO email_comm_log (matter_id, kind, direction, occurred_at, subject, participants, duration_minutes, body, created_by, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(m.id, input.kind, input.direction ?? null, occurred, subject, participants, dur, notes, input.userId ?? null, at).lastInsertRowid,
    );
    const label = { phone: "phone call", meeting: "meeting", note: "note" }[input.kind];
    engine.log("communication_logged", `Logged a ${label}${participants ? ` with ${participants}` : ""}${dur ? ` (${dur} min)` : ""}${subject ? `: ${subject}` : ""}`, {
      userId: input.userId ?? null,
      matterId: m.id,
    });
    return { id };
  });
}

/** Only hand-logged entries can be removed; sent and filed emails are part of the record. */
export function deleteCommunication(db: DB, engine: Engine, id: number, userId: number | null) {
  const r = db.prepare("SELECT * FROM email_comm_log WHERE id = ? AND deleted_at IS NULL").get(id) as any;
  if (!r) throw new EngineError("Entry not found", 404);
  if (r.kind === "email") throw new EngineError("Emails stay in the log; they cannot be removed", 409);
  db.prepare("UPDATE email_comm_log SET deleted_at = ? WHERE id = ?").run(new Date().toISOString(), id);
  engine.log("communication_removed", `Removed a logged ${r.kind === "phone" ? "phone call" : r.kind}${r.subject ? `: ${r.subject}` : ""}`, { userId, matterId: r.matter_id });
}

// ------------------------------------------------------------------ list

export function listCommunications(db: DB, matterId: number) {
  checkMatter(db, matterId);
  const rows = db
    .prepare(
      `SELECT c.id, c.kind, c.direction, c.occurred_at, c.subject, c.from_addr, c.to_addrs, c.cc_addrs, c.participants, c.duration_minutes,
              substr(c.body, 1, 400) AS preview, c.document_id, c.attachment_ids, c.created_at, u.name AS created_by_name,
              o.status AS send_status, o.last_error AS send_error
       FROM email_comm_log c LEFT JOIN users u ON u.id = c.created_by LEFT JOIN email_outbox o ON o.id = c.outbox_id
       WHERE c.matter_id = ? AND c.deleted_at IS NULL ORDER BY c.occurred_at DESC, c.id DESC LIMIT 500`,
    )
    .all(matterId) as any[];
  return rows.map((r) => ({ ...r, attachment_ids: JSON.parse(r.attachment_ids) }));
}

export function getCommunication(db: DB, id: number) {
  const r = db
    .prepare(
      `SELECT c.*, u.name AS created_by_name, o.status AS send_status, o.last_error AS send_error
       FROM email_comm_log c LEFT JOIN users u ON u.id = c.created_by LEFT JOIN email_outbox o ON o.id = c.outbox_id
       WHERE c.id = ? AND c.deleted_at IS NULL`,
    )
    .get(id) as any;
  if (!r) throw new EngineError("Entry not found", 404);
  const ids: number[] = JSON.parse(r.attachment_ids);
  const attachments = ids.length
    ? (db.prepare(`SELECT id, name FROM doc_documents WHERE id IN (${ids.map(() => "?").join(",")})`).all(...ids) as any[])
    : [];
  return { ...r, attachment_ids: ids, attachments };
}

// ------------------------------------------------------------------ import .eml

/** A safe document name from an email subject: "2026-11-18 Re Closing documents.eml". */
export function emlName(date: string | null, subject: string): string {
  const day = (date ?? new Date().toISOString()).slice(0, 10);
  const clean = (subject || "Email").replace(/[\x00-\x1f\x7f/\\:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().replace(/[. ]+$/, "").slice(0, 120);
  return `${day} ${clean || "Email"}.eml`;
}

function safeAttachmentName(name: string): string {
  let n = name.replace(/[\x00-\x1f\x7f/\\:*?"<>|]+/g, "_").replace(/\s+/g, " ").trim().replace(/[. ]+$/, "");
  if (n.length > 180) {
    const dot = n.lastIndexOf(".");
    n = dot > 0 && n.length - dot <= 10 ? n.slice(0, 170) + n.slice(dot) : n.slice(0, 180);
  }
  try {
    return checkFilename(n || "attachment");
  } catch {
    return "attachment_" + n.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 100);
  }
}

export interface ImportInput {
  matterId: number;
  filename?: string;
  data: Buffer;
  userId?: number | null;
}

/**
 * File a saved email to a matter: the .eml itself and each attachment go into the matter's
 * documents (folder "Correspondence"), and an entry is added to the communication log.
 * The same message (by Message-ID) cannot be filed to one matter twice.
 */
export function importEml(db: DB, engine: Engine, docs: Documents, input: ImportInput, opts: { now?: Date; env?: Env } = {}) {
  const m = checkMatter(db, input.matterId);
  if (!input.data?.length) throw new EngineError("The file is empty");
  if (input.data.length > docs.maxBytes) throw new EngineError("That email is too large", 413);
  const msg = parseMessage(input.data);
  if (!msg.from.length && !msg.subject && !msg.text) throw new EngineError("That file does not look like a saved email (.eml)", 415);
  if (msg.messageId) {
    const dup = db.prepare("SELECT id FROM email_comm_log WHERE matter_id = ? AND message_id = ? AND deleted_at IS NULL").get(m.id, msg.messageId) as any;
    if (dup) throw new EngineError("This email is already filed to this matter", 409);
  }
  const cfg = loadConfig(db, opts.env);
  const ours = new Set(
    [cfg.fromAddress, ...(db.prepare("SELECT email FROM users WHERE email IS NOT NULL").all() as any[]).map((u) => u.email)].filter(Boolean).map((e: string) => e.toLowerCase()),
  );
  const direction = msg.from.some((a) => ours.has(a.address.toLowerCase())) ? "out" : "in";
  const userId = input.userId ?? null;
  return tx(db, () => {
    const eml = docs.upload({
      matterId: m.id,
      filename: emlName(msg.date, msg.subject),
      data: input.data,
      folder: CORRESPONDENCE_FOLDER,
      category: "Correspondence",
      onConflict: "rename",
      userId,
    }) as any;
    const saved: { id: number; name: string }[] = [];
    const skipped: { name: string; reason: string }[] = [];
    for (const a of msg.attachments) {
      const name = safeAttachmentName(a.filename);
      if (!a.data.length) {
        skipped.push({ name, reason: "empty" });
        continue;
      }
      try {
        const d = docs.upload({ matterId: m.id, filename: name, data: a.data, folder: CORRESPONDENCE_FOLDER, category: "Correspondence", onConflict: "rename", userId }) as any;
        saved.push({ id: d.id, name: d.name });
      } catch (e: any) {
        // A file whose contents do not match its name, or one too large, is left out (but stays inside the filed .eml).
        if (!(e instanceof EngineError)) throw e;
        skipped.push({ name, reason: e.message });
      }
    }
    const at = now(opts);
    const id = Number(
      db
        .prepare(
          `INSERT INTO email_comm_log (matter_id, kind, direction, occurred_at, subject, from_addr, to_addrs, cc_addrs, body, message_id, document_id, attachment_ids, created_by, created_at)
           VALUES (?, 'email', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          m.id,
          direction,
          msg.date ?? at,
          msg.subject || "(no subject)",
          addrText(msg.from) || null,
          addrText(msg.to) || null,
          addrText(msg.cc) || null,
          msg.text.slice(0, MAX_BODY_CHARS),
          msg.messageId,
          eml.id,
          JSON.stringify(saved.map((s) => s.id)),
          userId,
          at,
        ).lastInsertRowid,
    );
    engine.log(
      "email_filed",
      `Filed email "${msg.subject || "(no subject)"}" from ${addrText(msg.from) || "unknown sender"}${saved.length ? ` with ${saved.length} attachment(s)` : ""}`,
      { userId, matterId: m.id },
    );
    return { id, documentId: eml.id, subject: msg.subject, from: addrText(msg.from), attachments: saved, skipped };
  });
}
