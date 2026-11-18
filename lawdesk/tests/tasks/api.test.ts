// API tests: start the real server on port 0 and drive the main flows over HTTP.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { openDb } from "../../src/db.ts";
import { createServer } from "../../src/server.ts";
import { modules } from "../../src/modules.ts";
import { seed } from "../../src/seed.ts";
import { EngineError } from "../../src/engine.ts";
import { signedInAs } from "../auth/helpers.ts";

const servers: any[] = [];
after(() => servers.forEach((s) => s.close()));

async function start(opts: { today?: string; modules?: any[] } = {}) {
  let now = opts.today ?? "2026-11-16"; // a Monday
  const db = openDb();
  const errors: unknown[] = [];
  const server = createServer(db, { today: () => now, log: (...a) => errors.push(a), modules: opts.modules });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  servers.push(server);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // Every API call needs a signed-in account: start as a "Test admin" (one extra person in
  // the users table), and actAs(id) signs in as that person instead.
  const session = signedInAs(db);
  let cookie = session.cookie;
  async function call(method: string, path: string, body?: unknown, raw?: string) {
    const headers: Record<string, string> = { Cookie: cookie, "X-Requested-With": "lawdesk" };
    if (body !== undefined || raw !== undefined) headers["Content-Type"] = "application/json";
    const res = await fetch(base + path, { method, headers, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
    const text = await res.text();
    let data: any = text;
    try {
      data = JSON.parse(text);
    } catch {}
    return { status: res.status, data, headers: res.headers };
  }
  const ok = async (method: string, path: string, body?: unknown) => {
    const r = await call(method, path, body);
    assert.equal(r.status, 200, `${method} ${path} -> ${r.status} ${JSON.stringify(r.data)}`);
    return r.data;
  };
  return { db, base, call, ok, errors, setToday: (d: string) => (now = d), actAs: (id: number | null) => (cookie = id == null ? session.cookie : signedInAs(db, id).cookie) };
}

async function firm(s: Awaited<ReturnType<typeof start>>) {
  const atty = (await s.ok("POST", "/api/users", { name: "Attorney A", defaultRole: "attorney" })).id;
  const para = (await s.ok("POST", "/api/users", { name: "Paralegal P", defaultRole: "paralegal" })).id;
  await s.ok("POST", "/api/date-fields", { key: "closing_date", label: "Closing date" });
  const area = await s.ok("POST", "/api/practice-areas", { name: "Business formation", stages: ["Intake", "Drafting", "Done"] });
  const client = (await s.ok("POST", "/api/contacts", { name: "Acme Widgets LLC", kind: "company" })).id;
  const list = await s.ok("POST", "/api/checklists", {
    name: "LLC formation",
    practiceAreaId: area.id,
    items: [
      { key: "intake", title: "Intake call", role: "attorney", offsetDays: 2, businessDays: true },
      { key: "draft", title: "Draft articles", role: "paralegal", anchor: "after_deps", offsetDays: 3, dependsOn: ["intake"] },
      { key: "sign", title: "Signing meeting", role: "attorney", anchor: "field:closing_date", offsetDays: -1, businessDays: true },
    ],
  });
  return { atty, para, area, client, list };
}

test("serves the app and static files, and refuses paths outside public/", async () => {
  const s = await start();
  const home = await fetch(s.base + "/");
  assert.equal(home.status, 200);
  assert.match(home.headers.get("content-type")!, /text\/html/);
  assert.match(home.headers.get("content-security-policy")!, /default-src 'self'/);
  assert.match(await home.text(), /<div id="app">/);
  const js = await fetch(s.base + "/js/app.js");
  assert.match(js.headers.get("content-type")!, /javascript/);
  for (const p of ["/../src/db.ts", "/%2e%2e/src/db.ts", "/js/../../package.json"]) {
    const r = await fetch(s.base + p);
    assert.notEqual(r.status, 200, p);
  }
  assert.equal((await s.call("GET", "/api/nope")).status, 404);
  assert.equal((await s.call("PUT", "/api/setup")).status, 405);
});

test("errors: engine errors keep their status and message; bad JSON is 400; crashes are a generic 500", async () => {
  const boom = {
    name: "boom",
    routes: [
      { method: "GET", path: "/boom", handler: () => { throw new Error("secret detail"); } },
      { method: "GET", path: "/teapot", handler: () => { throw new EngineError("No tea", 418); } },
    ],
  };
  const s = await start({ modules: [...modules, boom] });
  const e1 = await s.call("GET", "/api/matters/999");
  assert.equal(e1.status, 404);
  assert.equal(e1.data.error, "Matter not found");
  const e2 = await s.call("POST", "/api/users", undefined, "{not json");
  assert.equal(e2.status, 400);
  const e3 = await s.call("GET", "/api/matters/abc");
  assert.equal(e3.status, 400);
  const e4 = await s.call("GET", "/api/boom");
  assert.equal(e4.status, 500);
  assert.doesNotMatch(JSON.stringify(e4.data), /secret detail/);
  assert.equal(s.errors.length, 1, "the crash is logged on the server");
  assert.equal((await s.call("GET", "/api/teapot")).status, 418);
});

test("raw responses, first-match route order and the body limit", async () => {
  const extra = {
    name: "extra",
    routes: [
      { method: "GET", path: "/docs/search", handler: () => ({ which: "search" }) },
      { method: "GET", path: "/docs/:id", handler: (ctx: any) => ({ which: "id", id: ctx.params.id }) },
      { method: "GET", path: "/feed/:file", handler: () => ({ __raw: true, contentType: "text/calendar; charset=utf-8", headers: { "X-Test": "1" }, body: "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n" }) },
      { method: "POST", path: "/echo", handler: (ctx: any) => ({ n: String(ctx.body.data).length }) },
    ],
  };
  const s = await start({ modules: [...modules, extra] });
  assert.equal((await s.ok("GET", "/api/docs/search")).which, "search");
  assert.deepEqual(await s.ok("GET", "/api/docs/7"), { which: "id", id: "7" });
  const feed = await s.call("GET", "/api/feed/abc.ics");
  assert.equal(feed.status, 200);
  assert.match(feed.headers.get("content-type")!, /text\/calendar/);
  assert.equal(feed.headers.get("x-test"), "1");
  assert.match(feed.data, /^BEGIN:VCALENDAR/);
  // A 2 MB body is fine (document uploads are base64 JSON); 35 MB is refused.
  assert.equal((await s.ok("POST", "/api/echo", { data: "x".repeat(2_000_000) })).n, 2_000_000);
  const big = await s.call("POST", "/api/echo", undefined, JSON.stringify({ data: "x".repeat(35 * 1024 * 1024) }));
  assert.equal(big.status, 413);
});

test("main flow: set up, open a matter, checklist tasks, finish one, see what it unlocked", async () => {
  const s = await start();
  const f = await firm(s);
  s.actAs(f.atty);
  const setup = await s.ok("GET", "/api/setup");
  assert.equal(setup.users.length, 3); // two people plus the test admin
  assert.deepEqual(setup.practiceAreas[0].stages.map((x: any) => x.name), ["Intake", "Drafting", "Done"]);

  const m = await s.ok("POST", "/api/matters", {
    name: "Acme formation",
    number: "24-001",
    clientId: f.client,
    practiceAreaId: f.area.id,
    roles: { attorney: f.atty, paralegal: f.para },
  });
  assert.equal(m.stage_id, f.area.stageIds[0]);
  const dup = await s.call("POST", "/api/matters", { name: "Other", number: "24-001" });
  assert.equal(dup.status, 409);

  const applied = await s.ok("POST", `/api/matters/${m.id}/checklists`, { listId: f.list.id });
  assert.equal(applied.added, 3);
  let d = await s.ok("GET", `/api/matters/${m.id}`);
  const byTitle = (t: string) => d.tasks.find((x: any) => x.title === t);
  assert.equal(byTitle("Intake call").due_date, "2026-11-18");
  assert.equal(byTitle("Draft articles").status, "waiting");
  assert.equal(byTitle("Draft articles").waiting_on[0].title, "Intake call");
  assert.equal(byTitle("Draft articles").waiting_on[0].assignee_name, "Attorney A");
  assert.equal(byTitle("Intake call").blocks.length, 1);
  assert.equal(byTitle("Signing meeting").due_date, null);

  // Setting the closing date dates the signing meeting and reports it.
  const dateRes = await s.ok("PUT", `/api/matters/${m.id}/dates/closing_date`, { value: "2026-12-04" });
  assert.equal(dateRes.redated.length, 1);
  assert.equal(dateRes.redated[0].due_date, "2026-12-03");

  // A waiting task can't be finished.
  const blocked = await s.call("POST", `/api/tasks/${byTitle("Draft articles").id}/complete`);
  assert.equal(blocked.status, 409);
  assert.match(blocked.data.error, /waiting on "Intake call"/);

  s.setToday("2026-11-17");
  const done = await s.ok("POST", `/api/tasks/${byTitle("Intake call").id}/complete`);
  assert.equal(done.task.status, "done");
  assert.equal(done.effects.unlocked.length, 1);
  assert.equal(done.effects.unlocked[0].title, "Draft articles");
  assert.equal(done.effects.unlocked[0].due_date, "2026-11-20");

  // Undo puts it back to waiting.
  const undo = await s.ok("POST", `/api/tasks/${byTitle("Intake call").id}/reopen`);
  assert.equal(undo.effects.relocked[0].title, "Draft articles");

  // My tasks buckets for the paralegal and the attorney.
  const mine = await s.ok("GET", `/api/my-tasks?userId=${f.para}`);
  assert.equal(mine.waiting.length, 1);
  assert.equal(mine.waiting[0].waiting_on[0].title, "Intake call");
  const atty = await s.ok("GET", `/api/my-tasks?userId=${f.atty}`);
  assert.equal(atty.upcoming.length, 1);
  assert.equal(atty.later.length, 1);

  // The activity log names who did it.
  d = await s.ok("GET", `/api/matters/${m.id}`);
  const finished = d.activity.find((a: any) => a.kind === "task_done");
  assert.equal(finished.user_name, "Attorney A");
});

test("tasks: quick-add style create, inline edits, skip, delete, firm filters", async () => {
  const s = await start();
  const f = await firm(s);
  const m = await s.ok("POST", "/api/matters", { name: "Acme", practiceAreaId: f.area.id, roles: { attorney: f.atty } });
  const a = await s.ok("POST", "/api/tasks", { title: "Call client", matterId: m.id, assigneeId: f.atty, dueDate: "2026-11-15", priority: "high" });
  assert.equal(a.task.matter_name, "Acme");
  const b = await s.ok("POST", "/api/tasks", { title: "Send letter", matterId: m.id, dependsOn: [a.task.id] });
  assert.equal(b.task.status, "waiting");
  const loose = await s.ok("POST", "/api/tasks", { title: "Order supplies" });
  assert.equal(loose.task.matter_id, null);
  assert.equal((await s.call("POST", "/api/tasks", { title: "  " })).status, 400);
  assert.equal((await s.call("POST", "/api/tasks", { title: "x", dueDate: "11/20/2026" })).status, 400);
  assert.equal((await s.call("POST", "/api/tasks", { title: "x", assigneeId: 999 })).status, 404);

  let my = await s.ok("GET", `/api/my-tasks?userId=${f.atty}`);
  assert.equal(my.overdue.length, 1);

  const moved = await s.ok("PATCH", `/api/tasks/${a.task.id}`, { dueDate: "2026-11-16", assigneeId: f.para, title: "Call client back" });
  assert.equal(moved.task.due_date, "2026-11-16");
  assert.equal(moved.task.assignee_name, "Paralegal P");
  assert.equal(moved.task.title, "Call client back");
  my = await s.ok("GET", `/api/my-tasks?userId=${f.para}`);
  assert.equal(my.dueToday.length, 1);

  const unassigned = await s.ok("GET", "/api/firm-tasks?unassigned=1");
  assert.deepEqual(unassigned.tasks.map((t: any) => t.title).sort(), ["Order supplies", "Send letter"]);
  const paras = await s.ok("GET", `/api/firm-tasks?assigneeId=${f.para}`);
  assert.equal(paras.tasks.length, 1);

  const skipped = await s.ok("POST", `/api/tasks/${a.task.id}/skip`);
  assert.equal(skipped.effects.unlocked[0].title, "Send letter");
  const doneList = await s.ok("GET", "/api/firm-tasks?status=skipped");
  assert.equal(doneList.tasks.length, 1);

  await s.ok("DELETE", `/api/tasks/${loose.task.id}`);
  assert.equal((await s.call("GET", `/api/tasks/${loose.task.id}`)).status, 404);
});

test("matters: stage moves run automations; roles move tasks; close needs every task finished", async () => {
  const s = await start();
  const f = await firm(s);
  const [intake, drafting, doneStage] = f.area.stageIds;
  await s.ok("POST", "/api/automations", { trigger: "stage_entered", triggerRef: drafting, action: "apply_list", actionRef: f.list.id });
  const auto2 = await s.ok("POST", "/api/automations", { trigger: "list_completed", triggerRef: f.list.id, action: "set_stage", actionRef: doneStage });
  assert.match(auto2.name, /finished/);
  assert.equal((await s.call("POST", "/api/automations", { trigger: "nope", triggerRef: 1, action: "apply_list", actionRef: 1 })).status, 400);

  // With two paralegals nobody is guessed for the paralegal step until the role is filled.
  await s.ok("POST", "/api/users", { name: "Second Paralegal", defaultRole: "paralegal" });
  const m = await s.ok("POST", "/api/matters", { name: "Acme", practiceAreaId: f.area.id, roles: { attorney: f.atty } });
  const moved = await s.ok("POST", `/api/matters/${m.id}/stage`, { stageId: drafting });
  assert.equal(moved.added, 3);
  assert.ok(moved.events.some((e: any) => e.kind === "automation"));

  // Paralegal role filled later: that role's open tasks move to them.
  const role = await s.ok("PUT", `/api/matters/${m.id}/roles/paralegal`, { userId: f.para });
  assert.match(role.events[0].detail, /1 open task/);

  const closeEarly = await s.call("POST", `/api/matters/${m.id}/close`);
  assert.equal(closeEarly.status, 409);

  let d = await s.ok("GET", `/api/matters/${m.id}`);
  const id = (t: string) => d.tasks.find((x: any) => x.title === t).id;
  await s.ok("POST", `/api/tasks/${id("Intake call")}/complete`);
  await s.ok("POST", `/api/tasks/${id("Signing meeting")}/skip`);
  const last = await s.ok("POST", `/api/tasks/${id("Draft articles")}/complete`);
  assert.ok(last.effects.events.some((e: any) => e.kind === "checklist_done"));
  d = await s.ok("GET", `/api/matters/${m.id}`);
  assert.equal(d.matter.stage_id, doneStage);
  assert.equal(d.checklists[0].finished, 3);

  const closed = await s.ok("POST", `/api/matters/${m.id}/close`);
  assert.equal(closed.status, "closed");
  assert.equal((await s.ok("GET", "/api/matters")).length, 0);
  assert.equal((await s.ok("GET", "/api/matters?status=closed")).length, 1);
  await s.ok("POST", `/api/matters/${m.id}/reopen`);
  const edited = await s.ok("PATCH", `/api/matters/${m.id}`, { name: "Acme Widgets formation" });
  assert.equal(edited.name, "Acme Widgets formation");
  void intake;
});

test("checklists: validation errors come back as 400; update can propagate to open tasks", async () => {
  const s = await start();
  const f = await firm(s);
  const loop = await s.call("POST", "/api/checklists", {
    name: "Bad",
    items: [
      { key: "a", title: "A", dependsOn: ["b"] },
      { key: "b", title: "B", dependsOn: ["a"] },
    ],
  });
  assert.equal(loop.status, 400);
  assert.match(loop.data.error, /loop/i);
  assert.equal((await s.call("POST", "/api/checklists", { name: "Empty", items: [] })).status, 400);

  const m = await s.ok("POST", "/api/matters", { name: "Acme", roles: { attorney: f.atty, paralegal: f.para } });
  await s.ok("POST", `/api/matters/${m.id}/checklists`, { listId: f.list.id });
  const before = await s.ok("GET", `/api/checklists/${f.list.id}`);
  assert.equal(before.open_tasks, 3);
  assert.equal(before.times_used, 1);

  const items = before.items.map((i: any) => (i.key === "intake" ? { ...i, title: "Intake meeting", offsetDays: 5 } : i));
  const noProp = await s.ok("PUT", `/api/checklists/${f.list.id}`, { name: before.name, practiceAreaId: f.area.id, items, propagate: false });
  assert.equal(noProp.changedTasks, 0);
  let d = await s.ok("GET", `/api/matters/${m.id}`);
  assert.ok(d.tasks.some((t: any) => t.title === "Intake call"));

  const prop = await s.ok("PUT", `/api/checklists/${f.list.id}`, { name: before.name, practiceAreaId: f.area.id, items, propagate: true });
  assert.equal(prop.changedTasks, 1);
  d = await s.ok("GET", `/api/matters/${m.id}`);
  const t = d.tasks.find((x: any) => x.title === "Intake meeting");
  assert.equal(t.due_date, "2026-11-23");

  assert.equal((await s.call("DELETE", `/api/checklists/${f.list.id}`)).status, 409);
});

test("settings: people, stages, date fields, closed days", async () => {
  const s = await start();
  const f = await firm(s);
  const u = await s.ok("PATCH", `/api/users/${f.para}`, { name: "Pat Paralegal", active: false });
  assert.equal(u.active, 0);
  const setup = await s.ok("GET", "/api/setup");
  assert.equal(setup.users.length, 2); // with the test admin
  assert.equal(setup.allUsers.length, 3);

  const st = await s.ok("POST", `/api/practice-areas/${f.area.id}/stages`, { name: "Archived" });
  const order = [st.id, ...f.area.stageIds];
  const reordered = await s.ok("PUT", `/api/practice-areas/${f.area.id}/stage-order`, { stageIds: order });
  assert.equal(reordered[0].name, "Archived");
  assert.equal((await s.call("PUT", `/api/practice-areas/${f.area.id}/stage-order`, { stageIds: [st.id] })).status, 400);
  await s.ok("PATCH", `/api/stages/${st.id}`, { name: "Archive" });
  await s.ok("DELETE", `/api/stages/${st.id}`);
  assert.equal((await s.call("POST", "/api/practice-areas", { name: "Business formation" })).status, 409);

  assert.equal((await s.call("POST", "/api/date-fields", { key: "closing_date", label: "Again" })).status, 409);
  assert.equal((await s.call("DELETE", "/api/date-fields/closing_date")).status, 409, "a checklist uses it");
  await s.ok("POST", "/api/date-fields", { key: "filing_date", label: "Filing date" });
  await s.ok("PATCH", "/api/date-fields/filing_date", { label: "Filed on" });
  await s.ok("DELETE", "/api/date-fields/filing_date");

  // Closing the firm on Wednesday pushes a 2-business-day task from Monday to Thursday.
  const m = await s.ok("POST", "/api/matters", { name: "Acme", roles: { attorney: f.atty } });
  await s.ok("POST", `/api/matters/${m.id}/checklists`, { listId: f.list.id });
  const hol = await s.ok("POST", "/api/holidays", { date: "2026-11-18", name: "Office closed" });
  assert.equal(hol.length, 1);
  let d = await s.ok("GET", `/api/matters/${m.id}`);
  assert.equal(d.tasks.find((t: any) => t.title === "Intake call").due_date, "2026-11-19");
  await s.ok("DELETE", "/api/holidays/2026-11-18");
  d = await s.ok("GET", `/api/matters/${m.id}`);
  assert.equal(d.tasks.find((t: any) => t.title === "Intake call").due_date, "2026-11-18");
});

test("the demo seed loads through the engine and serves sensible screens", async () => {
  const s = await start({ today: "2026-11-17" });
  const r = seed(s.db, "2026-11-17");
  const matters = await s.ok("GET", "/api/matters");
  assert.equal(matters.length, 15);
  assert.ok(matters.every((m: any) => m.stage_name), "every open matter has a stage");
  assert.ok(matters.every((m: any) => m.attorney_name), "every open matter has a responsible attorney");
  const closed = await s.ok("GET", "/api/matters?status=closed");
  assert.equal(closed.length, 3);
  assert.equal(closed.find((m: any) => m.number === "D-1001").stage_name, "Signed", "the finished checklist's automation moved it");
  const jordan = await s.ok("GET", `/api/my-tasks?userId=${r.users.jordan}`);
  assert.ok(jordan.overdue.length > 0 && jordan.waiting.length > 0);
  const contacts = await s.ok("GET", "/api/contacts");
  // Every demo client is marked in its notes (the app shows a "Demo data" banner from this).
  assert.ok(contacts.every((c: any) => /Fictional demo data/.test(c.notes)));
  // A non-empty database is refused by the CLI; here we just check seeding twice would clash.
  assert.throws(() => seed(s.db, "2026-11-17"));
});
