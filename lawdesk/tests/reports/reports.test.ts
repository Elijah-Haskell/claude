// Report figures checked against values worked out by hand from tests/reports/fixture.ts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture, TODAY } from "./fixture.ts";
import { runReport, REPORTS, defaultRange, kindLabel } from "../../src/reports/reports.ts";

const strip = (rows: any[]) => rows.map(({ _links, ...r }) => r);
const run = (f: ReturnType<typeof fixture>, key: string, x: any = {}) => runReport(f.ctx, key, { options: {}, ...x });

test("task completion and on-time rate by person (tasks due in November)", () => {
  const f = fixture();
  const r = run(f, "tasks"); // default: this month, 2026-11-01..2026-11-18
  assert.deepEqual([r.filters.from, r.filters.to], ["2026-11-01", TODAY]);
  // Avery: due 11-05 (done 11-04), 11-06 (done 11-06), 11-07 (done 11-10, late), 11-10 open.
  //   11-20 is outside the range, the skipped and undated tasks are left out.
  // Pat: 11-02 done on time, 11-15 open. Unassigned: 11-01 open.
  assert.deepEqual(
    strip(r.rows).map((x) => [x.person, x.due, x.done, x.on_time, x.late, x.open, x.overdue, x.completion_rate, x.on_time_rate]),
    [
      ["Avery Attorney", 4, 3, 2, 1, 1, 1, 0.75, 0.6667],
      ["Pat Paralegal", 2, 1, 1, 0, 1, 1, 0.5, 1],
      ["Unassigned", 1, 0, 0, 0, 1, 1, 0, null],
    ],
  );
  const t = r.totals!;
  assert.deepEqual([t.due, t.done, t.on_time, t.late, t.open, t.overdue, t.completion_rate, t.on_time_rate], [7, 4, 3, 1, 3, 3, 0.5714, 0.75]);
  // October: Pat's 10-20 task done 10-25 (late) and the open task on the closed matter (10-15).
  const oct = run(f, "tasks", { from: "2026-10-01", to: "2026-10-31", userId: f.pat });
  assert.deepEqual(strip(oct.rows).map((x) => [x.due, x.done, x.late, x.overdue, x.on_time_rate]), [[2, 1, 1, 1, 0]]);
  // Matter filter.
  assert.deepEqual(run(f, "tasks", { matterId: f.m2 }).rows.map((x) => x.person), ["Pat Paralegal"]);
});

test("matter list: stages, ages and days in stage", () => {
  const f = fixture();
  const r = run(f, "matters", { options: { status: "all" } });
  assert.deepEqual(
    strip(r.rows).map((m) => [m.matter, m.stage, m.status, m.age_days, m.stage_days, m.open_tasks, m.overdue_tasks, m.last_activity]),
    [
      // opened 06-15, closed 10-31: 30 + 31 + 31 + 30 + 16 = 138 days
      ["2026-003 Jones estate", "Intake", "Closed", 138, null, 1, 1, "2026-10-31"],
      // opened 07-01 -> 11-18: 31 + 31 + 30 + 31 + 17 = 140; stage moved 09-10 -> 20 + 31 + 18 = 69
      ["2026-001 Acme lease", "Discovery", "Open", 140, 69, 4, 2, "2026-10-01"],
      // 11-03 -> 11-18 = 15. Its last history entry is 11-19 03:30 UTC = 11-18 in Kansas.
      ["2026-002 Acme formation", null, "Open", 15, null, 1, 1, "2026-11-18"],
    ],
  );
  assert.deepEqual(r.rows[1]._links, { matter: `#/matters/${f.m1}` });
  assert.equal(run(f, "matters").rows.length, 2, "open only by default");
  assert.deepEqual(run(f, "matters", { from: "2026-11-01", to: "2026-11-30" }).rows.map((m) => m.matter), ["2026-002 Acme formation"]);
  assert.deepEqual(run(f, "matters", { userId: f.pat, options: { status: "all" } }).rows.map((m) => m.matter), ["2026-003 Jones estate", "2026-001 Acme lease"]);
  assert.throws(() => run(f, "matters", { options: { status: "maybe" } }), /open, closed or all/);
});

test("productivity: hours worked, billable and billed by person", () => {
  const f = fixture();
  const r = run(f, "productivity", { from: "2026-07-01", to: TODAY });
  // Avery worked 60+7+30+120+45+10 = 272, all billable. Billed: I1 60 + 12 (7 rounded up) and I3 30 = 102;
  //   the flat-fee line on I2 is no-charge and not counted. Value 300 + 60 + 150 = $510.
  // Pat worked 90+30+60+30 = 210, 180 billable. Billed: I1 90 and I3 30 + 60 = 180 (the voided I0 is left out).
  //   Value 180 - 30 write-down + 60 + 120 = $330.
  assert.deepEqual(
    strip(r.rows).map((x) => [x.person, x.worked, x.billable, x.billed, x.billed_cents, x.billable_share, x.billed_share]),
    [
      ["Avery Attorney", 272, 272, 102, 51000, 1, 0.375],
      ["Pat Paralegal", 210, 180, 180, 33000, 0.8571, 1],
    ],
  );
  const t = r.totals!;
  assert.deepEqual([t.worked, t.billable, t.billed, t.billed_cents, t.billable_share, t.billed_share], [482, 452, 282, 84000, 0.9378, 0.6239]);
  // November only: Avery 120 + 45 + 10 = 175 worked, none billed yet; Pat 30 non-billable.
  const nov = run(f, "productivity");
  assert.deepEqual(strip(nov.rows).map((x) => [x.worked, x.billable, x.billed]), [[175, 175, 0], [30, 0, 0]]);
  // The inactive clerk is not listed.
  assert.ok(!r.rows.some((x) => x.person === "Former Clerk"));
});

test("revenue uses the billing module's definitions, month by month and for the whole period", () => {
  const f = fixture();
  const r = run(f, "revenue"); // default: this year
  assert.equal(r.rows.length, 11);
  const by = Object.fromEntries(r.rows.map((x) => [x.month, x]));
  // July: I1 standard $540, written down $30, billed $510, $200 paid -> 510/540 = 0.9444, 200/510 = 0.3922.
  assert.deepEqual(
    [by["Jul 2026"].invoices, by["Jul 2026"].standard_cents, by["Jul 2026"].adjustments_cents, by["Jul 2026"].billed_cents, by["Jul 2026"].collected_cents, by["Jul 2026"].realization_rate, by["Jul 2026"].collection_rate],
    [1, 54000, 3000, 51000, 20000, 0.9444, 0.3922],
  );
  assert.equal(by["Aug 2026"].cash_received_cents, 20000);
  assert.equal(by["Sep 2026"].invoices, 0, "the voided September invoice is left out");
  assert.deepEqual([by["Oct 2026"].billed_cents, by["Oct 2026"].collection_rate], [38000, 0]);
  // November: I2 $900 paid in full; cash $900 + Bob's unapplied $100.
  assert.deepEqual([by["Nov 2026"].billed_cents, by["Nov 2026"].collected_cents, by["Nov 2026"].cash_received_cents], [90000, 90000, 100000]);
  assert.equal(by["Jun 2026"].realization_rate, null);
  // Whole period: billed 510 + 380 + 900 = 1790 of 1820 standard; collected 200 + 900 = 1100.
  const t = r.totals!;
  assert.deepEqual(
    [t.invoices, t.standard_cents, t.billed_cents, t.collected_cents, t.cash_received_cents, t.realization_rate, t.collection_rate],
    [3, 182000, 179000, 110000, 120000, 0.9835, 0.6145],
  );
});

test("A/R aging by client and by invoice", () => {
  const f = fixture();
  const r = run(f, "aging");
  assert.equal(r.filters.to, TODAY);
  // I1 owes 510 - 200 = $310, due 08-30, 80 days past due. I3 owes $380, due 11-04, 14 days.
  assert.deepEqual(strip(r.rows), [
    { client: "Acme Widgets LLC", current: 0, d1_30: 0, d31_60: 0, d61_90: 31000, d90_plus: 0, total: 31000, credit_cents: 0 },
    { client: "Bob Jones", current: 0, d1_30: 38000, d31_60: 0, d61_90: 0, d90_plus: 0, total: 38000, credit_cents: 10000 },
  ]);
  assert.equal(r.totals!.total, 69000);
  const inv = run(f, "aging", { options: { view: "invoice" } });
  assert.deepEqual(strip(inv.rows).map((x) => [x.invoice, x.days_past_due, x.balance_cents]), [["Invoice 1", 80, 31000], ["Invoice 3", 14, 38000]]);
  assert.deepEqual(inv.rows[0]._links, { matter: `#/matters/${f.m1}` });
  // As of 2026-08-31 only I1 exists: $510 - $200 = $310, 1 day past due.
  const aug = run(f, "aging", { to: "2026-08-31" });
  assert.deepEqual(strip(aug.rows).map((x) => [x.client, x.d1_30, x.total]), [["Acme Widgets LLC", 31000, 31000]]);
});

test("time by matter", () => {
  const f = fixture();
  const r = run(f, "time-by-matter", { from: "2026-07-01", to: TODAY });
  assert.deepEqual(strip(r.rows).map((x) => [x.matter, x.method, x.worked, x.billable, x.nonbillable, x.billed, x.billed_cents, x.unbilled, x.unbilled_cents]), [
    // m1: 60+7+45+10 + 90+30 = 242 worked, 30 non-billable. Billed I1: 60+12+90 = 162 min, $510.
    //   Unbilled: 45 min (bills as 48 = $240) + 10 on a draft (bills as 12 = $60) = 55 min, $300.
    ["2026-001 Acme lease", "Hourly", 242, 212, 30, 162, 51000, 55, 30000],
    // m2: flat fee, 120 minutes recorded, none billed by the hour.
    ["2026-002 Acme formation", "Flat fee", 120, 120, 0, 0, 0, 0, 0],
    // m3: 30+60+30 = 120 all billed on I3: $60 + $120 + $150.
    ["2026-003 Jones estate", "Hourly", 120, 120, 0, 120, 33000, 0, 0],
  ]);
  assert.deepEqual([r.totals!.worked, r.totals!.billed, r.totals!.unbilled_cents], [482, 282, 30000]);
  const avery = run(f, "time-by-matter", { from: "2026-07-01", to: TODAY, userId: f.avery, matterId: f.m1 });
  assert.deepEqual(strip(avery.rows).map((x) => [x.worked, x.billed, x.unbilled_cents]), [[122, 72, 30000]]);
});

test("client list with matters and what they owe", () => {
  const f = fixture();
  const r = run(f, "clients");
  assert.deepEqual(
    r.rows.map((c) => [c.client, c.kind, c.open, c.closed, c.first_opened, c.owed_cents, c.matters.map((m: any) => m.label)]),
    [
      ["Acme Widgets LLC", "Company", 2, 0, "2026-07-01", 31000, ["2026-001 Acme lease", "2026-002 Acme formation"]],
      ["Bob Jones", "Person", 0, 1, "2026-06-15", 38000, ["2026-003 Jones estate (closed)"]],
    ],
  );
  assert.ok(!r.rows.some((c) => c.client === "Not A Client"));
  assert.deepEqual(run(f, "clients", { userId: f.pat }).rows.map((c) => [c.client, c.open]), [["Acme Widgets LLC", 1], ["Bob Jones", 0]]);
});

test("activity log: Kansas dates, filters and literal search", () => {
  const f = fixture();
  const r = run(f, "activity", { from: "2026-10-31", to: TODAY });
  assert.deepEqual(
    r.rows.map((a) => [a.date, a.time, a.who, a.what]),
    [
      ["2026-11-18", "9:30 PM", "Pat Paralegal", "Invoice finalized"], // 11-19 03:30 UTC, CST
      ["2026-11-03", "9:00 AM", "Avery Attorney", "Opened a matter"],
      ["2026-10-31", "11:30 PM", "Not recorded", "Automatic step"], // 11-01 04:30 UTC, still CDT
      ["2026-10-31", "10:00 AM", "Avery Attorney", "Closed a matter"],
    ],
  );
  assert.equal(run(f, "activity", { from: "2026-11-19", to: "2026-11-30" }).rows.length, 0);
  assert.equal(run(f, "activity", { from: "2026-11-01", to: "2026-11-01" }).rows.length, 0);
  assert.equal(run(f, "activity", { from: "2026-06-01", to: TODAY, userId: f.pat }).rows.length, 2);
  assert.equal(run(f, "activity", { from: "2026-06-01", to: TODAY, matterId: f.m3 }).rows.length, 3);
  assert.equal(run(f, "activity", { from: "2026-06-01", to: TODAY, options: { kind: "stage_changed" } }).rows.length, 2);
  // "%" is matched literally, not as a wildcard.
  assert.deepEqual(run(f, "activity", { from: "2026-06-01", to: TODAY, options: { q: "100%" } }).rows.map((a) => a.what), ["Finished a task"]);
  assert.equal(run(f, "activity", { from: "2026-06-01", to: TODAY, options: { q: "%" } }).rows.length, 1);
  assert.equal(kindLabel("payment_received"), "Payment received");
});

test("every report defines its terms, and bad filters are refused", () => {
  const f = fixture();
  for (const info of REPORTS) {
    const r = run(f, info.key);
    assert.ok(r.definitions.length > 0, `${info.key} has definitions`);
    for (const c of r.columns) assert.ok(c.label && c.type, `${info.key}.${c.key}`);
  }
  assert.throws(() => run(f, "tasks", { from: "2026-11-10", to: "2026-11-01" }), /after its end/);
  assert.throws(() => run(f, "nope"), /No such report/);
  assert.deepEqual(defaultRange(REPORTS.find((r) => r.key === "activity")!, TODAY), { from: "2026-11-12", to: TODAY });
});

test("reports still work with no billing module and with billing but no data", () => {
  const f = fixture({ billing: false, conflicts: false });
  for (const key of ["productivity", "revenue", "aging", "time-by-matter"]) {
    const r = run(f, key);
    assert.equal(r.available, false, key);
    assert.equal(r.rows.length, 0);
  }
  const c = run(f, "clients");
  assert.ok(!c.columns.some((x) => x.key === "owed_cents"));
  assert.equal(c.rows.length, 2);
  assert.equal(run(f, "tasks").rows.length, 3);
});
