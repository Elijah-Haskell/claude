// Notices sent by email: a task assigned to you, the morning list of what is due, calendar
// reminders, and password-reset links. Each one is queued in the outbox; nothing here talks
// to a mail server directly.
//
// All times of day are the firm's (America/Chicago).

import type { DB } from "../db.ts";
import { Engine, EngineError } from "../engine.ts";
import { today as todayIn } from "../dates.ts";
import { Calendar } from "../calendar/calendar.ts";
import { FIRM_TZ, utcToLocal } from "../calendar/tz.ts";
import { textToHtml, isValidAddress } from "./mime.ts";
import { queueEmail } from "./outbox.ts";
import { loadConfig } from "./settings.ts";

type Env = Record<string, string | undefined>;
export interface NotifyOpts {
  now?: Date;
  env?: Env;
}

export interface Prefs {
  taskAssigned: boolean;
  digest: boolean;
  digestTime: string;
  digestWeekends: boolean;
  reminders: boolean;
}

const DEFAULT_PREFS: Prefs = { taskAssigned: true, digest: true, digestTime: "07:30", digestWeekends: false, reminders: true };

export function getPrefs(db: DB, userId: number): Prefs & { userId: number; email: string | null; lastDigestOn: string | null } {
  const u = db.prepare("SELECT id, email FROM users WHERE id = ?").get(userId) as any;
  if (!u) throw new EngineError("Person not found", 404);
  const p = db.prepare("SELECT * FROM email_prefs WHERE user_id = ?").get(userId) as any;
  return {
    userId,
    email: u.email ?? null,
    taskAssigned: p ? !!p.task_assigned : DEFAULT_PREFS.taskAssigned,
    digest: p ? !!p.digest : DEFAULT_PREFS.digest,
    digestTime: p?.digest_time ?? DEFAULT_PREFS.digestTime,
    digestWeekends: p ? !!p.digest_weekends : DEFAULT_PREFS.digestWeekends,
    reminders: p ? !!p.reminders : DEFAULT_PREFS.reminders,
    lastDigestOn: p?.last_digest_on ?? null,
  };
}

export function setPrefs(db: DB, userId: number, patch: Partial<Prefs>) {
  const cur = getPrefs(db, userId);
  const bool = (v: unknown, what: string, fallback: boolean) => {
    if (v === undefined) return fallback;
    if (typeof v !== "boolean") throw new EngineError(`${what} must be true or false`);
    return v;
  };
  let time = cur.digestTime;
  if (patch.digestTime !== undefined) {
    if (typeof patch.digestTime !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(patch.digestTime)) throw new EngineError("Time must look like 07:30");
    time = patch.digestTime;
  }
  const next = {
    taskAssigned: bool(patch.taskAssigned, "Task emails", cur.taskAssigned),
    digest: bool(patch.digest, "Daily summary", cur.digest),
    digestWeekends: bool(patch.digestWeekends, "Weekend summaries", cur.digestWeekends),
    reminders: bool(patch.reminders, "Calendar reminders", cur.reminders),
  };
  db.prepare(
    `INSERT INTO email_prefs (user_id, task_assigned, digest, digest_time, digest_weekends, reminders) VALUES (?,?,?,?,?,?)
     ON CONFLICT(user_id) DO UPDATE SET task_assigned = excluded.task_assigned, digest = excluded.digest, digest_time = excluded.digest_time,
       digest_weekends = excluded.digest_weekends, reminders = excluded.reminders`,
  ).run(userId, +next.taskAssigned, +next.digest, time, +next.digestWeekends, +next.reminders);
  return getPrefs(db, userId);
}

function getState(db: DB, key: string): string | null {
  return ((db.prepare("SELECT value FROM email_state WHERE key = ?").get(key) as any)?.value as string) ?? null;
}
function setState(db: DB, key: string, value: string) {
  db.prepare("INSERT INTO email_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

// ------------------------------------------------------------------ wording helpers

const LONG = new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
const TIME = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: FIRM_TZ });
const LONG_LOCAL = new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: FIRM_TZ });

export function longDay(iso: string): string {
  return LONG.format(new Date(iso + "T12:00:00Z"));
}

function matterLabel(r: { matter_number?: string | null; matter_name?: string | null }): string {
  return [r.matter_number, r.matter_name].filter(Boolean).join(" ");
}

function footer(appUrl: string): string {
  return `\n\n—\nSent by Lawdesk. You can choose which emails you receive under Settings > Email (${appUrl}/#/settings).`;
}

function firstName(name: string): string {
  return String(name || "").split(/\s+/)[0] || "there";
}

function recipient(u: { name: string; email: string }) {
  return [{ name: u.name, address: u.email }];
}

function activeUsersWithEmail(db: DB): { id: number; name: string; email: string }[] {
  return (db.prepare("SELECT id, name, email FROM users WHERE active = 1 AND email IS NOT NULL AND email <> ''").all() as any[]).filter((u) => isValidAddress(u.email));
}

// ------------------------------------------------------------------ task assigned

/**
 * Tell people about tasks newly assigned to them. The first run only records what is already
 * assigned (so turning email on does not send a flood). Several new tasks for one person in
 * the same run go out as one email. Assigning a task to yourself sends nothing.
 */
export function notifyAssignments(db: DB, opts: NotifyOpts = {}): number {
  // Forget pairs that no longer hold, so a task moved away and back is announced again.
  db.prepare("DELETE FROM email_assign_seen WHERE NOT EXISTS (SELECT 1 FROM tasks t WHERE t.id = task_id AND t.assignee_id = user_id)").run();
  const fresh = db
    .prepare(
      `SELECT t.id, t.title, t.due_date, t.priority, t.status, t.assignee_id, t.matter_id, m.number AS matter_number, m.name AS matter_name
       FROM tasks t LEFT JOIN matters m ON m.id = t.matter_id
       WHERE t.assignee_id IS NOT NULL AND t.status IN ('open','waiting')
         AND NOT EXISTS (SELECT 1 FROM email_assign_seen s WHERE s.task_id = t.id AND s.user_id = t.assignee_id)
       ORDER BY t.id`,
    )
    .all() as any[];
  const mark = db.prepare("INSERT OR IGNORE INTO email_assign_seen (task_id, user_id) VALUES (?, ?)");
  if (!getState(db, "assign_baseline")) {
    for (const t of fresh) mark.run(t.id, t.assignee_id);
    setState(db, "assign_baseline", (opts.now ?? new Date()).toISOString());
    return 0;
  }
  if (!fresh.length) return 0;
  const cfg = loadConfig(db, opts.env);
  const people = new Map(activeUsersWithEmail(db).map((u) => [u.id, u]));
  const byUser = new Map<number, { task: any; by: string | null }[]>();
  const lastActor = db.prepare(
    "SELECT a.user_id, u.name FROM activity a LEFT JOIN users u ON u.id = a.user_id WHERE a.task_id = ? ORDER BY a.id DESC LIMIT 1",
  );
  for (const t of fresh) {
    mark.run(t.id, t.assignee_id);
    const actor = lastActor.get(t.id) as any;
    if (actor?.user_id === t.assignee_id) continue; // they did it themselves
    const u = people.get(t.assignee_id);
    if (!u || !getPrefs(db, u.id).taskAssigned) continue;
    byUser.set(u.id, [...(byUser.get(u.id) ?? []), { task: t, by: actor?.name ?? null }]);
  }
  let queued = 0;
  for (const [uid, items] of byUser) {
    const u = people.get(uid)!;
    const line = ({ task: t }: { task: any }) =>
      [
        `• ${t.title}`,
        matterLabel(t) ? `  Matter: ${matterLabel(t)}` : null,
        t.due_date ? `  Due: ${longDay(t.due_date)}` : "  No due date",
        t.priority === "high" ? "  Priority: high" : null,
        t.status === "waiting" ? "  Waiting on another task before it can start" : null,
      ]
        .filter(Boolean)
        .join("\n");
    const bys = [...new Set(items.map((i) => i.by).filter(Boolean))];
    const who = bys.length === 1 ? `${bys[0]} assigned you` : "You have been assigned";
    const single = items.length === 1 ? items[0].task : null;
    const subject = single ? `New task: ${single.title}${matterLabel(single) ? ` (${matterLabel(single)})` : ""}` : `${items.length} new tasks for you`;
    const link = single?.matter_id ? `${cfg.appUrl}/#/matters/${single.matter_id}` : `${cfg.appUrl}/#/my`;
    const text =
      `Dear ${firstName(u.name)},\n\n${who} ${single ? "a task" : `${items.length} tasks`} in Lawdesk.\n\n` +
      items.map(line).join("\n\n") +
      `\n\nOpen in Lawdesk: ${link}` +
      footer(cfg.appUrl);
    queueEmail(db, { kind: "task_assigned", to: recipient(u), subject, text, html: textToHtml(text), matterId: single?.matter_id ?? null }, opts);
    queued++;
  }
  return queued;
}

// ------------------------------------------------------------------ daily summary

/**
 * Each person's summary of overdue tasks and tasks due today, once a day at the time they
 * chose. Skipped on weekends unless they asked for it, and when there is nothing to report.
 */
export function sendDigests(db: DB, opts: NotifyOpts = {}): number {
  const now = opts.now ?? new Date();
  const local = utcToLocal(now.getTime(), FIRM_TZ);
  const day = local.date;
  const hhmm = local.time.slice(0, 5);
  const weekend = [0, 6].includes(new Date(day + "T12:00:00Z").getUTCDay());
  const engine = new Engine(db, { today: () => todayIn(FIRM_TZ, now) });
  const cfg = loadConfig(db, opts.env);
  let queued = 0;
  for (const u of activeUsersWithEmail(db)) {
    const p = getPrefs(db, u.id);
    if (!p.digest || p.lastDigestOn === day || hhmm < p.digestTime || (weekend && !p.digestWeekends)) continue;
    db.prepare(
      `INSERT INTO email_prefs (user_id, last_digest_on) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET last_digest_on = excluded.last_digest_on`,
    ).run(u.id, day);
    const mine = engine.myTasks(u.id, 7);
    if (!mine.overdue.length && !mine.dueToday.length) continue;
    const row = (t: any) => `• ${t.title}${matterLabel(t) ? ` (${matterLabel(t)})` : ""}${t.due_date && t.due_date < day ? `, due ${longDay(t.due_date)}` : ""}`;
    const sections: string[] = [];
    if (mine.overdue.length) sections.push(`Overdue (${mine.overdue.length})\n` + mine.overdue.map(row).join("\n"));
    if (mine.dueToday.length) sections.push(`Due today (${mine.dueToday.length})\n` + mine.dueToday.map(row).join("\n"));
    if (mine.upcoming.length) sections.push(`Coming up in the next week: ${mine.upcoming.length} task${mine.upcoming.length === 1 ? "" : "s"}.`);
    const counts = [mine.overdue.length ? `${mine.overdue.length} overdue` : null, mine.dueToday.length ? `${mine.dueToday.length} due today` : null].filter(Boolean).join(", ");
    const text =
      `Dear ${firstName(u.name)},\n\nHere are your tasks for ${longDay(day)}.\n\n` + sections.join("\n\n") + `\n\nSee all your tasks: ${cfg.appUrl}/#/my` + footer(cfg.appUrl);
    queueEmail(db, { kind: "digest", to: recipient(u), subject: `Your tasks for ${longDay(day)}: ${counts}`, text, html: textToHtml(text) }, opts);
    queued++;
  }
  return queued;
}

// ------------------------------------------------------------------ calendar reminders

/**
 * Email each attendee the reminders that came due since the last check (at most a day back,
 * so a server that was off for a week does not send a week of stale reminders). Each
 * (event, occurrence, reminder, person) is recorded, so no reminder is ever sent twice.
 */
export function sendReminders(db: DB, opts: NotifyOpts = {}): number {
  const now = opts.now ?? new Date();
  const nowMs = now.getTime();
  const last = Date.parse(getState(db, "reminders_checked_to") ?? "");
  const from = Number.isNaN(last) ? nowMs - 5 * 60_000 : Math.max(last, nowMs - 24 * 3600_000);
  if (from >= nowMs) return 0;
  const cal = new Calendar(db, { now: () => now });
  const due = cal.remindersDue(new Date(from), now);
  setState(db, "reminders_checked_to", now.toISOString());
  if (!due.length) return 0;
  const cfg = loadConfig(db, opts.env);
  const people = new Map(activeUsersWithEmail(db).map((u) => [u.id, u]));
  const record = db.prepare(
    "INSERT OR IGNORE INTO email_reminders_sent (event_id, occurrence, minutes_before, user_id, sent_at) VALUES (?,?,?,?,?)",
  );
  const link = db.prepare("UPDATE email_reminders_sent SET outbox_id = ? WHERE event_id = ? AND occurrence = ? AND minutes_before = ? AND user_id = ?");
  let queued = 0;
  for (const r of due) {
    const m = r.matterId ? (db.prepare("SELECT number AS matter_number, name AS matter_name FROM matters WHERE id = ?").get(r.matterId) as any) : null;
    const when = r.allDay ? longDay(r.start.slice(0, 10)) : `${LONG_LOCAL.format(new Date(r.start))} at ${TIME.format(new Date(r.start))}`;
    for (const uid of r.userIds) {
      const u = people.get(uid);
      if (!u || !getPrefs(db, uid).reminders) continue;
      if (!record.run(r.eventId, r.occurrence, r.minutesBefore, uid, now.toISOString()).changes) continue;
      const text =
        `Dear ${firstName(u.name)},\n\nThis is a reminder of:\n\n${r.title}\n${when}` +
        (m ? `\nMatter: ${matterLabel(m)}` : "") +
        `\n\nOpen the calendar in Lawdesk: ${cfg.appUrl}/#/calendar` +
        footer(cfg.appUrl);
      const q = queueEmail(db, { kind: "reminder", to: recipient(u), subject: `Reminder: ${r.title}, ${when}`, text, html: textToHtml(text), matterId: r.matterId }, opts);
      link.run(q.id, r.eventId, r.occurrence, r.minutesBefore, uid);
      queued++;
    }
  }
  return queued;
}

// ------------------------------------------------------------------ password reset

/**
 * Queue a password-reset email. For the sign-in module to call; it decides whether the
 * address belongs to anyone (and should not tell the person asking either way).
 * The message is marked sensitive: its subject is hidden in the outbox list and its
 * contents are deleted once it has been sent.
 */
export function sendPasswordReset(db: DB, email: string, link: string, opts: NotifyOpts & { expiresInMinutes?: number } = {}) {
  if (!isValidAddress(email)) throw new EngineError("Not a valid email address");
  if (typeof link !== "string" || !/^https?:\/\/[^\s]+$/.test(link)) throw new EngineError("The reset link must be an http(s) address");
  const u = db.prepare("SELECT name FROM users WHERE lower(email) = lower(?)").get(email) as any;
  const mins = opts.expiresInMinutes ?? 60;
  const text =
    `Dear ${u ? firstName(u.name) : "Lawdesk user"},\n\nSomeone asked to reset the password for your Lawdesk account. ` +
    `To choose a new password, open this link within ${mins} minutes:\n\n${link}\n\n` +
    `If you did not ask for this, you can ignore this email; your password will not change.`;
  return queueEmail(db, { kind: "password_reset", to: [{ name: u?.name ?? null, address: email }], subject: "Reset your Lawdesk password", text, html: textToHtml(text), sensitive: true }, opts);
}
