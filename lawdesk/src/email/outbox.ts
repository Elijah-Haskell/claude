// The outbox: every message is queued here first and sent by the background job, so a
// mail server that is down for an hour delays mail instead of losing it.
//
// A failed attempt is retried after 1, 5, 15, 60 and 240 minutes; after the sixth try (or a
// permanent refusal such as "no such user" or a wrong password) the message is marked failed
// and the error is shown in Settings > Email.

import type { DB } from "../db.ts";
import { EngineError } from "../engine.ts";
import { type Address, type Attachment, buildMessage } from "./mime.ts";
import { loadConfig, transportFor } from "./settings.ts";
import type { Transport } from "./transport.ts";
import { SmtpError } from "./smtp.ts";

export const RETRY_MINUTES = [1, 5, 15, 60, 240];
export const MAX_ATTEMPTS = RETRY_MINUTES.length + 1;
/** A message stuck in "sending" this long (the server stopped mid-send) is tried again. */
const STALE_SENDING_MS = 10 * 60_000;

export interface QueueInput {
  kind: string;
  to: Address[];
  cc?: Address[];
  bcc?: Address[];
  replyTo?: Address | null;
  subject: string;
  text: string;
  html?: string | null;
  attachments?: Attachment[];
  matterId?: number | null;
  userId?: number | null;
  sensitive?: boolean;
  inReplyTo?: string | null;
}

type Env = Record<string, string | undefined>;

const iso = (d: Date) => d.toISOString();

/** Build the message with the firm's From address and put it in the queue. */
export function queueEmail(db: DB, input: QueueInput, opts: { now?: Date; env?: Env } = {}) {
  const now = opts.now ?? new Date();
  const cfg = loadConfig(db, opts.env);
  if (!cfg.fromAddress) throw new EngineError("Set the From address in Settings > Email before sending");
  const subject = String(input.subject ?? "").trim();
  if (!subject) throw new EngineError("Add a subject");
  if (subject.length > 900) throw new EngineError("The subject is too long");
  const built = buildMessage({
    from: { name: cfg.fromName, address: cfg.fromAddress },
    to: input.to,
    cc: input.cc,
    bcc: input.bcc,
    replyTo: input.replyTo,
    subject,
    text: input.text,
    html: input.html,
    attachments: input.attachments,
    inReplyTo: input.inReplyTo,
    date: now,
  });
  const id = Number(
    db
      .prepare(
        `INSERT INTO email_outbox (kind, status, message_id, from_addr, recipients, subject, raw, sensitive, matter_id, user_id, next_attempt_at, created_at)
         VALUES (?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.kind,
        built.messageId,
        built.envelope.from,
        JSON.stringify(built.envelope.to),
        subject,
        built.raw,
        input.sensitive ? 1 : 0,
        input.matterId ?? null,
        input.userId ?? null,
        iso(now),
        iso(now),
      ).lastInsertRowid,
  );
  return { id, messageId: built.messageId, size: built.raw.length };
}

/** When to try again after `attempts` failures, or null to give up. */
export function nextAttemptAt(attempts: number, now: Date): string | null {
  if (attempts >= MAX_ATTEMPTS) return null;
  return iso(new Date(now.getTime() + RETRY_MINUTES[Math.min(attempts, RETRY_MINUTES.length) - 1] * 60_000));
}

export interface DeliverySummary {
  sent: number;
  retrying: number;
  failed: number;
}

/** Send everything that is due. Never throws for a single bad message. */
export async function deliverDue(db: DB, opts: { now?: Date; transport?: Transport; env?: Env; limit?: number } = {}): Promise<DeliverySummary> {
  const now = opts.now ?? new Date();
  const summary: DeliverySummary = { sent: 0, retrying: 0, failed: 0 };
  db.prepare("UPDATE email_outbox SET status = 'queued' WHERE status = 'sending' AND next_attempt_at < ?").run(iso(new Date(now.getTime() - STALE_SENDING_MS)));
  const due = db
    .prepare("SELECT id FROM email_outbox WHERE status = 'queued' AND next_attempt_at <= ? ORDER BY next_attempt_at, id LIMIT ?")
    .all(iso(now), opts.limit ?? 50) as { id: number }[];
  if (!due.length) return summary;

  let transport: Transport;
  try {
    transport = opts.transport ?? transportFor(loadConfig(db, opts.env));
  } catch (e: any) {
    // Not set up yet: leave everything queued and say why on each message.
    db.prepare("UPDATE email_outbox SET last_error = ? WHERE status = 'queued' AND next_attempt_at <= ?").run(String(e.message).slice(0, 500), iso(now));
    return summary;
  }

  for (const { id } of due) {
    // Claim the row so a second worker (or an overlapping tick) leaves it alone.
    const claimed = db.prepare("UPDATE email_outbox SET status = 'sending', attempts = attempts + 1, next_attempt_at = ? WHERE id = ? AND status = 'queued'").run(iso(now), id);
    if (!claimed.changes) continue;
    const row = db.prepare("SELECT * FROM email_outbox WHERE id = ?").get(id) as any;
    try {
      const r = await transport.send({ from: row.from_addr, to: JSON.parse(row.recipients) }, Buffer.from(row.raw));
      const note = r.rejected?.length ? `Not delivered to: ${r.rejected.map((x) => `${x.address} (${x.reply})`).join("; ")}` : null;
      db.prepare(
        `UPDATE email_outbox SET status = 'sent', sent_at = ?, response = ?, last_error = ?, raw = CASE WHEN sensitive = 1 THEN NULL ELSE raw END WHERE id = ?`,
      ).run(iso(new Date()), String(r.response).slice(0, 500), note, id);
      summary.sent++;
    } catch (e: any) {
      const permanent = e instanceof SmtpError ? e.permanent : false;
      const next = permanent ? null : nextAttemptAt(row.attempts, now);
      const msg = String(e?.message ?? e).slice(0, 500);
      if (next) {
        db.prepare("UPDATE email_outbox SET status = 'queued', next_attempt_at = ?, last_error = ? WHERE id = ?").run(next, msg, id);
        summary.retrying++;
      } else {
        db.prepare("UPDATE email_outbox SET status = 'failed', last_error = ? WHERE id = ?").run(msg, id);
        summary.failed++;
      }
    }
  }
  return summary;
}

/** The outbox for the settings screen (no message bodies; sensitive subjects hidden). */
export function listOutbox(db: DB, opts: { status?: string | null; limit?: number } = {}) {
  const where = opts.status ? "WHERE o.status = ?" : "";
  const params: any[] = opts.status ? [opts.status] : [];
  const rows = db
    .prepare(
      `SELECT o.id, o.kind, o.status, o.recipients, o.subject, o.sensitive, o.matter_id, o.attempts, o.next_attempt_at, o.last_error,
              o.response, o.created_at, o.sent_at, m.number AS matter_number, m.name AS matter_name
       FROM email_outbox o LEFT JOIN matters m ON m.id = o.matter_id ${where} ORDER BY o.id DESC LIMIT ?`,
    )
    .all(...params, Math.min(Math.max(opts.limit ?? 50, 1), 500)) as any[];
  return rows.map((r) => ({
    ...r,
    recipients: JSON.parse(r.recipients),
    subject: r.sensitive ? "(password reset)" : r.subject,
    sensitive: !!r.sensitive,
  }));
}

export function retryOutbox(db: DB, id: number, now = new Date()) {
  const r = db.prepare("SELECT status, raw FROM email_outbox WHERE id = ?").get(id) as any;
  if (!r) throw new EngineError("Message not found", 404);
  if (r.status !== "failed" && r.status !== "cancelled" && r.status !== "queued") throw new EngineError("Only a failed, cancelled or waiting message can be sent again");
  if (!r.raw) throw new EngineError("This message can no longer be sent");
  db.prepare("UPDATE email_outbox SET status = 'queued', attempts = 0, next_attempt_at = ? WHERE id = ?").run(iso(now), id);
}

export function cancelOutbox(db: DB, id: number) {
  const r = db.prepare("SELECT status FROM email_outbox WHERE id = ?").get(id) as any;
  if (!r) throw new EngineError("Message not found", 404);
  if (r.status !== "queued" && r.status !== "failed") throw new EngineError("Only a waiting or failed message can be cancelled");
  db.prepare("UPDATE email_outbox SET status = 'cancelled' WHERE id = ?").run(id);
}
