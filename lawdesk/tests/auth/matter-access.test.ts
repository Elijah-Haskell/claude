// Matter restrictions across modules, over real HTTP: a restricted matter's billing,
// documents, calendar, conflicts, contacts, trust, reports, email, payments, e-signature
// and intake records are hidden from anyone not on its list. All data is made up.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { openDb } from "../../src/db.ts";
import { Engine } from "../../src/engine.ts";
import { createServer } from "../../src/server.ts";
import { Documents } from "../../src/documents/documents.ts";
import { setDocuments } from "../../src/documents/routes.ts";
import { routes as trustRoutes } from "../../src/trust/routes.ts";
import { routes as reportRoutes } from "../../src/reports/routes.ts";
import { matterIdsInRequest } from "../../src/auth/access.ts";
import { signedInAs } from "./helpers.ts";

const TODAY = "2026-11-18";
const filesDir = mkdtempSync(join(tmpdir(), "lawdesk-access-"));
const servers: any[] = [];
after(() => {
  servers.forEach((s) => s.close());
  rmSync(filesDir, { recursive: true, force: true });
});

async function setup() {
  const db = openDb();
  setDocuments(db, new Documents(db, { dir: filesDir, today: () => TODAY }));
  const server = createServer(db, { today: () => TODAY, log: () => {} });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  servers.push(server);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const engine = new Engine(db, { today: () => TODAY });

  const as = (cookie: string) => {
    const call = async (method: string, path: string, body?: unknown) => {
      const headers: Record<string, string> = { Cookie: cookie, "X-Requested-With": "lawdesk" };
      if (body !== undefined) headers["Content-Type"] = "application/json";
      const res = await fetch(base + "/api" + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await res.text();
      let data: any = text;
      try {
        data = JSON.parse(text);
      } catch {}
      return { status: res.status, data };
    };
    const ok = async (method: string, path: string, body?: unknown) => {
      const r = await call(method, path, body);
      assert.equal(r.status, 200, `${method} ${path} -> ${r.status} ${JSON.stringify(r.data)}`);
      return r.data;
    };
    return { call, ok };
  };

  const adminId = engine.addUser("Avery Admin (demo)");
  const attorneyId = engine.addUser("Riley Attorney (demo)");
  const walledId = engine.addUser("Casey Staff (demo)");
  const insideId = engine.addUser("Sam Staff (demo)");
  const admin = as(signedInAs(db, adminId, "admin").cookie);
  const riley = as(signedInAs(db, attorneyId, "attorney").cookie);
  const casey = as(signedInAs(db, walledId, "staff").cookie);
  const sam = as(signedInAs(db, insideId, "staff").cookie);

  const client = engine.addContact("Harbor Mill Co. (demo)", "company");
  const adverse = engine.addContact("Quill Lane Partners (demo)", "company");
  const open = engine.createMatter({ name: "Ordinary lease (demo)", number: "T-1", clientId: client });
  const secret = engine.createMatter({ name: "Sealed acquisition (demo)", number: "T-2", clientId: client });
  return { db, engine, admin, riley, casey, sam, ids: { adminId, attorneyId, walledId, insideId }, client, adverse, open, secret };
}

test("the server finds the matter a request names in its path, query or body", () => {
  const q = (s: string) => new URLSearchParams(s);
  assert.deepEqual(matterIdsInRequest("/matters/:id/documents", { id: "7" }, q(""), {}), [7]);
  assert.deepEqual(matterIdsInRequest("/billing/matters/:matterId/rates/:userId", { matterId: "3", userId: "9" }, q(""), {}), [3]);
  assert.deepEqual(matterIdsInRequest("/calendar/agenda", {}, q("matter=4&from=x"), {}), [4]);
  assert.deepEqual(matterIdsInRequest("/billing/time", {}, q("matterId=5"), { matterId: 6 }), [5, 6]);
  assert.deepEqual(matterIdsInRequest("/documents/:id", { id: "8" }, q(""), { matterId: "abc" }), []);
});

test("trust and reports routes are for attorneys and administrators only", () => {
  for (const r of [...trustRoutes, ...reportRoutes]) assert.deepEqual(r.roles, ["admin", "attorney"], `${r.method} ${r.path}`);
});

test("staff get 403 from trust and firm-wide reports; attorneys get in", async () => {
  const s = await setup();
  assert.equal((await s.sam.call("GET", "/trust/accounts")).status, 403);
  assert.equal((await s.sam.call("POST", "/trust/accounts", { name: "x" })).status, 403);
  assert.equal((await s.sam.call("GET", "/reports/dashboard")).status, 403);
  assert.equal((await s.sam.call("GET", "/reports")).status, 403);
  assert.equal((await s.riley.call("GET", "/trust/accounts")).status, 200);
  assert.equal((await s.riley.call("GET", "/reports/dashboard")).status, 200);
});

test("a restricted matter's records in every module are hidden from people not on its list", async () => {
  const s = await setup();
  const { admin, riley, casey, sam, open, secret } = s;

  // Records on both matters, made by the administrator.
  for (const m of [open, secret]) {
    await admin.ok("POST", "/billing/time", { matterId: m, userId: s.ids.adminId, date: "2026-11-02", minutes: 90, description: `Drafting ${m}` });
    await admin.ok("POST", "/billing/expenses", { matterId: m, date: "2026-11-02", description: `Filing fee ${m}`, costCents: 5000 });
  }
  const secretInvoice = await admin.ok("POST", "/billing/invoices", { matterId: secret });
  await admin.ok("POST", `/billing/invoices/${secretInvoice.id}/finalize`);
  const openInvoice = await admin.ok("POST", "/billing/invoices", { matterId: open });
  await admin.ok("POST", `/billing/invoices/${openInvoice.id}/finalize`);
  for (const m of [open, secret]) await admin.ok("POST", "/billing/time", { matterId: m, userId: s.ids.adminId, date: "2026-11-10", minutes: 30, description: `Call ${m}` });
  const secretTime = (await admin.ok("GET", `/billing/time?matterId=${secret}`))[0];
  const doc = await admin.ok("POST", `/matters/${secret}/documents`, { filename: "Term sheet.txt", contentBase64: Buffer.from("Confidential term sheet").toString("base64") });
  await admin.ok("POST", `/matters/${open}/documents`, { filename: "Lease.txt", contentBase64: Buffer.from("Ordinary lease").toString("base64") });
  const event = (await admin.ok("POST", "/calendar/events", { title: "Closing call (demo)", kind: "meeting", matterId: secret, start: "2026-11-20T10:00" })).event;
  await admin.ok("POST", "/calendar/events", { title: "Lease walk-through (demo)", kind: "meeting", matterId: open, start: "2026-11-20T14:00" });
  const party = await admin.ok("POST", `/conflicts/matters/${secret}/parties`, { contactId: s.adverse, role: "adverse_party" });
  const check = await admin.ok("POST", "/conflict-checks", { matterId: secret });
  const comm = await admin.ok("POST", `/matters/${secret}/communications/log`, { kind: "phone", participants: "Client", durationMinutes: 10, notes: "Price discussed" });
  const account = await riley.ok("POST", "/trust/accounts", { name: "IOLTA (demo)", bankName: "Bank (demo)", kind: "iolta", inKansas: true, openedOn: "2026-01-01" });
  await riley.ok("POST", `/trust/accounts/${account.id}/deposits`, { matterId: secret, amountCents: 100000, party: "Client (demo)", date: "2026-11-03" });
  await riley.ok("POST", `/trust/accounts/${account.id}/deposits`, { matterId: open, amountCents: 20000, party: "Client (demo)", date: "2026-11-03" });
  const secretLedger = (await riley.ok("GET", `/trust/accounts/${account.id}/ledgers`)).find((l: any) => l.matter_id === secret);

  // Restrict the matter to Riley and Sam.
  await admin.ok("PUT", `/matters/${secret}/access`, { userIds: [s.ids.attorneyId, s.ids.insideId] });

  const notFound = async (who: typeof casey, method: string, path: string, body?: unknown) => {
    const r = await who.call(method, path, body);
    assert.equal(r.status, 404, `${method} ${path} should be hidden, got ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
  };

  // Routes that name the matter: refused by the server for every module.
  for (const path of [
    `/matters/${secret}/documents`,
    `/matters/${secret}/communications`,
    `/matters/${secret}/esign`,
    `/billing/matters/${secret}`,
    `/billing/time?matterId=${secret}`,
    `/billing/invoices?matterId=${secret}`,
    `/billing/reports/wip?matterId=${secret}`,
    `/calendar/agenda?scope=firm&matter=${secret}&from=2026-11-01&to=2026-11-30`,
    `/conflicts/matters/${secret}/parties`,
    `/conflict-checks?matterId=${secret}`,
    `/pay/matters/${secret}`,
  ])
    await notFound(casey, "GET", path);
  await notFound(casey, "POST", "/billing/time", { matterId: secret, userId: s.ids.walledId, minutes: 6, description: "x" });
  await notFound(casey, "POST", "/calendar/events", { title: "x", matterId: secret, start: "2026-11-21T09:00" });
  await notFound(casey, "POST", "/deadlines/add-to-matter", { matterId: secret });

  // Records looked up by their own id.
  for (const path of [
    `/billing/time/${secretTime.id}`,
    `/billing/invoices/${secretInvoice.id}`,
    `/billing/invoices/${secretInvoice.id}/print`,
    `/documents/${doc.id}`,
    `/documents/${doc.id}/file`,
    `/documents/${doc.id}/esign`,
    `/calendar/events/${event.id}`,
    `/conflict-checks/${check.id}`,
    `/conflict-checks/${check.id}/report`,
    `/conflicts/checks/${check.id}`,
    `/communications/${comm.id}`,
    `/pay/invoices/${secretInvoice.id}/links`,
  ])
    await notFound(casey, "GET", path);
  await notFound(casey, "PATCH", `/conflicts/parties/${party.id}`, { role: "co_party" });
  await notFound(casey, "DELETE", `/documents/${doc.id}`);
  await notFound(casey, "POST", `/billing/invoices/${secretInvoice.id}/payments`, { amountCents: 100 });
  await notFound(casey, "POST", "/esign/requests", { documentId: doc.id, signerName: "x", signerEmail: "x@example.test" });

  // Lists that span matters leave the restricted one out.
  const has = (rows: any[], key: string, id: number) => rows.some((r) => r[key] === id);
  assert.ok(!has(await casey.ok("GET", "/billing/time"), "matter_id", secret));
  assert.ok(has(await casey.ok("GET", "/billing/time"), "matter_id", open));
  assert.ok(!has(await casey.ok("GET", "/billing/expenses"), "matter_id", secret));
  assert.ok(!has(await casey.ok("GET", "/billing/invoices"), "matter_id", secret));
  const wip = await casey.ok("GET", "/billing/reports/wip");
  assert.deepEqual(wip.rows.map((r: any) => r.matter_id), [open]);
  assert.equal(wip.totals.total_cents, wip.rows[0].total_cents, "totals cover only the rows shown");
  const aging = await casey.ok("GET", "/billing/reports/aging");
  assert.ok(aging.rows.every((c: any) => c.invoices.every((i: any) => i.id !== secretInvoice.id)));
  assert.equal(aging.totals.total, aging.rows.reduce((t: number, c: any) => t + c.total, 0));
  const statement = await casey.ok("GET", `/billing/clients/${s.client}/statement`);
  assert.ok(!JSON.stringify(statement).includes("Sealed acquisition"), "the statement doesn't name the matter");
  assert.match(JSON.stringify(statement.lines), /restricted matter/);
  const found = await casey.ok("GET", "/documents/search?q=term");
  assert.ok(found.results.every((d: any) => d.matterId !== secret));
  assert.ok((await casey.ok("GET", "/documents/search")).results.some((d: any) => d.matterId === open));
  const agenda = await casey.ok("GET", "/calendar/agenda?scope=firm&from=2026-11-01&to=2026-11-30&tasks=0");
  assert.ok(agenda.items.every((i: any) => i.matterId !== secret));
  assert.ok(agenda.items.some((i: any) => i.matterId === open));
  assert.ok((await casey.ok("GET", "/calendar/events")).every((e: any) => e.matterId !== secret));
  assert.ok((await casey.ok("GET", "/conflict-checks")).every((k: any) => k.matterId !== secret));
  const profile = await casey.ok("GET", `/contacts/${s.client}/profile`);
  assert.deepEqual(profile.matters.map((m: any) => m.id), [open]);

  // A new conflict check still finds the walled matter's party, but doesn't name the matter.
  const fresh = await casey.ok("POST", "/conflict-checks", { terms: [{ name: "Quill Lane Partners", kind: "company" }] });
  const hit = fresh.results.find((h: any) => h.contactId === s.adverse);
  assert.ok(hit, "the hit is still reported");
  assert.ok(!JSON.stringify(fresh).includes("Sealed acquisition"), "no matter name in the result");
  assert.ok(hit.involvements.some((i: any) => i.restricted && i.matterId === null));

  // Trust: staff never reach it; an attorney on the list sees the ledger.
  const rileyLedgers = await riley.ok("GET", `/trust/accounts/${account.id}/ledgers`);
  assert.ok(rileyLedgers.some((l: any) => l.matter_id === secret), "Riley is on the list");
  assert.equal((await casey.call("GET", `/trust/ledgers/${secretLedger.id}`)).status, 403, "staff never reach trust");

  // Take Riley off the list: trust ledgers and reports leave the matter out for him.
  s.db.prepare("DELETE FROM auth_matter_access WHERE user_id = ?").run(s.ids.attorneyId);
  assert.equal((await riley.call("GET", `/trust/ledgers/${secretLedger.id}`)).status, 404);
  assert.ok((await riley.ok("GET", `/trust/accounts/${account.id}/ledgers`)).every((l: any) => l.matter_id !== secret));
  assert.equal((await riley.call("GET", `/trust/matters/${secret}/ledgers`)).status, 404);
  assert.equal((await riley.call("GET", `/reports/matters?matterId=${secret}`)).status, 404);
  const report = await riley.ok("GET", "/reports/matters");
  assert.ok(report.rows.every((r: any) => r._links?.matter !== `#/matters/${secret}`));
  const catalogue = await riley.ok("GET", "/reports");
  assert.ok(catalogue.matters.every((m: any) => m.id !== secret));

  // People on the list, and administrators, see everything.
  assert.equal((await sam.ok("GET", `/documents/${doc.id}`)).id, doc.id);
  assert.ok(has(await sam.ok("GET", "/billing/invoices"), "matter_id", secret));
  assert.equal((await admin.ok("GET", `/conflict-checks/${check.id}`)).id, check.id);
  assert.ok((await admin.ok("GET", "/reports/matters")).rows.some((r: any) => r._links?.matter === `#/matters/${secret}`));
});

test("a converted lead doesn't name a matter that was restricted afterwards", async () => {
  const s = await setup();
  const lead = await s.admin.ok("POST", "/intake/leads", { name: "Pat Example (demo)", email: "pat@example.test", source: "phone" });
  await s.admin.ok("POST", `/intake/leads/${lead.id}/conflict-decision`, { decision: "cleared" });
  const conv = await s.admin.ok("POST", `/intake/leads/${lead.id}/convert`, { matterNumber: "T-9" });
  assert.equal((await s.casey.ok("GET", `/intake/leads/${lead.id}`)).matterId, conv.matterId);
  await s.admin.ok("PUT", `/matters/${conv.matterId}/access`, { userIds: [s.ids.insideId] });
  const seen = await s.casey.ok("GET", `/intake/leads/${lead.id}`);
  assert.equal(seen.matterId, null);
  assert.equal(seen.matterName, null);
  assert.equal(seen.matterRestricted, true);
  assert.ok((await s.casey.ok("GET", "/intake/leads")).every((l: any) => l.matterId !== conv.matterId));
  assert.equal((await s.sam.ok("GET", `/intake/leads/${lead.id}`)).matterId, conv.matterId);
});
