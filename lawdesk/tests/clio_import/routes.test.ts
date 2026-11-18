import { after, test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { openDb } from "../../src/db.ts";
import { createServer } from "../../src/server.ts";
import { clioSetup } from "../../src/clio_import/routes.ts";
import { FakeClio, fakeFirm } from "./fake_clio.ts";
import { fixture } from "./helpers.ts";

const closers: (() => Promise<void>)[] = [];
after(() => Promise.all(closers.map((c) => c())));

async function start() {
  const db = openDb();
  const server = createServer(db, { today: () => "2026-03-15", log: () => {} });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  closers.push(() => new Promise((r) => server.close(() => r())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: res.status, json, text, headers: res.headers };
  };
  db.prepare("INSERT INTO users (name, default_role) VALUES ('Jordan Reyes','attorney'), ('Riley Chen','attorney')").run();
  return { db, call };
}

test("routes: kinds, preview, trial run, import, run list, report and problems file", async () => {
  const { db, call } = await start();
  const kinds = await call("GET", "/clio-import/kinds");
  assert.equal(kinds.status, 200);
  assert.deepEqual(kinds.json.map((k: any) => k.kind), ["contacts", "matters", "tasks", "calendar", "time", "expenses", "trust_balances"]);

  const csv = fixture("contacts_migration.csv");
  const p = await call("POST", "/clio-import/preview", { kind: "contacts", csv });
  assert.equal(p.status, 200);
  assert.equal(p.json.counts.ready, 5);
  assert.equal(p.json.headers[2], "first_name");

  const bad = await call("POST", "/clio-import/preview", { kind: "invoices", csv });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /Choose what the file holds/);

  const dry = await call("POST", "/clio-import/import", { kind: "contacts", csv, dryRun: true, fileName: "contacts.csv" });
  assert.equal(dry.json.dryRun, true);
  assert.equal((db.prepare("SELECT COUNT(*) n FROM contacts").get() as any).n, 0);
  const real = await call("POST", "/clio-import/import", { kind: "contacts", csv, mapping: p.json.mapping, fileName: "contacts.csv" });
  assert.equal(real.json.byType.Contacts.created, 5);
  await call("POST", "/clio-import/import", { kind: "matters", csv: fixture("matters_migration.csv") });

  const runs = await call("GET", "/clio-import/runs");
  assert.equal(runs.json.length, 3);
  const one = await call("GET", `/clio-import/runs/${real.json.runId}`);
  assert.equal(one.json.report.fileName, "contacts.csv");
  const probs = await call("GET", `/clio-import/runs/${runs.json[0].id}/problems.csv`);
  assert.match(probs.headers.get("content-type")!, /text\/csv/);
  assert.match(probs.text, /^What,Line,Record,Reason\r\n/);
  assert.match(probs.text, /Skipped,5,Matters: Row 5,/);
  assert.equal((await call("GET", "/clio-import/runs/999")).status, 404);

  const rec = await call("GET", "/clio-import/reconciliation");
  assert.equal(rec.json.counts.matters, 3);
});

test("routes: API connection when not set up, then sign-in round trip and a full import", async () => {
  const { db, call } = await start();
  const saved = { ...clioSetup };
  closers.push(async () => Object.assign(clioSetup, saved));

  clioSetup.config = () => null;
  assert.deepEqual((await call("GET", "/clio-import/api/status")).json, { configured: false });
  assert.equal((await call("POST", "/clio-import/api/connect")).status, 400);

  const fake = await new FakeClio({ now: () => Date.now(), data: fakeFirm(20) }).listen();
  closers.push(() => fake.close());
  clioSetup.config = () => ({ clientId: "test-client", clientSecret: "test-secret", redirectUri: "http://x/cb", region: "us", host: fake.url, tokenKey: "k" });
  clioSetup.deps = { sleep: async () => {} };

  let st = (await call("GET", "/clio-import/api/status")).json;
  assert.equal(st.configured, true);
  assert.equal(st.connected, false);
  assert.equal(st.encrypted, true);
  const { url } = (await call("POST", "/clio-import/api/connect")).json;
  const state = new URL(url).searchParams.get("state");

  const badCb = await call("GET", `/clio-import/oauth/callback?code=good-code&state=nope`);
  assert.equal(badCb.status, 303);
  assert.match(badCb.headers.get("location")!, /error=/);
  const cb = await call("GET", `/clio-import/oauth/callback?code=good-code&state=${state}`);
  assert.equal(cb.status, 303);
  assert.equal(cb.headers.get("location"), "/#/settings/import-clio?connected=1");
  assert.equal((await call("GET", "/clio-import/api/status")).json.connected, true);

  const job = (await call("POST", "/clio-import/api/jobs")).json;
  assert.ok(job.id);
  for (let i = 0; i < 200; i++) {
    st = (await call("GET", "/clio-import/api/status")).json;
    if (st.job.status !== "running") break;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(st.job.status, "done", st.job.error ?? "");
  assert.equal((db.prepare("SELECT COUNT(*) n FROM contacts").get() as any).n, 20);
  assert.equal((await call("POST", `/clio-import/api/jobs/${job.id}/resume`)).status, 400);

  await call("POST", "/clio-import/api/disconnect");
  assert.equal((await call("GET", "/clio-import/api/status")).json.connected, false);
  assert.equal(fake.accessTokens.size, 0, "the token was revoked at Clio");
});
