// The background email job. The server starts it once a minute; tests call runEmailJobs
// directly with a fixed clock and a transport of their own.
//
//   LAWDESK_EMAIL_WORKER=0   turn the background job off (mail then stays queued)

import type { DB } from "../db.ts";
import { notifyAssignments, sendDigests, sendReminders } from "./notify.ts";
import { deliverDue, type DeliverySummary } from "./outbox.ts";
import type { Transport } from "./transport.ts";

type Env = Record<string, string | undefined>;

export interface JobSummary extends DeliverySummary {
  assignments: number;
  digests: number;
  reminders: number;
  errors: string[];
}

/** One pass: queue any notices that are due, then send what is in the outbox. */
export async function runEmailJobs(db: DB, opts: { now?: Date; transport?: Transport; env?: Env } = {}): Promise<JobSummary> {
  const errors: string[] = [];
  const step = (name: string, fn: () => number) => {
    try {
      return fn();
    } catch (e: any) {
      errors.push(`${name}: ${e?.message ?? e}`);
      return 0;
    }
  };
  const assignments = step("task emails", () => notifyAssignments(db, opts));
  const digests = step("daily summaries", () => sendDigests(db, opts));
  const reminders = step("calendar reminders", () => sendReminders(db, opts));
  let delivery: DeliverySummary = { sent: 0, retrying: 0, failed: 0 };
  try {
    delivery = await deliverDue(db, opts);
  } catch (e: any) {
    errors.push(`sending: ${e?.message ?? e}`);
  }
  return { assignments, digests, reminders, ...delivery, errors };
}

export interface EmailWorker {
  stop(): void;
  /** Run a pass now (skipped if one is already running). */
  runNow(): Promise<JobSummary | null>;
}

export function startEmailWorker(
  db: DB,
  opts: { intervalMs?: number; log?: (...a: unknown[]) => void; transport?: Transport; env?: Env } = {},
): EmailWorker {
  const log = opts.log ?? ((...a: unknown[]) => console.error(...a));
  let running = false;
  const runNow = async () => {
    if (running) return null;
    running = true;
    try {
      const r = await runEmailJobs(db, { transport: opts.transport, env: opts.env });
      for (const e of r.errors) log(`[lawdesk email] ${e}`);
      return r;
    } catch (e) {
      log("[lawdesk email] job failed:", e);
      return null;
    } finally {
      running = false;
    }
  };
  const timer = setInterval(runNow, opts.intervalMs ?? 60_000);
  timer.unref();
  return { stop: () => clearInterval(timer), runNow };
}
