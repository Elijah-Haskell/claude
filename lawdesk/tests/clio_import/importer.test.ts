import { test } from "node:test";
import assert from "node:assert/strict";
import { guessMapping, missingRequired, checkMapping } from "../../src/clio_import/fields.ts";
import { reconciliation } from "../../src/clio_import/report.ts";
import { fixture, setup, withMatters } from "./helpers.ts";

const counts = (s: ReturnType<typeof setup>) => ({
  contacts: s.one("SELECT COUNT(*) n FROM contacts").n,
  matters: s.one("SELECT COUNT(*) n FROM matters").n,
  tasks: s.one("SELECT COUNT(*) n FROM tasks").n,
  events: s.one("SELECT COUNT(*) n FROM cal_events").n,
  time: s.one("SELECT COUNT(*) n FROM billing_time_entries").n,
  expenses: s.one("SELECT COUNT(*) n FROM billing_expenses").n,
  billed: s.one("SELECT COUNT(*) n FROM clio_import_billed").n,
  users: s.one("SELECT COUNT(*) n FROM users").n,
});

// ------------------------------------------------------------------ mapping

test("mapping: Clio's migration-template headings are recognised", () => {
  const h = "status,location,client_reference,description,open_date,close_date,pending_date,custom_number,note,client_first_name,client_last_name,client_company_name,responsible_attorney,practice_area".split(",");
  const m = guessMapping("matters", h);
  assert.equal(h[m.name], "description");
  assert.equal(h[m.number], "custom_number");
  assert.equal(h[m.responsible_attorney], "responsible_attorney");
  assert.equal(h[m.client_company_name], "client_company_name");
  assert.equal(h[m.note], "note");
  assert.deepEqual(missingRequired("matters", m), []);
  const a = guessMapping("time", "matter,date,activity_description,note,price,quantity,type,activity_user,non_billable".split(","));
  assert.deepEqual(Object.keys(a).sort(), ["activity_category", "date", "description", "hours", "matter", "non_billable", "rate", "type", "user"].sort());
});

test("mapping: export-style headings, any case and spacing; each column used once", () => {
  const h = ["Display Number", "Matter Description", "Client", "RESPONSIBLE ATTORNEY", "Open Date", "Practice Area", "Status"];
  const m = guessMapping("matters", h);
  assert.equal(m.number, 0);
  assert.equal(m.name, 1);
  assert.equal(m.client_name, 2);
  assert.equal(m.responsible_attorney, 3);
  const used = Object.values(m);
  assert.equal(new Set(used).size, used.length);
});

test("mapping: missing required fields named in plain words; bad manual mapping refused", () => {
  assert.deepEqual(missingRequired("contacts", {}), ["Full name or First name or Last name or Company"]);
  assert.ok(missingRequired("time", { date: 0 }).includes("Timekeeper"));
  assert.throws(() => checkMapping("contacts", ["a"], { name: 5 }), /not in the file/);
  assert.deepEqual(checkMapping("contacts", ["a", "b"], { name: "1", nonsense: 0, email: "" }), { name: 1 });
});

// ------------------------------------------------------------------ preview

test("preview: rows marked new / problem with reasons; nothing is written", () => {
  const s = setup();
  const before = counts(s);
  const p = s.imp.preview("matters", fixture("matters_migration.csv"));
  assert.equal(p.counts.rows, 5);
  assert.equal(p.counts.problems, 2);
  assert.equal(p.counts.new, 3);
  const bad = p.rows.filter((r) => r.status === "problem");
  assert.match(bad[0].errors[0], /Open date.*13\/45\/2026/);
  assert.match(bad[1].errors[0], /Frozen/);
  assert.deepEqual(counts(s), before);
});

test("preview: a manual mapping overrides the guess", () => {
  const s = setup();
  const csv = "Who,Mail\nAvery Fictional,avery@example.com\n";
  const guessed = s.imp.preview("contacts", csv);
  assert.ok(guessed.missing.length > 0, "nothing guessed from these headings");
  const p = s.imp.preview("contacts", csv, { name: 0, email: 1 });
  assert.deepEqual(p.missing, []);
  assert.equal(p.counts.ready, 1);
  assert.match(p.rows[0].summary, /Avery Fictional/);
});

test("import: refuses to run while a required column has no mapping", () => {
  const s = setup();
  assert.throws(() => s.imp.importCsv("contacts", "Who\nX\n"), /Choose a column/);
});

// ------------------------------------------------------------------ contacts & matters

test("contacts: people and companies, extra details kept in notes, bad rows skipped with reasons", () => {
  const s = setup();
  const r = s.imp.importCsv("contacts", "﻿" + fixture("contacts_migration.csv").replace(/\n/g, "\r\n"));
  assert.deepEqual(r.byType.Contacts, { created: 5, updated: 0, unchanged: 0, skipped: 1 });
  const avery = s.one("SELECT * FROM contacts WHERE name = 'Avery Fictional'");
  assert.equal(avery.kind, "person");
  assert.equal(avery.email, "avery@example.com");
  assert.match(avery.notes, /Job title: Owner/);
  assert.match(avery.notes, /Company: Prairie Example Bakery LLC/);
  assert.match(avery.notes, /Address: 100 Sample St, Topeka, KS 66601/);
  assert.equal(s.one("SELECT kind FROM contacts WHERE name = 'Prairie Example Bakery LLC'").kind, "company");
  assert.match(s.one("SELECT notes FROM contacts WHERE name = 'Blake Testperson'").notes, /200 Placeholder Ave\nApt 3/);
  assert.ok(s.one(`SELECT 1 FROM contacts WHERE name = 'Casey "CJ" Madeup'`));
  assert.match(r.skipped[0].reason, /No name/);
  assert.ok(r.warnings.some((w) => /doesn't look like an email/.test(w.message)));
  assert.ok(r.warnings.some((w) => /part of the name/.test(w.message)));
});

test("matters: client, practice area, responsible attorney role, closed and pending", () => {
  const s = withMatters();
  const lease = s.one("SELECT * FROM matters WHERE number = '2026-0001'");
  assert.equal(lease.name, "Bakery lease review");
  assert.equal(lease.opened_on, "2026-03-02");
  assert.equal(s.one("SELECT name FROM contacts WHERE id = ?", lease.client_id).name, "Prairie Example Bakery LLC");
  assert.equal(s.one("SELECT name FROM practice_areas WHERE id = ?", lease.practice_area_id).name, "Real Estate");
  assert.match(lease.description, /Location: Shawnee County/);
  assert.equal(s.one("SELECT user_id FROM matter_roles WHERE matter_id = ? AND role = 'attorney'", lease.id).user_id, s.jordan);
  const estate = s.one("SELECT * FROM matters WHERE number = '2025-0042'");
  assert.equal(estate.status, "closed");
  assert.equal(estate.closed_on, "2025-06-30");
  assert.equal(s.one("SELECT user_id FROM matter_roles WHERE matter_id = ?", estate.id).user_id, s.riley);
  const pending = s.one("SELECT * FROM matters WHERE number = '2026-0007'");
  assert.equal(pending.status, "open");
  assert.match(pending.description, /Clio status: Pending since 2026-09-15/);
  // The unknown attorney and client were added, and the report says so.
  const run = s.imp.getRun(2).report;
  assert.deepEqual(run.added.people, ["Morgan Newhire"]);
  assert.deepEqual(run.added.clients, ["Casey Unknownclient"]);
  assert.deepEqual(run.added.practiceAreas, ["Real Estate", "Estate Planning", "Litigation"]);
  // No automatic steps ran and no checklist tasks appeared.
  assert.equal(s.one("SELECT COUNT(*) n FROM tasks").n, 0);
  assert.ok(s.one("SELECT 1 FROM activity WHERE kind = 'clio_import'"), "the import is in the activity log");
});

test("matters: imported practice area with stages puts the matter in the first stage without running automations", () => {
  const s = setup();
  const area = s.engine.addPracticeArea("Real Estate", ["Intake", "Closing"]);
  const list = s.engine.createList({ name: "Intake list", items: [{ key: "a", title: "Do intake" }] });
  s.engine.addAutomation("Intake checklist", "stage_entered", area.stageIds[0], "apply_list", list);
  // Sanity check: a matter opened by hand in this area does get the checklist.
  const byHand = s.engine.createMatter({ name: "Typed by hand", practiceAreaId: area.id });
  assert.equal(s.one("SELECT COUNT(*) n FROM tasks WHERE matter_id = ?", byHand).n, 1);
  s.imp.importCsv("contacts", fixture("contacts_migration.csv"));
  s.imp.importCsv("matters", fixture("matters_migration.csv"));
  const m = s.one("SELECT * FROM matters WHERE number = '2026-0001'");
  assert.equal(m.practice_area_id, area.id);
  assert.equal(m.stage_id, area.stageIds[0]);
  assert.equal(s.one("SELECT COUNT(*) n FROM tasks WHERE matter_id = ?", m.id).n, 0);
});

test("matters: an existing Lawdesk matter with the same number is updated, not duplicated", () => {
  const s = setup();
  const c = s.engine.addContact("Prairie Example Bakery LLC", "company");
  const existing = s.engine.createMatter({ name: "Lease (typed by hand)", number: "2026-0001", clientId: c });
  s.imp.importCsv("contacts", fixture("contacts_migration.csv"));
  const r = s.imp.importCsv("matters", fixture("matters_migration.csv"));
  assert.equal(r.byType.Matters.updated, 1);
  assert.equal(s.one("SELECT COUNT(*) n FROM matters WHERE number = '2026-0001'").n, 1);
  assert.equal(s.one("SELECT name FROM matters WHERE id = ?", existing).name, "Bakery lease review");
  // The contact typed by hand was matched by name rather than duplicated.
  assert.equal(s.one("SELECT COUNT(*) n FROM contacts WHERE name = 'Prairie Example Bakery LLC'").n, 1);
});

// ------------------------------------------------------------------ tasks & calendar

test("tasks: due dates, done flag, matter link; unknown matter skipped", () => {
  const s = withMatters();
  const r = s.imp.importCsv("tasks", fixture("tasks_migration.csv"));
  assert.deepEqual(r.byType.Tasks, { created: 3, updated: 0, unchanged: 0, skipped: 1 });
  const redline = s.one("SELECT * FROM tasks WHERE title = 'Send lease redline'");
  assert.equal(redline.due_date, "2026-03-20");
  assert.equal(redline.status, "open");
  assert.equal(redline.description, "First pass, then call client");
  assert.equal(s.one("SELECT number FROM matters WHERE id = ?", redline.matter_id).number, "2026-0001");
  const done = s.one("SELECT * FROM tasks WHERE title = 'File closing letter'");
  assert.equal(done.status, "done");
  assert.equal(done.completed_on, "2025-07-01");
  assert.equal(s.one("SELECT matter_id FROM tasks WHERE title = 'Call client'").matter_id, null);
  assert.match(r.skipped[0].reason, /2099-9999.*import matters first/);
});

test("calendar: timed events converted from Kansas time; same start and end time read as all-day", () => {
  const s = withMatters();
  const r = s.imp.importCsv("calendar", fixture("calendar_migration.csv"));
  assert.deepEqual(r.byType.Calendar, { created: 2, updated: 0, unchanged: 0, skipped: 1 });
  const e = s.one("SELECT * FROM cal_events WHERE title = 'Lease signing'");
  assert.equal(e.start_at, "2026-03-25T14:30:00Z"); // 9:30 CDT
  assert.equal(e.end_at, "2026-03-25T15:30:00Z");
  assert.equal(e.source, "clio_import");
  assert.equal(e.location, "Conference room");
  const retreat = s.one("SELECT * FROM cal_events WHERE title = 'Firm retreat'");
  assert.equal(retreat.all_day, 1);
  assert.equal(retreat.start_date, "2026-03-09");
  assert.match(r.skipped[0].reason, /25:00:00 PM/);
});

// ------------------------------------------------------------------ time and expenses

test("time and expenses: unbilled into billing, totals in cents, problems skipped with reasons", () => {
  const s = withMatters();
  const r = s.imp.importCsv("time", fixture("activities_migration.csv"));
  assert.deepEqual(r.byType["Time and expenses"], { created: 6, updated: 0, unchanged: 0, skipped: 3 });
  const reasons = r.skipped.map((x) => x.reason).join(" | ");
  assert.match(reasons, /Negative amount/);
  assert.match(reasons, /more than a day/);
  assert.match(reasons, /2099-9999/);
  const first = s.one("SELECT * FROM billing_time_entries WHERE description = 'Reviewed lease draft'");
  assert.equal(first.minutes, 90);
  assert.equal(first.rate_cents, 25000);
  assert.equal(first.billable, 1);
  assert.equal(first.activity_code, "L110 A104");
  // The two identical "Call with client" lines are both kept, as non-billable.
  assert.deepEqual(s.q("SELECT billable FROM billing_time_entries WHERE description = 'Call with client'").map((x) => x.billable), [0, 0]);
  const fee = s.one("SELECT * FROM billing_expenses");
  assert.equal(fee.cost_cents, 119550);
  assert.equal(fee.expense_code, "E112");
  assert.equal(fee.receipt_note, "Vendor: Shawnee County; Reference: R-1001");
  assert.deepEqual(
    { ...r.totals },
    {
      timeEntries: 5,
      timeMinutes: 90 + 15 + 15 + 120 + 60,
      unbilledTimeMinutes: 90 + 120 + 60,
      unbilledTimeCents: 37500 + 60000 + 18000,
      nonBillableTimeMinutes: 30,
      billedTimeMinutes: 0,
      billedTimeCents: 0,
      expenseEntries: 1,
      unbilledExpenseCents: 119550,
      nonBillableExpenseCents: 0,
      billedExpenseCents: 0,
      clioStatedTotalCents: 37500 + 6250 + 6250 + 119550 + 60000 + 18000,
    },
  );
  assert.ok(r.added.people.includes("Taylor Contractor"));
});

test("time: timekeeper not in Lawdesk is skipped when adding people is turned off", () => {
  const s = withMatters();
  const r = s.imp.importCsv("time", fixture("activities_migration.csv"), { createMissingPeople: false });
  assert.ok(r.skipped.some((x) => /Taylor Contractor.*Settings > People/.test(x.reason)));
});

test("time: billed entries kept as history only, never in the billing tables; draft bills count as unbilled", () => {
  const s = withMatters();
  const r = s.imp.importCsv("time", fixture("time_export.csv"));
  assert.equal(r.totals.billedTimeMinutes, 60);
  assert.equal(r.totals.billedTimeCents, 25000);
  assert.equal(r.totals.unbilledTimeCents, 50000 + 15000);
  const hist = s.one("SELECT * FROM clio_import_billed");
  assert.equal(hist.bill_number, "1042");
  assert.equal(hist.description, "Initial consultation");
  assert.equal(s.one("SELECT COUNT(*) n FROM billing_time_entries WHERE description = 'Initial consultation'").n, 0);
  assert.ok(r.warnings.some((w) => /draft bill/.test(w.message)));
});

test("re-import: same file again changes nothing; a changed row updates; billed-since moves to history", () => {
  const s = withMatters();
  s.imp.importCsv("contacts", fixture("contacts_migration.csv"));
  const first = counts(s);
  const again = s.imp.importCsv("matters", fixture("matters_migration.csv"));
  assert.deepEqual(again.byType.Matters, { created: 0, updated: 0, unchanged: 3, skipped: 2 });
  s.imp.importCsv("time", fixture("time_export.csv"));
  const mid = counts(s);
  const r2 = s.imp.importCsv("time", fixture("time_export.csv"));
  assert.deepEqual(r2.byType["Time and expenses"], { created: 0, updated: 0, unchanged: 3, skipped: 0 });
  assert.deepEqual(counts(s), mid);
  // Clio has since billed entry 9001 and the hours on 9003 were corrected.
  const changed = fixture("time_export.csv").replace("$500.00,Unbilled,,No", "$500.00,Billed,1050,No").replace("2025-0042,Riley Chen,Draft revisions,0.5", "2025-0042,Riley Chen,Draft revisions,0.7");
  const r3 = s.imp.importCsv("time", changed);
  assert.deepEqual(r3.byType["Time and expenses"], { created: 0, updated: 2, unchanged: 1, skipped: 0 });
  assert.equal(counts(s).time, mid.time - 1);
  assert.equal(counts(s).billed, mid.billed + 1);
  assert.equal(s.one("SELECT minutes FROM billing_time_entries WHERE description = 'Draft revisions'").minutes, 42);
  assert.equal(first.contacts, counts(s).contacts);
});

test("re-import: an entry already put on a Lawdesk invoice is left alone", () => {
  const s = withMatters();
  s.imp.importCsv("time", fixture("time_export.csv"));
  const lease = s.one("SELECT id FROM matters WHERE number = '2026-0001'").id;
  s.imp.billing.createDraft({ matterId: lease });
  const changed = fixture("time_export.csv").replace("Prepared estoppel certificate,2.0", "Prepared estoppel certificate,3.0");
  const r = s.imp.importCsv("time", changed);
  assert.ok(r.skipped.some((x) => /Lawdesk invoice/.test(x.reason)));
  assert.equal(s.one("SELECT minutes FROM billing_time_entries WHERE description = 'Prepared estoppel certificate'").minutes, 120);
});

// ------------------------------------------------------------------ dry run, batches

test("trial run: full report, nothing kept", () => {
  const s = setup();
  const before = counts(s);
  const r = s.imp.importCsv("contacts", fixture("contacts_migration.csv"), { dryRun: true });
  assert.equal(r.dryRun, true);
  assert.equal(r.byType.Contacts.created, 5);
  assert.deepEqual(counts(s), before);
  assert.equal(s.one("SELECT COUNT(*) n FROM clio_import_map").n, 0);
  assert.equal(s.one("SELECT dry_run FROM clio_import_runs WHERE id = ?", r.runId).dry_run, 1);
  // And a real run afterwards gives the same counts.
  const real = s.imp.importCsv("contacts", fixture("contacts_migration.csv"));
  assert.deepEqual(real.byType, r.byType);
});

test("batches: one failing row doesn't undo the rest of its batch; small batches give the same result", () => {
  const a = withMatters();
  const big = a.imp.importCsv("time", fixture("activities_migration.csv"), { batchSize: 1000 });
  const b = withMatters();
  const small = b.imp.importCsv("time", fixture("activities_migration.csv"), { batchSize: 2 });
  assert.deepEqual(big.byType, small.byType);
  assert.deepEqual(big.totals, small.totals);
  assert.equal(counts(a).time, counts(b).time);
});

test("a row that fails half-way leaves nothing behind (its new client is rolled back too)", () => {
  const s = setup();
  s.imp.importCsv("contacts", "first_name,last_name\nAvery,Fictional\n");
  // Second matter reuses the number of the first, so it fails after its new client was added.
  const csv = "description,custom_number,client_company_name,status\nFirst,M-1,Prairie Example Bakery LLC,Open\nSecond,M-1,Brand New Client Co,Open\n";
  const r = s.imp.importCsv("matters", csv);
  assert.equal(r.byType.Matters.created, 1);
  // Without Clio IDs both rows share a natural key (same number), so the second updates the first.
  assert.equal(s.one("SELECT COUNT(*) n FROM matters").n, 1);

  // With Clio IDs they are two different matters, and the second can't have the same number.
  const t = setup();
  const csv2 = "Id,description,custom_number,client_company_name,status\n1,First,M-9,Old Client Co,Open\n2,Second,M-9,Brand New Client Co,Open\n";
  const r2 = t.imp.importCsv("matters", csv2);
  assert.equal(r2.byType.Matters.skipped, 1);
  assert.match(r2.skipped[0].reason, /already used/);
  assert.equal(t.one("SELECT COUNT(*) n FROM contacts WHERE name = 'Brand New Client Co'").n, 0, "the rolled-back row's client is gone");
  assert.deepEqual(r2.added.clients, ["Old Client Co"]);
  // ...and the lookups forgot it too: a later row naming that client adds it once, properly.
  const r3 = t.imp.importCsv("matters", "description,custom_number,client_company_name\nThird,M-10,Brand New Client Co\n");
  assert.equal(r3.byType.Matters.created, 1);
  assert.equal(t.one("SELECT COUNT(*) n FROM contacts WHERE name = 'Brand New Client Co'").n, 1);
});

// ------------------------------------------------------------------ trust & reconciliation

test("trust balances: listed for sign-off only; total lines ignored; nothing posted", () => {
  const s = withMatters();
  const tablesBefore = s.q("SELECT name FROM sqlite_master WHERE type = 'table'").map((t) => t.name);
  const r = s.imp.importCsv("trust_balances", fixture("trust_report.csv"));
  assert.equal(r.trust!.totalCents, 325025);
  assert.equal(r.trust!.lines.length, 3);
  assert.match(r.trust!.note, /Nothing was posted to trust/);
  assert.equal(r.trust!.lines[0].matterId, s.one("SELECT id FROM matters WHERE number = '2026-0001'").id, "matched '<number> - <name>'");
  assert.match(r.skipped[0].reason, /total line/);
  // Only the report table was written; no other table gained rows.
  const written = tablesBefore.filter((t) => t.includes("trust") && t !== "clio_import_trust_balances");
  for (const t of written) assert.equal(s.one(`SELECT COUNT(*) n FROM ${t}`).n, 0, t);
  assert.equal(s.one("SELECT COUNT(*) n FROM clio_import_trust_balances").n, 3);
});

test("reconciliation: what Lawdesk now holds from Clio, for checking against Clio's reports", () => {
  const s = withMatters();
  s.imp.importCsv("tasks", fixture("tasks_migration.csv"));
  s.imp.importCsv("time", fixture("activities_migration.csv"));
  s.imp.importCsv("time", fixture("time_export.csv"));
  s.imp.importCsv("trust_balances", fixture("trust_report.csv"));
  const rec = reconciliation(s.db);
  assert.equal(rec.counts.contacts, 5);
  assert.equal(rec.counts.matters, 3);
  assert.equal(rec.counts.tasks, 3);
  assert.equal(rec.counts.unbilledTimeEntries, 5 + 2);
  assert.equal(rec.counts.billedTimeEntries, 1);
  assert.equal(rec.money.unbilledTimeCents, 37500 + 60000 + 18000 + 50000 + 15000);
  assert.equal(rec.money.unbilledExpenseCents, 119550);
  assert.equal(rec.money.billedTimeCents, 25000);
  assert.equal(rec.money.nonBillableTimeMinutes, 30);
  assert.equal(rec.trust!.totalCents, 325025);
});
