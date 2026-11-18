// A small made-up firm with known numbers, for the report tests. Every expected value in
// the tests is worked out by hand from the data below (see the comments).
//
// Today is 2026-11-18. Billing: 6-minute increments, Avery $300/h, Pat $120/h, 30-day terms.
//
// Matters
//   m1 2026-001 Acme lease      Acme  Litigation, stage Discovery  opened 2026-07-01  hourly
//   m2 2026-002 Acme formation  Acme  no practice area             opened 2026-11-03  flat fee $900
//   m3 2026-003 Jones estate    Bob   Litigation, stage Intake     opened 2026-06-15  hourly, closed 2026-10-31
//
// Time (minutes as worked)
//   Avery m1 07-10 60, m1 07-11 7 (bills as 12), m3 10-02 30, m2 11-04 120 (flat: no charge),
//         m1 11-12 45 (bills as 48, unbilled), m1 11-14 10 (bills as 12, on a draft)
//   Pat   m1 07-12 90, m3 09-15 30, m3 10-01 60, m1 11-13 30 non-billable
//
// Invoices
//   I0 m3 issued 09-20: Pat 09-15 30 min + $50 expense, VOIDED 09-25 (its items go back to unbilled)
//   I1 m1 issued 07-31 due 08-30: Avery 60 ($300) + 12 ($60), Pat 90 ($180) written down $30
//        -> standard $540, total $510; paid $200 on 08-15; owes $310, 80 days past due
//   I3 m3 issued 10-05 due 11-04: Pat 30 ($60) + 60 ($120), Avery 30 ($150), expense $50 -> $380, unpaid, 14 days past due
//   I2 m2 issued 11-05 due 12-05: flat fee $900 + Avery's 120 min at no charge; paid $900 on 11-10
//   Draft on m1 holding Avery's 11-14 entry.
//   Bob pays $100 on 11-16 not applied to anything (client credit).

import { openDb } from "../../src/db.ts";
import { Engine } from "../../src/engine.ts";
import { Billing } from "../../src/billing/billing.ts";
import { SCHEMA as BILLING_SCHEMA } from "../../src/billing/schema.ts";
import { SCHEMA as CONFLICTS_SCHEMA } from "../../src/conflicts/schema.ts";

export const TODAY = "2026-11-18";

export function fixture(opts: { billing?: boolean; conflicts?: boolean } = {}) {
  let day = "2026-06-15";
  const db = openDb();
  if (opts.billing !== false) db.exec(BILLING_SCHEMA);
  if (opts.conflicts !== false) db.exec(CONFLICTS_SCHEMA);
  const engine = new Engine(db, { today: () => day });
  const at = (d: string) => (day = d);

  const avery = engine.addUser("Avery Attorney", "attorney");
  const pat = engine.addUser("Pat Paralegal", "paralegal");
  const gone = engine.addUser("Former Clerk", "assistant");
  db.prepare("UPDATE users SET active = 0 WHERE id = ?").run(gone);
  const acme = engine.addContact("Acme Widgets LLC", "company", "ap@acme.example");
  const bob = engine.addContact("Bob Jones", "person", null, "555-0100");
  engine.addContact("Not A Client", "person");
  const lit = engine.addPracticeArea("Litigation", ["Intake", "Discovery", "Trial"]);

  const m3 = engine.createMatter({ name: "Jones estate", number: "2026-003", clientId: bob, practiceAreaId: lit.id, openedOn: "2026-06-15", roles: { attorney: avery, paralegal: pat } });
  const m1 = engine.createMatter({ name: "Acme lease", number: "2026-001", clientId: acme, practiceAreaId: lit.id, openedOn: "2026-07-01", roles: { attorney: avery, paralegal: pat } });
  engine.setStage(m1, lit.stageIds[1]);
  const m2 = engine.createMatter({ name: "Acme formation", number: "2026-002", clientId: acme, openedOn: "2026-11-03", roles: { attorney: avery } });

  let b: Billing | null = null;
  if (opts.billing !== false) {
    b = new Billing(db, { today: () => day, now: () => new Date(day + "T15:00:00Z") });
    b.updateSettings({ firmName: "Test Firm", defaultRateCents: 20000, paymentTermsDays: 30 });
    b.setUserRate(avery, 30000);
    b.setUserRate(pat, 12000);
    b.setMatterBilling(m2, { method: "flat", flatFeeCents: 90000 });

    // I1 on m1
    b.addTime({ userId: avery, matterId: m1, date: "2026-07-10", minutes: 60 });
    b.addTime({ userId: avery, matterId: m1, date: "2026-07-11", minutes: 7 });
    b.addTime({ userId: pat, matterId: m1, date: "2026-07-12", minutes: 90 });
    at("2026-07-31");
    const i1 = b.createDraft({ matterId: m1, to: "2026-07-31" });
    const patLine = i1.lines.find((l: any) => l.user_id === pat);
    b.writeDownLine(i1.id, patLine.id, { amountCents: 3000, reason: "Training time" });
    b.finalize(i1.id);
    at("2026-08-15");
    b.payInvoice(i1.id, { amountCents: 20000 });

    // I0 on m3, voided
    b.addTime({ userId: pat, matterId: m3, date: "2026-09-15", minutes: 30 });
    b.addExpense({ matterId: m3, date: "2026-09-15", costCents: 5000, description: "Filing fee" });
    at("2026-09-20");
    const i0 = b.createDraft({ matterId: m3 });
    b.finalize(i0.id);
    at("2026-09-25");
    b.void(i0.id, "Sent to the wrong address");

    // I3 on m3
    b.addTime({ userId: pat, matterId: m3, date: "2026-10-01", minutes: 60 });
    b.addTime({ userId: avery, matterId: m3, date: "2026-10-02", minutes: 30 });
    at("2026-10-05");
    b.finalize(b.createDraft({ matterId: m3 }).id);

    // I2 on m2 (flat fee)
    b.addTime({ userId: avery, matterId: m2, date: "2026-11-04", minutes: 120 });
    at("2026-11-05");
    const i2 = b.createDraft({ matterId: m2 });
    b.finalize(i2.id);
    at("2026-11-10");
    b.payInvoice(i2.id, { amountCents: 90000 });

    // Unbilled work on m1
    b.addTime({ userId: avery, matterId: m1, date: "2026-11-12", minutes: 45 });
    b.addTime({ userId: pat, matterId: m1, date: "2026-11-13", minutes: 30, billable: false });
    b.addTime({ userId: avery, matterId: m1, date: "2026-11-14", minutes: 10 });
    at("2026-11-15");
    b.createDraft({ matterId: m1, from: "2026-11-14", to: "2026-11-14" });
    at("2026-11-16");
    b.recordPayment({ clientId: bob, amountCents: 10000 });
  }

  // Tasks: [assignee, matter, due, finish ("done" | "skip" | null), finished on]
  const tasks: [number | null, number, string | null, string | null, string | null][] = [
    [avery, m1, "2026-11-05", "done", "2026-11-04"], // on time
    [avery, m1, "2026-11-06", "done", "2026-11-06"], // on time (same day)
    [avery, m1, "2026-11-07", "done", "2026-11-10"], // late
    [avery, m1, "2026-11-10", null, null], // overdue
    [avery, m1, "2026-11-20", null, null], // not due yet
    [avery, m1, "2026-11-12", "skip", "2026-11-12"], // skipped: left out
    [avery, m1, null, null, null], // no due date: left out
    [pat, m2, "2026-11-02", "done", "2026-11-02"], // on time
    [pat, m2, "2026-11-15", null, null], // overdue
    [pat, m2, "2026-10-20", "done", "2026-10-25"], // late, in October
    [null, m1, "2026-11-01", null, null], // unassigned, overdue
    [pat, m3, "2026-10-15", null, null], // open on the closed matter
  ];
  at("2026-06-15");
  for (const [who, matter, due, finish, on] of tasks) {
    const id = engine.addTask({ title: "Task", matterId: matter, assigneeId: who, dueDate: due });
    if (who == null) db.prepare("UPDATE tasks SET assignee_id = NULL WHERE id = ?").run(id);
    if (finish) {
      at(on!);
      if (finish === "done") engine.completeTask(id);
      else engine.skipTask(id);
      at("2026-06-15");
    }
  }
  // Close m3 directly (it still has an open task, which the engine would refuse).
  db.prepare("UPDATE matters SET status = 'closed', closed_on = '2026-10-31' WHERE id = ?").run(m3);

  // Replace the history with known timestamps (UTC). Kansas is UTC-5 (CDT) until Nov 1, then UTC-6.
  db.exec("DELETE FROM activity");
  const log = db.prepare("INSERT INTO activity (at, user_id, matter_id, kind, detail) VALUES (?,?,?,?,?)");
  log.run("2026-06-15T15:00:00.000Z", avery, m3, "stage_changed", 'Moved to stage "Intake"');
  log.run("2026-09-10T15:00:00.000Z", avery, m1, "stage_changed", 'Moved to stage "Discovery"');
  log.run("2026-10-01T14:00:00.000Z", pat, m1, "task_done", 'Finished "Call client about 100% of rent"');
  log.run("2026-10-31T15:00:00.000Z", avery, m3, "matter_closed", "Closed the matter");
  log.run("2026-11-01T04:30:00.000Z", null, m3, "automation", "Late-night automatic step"); // Oct 31, 11:30 pm in Kansas
  log.run("2026-11-03T15:00:00.000Z", avery, m2, "matter_opened", 'Opened matter "Acme formation"');
  log.run("2026-11-19T03:30:00.000Z", pat, m2, "invoice_finalized", "Finalized invoice 9"); // Nov 18, 9:30 pm in Kansas

  if (opts.conflicts !== false) {
    const ins = db.prepare(
      "INSERT INTO conflicts_checks (matter_id, run_by, run_at, terms, results, hit_count, decision, decided_by, decided_at) VALUES (?,?,?,?,?,?,?,?,?)",
    );
    ins.run(m2, pat, "2026-11-10T16:00:00.000Z", JSON.stringify([{ name: "Zed Corp" }, { name: "Acme Widgets LLC", role: "client" }]), "[]", 2, null, null, null);
    ins.run(m1, pat, "2026-07-01T16:00:00.000Z", JSON.stringify([{ name: "Acme Widgets LLC" }]), "[]", 0, "cleared", avery, "2026-07-01T17:00:00.000Z");
  }

  day = TODAY;
  return { db, engine, b, avery, pat, gone, acme, bob, m1, m2, m3, lit, ctx: { db, today: TODAY } };
}
