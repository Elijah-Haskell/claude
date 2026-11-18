// The conflicts API, called through the route table the server will mount.
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../../src/db.ts";
import { Engine } from "../../src/engine.ts";
import { matchPath, type Route } from "../../src/http.ts";
import { SCHEMA } from "../../src/conflicts/schema.ts";
import { routes } from "../../src/conflicts/routes.ts";

function api(userId: number | null = null) {
  const db = openDb();
  db.exec(SCHEMA);
  const engine = new Engine(db, { today: () => "2026-11-18" });
  async function call(method: Route["method"], url: string, body: any = {}) {
    const u = new URL(url, "http://x");
    for (const r of routes) {
      if (r.method !== method) continue;
      const params = matchPath(r.path, u.pathname);
      if (!params) continue;
      try {
        return { status: 200, data: (await r.handler({ db, engine, params, query: u.searchParams, body, userId })) as any };
      } catch (e: any) {
        return { status: e.status ?? 500, data: { error: e.message } };
      }
    }
    return { status: 404, data: { error: "no route" } };
  }
  return { db, engine, call };
}

test("every route path is unique and lives under /conflicts", () => {
  const seen = new Set<string>();
  for (const r of routes) {
    assert.ok(r.path.startsWith("/conflicts/"), r.path);
    const key = r.method + " " + r.path;
    assert.ok(!seen.has(key), key);
    seen.add(key);
  }
});

test("aliases CRUD", async () => {
  const { engine, call } = api();
  const c = engine.addContact("Mary Johnson");
  const add = await call("POST", `/conflicts/contacts/${c}/aliases`, { name: "Mary Peterson", kind: "maiden_name" });
  assert.equal(add.status, 200);
  const id = add.data.id;
  assert.equal((await call("GET", `/conflicts/contacts/${c}/aliases`)).data[0].name, "Mary Peterson");
  assert.equal((await call("PATCH", `/conflicts/aliases/${id}`, { name: "Mary Petersen" })).data.name, "Mary Petersen");
  assert.equal((await call("POST", `/conflicts/contacts/${c}/aliases`, { name: "X", kind: "bogus" })).status, 400);
  assert.equal((await call("POST", `/conflicts/contacts/999/aliases`, { name: "X" })).status, 404);
  assert.equal((await call("DELETE", `/conflicts/aliases/${id}`)).data.ok, true);
  assert.equal((await call("GET", `/conflicts/contacts/${c}/aliases`)).data.length, 0);
  assert.equal((await call("DELETE", `/conflicts/aliases/${id}`)).status, 404);
});

test("relationships CRUD", async () => {
  const { engine, call } = api();
  const john = engine.addContact("John Smith");
  const acme = engine.addContact("Acme LLC", "company");
  const add = await call("POST", "/conflicts/relationships", { fromContactId: john, toContactId: acme, kind: "officer" });
  assert.equal(add.status, 200);
  assert.equal((await call("POST", "/conflicts/relationships", { fromContactId: john, toContactId: acme, kind: "officer" })).status, 409);
  assert.equal((await call("PATCH", `/conflicts/relationships/${add.data.id}`, { kind: "owner" })).data.kind, "owner");
  assert.equal((await call("GET", `/conflicts/contacts/${acme}/relationships`)).data[0].description, "John Smith is an owner of Acme LLC");
  assert.equal((await call("POST", "/conflicts/relationships", { fromContactId: "abc", toContactId: acme, kind: "owner" })).status, 400);
  assert.equal((await call("DELETE", `/conflicts/relationships/${add.data.id}`)).data.ok, true);
  assert.equal((await call("GET", `/conflicts/contacts/${john}/relationships`)).data.length, 0);
});

test("matter parties CRUD, logged to the matter's activity", async () => {
  const { call: call2, engine: e2 } = api();
  const client = e2.addContact("Kate Brennan");
  const adverse = e2.addContact("Robert Kowalski");
  const atty = e2.addUser("Attorney A");
  const m = e2.createMatter({ name: "Brennan v. Kowalski", clientId: client });
  const add = await call2("POST", `/conflicts/matters/${m}/parties`, { contactId: adverse, role: "adverse_party", userId: atty });
  assert.equal(add.status, 200);
  assert.equal((await call2("POST", `/conflicts/matters/${m}/parties`, { contactId: adverse, role: "adverse_party" })).status, 409);
  assert.equal((await call2("POST", `/conflicts/matters/${m}/parties`, { contactId: adverse, role: "judge" })).status, 400);
  const list = (await call2("GET", `/conflicts/matters/${m}/parties`)).data;
  assert.deepEqual(list.map((p: any) => [p.contact_name, p.role]), [["Kate Brennan", "client"], ["Robert Kowalski", "adverse_party"]]);
  assert.equal((await call2("PATCH", `/conflicts/parties/${add.data.id}`, { role: "co_party" })).data.role, "co_party");
  assert.equal((await call2("DELETE", `/conflicts/parties/${add.data.id}`)).data.ok, true);
  const act = e2.getMatter(m).activity.map((a: any) => [a.kind, a.user_id]);
  assert.deepEqual(act.filter((a: any) => a[0].startsWith("party_")), [["party_removed", null], ["party_changed", null], ["party_added", atty]]);
});

test("POST /conflicts/search saves a check; preview does not; decide and link through the API", async () => {
  const { db, engine, call } = api();
  const atty = engine.addUser("Attorney A");
  const bob = engine.addContact("Robert Kowalski");
  const kate = engine.addContact("Kate Brennan");
  const m = engine.createMatter({ name: "Brennan v. Kowalski", number: "2026-001", clientId: kate });
  await call("POST", `/conflicts/matters/${m}/parties`, { contactId: bob, role: "adverse_party" });

  const preview = await call("POST", "/conflicts/search", { name: "Bob Kowalski", preview: true });
  assert.equal(preview.data.checkId, null);
  assert.equal(preview.data.hits[0].contactId, bob);
  assert.equal((db.prepare("SELECT COUNT(*) n FROM conflicts_checks").get() as any).n, 0);

  const run = await call("POST", "/conflicts/search", { terms: [{ name: "Bob Kowalski", role: "client" }], userId: atty });
  assert.equal(run.status, 200);
  assert.ok(run.data.checkId);
  assert.equal(run.data.hits[0].severity, "high");

  const pending = await call("GET", "/conflicts/checks?pending=1");
  assert.deepEqual(pending.data.map((k: any) => k.id), [run.data.checkId]);
  assert.equal(pending.data[0].runByName, "Attorney A");

  const newMatter = engine.createMatter({ name: "Kowalski estate plan" });
  const linked = await call("PATCH", `/conflicts/checks/${run.data.checkId}`, { matterId: newMatter });
  assert.equal(linked.data.matterId, newMatter);
  assert.equal((await call("PATCH", `/conflicts/checks/${run.data.checkId}`, {})).status, 400);

  assert.equal((await call("POST", `/conflicts/checks/${run.data.checkId}/decision`, { decision: "waived" })).status, 400);
  const decided = await call("POST", `/conflicts/checks/${run.data.checkId}/decision`, { decision: "declined", note: "Adverse to current client", userId: atty });
  assert.equal(decided.data.decision, "declined");
  assert.equal(decided.data.decidedByName, "Attorney A");
  assert.equal((await call("GET", "/conflicts/checks?pending=1")).data.length, 0);
  assert.equal((await call("GET", `/conflicts/checks?matterId=${newMatter}`)).data.length, 1);
  const full = await call("GET", `/conflicts/checks/${run.data.checkId}`);
  assert.equal(full.data.results[0].contactId, bob);
  assert.equal(full.data.decisions.length, 1);
  assert.equal((await call("GET", "/conflicts/checks/999")).status, 404);
  assert.equal((await call("POST", "/conflicts/search", {})).status, 400);
});

test("the signed-in user wins over a userId in the body", async () => {
  const db = openDb();
  db.exec(SCHEMA);
  const engine = new Engine(db);
  const a = engine.addUser("A");
  const b = engine.addUser("B");
  const r = routes.find((x) => x.path === "/conflicts/search")!;
  const out: any = await r.handler({ db, engine, params: {}, query: new URLSearchParams(), body: { name: "Nobody", userId: b }, userId: a });
  assert.equal((db.prepare("SELECT run_by FROM conflicts_checks WHERE id = ?").get(out.checkId) as any).run_by, a);
});
