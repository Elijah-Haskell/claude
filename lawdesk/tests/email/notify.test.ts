import { test } from "node:test";
import assert from "node:assert/strict";
import { Calendar } from "../../src/calendar/calendar.ts";
import { getPrefs, notifyAssignments, sendDigests, sendPasswordReset, sendReminders, setPrefs } from "../../src/email/notify.ts";
import { listOutbox } from "../../src/email/outbox.ts";
import { runEmailJobs, startEmailWorker } from "../../src/email/worker.ts";
import { parseMessage } from "../../src/email/parse.ts";
import { MemoryTransport, setup } from "./helpers.ts";

const outbox = (db: any) => db.prepare("SELECT * FROM email_outbox ORDER BY id").all() as any[];

test("notify: task assignment emails (baseline, self-assignment, batching, reassignment)", () => {
  const { db, engine, avery, pat, nomail, matterId, env, cleanup } = setup();
  try {
    const now = new Date("2026-11-18T15:00:00Z");
    engine.addTask({ matterId, title: "Already assigned before email was on", assigneeId: pat } as any, avery);
    assert.equal(notifyAssignments(db, { now, env }), 0, "first run only records");
    assert.equal(outbox(db).length, 0);

    engine.addTask({ matterId, title: "Draft the purchase agreement", assigneeId: pat, dueDate: "2026-11-20", priority: "high" } as any, avery);
    engine.addTask({ matterId, title: "My own note", assigneeId: avery } as any, avery);
    engine.addTask({ matterId, title: "For someone without email", assigneeId: nomail } as any, avery);
    assert.equal(notifyAssignments(db, { now, env }), 1);
    const [m] = outbox(db);
    assert.deepEqual(JSON.parse(m.recipients), ["pat@firm.example.test"]);
    assert.equal(m.subject, "New task: Draft the purchase agreement (2026-0042 Client asset purchase)");
    const p = parseMessage(Buffer.from(m.raw));
    assert.match(p.text, /Avery Attorney assigned you a task/);
    assert.match(p.text, /Due: Friday, November 20, 2026/);
    assert.match(p.text, /Priority: high/);
    assert.match(p.text, new RegExp(`/#/matters/${matterId}`));
    assert.equal(notifyAssignments(db, { now, env }), 0, "never twice");

    // Several at once become one email.
    for (const t of ["One", "Two", "Three"]) engine.addTask({ matterId, title: t, assigneeId: avery } as any, pat);
    assert.equal(notifyAssignments(db, { now, env }), 1);
    assert.equal(outbox(db).at(-1).subject, "3 new tasks for you");

    // Reassign away and back: announced again. Turned off: nothing.
    const tid = (db.prepare("SELECT id FROM tasks WHERE title = 'One'").get() as any).id;
    engine.updateTask(tid, { assigneeId: pat } as any, avery);
    assert.equal(notifyAssignments(db, { now, env }), 1);
    setPrefs(db, avery, { taskAssigned: false });
    engine.updateTask(tid, { assigneeId: avery } as any, pat);
    assert.equal(notifyAssignments(db, { now, env }), 0);
  } finally {
    cleanup();
  }
});

test("notify: daily summary at the chosen Chicago time, once a day, weekdays only by default", () => {
  const { db, engine, avery, pat, matterId, env, cleanup } = setup();
  try {
    engine.addTask({ matterId, title: "Late thing", assigneeId: pat, dueDate: "2026-11-16" } as any, avery);
    engine.addTask({ matterId, title: "Today thing", assigneeId: pat, dueDate: "2026-11-18" } as any, avery);
    engine.addTask({ matterId, title: "Next week", assigneeId: pat, dueDate: "2026-11-23" } as any, avery);
    setPrefs(db, pat, { digestTime: "08:00" });
    // 07:59 in Chicago (CST, UTC-6) = 13:59 UTC.
    assert.equal(sendDigests(db, { now: new Date("2026-11-18T13:59:00Z"), env }), 0);
    assert.equal(sendDigests(db, { now: new Date("2026-11-18T14:00:00Z"), env }), 1);
    assert.equal(sendDigests(db, { now: new Date("2026-11-18T20:00:00Z"), env }), 0, "once a day");
    const m = outbox(db)[0];
    assert.equal(m.subject, "Your tasks for Wednesday, November 18, 2026: 1 overdue, 1 due today");
    const text = parseMessage(Buffer.from(m.raw)).text;
    assert.match(text, /Overdue \(1\)\n• Late thing \(2026-0042 Client asset purchase\), due Monday, November 16, 2026/);
    assert.match(text, /Due today \(1\)\n• Today thing/);
    assert.match(text, /Coming up in the next week: 1 task\./);
    // Avery has nothing due: no email. Saturday: no email unless asked.
    assert.equal(outbox(db).filter((r) => r.recipients.includes("avery")).length, 0);
    assert.equal(sendDigests(db, { now: new Date("2026-11-21T15:00:00Z"), env }), 0);
    setPrefs(db, pat, { digestWeekends: true });
    assert.equal(sendDigests(db, { now: new Date("2026-11-21T15:00:00Z"), env }), 1);
    assert.equal(getPrefs(db, pat).lastDigestOn, "2026-11-21");
    assert.throws(() => setPrefs(db, pat, { digestTime: "8am" }), /07:30/);
  } finally {
    cleanup();
  }
});

test("notify: calendar reminders go to attendees exactly once", () => {
  const { db, avery, pat, matterId, env, cleanup } = setup();
  try {
    const cal = new Calendar(db, { now: () => new Date("2026-11-18T12:00:00Z") });
    cal.createEvent({ title: "Hearing on motion", kind: "hearing", matterId, start: "2026-11-19T14:00:00Z", attendees: [avery, pat], reminders: [1440, 60] }, avery);
    // First check starts five minutes back; the 1-day reminder fires at 2026-11-18T14:00Z.
    assert.equal(sendReminders(db, { now: new Date("2026-11-18T13:00:00Z"), env }), 0);
    assert.equal(sendReminders(db, { now: new Date("2026-11-18T14:00:30Z"), env }), 2);
    assert.equal(sendReminders(db, { now: new Date("2026-11-18T14:01:30Z"), env }), 0);
    const m = outbox(db)[0];
    assert.equal(m.kind, "reminder");
    assert.equal(m.subject, "Reminder: Hearing on motion, Thursday, November 19 at 8:00 AM");
    // Even if the checkpoint is lost, nothing repeats.
    db.prepare("DELETE FROM email_state WHERE key = 'reminders_checked_to'").run();
    db.prepare("INSERT INTO email_state (key, value) VALUES ('reminders_checked_to', '2026-11-18T13:00:00Z')").run();
    assert.equal(sendReminders(db, { now: new Date("2026-11-18T14:02:00Z"), env }), 0);
    setPrefs(db, pat, { reminders: false });
    assert.equal(sendReminders(db, { now: new Date("2026-11-19T13:00:30Z"), env }), 1, "only Avery gets the 1-hour reminder");
    assert.equal((db.prepare("SELECT count(*) AS n FROM email_reminders_sent").get() as any).n, 3);
  } finally {
    cleanup();
  }
});

test("notify: password reset email", () => {
  const { db, env, cleanup } = setup();
  try {
    const q = sendPasswordReset(db, "PAT@firm.example.test", "https://lawdesk.example.test/reset?t=abc", { env });
    const row = (db.prepare("SELECT * FROM email_outbox WHERE id = ?").get(q.id) as any);
    assert.equal(row.sensitive, 1);
    const p = parseMessage(Buffer.from(row.raw));
    assert.match(p.text, /Dear Pat,/);
    assert.match(p.text, /https:\/\/lawdesk\.example\.test\/reset\?t=abc/);
    assert.equal(listOutbox(db)[0].subject, "(password reset)");
    assert.throws(() => sendPasswordReset(db, "pat@firm.example.test", "javascript:alert(1)", { env }), /http/);
  } finally {
    cleanup();
  }
});

test("worker: one pass queues and sends; the timer can be stopped; overlapping runs are skipped", async () => {
  const { db, engine, avery, pat, matterId, env, cleanup } = setup();
  try {
    const tr = new MemoryTransport();
    await runEmailJobs(db, { now: new Date("2026-11-18T15:00:00Z"), transport: tr, env });
    engine.addTask({ matterId, title: "Review title work", assigneeId: pat } as any, avery);
    const r = await runEmailJobs(db, { now: new Date("2026-11-18T15:01:00Z"), transport: tr, env });
    assert.equal(r.assignments, 1);
    assert.equal(r.sent, 1);
    assert.deepEqual(r.errors, []);
    assert.equal(tr.sent[0].envelope.to[0], "pat@firm.example.test");

    const w = startEmailWorker(db, { intervalMs: 60_000, transport: tr, env, log: () => {} });
    const [a, b] = await Promise.all([w.runNow(), w.runNow()]);
    assert.ok(a);
    assert.equal(b, null);
    w.stop();
  } finally {
    cleanup();
  }
});
