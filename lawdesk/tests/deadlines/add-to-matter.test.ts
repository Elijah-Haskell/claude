// The calculator's "add to matter" route and ruleId compute, plus the calendar agenda's ?matter= filter
// and the demo calendar seed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../../src/db.ts";
import { Engine, EngineError } from "../../src/engine.ts";
import { type Ctx, type Route, matchPath } from "../../src/http.ts";
import { SCHEMA } from "../../src/calendar/schema.ts";
import { routes as deadlineRoutes } from "../../src/deadlines/routes.ts";
import { routes as calendarRoutes } from "../../src/calendar/routes.ts";
import { DISCLAIMER } from "../../src/deadlines/compute.ts";
import { seed } from "../../src/seed.ts";
import { Calendar } from "../../src/calendar/calendar.ts";

function app() {
  const db = openDb();
  db.exec(SCHEMA);
  const engine = new Engine(db, { today: () => "2026-11-18" });
  const ann = engine.addUser("Ann Attorney", "attorney");
  const area = engine.addPracticeArea("Litigation (test)", ["Open"]);
  const matter = engine.createMatter({ name: "Test v. Example", number: "T-1", practiceAreaId: area.id, roles: { attorney: ann } }, ann);
  const routes: Route[] = [...deadlineRoutes, ...calendarRoutes];
  const call = async (method: string, url: string, body: any = {}, userId: number | null = ann) => {
    const u = new URL(url, "http://x");
    for (const r of routes) {
      if (r.method !== method) continue;
      const params = matchPath(r.path, u.pathname);
      if (!params) continue;
      const ctx: Ctx = { db, engine, params, query: u.searchParams, body, userId };
      return r.handler(ctx) as any;
    }
    throw new Error(`no route ${method} ${url}`);
  };
  return { db, engine, ann, matter, call };
}

test("compute with ruleId runs one library rule", async () => {
  const { call } = app();
  // Interrogatories mailed Thu 2026-10-01: Oct 31 (Sat) -> Mon Nov 2, + 3 days -> Thu Nov 5 (docs/deadlines.md).
  const r = await call("POST", "/deadlines/compute", { ruleId: "interrogatory-answers", trigger: "2026-10-01", serviceMethod: "mail" });
  assert.equal(r.rule.id, "interrogatory-answers");
  assert.equal(r.result.date, "2026-11-05");
  assert.equal(r.disclaimer, DISCLAIMER);
  await assert.rejects(async () => call("POST", "/deadlines/compute", { ruleId: "nope", trigger: "2026-10-01" }), EngineError);
});

test("add-to-matter creates a court_deadline event and a high-priority task with the working", async () => {
  const { call, matter, ann, engine } = app();
  const r = await call("POST", "/deadlines/add-to-matter", {
    ruleId: "interrogatory-answers",
    trigger: "2026-10-01",
    serviceMethod: "mail",
    matterId: matter,
    title: "Answers to interrogatories due",
    assigneeId: ann,
    // A date sent by the client is ignored: the server recomputes.
    date: "2030-01-01",
  });
  assert.equal(r.result.date, "2026-11-05");
  assert.equal(r.event.kind, "court_deadline");
  assert.equal(r.event.source, "deadlines");
  assert.equal(r.event.sourceRef, "interrogatory-answers:2026-10-01");
  assert.equal(r.event.allDay, true);
  assert.equal(r.event.start, "2026-11-05");
  assert.deepEqual(r.event.attendees, [ann]);
  assert.match(r.event.notes, /How it was computed/);
  assert.match(r.event.notes, /VERIFY THIS DATE/);
  const task = engine.getTask(r.task.id);
  assert.equal(task.priority, "high");
  assert.equal(task.due_date, "2026-11-05");
  assert.equal(task.matter_id, matter);
  assert.equal(task.assignee_id, ann);
  assert.match(task.description, /K\.S\.A\. 60-233\(b\)\(2\)/);
  assert.ok(task.description.endsWith(DISCLAIMER));
  assert.equal(r.disclaimer, DISCLAIMER);
});

test("add-to-matter: custom period, default title, and refusals", async () => {
  const { call, matter, db } = app();
  const r = await call("POST", "/deadlines/add-to-matter", { trigger: "2026-12-07", days: 7, direction: "before", matterId: matter });
  // Hearing Mon 2026-12-07, 7 days before = Mon Nov 30 (docs/deadlines.md).
  assert.equal(r.result.date, "2026-11-30");
  assert.equal(r.event.title, "Deadline: 7 days before 2026-12-07");
  assert.match(r.event.sourceRef, /^custom:7d:before:2026-12-07$/);
  await assert.rejects(async () => call("POST", "/deadlines/add-to-matter", { ruleId: "answer-petition", trigger: "2026-11-02" }), /Choose the matter/);
  await assert.rejects(async () => call("POST", "/deadlines/add-to-matter", { ruleId: "answer-petition", trigger: "2026-11-02", matterId: 999 }), /Matter not found/);
  await assert.rejects(async () => call("POST", "/deadlines/add-to-matter", { trigger: "bad", days: 3, matterId: matter }), EngineError);
  // Nothing half-made by the refusals.
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM cal_events").get() as any).n, 1);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM tasks").get() as any).n, 1);
});

test("add-to-matter: an hours period becomes a timed event", async () => {
  const { call, matter } = app();
  const r = await call("POST", "/deadlines/add-to-matter", { trigger: "2026-11-20T10:00", hours: 48, matterId: matter });
  // Fri 10:00 + 48 h = Sun 10:00 -> Mon 2026-11-23 10:00 (60-206(a)(2)(C)).
  assert.equal(r.result.date, "2026-11-23");
  assert.equal(r.event.allDay, false);
  assert.equal(r.event.startLocal, "2026-11-23T10:00");
});

test("agenda ?matter= keeps only that matter's items", async () => {
  const { call, matter, ann } = app();
  await call("POST", "/calendar/events", { title: "On the matter", matterId: matter, start: "2026-11-20T09:00", attendees: [ann] });
  await call("POST", "/calendar/events", { title: "Elsewhere", start: "2026-11-20T09:30", attendees: [ann] });
  const all = await call("GET", "/calendar/agenda?from=2026-11-18&to=2026-11-30&scope=firm&tasks=0");
  assert.equal(all.items.length, 2);
  assert.equal(all.conflicts.length, 1);
  const one = await call("GET", `/calendar/agenda?from=2026-11-18&to=2026-11-30&scope=firm&tasks=0&matter=${matter}`);
  assert.deepEqual(one.items.map((i: any) => i.title), ["On the matter"]);
});

test("demo seed has hearings, meetings and a weekly staff meeting", () => {
  const db = openDb();
  const demo = seed(db, "2026-11-18");
  const cal = new Calendar(db);
  const events = cal.listEvents();
  const staff = events.find((e) => e.title === "Staff meeting")!;
  assert.match(staff.rrule, /^FREQ=WEEKLY;BYDAY=TU/);
  assert.equal(staff.attendees.length, 4);
  assert.equal(staff.exceptions.filter((x: any) => x.cancelled).length, 1);
  assert.ok(events.filter((e) => e.kind === "hearing").length >= 2);
  assert.ok(events.every((e) => e.title && !/@(?!example)/.test(e.notes ?? "")));
  const ag = cal.agenda({ from: "2026-11-18", to: "2026-11-18", userId: demo.users.jordan, includeTasks: false });
  assert.ok(ag.conflicts.length >= 1, "a double-booking to show");
});
