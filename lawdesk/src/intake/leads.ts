// Leads: people who have asked the firm for help but are not clients yet. A lead moves
// through a pipeline (New, Contacted, Consultation scheduled, Engagement sent, then Hired
// or Not hired), gets an automatic conflict check, follow-up reminders and queued emails,
// and is converted into a client and matter in one step.

import { createHmac, randomBytes } from "node:crypto";
import { type DB, tx } from "../db.ts";
import { type ISODate, addBusinessDays, addDays, daysBetween, isISODate } from "../dates.ts";
import { type Engine, EngineError } from "../engine.ts";
import { runCheck, getCheck, decideCheck, linkCheck } from "../conflicts/search.ts";
import { addParty } from "../conflicts/store.ts";
import { compareNames, BANDS } from "../conflicts/names.ts";
import { fillDocx, fillText, longDate, type MergeData } from "../documents/assembly.ts";
import { detectMime, extensionOf } from "../documents/files.ts";
import type { Documents } from "../documents/documents.ts";
import { NOT_HIRED_REASONS, STATUS_KEYS, statusLabel, type Status } from "./schema.ts";

type Row = Record<string, any>;

export interface LeadInput {
  name?: string;
  kind?: "person" | "company";
  email?: string | null;
  phone?: string | null;
  source?: string | null;
  practiceAreaId?: number | null;
  summary?: string | null;
  opposing?: string[] | string | null;
  ownerId?: number | null;
}

export interface ConvertInput {
  /** Use this existing contact as the client; otherwise one is created from the lead. */
  contactId?: number | null;
  clientName?: string | null;
  clientKind?: "person" | "company";
  matterName?: string | null;
  matterNumber?: string | null;
  practiceAreaId?: number | null;
  roles?: Record<string, number>;
}

/**
 * Hooks other modules fill in. The e-signature module sets sendForSignature; when it is
 * set, "Send engagement letter" hands the letter to it instead of only marking it sent.
 */
export const intakeHooks: {
  sendForSignature: null | ((req: { db: DB; engagementId: number; leadId: number; name: string; email: string | null; filename: string; mime: string; data: Buffer; userId: number | null }) => { ref: string } | Promise<{ ref: string }>);
} = { sendForSignature: null };

const MAX = { name: 200, email: 200, phone: 40, source: 120, summary: 10000, party: 200, note: 10000, subject: 300, body: 20000 };
const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const COMPANY_RE = /\b(llc|l\.l\.c\.|inc|incorporated|corp|corporation|co|company|lp|llp|pllc|pa|ltd|bank|trust|association|partners|group|holdings|church|city|county|state|university|hospital)\b\.?$/i;

export function bad(message: string, status = 400): never {
  throw new EngineError(message, status);
}

export function cleanText(v: unknown, what: string, max: number, required = false): string | null {
  if (v === undefined || v === null || v === "") {
    if (required) bad(`${what} is required`);
    return null;
  }
  if (typeof v !== "string" && typeof v !== "number") bad(`${what} must be text`);
  const s = String(v).replace(/\r\n/g, "\n").trim();
  if (required && !s) bad(`${what} is required`);
  if (s.length > max) bad(`${what} is too long (at most ${max} characters)`);
  return s || null;
}

export function cleanEmail(v: unknown, what = "Email"): string | null {
  const s = cleanText(v, what, MAX.email);
  if (s && !EMAIL_RE.test(s)) bad(`${what} doesn't look like an email address`);
  return s;
}

export function cleanPhone(v: unknown, what = "Phone"): string | null {
  const s = cleanText(v, what, MAX.phone);
  if (s && (!/^[0-9+().\-\s x]+$/i.test(s) || s.replace(/\D/g, "").length < 7)) bad(`${what} doesn't look like a phone number`);
  return s;
}

/** A guess at whether a typed name is a business, for new contacts made from party names. */
export function looksLikeCompany(name: string): boolean {
  return COMPANY_RE.test(name.trim().replace(/[,.]+$/, ""));
}

export function parseParties(v: unknown): string[] {
  if (v === undefined || v === null || v === "") return [];
  const list = Array.isArray(v) ? v : String(v).split(/\n|;/);
  const out: string[] = [];
  for (const raw of list) {
    const s = cleanText(raw, "Other party's name", MAX.party);
    if (s && !out.some((x) => x.toLowerCase() === s.toLowerCase())) out.push(s);
  }
  if (out.length > 20) bad("List at most 20 other parties");
  return out;
}

export const token = (bytes = 18) => randomBytes(bytes).toString("base64url");

export class Intake {
  db: DB;
  engine: Engine;
  private nowFn: () => number;
  /** Set by the routes so engagement letters can be filed into matters. */
  documents: Documents | null = null;

  constructor(db: DB, engine: Engine, opts: { now?: () => number; documents?: Documents | null } = {}) {
    this.db = db;
    this.engine = engine;
    this.nowFn = opts.now ?? (() => Date.now());
    this.documents = opts.documents ?? null;
  }

  now(): number {
    return this.nowFn();
  }
  nowIso(): string {
    return new Date(this.now()).toISOString();
  }
  today(): ISODate {
    return this.engine.today();
  }

  one(sql: string, ...p: any[]): Row | undefined {
    return this.db.prepare(sql).get(...p) as Row | undefined;
  }
  all(sql: string, ...p: any[]): Row[] {
    return this.db.prepare(sql).all(...p) as Row[];
  }
  run(sql: string, ...p: any[]): number {
    return Number(this.db.prepare(sql).run(...p).lastInsertRowid);
  }

  // ------------------------------------------------------------- settings

  settings(): Row {
    let s = this.one("SELECT * FROM intake_settings WHERE id = 1");
    if (!s) {
      this.run("INSERT OR IGNORE INTO intake_settings (id) VALUES (1)");
      s = this.one("SELECT * FROM intake_settings WHERE id = 1")!;
    }
    if (!s.secret || !s.booking_token) {
      this.run(
        "UPDATE intake_settings SET secret = COALESCE(secret, ?), booking_token = COALESCE(booking_token, ?) WHERE id = 1",
        randomBytes(32).toString("hex"),
        token(),
      );
      s = this.one("SELECT * FROM intake_settings WHERE id = 1")!;
    }
    return s;
  }

  /** The firm's name for public pages: intake's own setting, else the billing letterhead. */
  firmName(): string {
    const own = this.settings().firm_name;
    if (own) return own;
    try {
      const b = this.one("SELECT firm_name FROM billing_settings WHERE id = 1");
      if (b?.firm_name) return b.firm_name;
    } catch {
      /* billing tables not created */
    }
    return "Our firm";
  }

  publicSettings() {
    const s = this.settings();
    return {
      firmName: s.firm_name,
      firmNameShown: this.firmName(),
      bookingToken: s.booking_token,
      bookingIntro: s.booking_intro,
      minNoticeHours: s.min_notice_hours,
      daysAhead: s.days_ahead,
      newLeadTaskDays: s.new_lead_task_days,
      engagementFollowupDays: s.engagement_followup_days,
      defaultOwnerId: s.default_owner_id,
    };
  }

  updateSettings(patch: Row, userId: number | null) {
    const s = this.settings();
    const int = (v: unknown, what: string, lo: number, hi: number) => {
      const n = Number(v);
      if (!Number.isInteger(n) || n < lo || n > hi) bad(`${what} must be a whole number from ${lo} to ${hi}`);
      return n;
    };
    const next = {
      firm_name: patch.firmName !== undefined ? cleanText(patch.firmName, "Firm name", 200) ?? "" : s.firm_name,
      booking_intro: patch.bookingIntro !== undefined ? cleanText(patch.bookingIntro, "Booking page note", 2000) : s.booking_intro,
      min_notice_hours: patch.minNoticeHours !== undefined ? int(patch.minNoticeHours, "Notice", 0, 24 * 14) : s.min_notice_hours,
      days_ahead: patch.daysAhead !== undefined ? int(patch.daysAhead, "Days shown", 1, 90) : s.days_ahead,
      new_lead_task_days: patch.newLeadTaskDays !== undefined ? int(patch.newLeadTaskDays, "First call reminder", 0, 30) : s.new_lead_task_days,
      engagement_followup_days:
        patch.engagementFollowupDays !== undefined ? int(patch.engagementFollowupDays, "Engagement follow-up", 1, 60) : s.engagement_followup_days,
      default_owner_id: patch.defaultOwnerId !== undefined ? this.checkUser(patch.defaultOwnerId) : s.default_owner_id,
    };
    this.run(
      `UPDATE intake_settings SET firm_name = ?, booking_intro = ?, min_notice_hours = ?, days_ahead = ?, new_lead_task_days = ?,
         engagement_followup_days = ?, default_owner_id = ? WHERE id = 1`,
      next.firm_name,
      next.booking_intro,
      next.min_notice_hours,
      next.days_ahead,
      next.new_lead_task_days,
      next.engagement_followup_days,
      next.default_owner_id,
    );
    if (patch.newBookingLink === true) this.run("UPDATE intake_settings SET booking_token = ? WHERE id = 1", token());
    this.engine.log("intake_settings", "Changed intake settings", { userId });
    return this.publicSettings();
  }

  /** HMAC stamp put on a public form when it is opened; checked on submit (time-to-submit). */
  stamp(purpose: string, at = this.now()): string {
    const mac = createHmac("sha256", this.settings().secret).update(`${purpose}:${at}`).digest("base64url").slice(0, 22);
    return `${at}.${mac}`;
  }

  /** Milliseconds since the stamp was made, or null when it is forged or malformed. */
  stampAge(purpose: string, stamp: unknown): number | null {
    if (typeof stamp !== "string" || !/^\d{10,16}\.[A-Za-z0-9_-]{22}$/.test(stamp)) return null;
    const at = Number(stamp.split(".")[0]);
    if (this.stamp(purpose, at) !== stamp) return null;
    return this.now() - at;
  }

  // --------------------------------------------------------------- helpers

  checkUser(v: unknown): number | null {
    if (v === undefined || v === null || v === "") return null;
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0 || !this.one("SELECT id FROM users WHERE id = ?", n)) bad("Unknown person");
    return n;
  }

  checkArea(v: unknown): number | null {
    if (v === undefined || v === null || v === "") return null;
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0 || !this.one("SELECT id FROM practice_areas WHERE id = ?", n)) bad("Unknown practice area");
    return n;
  }

  leadRow(id: number): Row {
    const r = this.one("SELECT * FROM intake_leads WHERE id = ?", id);
    if (!r) bad("Lead not found", 404);
    return r;
  }

  log(leadId: number, kind: string, detail: string, userId: number | null, at = this.nowIso()) {
    this.run("INSERT INTO intake_activity (lead_id, at, user_id, kind, detail) VALUES (?,?,?,?,?)", leadId, at, userId, kind, detail);
  }

  private holidays(): Set<string> {
    return new Set(this.all("SELECT date FROM holidays").map((r) => r.date as string));
  }

  // ----------------------------------------------------------------- leads

  /**
   * Add a lead: from a public form, a booking, or typed in by staff. Runs the conflict check,
   * sets a first-call reminder for the owner and writes the history.
   */
  createLead(input: LeadInput & { formId?: number | null; answers?: { label: string; value: string }[]; via?: string }, userId: number | null = null): Row {
    return tx(this.db, () => {
      const s = this.settings();
      const name = cleanText(input.name, "Name", MAX.name, true)!;
      const kind =
        input.kind === "company" || input.kind === "person" ? input.kind : input.kind ? bad("Kind must be person or company") : looksLikeCompany(name) ? "company" : "person";
      const owner = this.checkUser(input.ownerId) ?? s.default_owner_id ?? null;
      const now = this.nowIso();
      const pos = (this.one("SELECT MIN(position) AS p FROM intake_leads WHERE status = 'new'")?.p ?? 1) - 1;
      const id = this.run(
        `INSERT INTO intake_leads (name, kind, email, phone, source, practice_area_id, summary, opposing, owner_id, form_id, answers,
           public_token, received_on, created_at, status_changed_at, position)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        name,
        kind,
        cleanEmail(input.email),
        cleanPhone(input.phone),
        cleanText(input.source, "How they heard about us", MAX.source),
        this.checkArea(input.practiceAreaId),
        cleanText(input.summary, "Summary", MAX.summary),
        JSON.stringify(parseParties(input.opposing)),
        owner,
        input.formId ?? null,
        JSON.stringify(input.answers ?? []),
        token(),
        this.today(),
        now,
        now,
        pos,
      );
      this.log(id, "lead_created", input.via ?? "Added by hand", userId);
      this.runConflictCheck(id, userId);
      if (owner) {
        const due = addBusinessDays(this.today(), s.new_lead_task_days, this.holidays());
        this.addReminder(id, { title: `Call new lead: ${name}`, dueDate: due, assigneeId: owner, kind: "first_call" }, userId);
      }
      return this.getLead(id);
    });
  }

  updateLead(id: number, patch: LeadInput, userId: number | null): Row {
    return tx(this.db, () => {
      const l = this.leadRow(id);
      const changes: string[] = [];
      const set = (col: string, value: unknown, label: string) => {
        if (value === undefined) return;
        const old = l[col];
        if ((old ?? null) === (value ?? null)) return;
        this.run(`UPDATE intake_leads SET ${col} = ? WHERE id = ?`, value as any, id);
        changes.push(label);
      };
      if (patch.name !== undefined) set("name", cleanText(patch.name, "Name", MAX.name, true), "name");
      if (patch.kind !== undefined) set("kind", patch.kind === "company" ? "company" : "person", "type");
      if (patch.email !== undefined) set("email", cleanEmail(patch.email), "email");
      if (patch.phone !== undefined) set("phone", cleanPhone(patch.phone), "phone");
      if (patch.source !== undefined) set("source", cleanText(patch.source, "How they heard about us", MAX.source), "source");
      if (patch.practiceAreaId !== undefined) set("practice_area_id", this.checkArea(patch.practiceAreaId), "practice area");
      if (patch.summary !== undefined) set("summary", cleanText(patch.summary, "Summary", MAX.summary), "summary");
      if (patch.opposing !== undefined) set("opposing", JSON.stringify(parseParties(patch.opposing)), "other parties");
      if (patch.ownerId !== undefined) {
        const owner = this.checkUser(patch.ownerId);
        if (owner !== l.owner_id) {
          this.run("UPDATE intake_leads SET owner_id = ? WHERE id = ?", owner, id);
          const who = owner ? this.one("SELECT name FROM users WHERE id = ?", owner)!.name : "nobody";
          changes.push(`owner (now ${who})`);
          // Open reminders follow the lead to its new owner.
          for (const t of this.all(
            "SELECT t.id FROM intake_lead_tasks lt JOIN tasks t ON t.id = lt.task_id WHERE lt.lead_id = ? AND t.status IN ('open','waiting')",
            id,
          )) {
            this.engine.updateTask(t.id, { assigneeId: owner }, userId);
          }
        }
      }
      if (changes.length) {
        this.log(id, "lead_updated", `Changed ${changes.join(", ")}`, userId);
        if (changes.includes("name") || changes.includes("other parties")) this.runConflictCheck(id, userId);
      }
      return this.getLead(id);
    });
  }

  /** Move a lead along the pipeline. Hired happens only through convert(). */
  setStatus(id: number, status: string, opts: { reason?: string | null; note?: string | null; position?: number | null }, userId: number | null): Row {
    return tx(this.db, () => {
      const l = this.leadRow(id);
      if (!STATUS_KEYS.includes(status)) bad(`Status must be one of: ${STATUS_KEYS.join(", ")}`);
      if (status === "hired" && l.status !== "hired") bad("Use “Convert to client” to mark a lead hired; it opens the matter too", 409);
      if (l.status === "hired" && status !== "hired") bad("This lead is already a client. Its matter carries on from here.", 409);
      if (opts.position != null && Number.isFinite(Number(opts.position))) {
        this.run("UPDATE intake_leads SET position = ? WHERE id = ?", Number(opts.position), id);
      }
      if (l.status === status) return this.getLead(id);
      let detail = `${statusLabel(l.status)} → ${statusLabel(status)}`;
      if (status === "not_hired") {
        const reason = cleanText(opts.reason, "Reason", 200, true)!;
        const note = cleanText(opts.note, "Note", 2000);
        this.run("UPDATE intake_leads SET not_hired_reason = ?, closed_on = ? WHERE id = ?", note ? `${reason}: ${note}` : reason, this.today(), id);
        detail += ` (${note ? `${reason}: ${note}` : reason})`;
        this.closeFollowUps(id, userId);
      } else {
        this.run("UPDATE intake_leads SET not_hired_reason = NULL, closed_on = NULL WHERE id = ?", id);
      }
      if (opts.position == null) {
        const pos = (this.one("SELECT MIN(position) AS p FROM intake_leads WHERE status = ?", status)?.p ?? 1) - 1;
        this.run("UPDATE intake_leads SET position = ? WHERE id = ?", pos, id);
      }
      this.run("UPDATE intake_leads SET status = ?, status_changed_at = ? WHERE id = ?", status, this.nowIso(), id);
      this.log(id, "status_changed", detail, userId);
      return this.getLead(id);
    });
  }

  addNote(id: number, body: unknown, userId: number | null): Row {
    this.leadRow(id);
    const text = cleanText(body, "Note", MAX.note, true)!;
    this.run("INSERT INTO intake_notes (lead_id, body, user_id, at) VALUES (?,?,?,?)", id, text, userId, this.nowIso());
    this.log(id, "note_added", `Note: ${text.length > 120 ? text.slice(0, 117) + "…" : text}`, userId);
    return this.getLead(id);
  }

  deleteNote(noteId: number, userId: number | null) {
    const n = this.one("SELECT * FROM intake_notes WHERE id = ?", noteId);
    if (!n) bad("Note not found", 404);
    this.run("DELETE FROM intake_notes WHERE id = ?", noteId);
    this.log(n.lead_id, "note_deleted", "Deleted a note", userId);
    return this.getLead(n.lead_id);
  }

  listLeads(filter: { status?: string | null; ownerId?: number | null; q?: string | null; open?: boolean } = {}): Row[] {
    const where: string[] = [];
    const p: any[] = [];
    if (filter.status) {
      where.push("l.status = ?");
      p.push(filter.status);
    }
    if (filter.open) where.push("l.status NOT IN ('hired','not_hired')");
    if (filter.ownerId) {
      where.push("l.owner_id = ?");
      p.push(filter.ownerId);
    }
    if (filter.q) {
      where.push("(l.name LIKE ? OR l.email LIKE ? OR l.phone LIKE ? OR l.summary LIKE ? OR l.source LIKE ?)");
      const like = `%${String(filter.q).replace(/[%_]/g, (c) => "\\" + c)}%`;
      p.push(like, like, like, like, like);
    }
    const rows = this.all(
      `SELECT l.*, u.name AS owner_name, pa.name AS practice_area, k.decision AS conflict_decision, k.hit_count AS conflict_hits,
         (SELECT MIN(t.due_date) FROM intake_lead_tasks lt JOIN tasks t ON t.id = lt.task_id WHERE lt.lead_id = l.id AND t.status IN ('open','waiting')) AS next_follow_up,
         (SELECT c.start_at FROM intake_consultations c WHERE c.lead_id = l.id AND c.status = 'booked' ORDER BY c.start_at DESC LIMIT 1) AS consult_at
       FROM intake_leads l LEFT JOIN users u ON u.id = l.owner_id LEFT JOIN practice_areas pa ON pa.id = l.practice_area_id
       LEFT JOIN conflicts_checks k ON k.id = l.conflict_check_id
       ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY l.position, l.id DESC`,
      ...p,
    );
    return rows.map((r) => this.leadOut(r));
  }

  private leadOut(r: Row): Row {
    return {
      id: r.id,
      name: r.name,
      kind: r.kind,
      email: r.email,
      phone: r.phone,
      source: r.source,
      practiceAreaId: r.practice_area_id,
      practiceArea: r.practice_area ?? null,
      summary: r.summary,
      opposing: JSON.parse(r.opposing || "[]"),
      status: r.status,
      statusLabel: statusLabel(r.status),
      notHiredReason: r.not_hired_reason,
      ownerId: r.owner_id,
      ownerName: r.owner_name ?? null,
      formId: r.form_id,
      receivedOn: r.received_on,
      createdAt: r.created_at,
      statusChangedAt: r.status_changed_at,
      hiredOn: r.hired_on,
      closedOn: r.closed_on,
      contactId: r.contact_id,
      matterId: r.matter_id,
      conflictCheckId: r.conflict_check_id,
      conflictDecision: r.conflict_decision ?? null,
      conflictHits: r.conflict_hits ?? null,
      earlierHits: JSON.parse(r.earlier_hits || "[]").length,
      nextFollowUp: r.next_follow_up ?? null,
      consultAt: r.consult_at ?? null,
      position: r.position,
      ageDays: daysBetween(r.received_on, this.today()),
    };
  }

  getLead(id: number): Row {
    const r = this.one(
      `SELECT l.*, u.name AS owner_name, pa.name AS practice_area, k.decision AS conflict_decision, k.hit_count AS conflict_hits,
         f.name AS form_name, m.name AS matter_name, m.number AS matter_number
       FROM intake_leads l LEFT JOIN users u ON u.id = l.owner_id LEFT JOIN practice_areas pa ON pa.id = l.practice_area_id
       LEFT JOIN conflicts_checks k ON k.id = l.conflict_check_id LEFT JOIN intake_forms f ON f.id = l.form_id
       LEFT JOIN matters m ON m.id = l.matter_id WHERE l.id = ?`,
      id,
    );
    if (!r) bad("Lead not found", 404);
    const out = this.leadOut(r);
    out.formName = r.form_name ?? null;
    out.matterName = r.matter_name ?? null;
    out.matterNumber = r.matter_number ?? null;
    out.answers = JSON.parse(r.answers || "[]");
    out.earlierInquiries = JSON.parse(r.earlier_hits || "[]");
    out.conflictCheck = r.conflict_check_id ? getCheck(this.db, r.conflict_check_id) : null;
    out.notes = this.all(
      "SELECT n.id, n.body, n.at, n.user_id AS userId, u.name AS userName FROM intake_notes n LEFT JOIN users u ON u.id = n.user_id WHERE n.lead_id = ? ORDER BY n.id DESC",
      id,
    );
    out.activity = this.all(
      "SELECT a.id, a.at, a.kind, a.detail, a.user_id AS userId, u.name AS userName FROM intake_activity a LEFT JOIN users u ON u.id = a.user_id WHERE a.lead_id = ? ORDER BY a.id DESC",
      id,
    );
    out.tasks = this.all(
      `SELECT t.id, t.title, t.status, t.due_date AS dueDate, t.assignee_id AS assigneeId, u.name AS assigneeName, lt.kind
       FROM intake_lead_tasks lt JOIN tasks t ON t.id = lt.task_id LEFT JOIN users u ON u.id = t.assignee_id
       WHERE lt.lead_id = ? ORDER BY (t.status IN ('done','skipped')), t.due_date IS NULL, t.due_date, t.id`,
      id,
    );
    out.emails = this.all(
      `SELECT id, kind, to_name AS toName, to_address AS toAddress, subject, body, send_after AS sendAfter, status, sent_at AS sentAt, engagement_id AS engagementId
       FROM intake_email_queue WHERE lead_id = ? ORDER BY send_after, id`,
      id,
    );
    out.engagements = this.all(
      `SELECT e.id, e.filename, e.mime, length(e.data) AS size, e.status, e.signature_ref AS signatureRef, e.created_at AS createdAt,
         e.sent_at AS sentAt, e.document_id AS documentId, t.name AS templateName
       FROM intake_engagements e LEFT JOIN doc_templates t ON t.id = e.template_id WHERE e.lead_id = ? ORDER BY e.id DESC`,
      id,
    );
    out.consultations = this.all(
      `SELECT c.id, c.user_id AS userId, u.name AS userName, c.event_id AS eventId, c.start_at AS startAt, c.end_at AS endAt,
         c.booked_via AS bookedVia, c.status FROM intake_consultations c JOIN users u ON u.id = c.user_id WHERE c.lead_id = ? ORDER BY c.start_at DESC`,
      id,
    );
    out.publicToken = r.public_token;
    return out;
  }

  // ------------------------------------------------------------- conflicts

  /** Search the lead's name (as a prospective client) and each other party (as adverse), and save the check. */
  runConflictCheck(id: number, userId: number | null): Row {
    const l = this.leadRow(id);
    const opposing: string[] = JSON.parse(l.opposing || "[]");
    const terms = [
      { name: l.name, kind: l.kind, role: "prospective_client" as const },
      ...opposing.map((n) => ({ name: n, kind: looksLikeCompany(n) ? ("company" as const) : ("person" as const), role: "adverse_party" as const })),
    ];
    const { checkId, hits } = runCheck(this.db, { terms }, userId);
    const earlier = this.earlierInquiries(id, l.name, opposing);
    this.run("UPDATE intake_leads SET conflict_check_id = ?, earlier_hits = ? WHERE id = ?", checkId, JSON.stringify(earlier), id);
    const extra = earlier.length ? `; ${earlier.length} earlier inquir${earlier.length === 1 ? "y" : "ies"} with a similar name` : "";
    this.log(id, "conflict_check", `Conflict check #${checkId}: ${hits.length ? `${hits.length} possible match(es)` : "no matches"}${extra}`, userId);
    return getCheck(this.db, checkId);
  }

  /**
   * Other leads whose name or other parties resemble this lead's names. People who consulted
   * the firm but did not hire it are not in contacts, so the conflicts search can't see them.
   */
  earlierInquiries(id: number, name: string, opposing: string[]) {
    const mine = [{ name, as: "this lead" }, ...opposing.map((n) => ({ name: n, as: "other party" }))];
    const out: Row[] = [];
    for (const o of this.all("SELECT id, name, kind, opposing, status, received_on FROM intake_leads WHERE id <> ? ORDER BY id DESC LIMIT 5000", id)) {
      const theirs = [{ name: o.name, as: "the lead" }, ...JSON.parse(o.opposing || "[]").map((n: string) => ({ name: n, as: "an other party" }))];
      let best: Row | null = null;
      for (const a of mine) {
        for (const b of theirs) {
          const kind = looksLikeCompany(a.name) || looksLikeCompany(b.name) ? "company" : "person";
          const s = compareNames(a.name, b.name, kind);
          if (s.score >= BANDS.possible && (!best || s.score > best.score)) {
            best = { score: s.score, term: a.name, termAs: a.as, matched: b.name, matchedAs: b.as };
          }
        }
      }
      if (best) out.push({ leadId: o.id, leadName: o.name, status: o.status, statusLabel: statusLabel(o.status), receivedOn: o.received_on, ...best });
    }
    return out.sort((a, b) => b.score - a.score).slice(0, 20);
  }

  decideConflict(id: number, decision: string, note: unknown, userId: number | null): Row {
    return tx(this.db, () => {
      const l = this.leadRow(id);
      if (!l.conflict_check_id) bad("Run a conflict check first", 409);
      decideCheck(this.db, l.conflict_check_id, decision, note == null ? null : String(note), userId);
      const label = decision === "cleared" ? "cleared" : decision === "waived" ? "waived" : "declined (conflict)";
      this.log(id, "conflict_decision", `Conflict check #${l.conflict_check_id} ${label}${note ? `: ${String(note).trim()}` : ""}`, userId);
      return this.getLead(id);
    });
  }

  // ------------------------------------------------------------- follow-ups

  addReminder(id: number, input: { title?: string; dueDate?: string | null; assigneeId?: number | null; kind?: string; description?: string | null }, userId: number | null): number {
    const l = this.leadRow(id);
    const due = input.dueDate ?? null;
    if (due !== null && !isISODate(due)) bad("Reminder date must be a date like 2026-01-31");
    const assignee = this.checkUser(input.assigneeId) ?? l.owner_id ?? null;
    const title = cleanText(input.title, "Reminder", 300) ?? `Follow up with ${l.name}`;
    const taskId = this.engine.addTask(
      { title, dueDate: due, assigneeId: assignee, description: cleanText(input.description, "Details", 5000) ?? `Lead: ${l.name} (Intake › Leads)` },
      userId,
    );
    this.run("INSERT INTO intake_lead_tasks (lead_id, task_id, kind) VALUES (?,?,?)", id, taskId, input.kind ?? "follow_up");
    this.log(id, "reminder_added", `Reminder “${title}”${due ? `, due ${longDate(due)}` : ""}`, userId);
    return taskId;
  }

  queueEmail(
    id: number | null,
    input: { kind?: string; to?: string | null; toName?: string | null; subject?: unknown; body?: unknown; sendAfter?: string | null; engagementId?: number | null },
    userId: number | null,
  ): number {
    const l = id ? this.leadRow(id) : null;
    const to = cleanEmail(input.to ?? l?.email, "Email address");
    if (!to) bad("This lead has no email address to write to", 409);
    const subject = cleanText(input.subject, "Subject", MAX.subject, true)!;
    const body = cleanText(input.body, "Message", MAX.body, true)!;
    let after = this.nowIso();
    if (input.sendAfter) {
      const t = isISODate(input.sendAfter) ? Date.parse(input.sendAfter + "T15:00:00Z") : Date.parse(input.sendAfter);
      if (Number.isNaN(t)) bad("Send date must be a date like 2026-01-31");
      after = new Date(t).toISOString();
    }
    const eid = this.run(
      `INSERT INTO intake_email_queue (lead_id, kind, to_name, to_address, subject, body, engagement_id, send_after, created_at, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      id,
      input.kind ?? "follow_up",
      input.toName ?? l?.name ?? null,
      to,
      subject,
      body,
      input.engagementId ?? null,
      after,
      this.nowIso(),
      userId,
    );
    if (id) this.log(id, "email_queued", `Email “${subject}” to ${to}, to go out ${after <= this.nowIso() ? "now" : longDate(after.slice(0, 10))}`, userId);
    return eid;
  }

  cancelEmail(emailId: number, userId: number | null) {
    const e = this.one("SELECT * FROM intake_email_queue WHERE id = ?", emailId);
    if (!e) bad("Email not found", 404);
    if (e.status !== "queued") bad("Only an email that hasn't gone out can be cancelled", 409);
    this.run("UPDATE intake_email_queue SET status = 'cancelled' WHERE id = ?", emailId);
    if (e.lead_id) this.log(e.lead_id, "email_cancelled", `Cancelled email “${e.subject}”`, userId);
    return e.lead_id ? this.getLead(e.lead_id) : { ok: true };
  }

  /** When a lead is decided, open reminders are skipped and unsent emails cancelled. */
  private closeFollowUps(id: number, userId: number | null) {
    for (const t of this.all(
      "SELECT t.id FROM intake_lead_tasks lt JOIN tasks t ON t.id = lt.task_id WHERE lt.lead_id = ? AND t.status IN ('open','waiting')",
      id,
    )) {
      this.engine.skipTask(t.id, userId);
    }
    const n = Number(this.db.prepare("UPDATE intake_email_queue SET status = 'cancelled' WHERE lead_id = ? AND status = 'queued'").run(id).changes);
    if (n) this.log(id, "email_cancelled", `Cancelled ${n} unsent email${n === 1 ? "" : "s"}`, userId);
  }

  // ------------------------------------------------------- engagement letter

  /** Values an engagement-letter template can use for a lead (same names as for a matter). */
  mergeData(l: Row, userId: number | null, matterName?: string | null): MergeData {
    const u = userId ? this.one("SELECT * FROM users WHERE id = ?", userId) : undefined;
    const owner = l.owner_id ? this.one("SELECT * FROM users WHERE id = ?", l.owner_id) : undefined;
    const area = l.practice_area_id ? this.one("SELECT name FROM practice_areas WHERE id = ?", l.practice_area_id)?.name : null;
    const today = this.today();
    return {
      today: longDate(today),
      today_iso: today,
      firm: { name: this.firmName() },
      user: { name: u?.name ?? null, email: u?.email ?? null },
      client: { name: l.name, email: l.email, phone: l.phone, kind: l.kind },
      lead: { name: l.name, email: l.email, phone: l.phone, source: l.source, summary: l.summary, other_parties: JSON.parse(l.opposing || "[]").join(", ") },
      matter: { name: matterName ?? (area ? `${l.name} – ${area}` : l.name), practice_area: area ?? null, description: l.summary, roles: { attorney: owner?.name ?? null } },
    };
  }

  /** Fill a document template for the lead and keep the result on the lead (status draft). */
  createEngagement(id: number, templateId: number, userId: number | null) {
    if (!this.documents) bad("Documents are not available", 500);
    const l = this.leadRow(id);
    if (l.status === "hired" || l.status === "not_hired") bad("This lead is already decided", 409);
    const t = this.documents.getTemplate(templateId) as Row;
    const { data: src, filename: tname } = this.documents.downloadTemplate(templateId);
    const merge = this.mergeData(l, userId);
    let out: Buffer;
    let unknown: string[];
    let empty: string[];
    const ext = extensionOf(tname);
    if (t.kind === "docx") ({ output: out, unknown, empty } = fillDocx(src, merge));
    else {
      const r = fillText(src.toString("utf8"), merge, { html: t.kind === "html" });
      out = Buffer.from(r.output, "utf8");
      ({ unknown, empty } = r);
    }
    const filename = `${String(t.name).replace(/[\\/:*?"<>|]+/g, " ").trim()} - ${l.name.replace(/[\\/:*?"<>|]+/g, " ").trim()}`.slice(0, 180) + (ext ? "." + ext : "");
    const eid = this.run(
      "INSERT INTO intake_engagements (lead_id, template_id, filename, mime, data, created_at, created_by) VALUES (?,?,?,?,?,?,?)",
      id,
      templateId,
      filename,
      detectMime(out, filename),
      out,
      this.nowIso(),
      userId,
    );
    this.log(id, "engagement_created", `Prepared engagement letter “${filename}” from template “${t.name}”`, userId);
    return { engagementId: eid, unknown, empty, lead: this.getLead(id) };
  }

  engagementFile(engagementId: number) {
    const e = this.one("SELECT * FROM intake_engagements WHERE id = ?", engagementId);
    if (!e) bad("Engagement letter not found", 404);
    return { filename: e.filename as string, mime: e.mime as string, data: Buffer.from(e.data as Uint8Array) };
  }

  /**
   * Send the letter. When the e-signature module has registered intakeHooks.sendForSignature,
   * the letter goes to it; otherwise it is marked sent (the lawyer sends it themselves) and an
   * email with the letter attached is queued for the email module. Either way the lead moves
   * to "Engagement sent" and a follow-up reminder and email are scheduled.
   */
  async sendEngagement(engagementId: number, opts: { message?: string | null; queueEmail?: boolean }, userId: number | null) {
    const e = this.one("SELECT * FROM intake_engagements WHERE id = ?", engagementId);
    if (!e) bad("Engagement letter not found", 404);
    const l = this.leadRow(e.lead_id);
    if (l.status === "hired" || l.status === "not_hired") bad("This lead is already decided", 409);
    let ref: string | null = null;
    if (intakeHooks.sendForSignature) {
      const r = await intakeHooks.sendForSignature({
        db: this.db, engagementId, leadId: l.id, name: l.name, email: l.email, filename: e.filename, mime: e.mime, data: Buffer.from(e.data as Uint8Array), userId,
      });
      ref = r?.ref ?? null;
    }
    return tx(this.db, () => {
      const s = this.settings();
      this.run("UPDATE intake_engagements SET status = 'sent', sent_at = ?, signature_ref = ? WHERE id = ?", this.nowIso(), ref, engagementId);
      this.log(l.id, "engagement_sent", `Engagement letter “${e.filename}” sent${ref ? " for e-signature" : ""}`, userId);
      const firm = this.firmName();
      if (!ref && opts.queueEmail !== false && l.email) {
        this.queueEmail(
          l.id,
          {
            kind: "engagement_letter",
            engagementId,
            subject: `Engagement letter from ${firm}`,
            body:
              (cleanText(opts.message, "Message", MAX.body) ??
                `Dear ${l.name},\n\nThank you for speaking with us. Our engagement letter is attached. Please read it, and sign and return it if you would like us to go ahead. Call us with any questions.\n\n${firm}`),
          },
          userId,
        );
      }
      const followDay = addBusinessDays(this.today(), s.engagement_followup_days, this.holidays());
      this.addReminder(l.id, { title: `Check on engagement letter: ${l.name}`, dueDate: followDay, kind: "engagement_follow_up" }, userId);
      if (l.email) {
        this.queueEmail(
          l.id,
          {
            kind: "engagement_follow_up",
            sendAfter: followDay,
            subject: `Following up: engagement letter from ${firm}`,
            body: `Dear ${l.name},\n\nWe wanted to check whether you received our engagement letter and whether you have any questions about it. We are glad to talk it through.\n\n${firm}`,
          },
          userId,
        );
      }
      if (l.status !== "engagement_sent") this.setStatus(l.id, "engagement_sent", {}, userId);
      return this.getLead(l.id);
    });
  }

  // --------------------------------------------------------------- convert

  /**
   * Make the lead a client: creates (or reuses) the contact, opens the matter in the chosen
   * practice area (which fires that area's first-stage automations), links the intake conflict
   * check to the matter, records the parties, files any engagement letters and copies the lead's
   * history into the matter's activity log. Needs the conflict check cleared or waived first.
   */
  convert(id: number, input: ConvertInput, userId: number | null) {
    return tx(this.db, () => {
      const l = this.leadRow(id);
      if (l.status === "hired") bad("This lead has already been converted", 409);
      if (!l.conflict_check_id) bad("Run a conflict check before opening a matter", 409);
      const k = getCheck(this.db, l.conflict_check_id);
      if (k.decision !== "cleared" && k.decision !== "waived") {
        bad(k.decision === "declined" ? "The conflict check was declined, so this lead can't become a client" : "Clear (or waive) the conflict check before opening a matter", 409);
      }
      let contactId: number;
      if (input.contactId) {
        const c = this.one("SELECT id FROM contacts WHERE id = ?", Number(input.contactId));
        if (!c) bad("Contact not found", 404);
        contactId = c.id;
      } else {
        const name = cleanText(input.clientName, "Client name", MAX.name) ?? l.name;
        contactId = this.engine.addContact(name, input.clientKind === "company" || input.clientKind === "person" ? input.clientKind : l.kind, l.email, l.phone);
      }
      const area = this.checkArea(input.practiceAreaId ?? l.practice_area_id);
      const areaName = area ? this.one("SELECT name FROM practice_areas WHERE id = ?", area)!.name : null;
      const roles: Record<string, number> = {};
      for (const [r, u] of Object.entries(input.roles ?? {})) {
        const uid = this.checkUser(u);
        if (uid) roles[String(r)] = uid;
      }
      if (!roles.attorney && l.owner_id) roles.attorney = l.owner_id;
      const matterName = cleanText(input.matterName, "Matter name", 300) ?? (areaName ? `${l.name} – ${areaName}` : l.name);
      const matterId = this.engine.createMatter(
        { name: matterName, number: cleanText(input.matterNumber, "Matter number", 60), clientId: contactId, practiceAreaId: area, description: l.summary, roles },
        userId,
      );
      this.engine.log("lead_converted", `Opened from intake lead “${l.name}” (received ${l.received_on}${l.source ? `, ${l.source}` : ""})`, { userId, matterId });
      // Conflict check and parties.
      if (k.matterId == null) linkCheck(this.db, l.conflict_check_id, matterId, userId);
      addParty(this.db, matterId, { contactId, role: "client" }, userId);
      for (const n of JSON.parse(l.opposing || "[]") as string[]) {
        const existing = this.one("SELECT id FROM contacts WHERE lower(name) = lower(?)", n);
        const cid = existing?.id ?? this.engine.addContact(n, looksLikeCompany(n) ? "company" : "person");
        if (!this.one("SELECT 1 FROM conflicts_matter_parties WHERE matter_id = ? AND contact_id = ? AND role = 'adverse_party'", matterId, cid)) {
          addParty(this.db, matterId, { contactId: cid, role: "adverse_party", note: "From intake" }, userId);
        }
      }
      // Engagement letters into the matter's documents.
      if (this.documents) {
        for (const e of this.all("SELECT * FROM intake_engagements WHERE lead_id = ? AND document_id IS NULL ORDER BY id", id)) {
          const doc = this.documents.upload({
            matterId, filename: e.filename, data: Buffer.from(e.data as Uint8Array), folder: "Intake", category: "Engagement", onConflict: "rename", userId,
            templateId: e.template_id, note: "Engagement letter prepared at intake",
          }) as Row;
          this.run("UPDATE intake_engagements SET document_id = ? WHERE id = ?", doc.id, e.id);
        }
      }
      // Consultation events now belong to the matter.
      this.run(
        "UPDATE cal_events SET matter_id = ? WHERE id IN (SELECT event_id FROM intake_consultations WHERE lead_id = ? AND event_id IS NOT NULL) AND matter_id IS NULL",
        matterId,
        id,
      );
      // History: keep the lead's own log and copy it into the matter's, oldest first, with original times.
      const ins = this.db.prepare("INSERT INTO activity (at, user_id, matter_id, task_id, kind, detail) VALUES (?,?,?,?,?,?)");
      for (const a of this.all("SELECT * FROM intake_activity WHERE lead_id = ? ORDER BY id", id)) {
        ins.run(a.at, a.user_id, matterId, null, "lead_history", `Intake: ${a.detail}`);
      }
      for (const n of this.all("SELECT * FROM intake_notes WHERE lead_id = ? ORDER BY id", id)) {
        ins.run(n.at, n.user_id, matterId, null, "lead_note", `Intake note: ${n.body}`);
      }
      this.closeFollowUps(id, userId);
      const now = this.nowIso();
      this.run(
        "UPDATE intake_leads SET status = 'hired', hired_on = ?, closed_on = ?, status_changed_at = ?, contact_id = ?, matter_id = ?, not_hired_reason = NULL WHERE id = ?",
        this.today(),
        this.today(),
        now,
        contactId,
        matterId,
        id,
      );
      this.log(id, "converted", `${statusLabel(l.status)} → Hired. Client and matter “${matterName}” opened`, userId);
      return { matterId, contactId, lead: this.getLead(id) };
    });
  }

  deleteLead(id: number, userId: number | null) {
    const l = this.leadRow(id);
    if (l.status === "hired") bad("A lead that became a client can't be deleted; its history is part of the matter", 409);
    tx(this.db, () => {
      for (const t of this.all("SELECT task_id FROM intake_lead_tasks WHERE lead_id = ?", id)) this.engine.deleteTask(t.task_id, userId);
      this.run("DELETE FROM intake_leads WHERE id = ?", id);
      this.engine.log("lead_deleted", `Deleted intake lead “${l.name}” (received ${l.received_on})`, { userId });
    });
  }
}

// ------------------------------------------------------------ email hooks

/** Queued emails whose send time has passed. For the email module's sender. */
export function dueEmails(db: DB, nowIso = new Date().toISOString(), limit = 50): Row[] {
  return db
    .prepare("SELECT * FROM intake_email_queue WHERE status = 'queued' AND send_after <= ? ORDER BY send_after, id LIMIT ?")
    .all(nowIso, limit) as Row[];
}

/** The email module calls this after a send attempt. */
export function markEmailSent(db: DB, id: number, result: { ok: boolean; error?: string | null } = { ok: true }) {
  db.prepare("UPDATE intake_email_queue SET status = ?, sent_at = ?, error = ? WHERE id = ? AND status = 'queued'").run(
    result.ok ? "sent" : "failed",
    new Date().toISOString(),
    result.ok ? null : result.error ?? "Failed",
    id,
  );
}

export { NOT_HIRED_REASONS, statusLabel };
export type { Status };
export const addDaysIso = addDays;
