import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture, TODAY } from "./fixture.ts";
import { dashboard } from "../../src/reports/dashboard.ts";
import { openDb } from "../../src/db.ts";
import { SCHEMA as BILLING_SCHEMA } from "../../src/billing/schema.ts";

test("headline figures", () => {
  const f = fixture();
  const d = dashboard(f.db, TODAY);
  assert.deepEqual(d.errors, []);
  assert.deepEqual(d.tiles, {
    overdue_tasks: 3, // Avery 11-10, Pat 11-15, unassigned 11-01; the one on the closed matter is not counted
    matters_opened: 1, // Acme formation, 11-03
    unbilled_time_cents: 30000, // 48 min + 12 min at $300/h
    unbilled_minutes: 55,
    outstanding_cents: 69000, // $310 + $380
    outstanding_invoices: 2,
    received_cents: 100000, // $900 on 11-10 + $100 on 11-16
  });
});

test("charts", () => {
  const f = fixture();
  const d = dashboard(f.db, TODAY);
  const c = d.charts.collections!;
  assert.equal(c.length, 12);
  assert.deepEqual([c[0].month, c[11].month], ["2025-12", "2026-11"]);
  assert.deepEqual(c.map((m) => m.received_cents), [0, 0, 0, 0, 0, 0, 0, 0, 20000, 0, 0, 100000]);
  // Last 90 days = 2026-08-21..2026-11-18. Avery worked 30 + 120 + 45 + 10 = 205, billed 30 (I3);
  // Pat worked 30 + 60 + 30 = 120, billed 30 + 60 = 90.
  assert.deepEqual(d.charts.hours!.from, "2026-08-21");
  assert.deepEqual(d.charts.hours!.people.map((p) => [p.name, p.worked, p.billed]), [["Avery Attorney", 205, 30], ["Pat Paralegal", 120, 90]]);
  assert.deepEqual(d.charts.aging, { current: 0, d1_30: 38000, d31_60: 0, d61_90: 31000, d90_plus: 0, total: 69000 });
  assert.deepEqual(
    d.charts.stages.map((a) => [a.name, a.stages.map((s: any) => `${s.name}:${s.count}`)]),
    [["Litigation", ["Intake:0", "Discovery:1", "Trial:0"]], ["No practice area", ["No stage:1"]]],
  );
});

test("needs-attention lists", () => {
  const f = fixture();
  const a = dashboard(f.db, TODAY).attention;
  assert.deepEqual(a.overdue_by_person.map((p) => [p.name, p.count, p.oldest_due, p.days_late]), [
    ["Avery Attorney", 1, "2026-11-10", 8],
    ["Pat Paralegal", 1, "2026-11-15", 3],
    ["Unassigned", 1, "2026-11-01", 17],
  ]);
  // Acme lease: last entry 10-01, 48 days ago. Acme formation had one on 11-18 (Kansas time).
  assert.deepEqual(a.quiet_matters.items.map((m) => [m.id, m.days_quiet, m.last_activity]), [[f.m1, 48, "2026-10-01"]]);
  assert.deepEqual(a.past_due_invoices!.items.map((i) => [i.number, i.days_past_due, i.balance_cents, i.matter_id]), [[1, 80, 31000, f.m1]]);
  assert.equal(a.past_due_invoices!.balance_cents, 31000);
  assert.deepEqual(a.undecided_conflicts!.items.map((k) => [k.matter_id, k.names, k.hit_count, k.days_waiting]), [[f.m2, ["Zed Corp", "Acme Widgets LLC"], 2, 8]]);
});

test("a matter with no history at all is quiet from its open date", () => {
  const f = fixture();
  const m = f.engine.createMatter({ name: "Old quiet one", openedOn: "2026-10-10" });
  f.db.prepare("DELETE FROM activity WHERE matter_id = ?").run(m);
  const q = dashboard(f.db, TODAY).attention.quiet_matters.items;
  assert.deepEqual(q.map((x) => [x.name, x.last_activity, x.days_quiet]), [["Acme lease", "2026-10-01", 48], ["Old quiet one", null, 39]]);
});

test("works with no billing or conflicts modules", () => {
  const f = fixture({ billing: false, conflicts: false });
  const d = dashboard(f.db, TODAY);
  assert.deepEqual(d.errors, []);
  assert.deepEqual(d.available, { billing: false, conflicts: false });
  assert.equal(d.tiles.overdue_tasks, 3);
  assert.equal(d.tiles.unbilled_time_cents, null);
  assert.equal(d.tiles.outstanding_cents, null);
  assert.equal(d.charts.collections, null);
  assert.equal(d.attention.past_due_invoices, null);
  assert.equal(d.attention.undecided_conflicts, null);
});

test("works on an empty database with billing installed", () => {
  const db = openDb();
  db.exec(BILLING_SCHEMA);
  const d = dashboard(db, TODAY);
  assert.deepEqual(d.errors, []);
  assert.deepEqual([d.tiles.overdue_tasks, d.tiles.unbilled_time_cents, d.tiles.outstanding_cents, d.tiles.received_cents], [0, 0, 0, 0]);
  assert.deepEqual(d.charts.collections!.map((m) => m.received_cents), Array(12).fill(0));
  assert.deepEqual(d.charts.hours!.people, []);
  assert.deepEqual(d.charts.stages, []);
});

test("a broken section is reported and the rest still loads", () => {
  const f = fixture();
  f.db.exec("DROP TABLE billing_writeoffs"); // billing half-installed
  const d = dashboard(f.db, TODAY);
  assert.equal(d.available.billing, false);
  assert.equal(d.tiles.overdue_tasks, 3);
  f.db.exec("ALTER TABLE conflicts_checks RENAME COLUMN decision TO decision_old");
  const d2 = dashboard(f.db, TODAY);
  assert.equal(d2.attention.undecided_conflicts, null);
  assert.match(d2.errors.join(" "), /Conflict checks/);
  assert.equal(d2.tiles.matters_opened, 1);
});
