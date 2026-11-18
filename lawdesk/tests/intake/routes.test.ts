import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, caller } from "./helpers.ts";
import { routes } from "../../src/intake/routes.ts";
import { intakeReport } from "../../src/intake/reports.ts";
import { createServer } from "../../src/server.ts";
import type { AddressInfo } from "node:net";

test("every route is unique, under /intake, and only the four public ones skip sign-in", () => {
  const seen = new Set<string>();
  for (const r of routes) {
    assert.ok(r.path.startsWith("/intake/"), r.path);
    const key = r.method + " " + r.path;
    assert.ok(!seen.has(key), key);
    seen.add(key);
  }
  const pub = routes.filter((r: any) => r.public).map((r) => `${r.method} ${r.path}`).sort();
  assert.deepEqual(pub, [
    "GET /intake/public/booking/:token",
    "GET /intake/public/forms/:token",
    "POST /intake/public/booking/:token",
    "POST /intake/public/forms/:token",
  ]);
  for (const r of routes as any[]) if (r.path.includes("/public/")) assert.equal(r.public, true, r.path);
});

test("staff API: add, move, note, decide, convert", async () => {
  const env = setup();
  const call = caller(env, env.jordan);
  const add = await call("POST", "/intake/leads", { name: "Avery Stone", email: "avery@example.test", practiceAreaId: env.area.id });
  assert.equal(add.status, 200);
  const id = add.data.id;
  assert.equal((await call("POST", `/intake/leads/${id}/status`, { status: "contacted" })).data.status, "contacted");
  assert.equal((await call("POST", `/intake/leads/${id}/status`, { status: "not_hired" })).status, 400);
  assert.equal((await call("POST", `/intake/leads/${id}/notes`, { body: "Left a voicemail" })).data.notes.length, 1);
  assert.equal((await call("GET", "/intake/leads?status=contacted")).data.length, 1);
  assert.equal((await call("POST", `/intake/leads/${id}/convert`, {})).status, 409);
  assert.equal((await call("POST", `/intake/leads/${id}/conflict-decision`, { decision: "cleared" })).status, 200);
  const conv = await call("POST", `/intake/leads/${id}/convert`, { matterNumber: "D-2001" });
  assert.equal(conv.status, 200);
  assert.equal(conv.data.lead.status, "hired");
  assert.equal((await call("GET", "/intake/leads/999")).status, 404);
  const opts = await call("GET", "/intake/options");
  assert.equal(opts.data.statuses.length, 6);
  assert.ok(opts.data.settings.bookingToken);
  const rep = await call("GET", "/intake/reports");
  assert.equal(rep.data.totals.hired, 1);
  assert.equal((await call("GET", "/intake/reports?from=2026-12-01&to=2026-11-01")).status, 400);
});

test("form and booking public routes over HTTP, with the caller's address", async () => {
  const env = setup();
  const server = createServer(env.db, { today: () => "2026-11-18", log: () => {} });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  try {
    const call = caller(env, env.jordan);
    const form = (await call("POST", "/intake/forms", { name: "Website", ownerId: env.jordan })).data;
    const def = await (await fetch(`${base}/intake/public/forms/${form.token}`)).json();
    assert.equal(def.title, "Website");
    // Sent too soon after loading.
    const fast = await fetch(`${base}/intake/public/forms/${form.token}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Requested-With": "lawdesk" }, body: JSON.stringify({ stamp: def.stamp, answers: {} }) });
    assert.equal(fast.status, 400);
    const missing = await fetch(`${base}/intake/public/forms/nope-nope-nope`);
    assert.equal(missing.status, 404);
    const booking = await fetch(`${base}/intake/public/booking/${env.it.settings().booking_token}`);
    assert.equal(booking.status, 200);
    assert.deepEqual((await booking.json()).days, []);
  } finally {
    server.close();
  }
});

test("reports: by source, conversion and time to hire", () => {
  const { it, db, jordan } = setup();
  const mk = (name: string, source: string | null, received: string) => {
    const l = it.createLead({ name, source, email: `${name.split(" ")[0].toLowerCase()}@example.test` });
    db.prepare("UPDATE intake_leads SET received_on = ? WHERE id = ?").run(received, l.id);
    return l.id;
  };
  const a = mk("Ann Hill", "Web search", "2026-11-01");
  const b = mk("Bo Lane", "Web search", "2026-11-05");
  const c = mk("Cy Moss", "Referral from a client", "2026-11-10");
  mk("Di Nash", null, "2026-11-12");
  mk("Old Lead", "Web search", "2026-01-01");
  for (const id of [a, c]) {
    it.decideConflict(id, "cleared", null, jordan);
    it.convert(id, {}, jordan);
  }
  db.prepare("UPDATE intake_leads SET hired_on = '2026-11-11' WHERE id = ?").run(a); // 10 days
  db.prepare("UPDATE intake_leads SET hired_on = '2026-11-14' WHERE id = ?").run(c); // 4 days
  it.setStatus(b, "not_hired", { reason: "Fees or budget" }, jordan);
  const r = intakeReport(it, { from: "2026-11-01", to: "2026-11-18" });
  assert.equal(r.totals.leads, 4);
  assert.equal(r.totals.hired, 2);
  assert.equal(r.totals.conversionPct, 50);
  assert.equal(r.totals.decidedConversionPct, 66.7);
  assert.deepEqual(r.bySource.map((s) => [s.source, s.leads, s.hired]), [["Web search", 2, 1], ["Not given", 1, 0], ["Referral from a client", 1, 1]]);
  assert.equal(r.timeToHire.medianDays, 7);
  assert.equal(r.timeToHire.fastestDays, 4);
  assert.deepEqual(r.notHiredReasons, [{ reason: "Fees or budget", count: 1 }]);
  assert.ok(r.definitions.conversion.startsWith("Conversion rate:"));
  assert.equal(r.pipeline.find((p) => p.status === "new")!.count, 2);
});
