import { test } from "node:test";
import assert from "node:assert/strict";
import { authHeaders } from "../auth/http.ts";
import type { AddressInfo } from "node:net";
import { openDb } from "../../src/db.ts";
import { createServer } from "../../src/server.ts";
import { routes } from "../../src/trust/routes.ts";
import { Engine } from "../../src/engine.ts";

test("routes: no two trust routes share a method and path", () => {
  const keys = routes.map((r) => `${r.method} ${r.path}`);
  assert.equal(new Set(keys).size, keys.length);
  for (const r of routes) assert.ok(r.path.startsWith("/trust/"));
});

test("routes: account, deposit, payment, reconciliation and printable reports over HTTP", async () => {
  const db = openDb();
  const day = "2026-10-15";
  const server = createServer(db, { today: () => day, log: () => {} });
  const engine = new Engine(db, { today: () => day });
  const atty = engine.addUser("Attorney A", "attorney");
  const client = engine.addContact("Client <b>One</b> (demo)");
  const matter = engine.createMatter({ name: "Matter & Co", number: "T-1", clientId: client });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, {
      method,
      headers: { "Content-Type": "application/json", ...authHeaders(db, atty) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const type = res.headers.get("content-type") ?? "";
    return { status: res.status, type, csp: res.headers.get("content-security-policy"), data: type.includes("json") ? await res.json() : await res.text() };
  };
  try {
    const bad = await call("POST", "/trust/accounts", { name: "IOLTA", bankName: "Bank", kind: "iolta" });
    assert.equal(bad.status, 400);
    assert.match(bad.data.error, /Kansas/);
    const a = (await call("POST", "/trust/accounts", { name: "IOLTA", bankName: "Bank (demo)", kind: "iolta", inKansas: true, openedOn: "2026-01-01" })).data;
    const dep = await call("POST", `/trust/accounts/${a.id}/deposits`, { matterId: matter, amountCents: 50000, party: "Client <script>", date: "2026-10-01" });
    assert.equal(dep.status, 200);
    assert.equal((await call("PUT", `/trust/entries/${dep.data.id}/cleared`, { clearedOn: "2026-10-02" })).data.cleared_on, "2026-10-02");
    const over = await call("POST", `/trust/accounts/${a.id}/disbursements`, { matterId: matter, amountCents: 50001, party: "X", method: "eft", memo: "x", date: "2026-10-03" });
    assert.equal(over.status, 409);
    assert.match(over.data.error, /below zero/);
    await call("POST", `/trust/accounts/${a.id}/disbursements`, { matterId: matter, amountCents: 1000, party: "X", method: "check", checkNumber: "101", memo: "Fee", date: "2026-10-03" });
    const rec = (await call("GET", `/trust/accounts/${a.id}/reconcile/2026-10?statement=50000`)).data;
    assert.equal(rec.preview.balanced, true);
    assert.equal(rec.preview.outstanding.length, 1);
    await call("PUT", `/trust/accounts/${a.id}/reconcile/2026-10`, { statementBalanceCents: 50000 });
    const signed = await call("POST", `/trust/accounts/${a.id}/reconcile/2026-10/sign`);
    assert.equal(signed.data.status, "signed");
    const ledgers = (await call("GET", `/trust/accounts/${a.id}/ledgers`)).data;
    const lid = ledgers.find((l: any) => l.kind === "client").id;

    for (const path of [
      `/trust/ledgers/${lid}/print`,
      `/trust/accounts/${a.id}/journal/print?from=2026-10-01&to=2026-10-31`,
      `/trust/accounts/${a.id}/balances/print`,
      `/trust/accounts/${a.id}/inactive/print?months=1`,
      `/trust/accounts/${a.id}/reconciliations/print`,
      `/trust/accounts/${a.id}/reconciliations/2026-10/print`,
      `/trust/rules/print`,
    ]) {
      const r = await call("GET", path);
      assert.equal(r.status, 200, path);
      assert.match(r.type, /text\/html/, path);
      assert.match(r.csp ?? "", /default-src 'none'/, path);
      assert.doesNotMatch(r.data, /<script|<b>One/, `${path} escapes user text`);
    }
    const stmt = (await call("GET", `/trust/ledgers/${lid}/print`)).data;
    assert.match(stmt, /Client &lt;b&gt;One&lt;\/b&gt;/);
    assert.match(stmt, /five years after the representation ends/);
    const rules = (await call("GET", "/trust/rules")).data;
    assert.ok(rules.rules.length >= 8);
    assert.ok(rules.gaps.some((g: any) => /Handbook/.test(g.what)));
    assert.equal(rules.retentionYears, 5);
    const log = db.prepare("SELECT * FROM activity WHERE kind LIKE 'trust_%' ORDER BY id").all() as any[];
    assert.ok(log.length >= 5);
    assert.ok(log.every((r) => r.user_id === atty));
  } finally {
    server.close();
  }
});
