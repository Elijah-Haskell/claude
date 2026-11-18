import { after, test } from "node:test";
import assert from "node:assert/strict";
import { ClioClient, Pacer, configFromEnv, decrypt, encrypt, type ClioConfig, type FetchFn } from "../../src/clio_import/api.ts";
import { ApiImport } from "../../src/clio_import/api_job.ts";
import { mapActivity, mapCalendarEntry, mapTask } from "../../src/clio_import/api_map.ts";
import { reconciliation } from "../../src/clio_import/report.ts";
import { FakeClio, fakeFirm } from "./fake_clio.ts";
import { setup } from "./helpers.ts";

const fakes: FakeClio[] = [];
after(() => Promise.all(fakes.map((f) => f.close())));

/** A fake Clio, a Lawdesk database and a client wired to a clock that only moves when the client waits. */
async function world(o: { limit?: number; tokenKey?: string | null; nContacts?: number; fetchWrap?: (f: FetchFn) => FetchFn } = {}) {
  let clock = Date.parse("2026-03-15T15:00:00Z");
  const now = () => clock;
  const fake = await new FakeClio({ now, limit: o.limit ?? 50, data: fakeFirm(o.nContacts ?? 450) }).listen();
  fakes.push(fake);
  const s = setup();
  const cfg: ClioConfig = {
    clientId: "test-client",
    clientSecret: "test-secret",
    redirectUri: "http://localhost:3000/api/clio-import/oauth/callback",
    region: "us",
    host: fake.url,
    tokenKey: o.tokenKey === undefined ? "a test key, not a real secret" : o.tokenKey,
  };
  const waits: number[] = [];
  const baseFetch: FetchFn = (url, init) => fetch(url, init as RequestInit) as any;
  const client = new ClioClient(s.db, cfg, {
    fetch: o.fetchWrap ? o.fetchWrap(baseFetch) : baseFetch,
    now,
    sleep: async (ms) => {
      waits.push(ms);
      clock += ms;
    },
  });
  const connect = async () => {
    const url = new URL(client.authorizeUrl(s.jordan));
    await client.completeAuthorization({ code: "good-code", state: url.searchParams.get("state") });
  };
  const job = new ApiImport(s.db, s.engine, client, { now: () => new Date(clock) });
  return { ...s, fake, cfg, client, connect, job, waits, now, advance: (ms: number) => (clock += ms) };
}

test("config: read from the environment; region picks Clio's host", () => {
  assert.equal(configFromEnv({}), null);
  const c = configFromEnv({ CLIO_CLIENT_ID: "id", CLIO_CLIENT_SECRET: "s", CLIO_REGION: "ca", PORT: "4000" })!;
  assert.equal(c.host, "https://ca.app.clio.com");
  assert.equal(c.redirectUri, "http://localhost:4000/api/clio-import/oauth/callback");
  assert.equal(c.tokenKey, null);
  assert.throws(() => configFromEnv({ CLIO_CLIENT_ID: "id", CLIO_CLIENT_SECRET: "s", CLIO_REGION: "mars" }), /CLIO_REGION/);
});

test("oauth: authorize link, state checked once, code swapped for tokens, tokens stored encrypted", async () => {
  const w = await world();
  const url = new URL(w.client.authorizeUrl(w.jordan));
  assert.equal(url.pathname, "/oauth/authorize");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("client_id"), "test-client");
  assert.equal(url.searchParams.get("redirect_uri"), w.cfg.redirectUri);
  const state = url.searchParams.get("state")!;
  assert.ok(state.length >= 20);
  await assert.rejects(w.client.completeAuthorization({ code: "good-code", state: "forged" }), /expired or was not started here/);
  await w.client.completeAuthorization({ code: "good-code", state });
  await assert.rejects(w.client.completeAuthorization({ code: "good-code", state }), /expired or was not started here/, "a state works once");
  const call = w.fake.tokenCalls[0];
  assert.deepEqual(
    { grant: call.grant_type, code: call.code, redirect: call.redirect_uri, secret: call.client_secret },
    { grant: "authorization_code", code: "good-code", redirect: w.cfg.redirectUri, secret: "test-secret" },
  );
  const row = w.one("SELECT * FROM clio_import_tokens");
  assert.equal(row.encrypted, 1);
  assert.ok(!row.access_token.includes("at-") && !row.refresh_token.includes("rt-"), "no plain tokens in the database");
  const tok = w.client.tokens.get()!;
  assert.match(tok.accessToken, /^at-/);
  assert.equal(tok.expiresAt, w.now() + 2592000 * 1000);
  await assert.rejects(w.client.completeAuthorization({ error: "access_denied", state }), /declined/);
});

test("oauth: an expired access token is refreshed and the request retried; refresh token kept", async () => {
  const w = await world();
  await w.connect();
  const before = w.client.tokens.get()!;
  w.fake.expireAccessTokens();
  const page = await w.client.get("/api/v4/users.json?fields=id,name&order=id(asc)");
  assert.equal(page.data.length, 3);
  const after = w.client.tokens.get()!;
  assert.notEqual(after.accessToken, before.accessToken);
  assert.equal(after.refreshToken, before.refreshToken);
  assert.equal(w.fake.tokenCalls.at(-1)!.grant_type, "refresh_token");
});

test("oauth: without CLIO_TOKEN_KEY tokens are stored as plain text (the screen warns)", async () => {
  const w = await world({ tokenKey: null });
  await w.connect();
  assert.equal(w.one("SELECT encrypted FROM clio_import_tokens").encrypted, 0);
  assert.equal(encrypt.length, 2);
  assert.equal(decrypt(encrypt("hello", "k"), "k"), "hello");
  assert.throws(() => decrypt(encrypt("hello", "k"), "other key"));
});

test("client: never sends the token to another host", async () => {
  const w = await world();
  await w.connect();
  await assert.rejects(w.client.get("https://evil.example.com/api/v4/users.json"), /another site/);
});

test("pacer: default 50 a minute; spreads what is left of the window; waits for reset when used up", () => {
  const p = new Pacer();
  assert.equal(p.delay(0), 0);
  p.sent(0);
  assert.equal(p.delay(0), 1200);
  p.update({ get: (k: string) => ({ "X-RateLimit-Limit": "50", "X-RateLimit-Remaining": "12", "X-RateLimit-Reset": "100" })[k] ?? null });
  // 10 usable requests (2 held back) over the 100 s left: one every 10 s.
  assert.equal(p.delay(0), 10_000);
  p.update({ get: (k: string) => ({ "X-RateLimit-Remaining": "2" })[k] ?? null });
  assert.equal(p.delay(40_000), 60_000 + 250);
});

test("api import: every page of every resource, mapped into Lawdesk", async () => {
  const w = await world();
  await w.connect();
  const id = w.job.create(w.jordan);
  await w.job.runToEnd(id);
  const st = w.job.status(id)!;
  assert.equal(st.status, "done", st.error ?? "");
  assert.equal(st.resources.find((r) => r.name === "contacts")!.pages, 3, "450 contacts = 3 pages of 200");
  assert.equal(st.resources.find((r) => r.name === "contacts")!.records, 450);
  // Every page request used cursor paging.
  for (const l of w.fake.log) assert.match(l.path, /order=id%28asc%29|order=id\(asc\)/);

  assert.equal(w.one("SELECT COUNT(*) n FROM contacts").n, 450);
  // People: Jordan matched by email (not duplicated); Sam added; the disabled user added as inactive.
  assert.equal(w.one("SELECT COUNT(*) n FROM users WHERE name = 'Jordan Reyes'").n, 1);
  assert.equal(w.one("SELECT active FROM users WHERE name = 'Former Associate'").active, 0);
  const lease = w.one("SELECT * FROM matters WHERE number = '00501-Sample'");
  assert.equal(w.one("SELECT name FROM contacts WHERE id = ?", lease.client_id).name, "Person1 Sample");
  assert.equal(w.one("SELECT user_id FROM matter_roles WHERE matter_id = ? AND role = 'attorney'", lease.id).user_id, w.jordan);
  assert.ok(w.one("SELECT 1 FROM matter_roles r JOIN users u ON u.id = r.user_id WHERE r.matter_id = ? AND r.role = 'originating attorney' AND u.name = 'Former Associate'", lease.id));
  assert.equal(w.one("SELECT status FROM matters WHERE number = '00502-Holdings'").status, "closed");
  const t = w.one("SELECT * FROM tasks WHERE title = 'Review title'");
  assert.equal(t.priority, "high");
  assert.equal(w.one("SELECT name FROM users WHERE id = ?", t.assignee_id).name, "Sam Patel");
  assert.equal(w.one("SELECT completed_on FROM tasks WHERE title = 'File articles'").completed_on, "2025-02-09");
  assert.match(w.one("SELECT description FROM tasks WHERE title = 'Client to send documents'").description, /in review/);
  assert.equal(w.one("SELECT all_day, start_date, end_date FROM cal_events WHERE title = 'Office closed'").end_date, "2026-03-30");

  const r = st.report!;
  assert.equal(r.totals.unbilledTimeCents, 37500);
  assert.equal(r.totals.billedTimeCents, 50000);
  assert.equal(r.totals.unbilledExpenseCents, 3550);
  assert.equal(r.totals.nonBillableTimeMinutes, 18);
  assert.ok(r.skipped.some((x) => /no matter/i.test(x.reason)), "the activity without a matter is listed as skipped");
  assert.ok(r.warnings.some((x) => /assigned to a contact/i.test(x.message)));
  const rec = reconciliation(w.db);
  assert.equal(rec.counts.contacts, 450);
  assert.equal(rec.counts.matters, 3);
  assert.equal(rec.counts.billedTimeEntries, 1);
  assert.equal(w.one("SELECT status FROM clio_import_runs WHERE id = ?", st.runId).status, "done");
});

test("api import: keeps under the rate limit by waiting, without ever being refused", async () => {
  const w = await world({ limit: 3, nContacts: 450 });
  await w.connect();
  const id = w.job.create();
  await w.job.runToEnd(id);
  assert.equal(w.job.status(id)!.status, "done");
  const ok = w.fake.log.filter((l) => l.status === 200);
  assert.equal(ok.length, 8, "1 users + 3 contacts + 1 matters + 1 tasks + 1 calendar + 1 activities");
  assert.equal(w.fake.log.filter((l) => l.status === 429).length, 0);
  // No 60-second window ever saw more than the limit.
  for (const a of ok) assert.ok(ok.filter((b) => b.at >= a.at && b.at < a.at + 60_000).length <= 3);
  assert.ok(w.waits.some((ms) => ms > 5000), "it paused for the window to reset");
});

test("api import: a 429 is waited out (Retry-After) and the request repeated", async () => {
  const w = await world();
  await w.connect();
  w.fake.force429 = 2;
  const id = w.job.create();
  await w.job.runToEnd(id);
  assert.equal(w.job.status(id)!.status, "done");
  assert.equal(w.fake.log.filter((l) => l.status === 429).length, 2);
  assert.equal(w.one("SELECT COUNT(*) n FROM contacts").n, 450);
});

test("api import: interrupted part-way, resumed by a fresh process, finishes with no duplicates", async () => {
  let calls = 0;
  let broken = false;
  const w = await world({
    fetchWrap: (f) => async (url, init) => {
      if (url.includes("/api/v4/") && ++calls === 4) broken = true; // the network drops on the 4th page
      if (broken && url.includes("/api/v4/")) throw new Error("socket hang up");
      return f(url, init);
    },
  });
  await w.connect();
  const id = w.job.create();
  await w.job.runToEnd(id);
  let st = w.job.status(id)!;
  assert.equal(st.status, "failed");
  assert.match(st.error!, /Can't reach Clio/);
  assert.equal(st.resources.find((r) => r.name === "contacts")!.pages, 2, "two contact pages were saved");
  assert.equal(w.one("SELECT COUNT(*) n FROM contacts").n, 400);

  // The network comes back; a new ApiImport (as after a server restart) picks up the job.
  broken = false;
  calls = 100;
  const again = new ApiImport(w.db, w.engine, w.client);
  await again.runToEnd(id);
  st = again.status(id)!;
  assert.equal(st.status, "done", st.error ?? "");
  assert.equal(w.one("SELECT COUNT(*) n FROM contacts").n, 450);
  assert.equal(w.one("SELECT COUNT(*) n FROM clio_import_map WHERE kind = 'contact'").n, 450);
  assert.equal(st.report!.byType.Contacts.created, 450);
  assert.equal(st.report!.totals.unbilledTimeCents, 37500);
});

test("api import: pause stops after the current page; resume carries on", async () => {
  const w = await world();
  await w.connect();
  const id = w.job.create();
  w.job.start(id);
  await w.job.pause(id);
  assert.equal(w.job.status(id)!.status, "paused");
  assert.equal(w.job.status(id)!.active, false);
  await assert.rejects(async () => w.job.create(), /already under way/);
  await w.job.runToEnd(id);
  assert.equal(w.job.status(id)!.status, "done");
  assert.equal(w.one("SELECT COUNT(*) n FROM contacts").n, 450);
});

test("api import: running it again later updates instead of duplicating", async () => {
  const w = await world({ nContacts: 30 });
  await w.connect();
  await w.job.runToEnd(w.job.create());
  const before = w.one("SELECT (SELECT COUNT(*) FROM contacts) c, (SELECT COUNT(*) FROM matters) m, (SELECT COUNT(*) FROM billing_time_entries) t, (SELECT COUNT(*) FROM tasks) k").c;
  w.fake.opts.data.contacts[0].primary_phone_number = "785-555-9999";
  const id2 = w.job.create();
  await w.job.runToEnd(id2);
  const r = w.job.status(id2)!.report!;
  assert.equal(r.byType.Contacts.updated, 1);
  assert.equal(r.byType.Contacts.unchanged, 29);
  assert.equal(r.byType.Matters.unchanged, 3);
  assert.equal(r.byType["Time and expenses"].unchanged, 4);
  assert.equal(w.one("SELECT COUNT(*) n FROM contacts").n, before);
  assert.equal(w.one("SELECT phone FROM contacts WHERE name = 'Person1 Sample'").phone, "785-555-9999");
});

test("api import: needs a connection first", async () => {
  const w = await world();
  assert.throws(() => w.job.create(), /Connect to Clio first/);
});

test("api mapping: activity hours from quantity_in_hours, or seconds when only quantity is given", () => {
  assert.equal((mapActivity({ id: 1, type: "TimeEntry", date: "2026-01-02", quantity_in_hours: 0.5, price: 100, matter: { id: 1 } }).rec as any).minutes, 30);
  assert.equal((mapActivity({ id: 1, type: "TimeEntry", date: "2026-01-02", quantity: 5400, price: 100, matter: { id: 1 } }).rec as any).minutes, 90);
  const fee = mapActivity({ id: 2, type: "FixedFee", date: "2026-01-02", price: 1500, total: 1500, matter: { id: 1 } }).rec as any;
  assert.equal(fee.flat, true);
  assert.equal(fee.amountCents, 150000);
  assert.match(mapActivity({ id: 3, type: "TimeEntry", date: "2026-01-02", matter: null }).errors[0], /no matter/);
  assert.equal((mapTask({ id: 4, name: "x", due_at: "2026-03-09T03:00:00Z", status: "pending" }).rec as any).due, "2026-03-08");
  assert.match(mapCalendarEntry({ id: 5, summary: "x" }).errors[0], /no start/);
});
