import { test } from "node:test";
import assert from "node:assert/strict";
import { setup } from "./helpers.ts";

test("rates resolve most-specific first: matter+user, matter, user, firm", () => {
  const { b, engine, atty, para, m1 } = setup();
  const nobody = engine.addUser("New Associate");
  assert.deepEqual(b.resolveRate(m1, nobody), { rate_cents: 20000, source: "firm" });
  assert.deepEqual(b.resolveRate(m1, atty), { rate_cents: 30000, source: "user" });
  b.setMatterBilling(m1, { rateCents: 25000 });
  assert.deepEqual(b.resolveRate(m1, atty), { rate_cents: 25000, source: "matter" });
  assert.deepEqual(b.resolveRate(m1, nobody), { rate_cents: 25000, source: "matter" });
  b.setMatterUserRate(m1, para, 9000);
  assert.deepEqual(b.resolveRate(m1, para), { rate_cents: 9000, source: "matter_user" });
  assert.deepEqual(b.resolveRate(m1, atty), { rate_cents: 25000, source: "matter" });
  b.setMatterUserRate(m1, para, null);
  b.setMatterBilling(m1, { rateCents: null });
  assert.deepEqual(b.resolveRate(m1, para), { rate_cents: 12000, source: "user" });
});

test("time entries take the resolved rate when entered, and keep it", () => {
  const { b, atty, m1 } = setup();
  const e = b.addTime({ userId: atty, matterId: m1, minutes: 25, description: "Review lease" });
  assert.equal(e.rate_cents, 30000);
  assert.equal(e.date, "2026-11-02");
  assert.equal(e.billable, 1);
  b.setUserRate(atty, 35000);
  assert.equal(b.timeEntry(e.id).rate_cents, 30000);
  const e2 = b.updateTime(e.id, { rateCents: null });
  assert.equal(e2.rate_cents, 35000); // null re-resolves
  const e3 = b.addTime({ userId: atty, matterId: m1, minutes: 6, rateCents: 1000, activityCode: "anything the firm likes" });
  assert.equal(e3.rate_cents, 1000);
  assert.equal(e3.activity_code, "anything the firm likes");
});

test("time entry validation", () => {
  const { b, engine, atty, m1, m3 } = setup();
  assert.throws(() => b.addTime({ userId: atty, matterId: m1, minutes: -1 }), /Minutes/);
  assert.throws(() => b.addTime({ userId: atty, matterId: m1, minutes: 1.5 }), /Minutes/);
  assert.throws(() => b.addTime({ userId: atty, matterId: 999 }), /Matter not found/);
  assert.throws(() => b.addTime({ userId: 999, matterId: m1 }), /User not found/);
  assert.throws(() => b.addTime({ userId: atty, matterId: m1, date: "2026-02-30" }), /date/);
  assert.throws(() => b.addTime({ userId: atty, matterId: m1, rateCents: 10.5 }), /Rate/);
  const task = engine.addTask({ matterId: m3, title: "Inventory" });
  assert.throws(() => b.addTime({ userId: atty, matterId: m1, taskId: task }), /different matter/);
  const ok = b.addTime({ userId: atty, matterId: m3, taskId: task, minutes: 30 });
  assert.equal(ok.task_id, task);
});

test("timer: start, stop rounds up to the minute, one running timer per person, resume adds time", () => {
  const { b, atty, para, m1, m2, setNow } = setup();
  setNow("2026-11-02T15:00:00Z");
  const t1 = b.startTimer({ input: { userId: atty, matterId: m1, description: "Call with client" } });
  assert.ok(t1.timer_started_at);
  setNow("2026-11-02T15:12:01Z"); // 12 min 1 s
  const stopped = b.stopTimer(t1.id);
  assert.equal(stopped.minutes, 13);
  assert.equal(stopped.timer_started_at, null);
  assert.throws(() => b.stopTimer(t1.id), /not running/);

  // Resume, then start another: the first one stops itself.
  b.startTimer({ entryId: t1.id });
  const p = b.startTimer({ input: { userId: para, matterId: m2 } }); // different person: unaffected
  setNow("2026-11-02T15:20:00Z");
  const t2 = b.startTimer({ input: { userId: atty, matterId: m2, description: "Drafting" } });
  const first = b.timeEntry(t1.id);
  assert.equal(first.timer_started_at, null);
  assert.equal(first.minutes, 13 + 8);
  assert.deepEqual(
    b.runningTimers().map((r) => r.id).sort(),
    [p.id, t2.id].sort(),
  );
  assert.deepEqual(b.runningTimers(atty).map((r) => r.id), [t2.id]);
});

test("a running timer is left off invoice drafts", () => {
  const { b, atty, m1 } = setup();
  b.startTimer({ input: { userId: atty, matterId: m1, minutes: 30 } });
  b.addTime({ userId: atty, matterId: m1, minutes: 6 });
  const inv = b.createDraft({ matterId: m1 });
  assert.equal(inv.lines.length, 1);
});

test("expenses: markup rounds to the cent; free-text code and receipt note", () => {
  const { b, atty, m1 } = setup();
  const x = b.addExpense({ matterId: m1, userId: atty, costCents: 1999, markupBp: 1500, description: "Courier", expenseCode: "courier", receiptNote: "Receipt in file" });
  assert.equal(x.cost_cents, 1999);
  const listed = b.listExpenses({ matterId: m1 });
  assert.equal(listed[0].amount_cents, 2299);
  assert.equal(listed[0].receipt_note, "Receipt in file");
  assert.throws(() => b.addExpense({ matterId: m1, costCents: -1 }), /Cost/);
  const y = b.updateExpense(x.id, { costCents: 1000, markupBp: 0 });
  assert.equal(y.cost_cents, 1000);
  b.deleteExpense(x.id);
  assert.equal(b.listExpenses().length, 0);
});

test("entries on a draft or finalized invoice are locked; drafts release them", () => {
  const { b, atty, m1 } = setup();
  const e = b.addTime({ userId: atty, matterId: m1, minutes: 30 });
  const x = b.addExpense({ matterId: m1, costCents: 500 });
  const inv = b.createDraft({ matterId: m1 });
  assert.throws(() => b.updateTime(e.id, { minutes: 1 }), /draft invoice/);
  assert.throws(() => b.deleteExpense(x.id), /draft invoice/);
  b.finalize(inv.id);
  assert.throws(() => b.deleteTime(e.id), /billed on invoice 1/);
  assert.throws(() => b.startTimer({ entryId: e.id }), /billed/);
  assert.equal(b.listTime({ status: "billed" }).length, 1);
  assert.equal(b.listTime({ status: "unbilled" }).length, 0);
});
