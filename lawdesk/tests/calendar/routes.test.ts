import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../../src/db.ts";
import { Engine } from "../../src/engine.ts";
import { type Ctx, matchPath } from "../../src/http.ts";
import { SCHEMA } from "../../src/calendar/schema.ts";
import { type RawResponse, routes } from "../../src/calendar/routes.ts";

function app() {
  const db = openDb();
  db.exec(SCHEMA);
  const engine = new Engine(db);
  const ann = engine.addUser("Ann Attorney", "attorney");
  const call = async (method: string, url: string, body: any = {}, userId: number | null = null) => {
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
  return { db, engine, ann, call };
}

test("routes: no two routes collide", () => {
  const seen = new Set<string>();
  for (const r of routes) {
    const k = `${r.method} ${r.path.replace(/:[^/]+/g, ":")}`;
    assert.ok(!seen.has(k), k);
    seen.add(k);
  }
});

test("routes: event CRUD, occurrences and agenda", async () => {
  const { call, ann } = app();
  const created = await call("POST", "/calendar/events", { title: "Weekly", start: "2026-03-02T09:00", rrule: "FREQ=WEEKLY;COUNT=3", attendees: [ann] }, ann);
  const id = created.event.id;
  assert.equal((await call("GET", `/calendar/events/${id}`)).title, "Weekly");
  await call("PATCH", `/calendar/events/${id}`, { location: "Room 1" }, ann);
  await call("DELETE", `/calendar/events/${id}/occurrences/${encodeURIComponent("20260309T140000Z")}`, {}, ann);
  let ag = await call("GET", `/calendar/agenda?from=2026-03-01&to=2026-03-31&user=${ann}`);
  assert.equal(ag.items.length, 2);
  await call("POST", `/calendar/events/${id}/occurrences/20260309T140000Z/restore`, {}, ann);
  await call("PATCH", `/calendar/events/${id}/occurrences/20260316T140000Z`, { title: "Moved" }, ann);
  ag = await call("GET", "/calendar/agenda?from=2026-03-01&to=2026-03-31&scope=firm");
  assert.deepEqual(ag.items.map((i: any) => i.title), ["Weekly", "Weekly", "Moved"]);
  assert.equal((await call("GET", "/calendar/events")).length, 1);
  assert.deepEqual(await call("GET", "/calendar/availability?users=1&start=2026-03-02T09:30&end=2026-03-02T09:45").then((b: any) => b.length), 1);
  assert.equal((await call("GET", "/calendar/reminders?from=2026-03-01T00:00:00Z&to=2026-04-01T00:00:00Z")).length, 0);
  await call("DELETE", `/calendar/events/${id}`, {}, ann);
  assert.equal((await call("GET", "/calendar/events")).length, 0);
});

test("routes: feed token create → feed is text/calendar → revoke → 404", async () => {
  const { call, ann } = app();
  await call("POST", "/calendar/events", { title: "Hearing", start: "2099-03-02T09:00", attendees: [ann] }, ann);
  const t = await call("POST", "/calendar/feed-tokens", { userId: ann, label: "Outlook" });
  assert.equal(t.url, `/api/calendar/feed/${t.token}.ics`);
  const res: RawResponse = await call("GET", `/calendar/feed/${t.token}.ics`);
  assert.equal(res.__raw, true);
  assert.equal(res.status, 200);
  assert.equal(res.contentType, "text/calendar; charset=utf-8");
  assert.match(res.body, /SUMMARY:Hearing\r\n/);
  const list = await call("GET", `/calendar/feed-tokens?user=${ann}`);
  assert.equal(list.length, 1);
  assert.ok(!JSON.stringify(list).includes(t.token));
  await call("DELETE", `/calendar/feed-tokens/${t.id}`, {}, ann);
  const gone: RawResponse = await call("GET", `/calendar/feed/${t.token}.ics`);
  assert.equal(gone.status, 404);
  assert.equal(gone.contentType.split(";")[0], "text/plain");
});

test("routes: import", async () => {
  const { call } = app();
  const r = await call("POST", "/calendar/import", {
    ics: "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:a\r\nSUMMARY:Imported\r\nDTSTART;VALUE=DATE:20260401\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n",
    kind: "court_deadline",
  });
  assert.equal(r.created.length, 1);
  const [e] = await call("GET", "/calendar/events?source=ics_import");
  assert.deepEqual([e.title, e.kind, e.allDay], ["Imported", "court_deadline", true]);
});
