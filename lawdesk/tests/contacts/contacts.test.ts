// The contact book, contact details, saved-check history, plain-English reasons and the
// printable conflict report, driven over HTTP through the real server.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { authHeaders } from "../auth/http.ts";
import type { AddressInfo } from "node:net";
import { openDb } from "../../src/db.ts";
import { createServer } from "../../src/server.ts";
import { seed } from "../../src/seed.ts";
import { plainReasons, countsText, bandCounts } from "../../src/contacts/plain.ts";
import { esc } from "../../src/contacts/report.ts";

const servers: any[] = [];
after(() => servers.forEach((s) => s.close()));

async function start({ withSeed = false } = {}) {
  const db = openDb();
  const server = createServer(db, { today: () => "2026-11-18", log: () => {} });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  servers.push(server);
  const demo = withSeed ? seed(db, "2026-11-18") : null;
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  async function call(method: string, path: string, body?: unknown, user?: number) {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    Object.assign(headers, authHeaders(db, user));
    const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let data: any = text;
    try {
      data = JSON.parse(text);
    } catch {}
    return { status: res.status, data, headers: res.headers };
  }
  const ok = async (method: string, path: string, body?: unknown, user?: number) => {
    const r = await call(method, path, body, user);
    assert.equal(r.status, 200, `${method} ${path} -> ${r.status} ${JSON.stringify(r.data)}`);
    return r.data;
  };
  return { db, demo, call, ok };
}

test("plain reasons read as sentences, without scores or rule codes", () => {
  const base = { contactId: 1, name: "Robert Kline", kind: "person", score: 0.92, band: "possible", match: "direct", rule: "nickname", relations: [], onProposedMatter: [], concerns: [], severity: "none", reasons: [] } as any;
  const r = plainReasons({
    ...base,
    matches: [{ term: "Bob Klein", matchedName: "Robert Kline", via: "name", aliasKind: null, score: 0.92, rules: ["nickname", "sounds alike"] }],
    involvements: [{ matterId: 3, matter: "D-1 Lease", status: "closed", closedOn: "2025-03-01", role: "adverse_party", text: "" }],
  });
  assert.deepEqual(r, [
    "“Bob Klein” is close to Robert Kline: a common nickname for the same first name and a name that sounds alike.",
    "Adverse party in matter D-1 Lease (closed 2025).",
  ]);
  const alias = plainReasons({ ...base, involvements: [], matches: [{ term: "Mary Peterson", matchedName: "Mary Peterson", via: "alias", aliasKind: "maiden_name", score: 1, rules: [] }] });
  assert.equal(alias[0], "“Mary Peterson” is recorded as Robert Kline’s maiden name.");
  assert.equal(alias[1], "Not on any matter.");
  for (const line of [...r, ...alias]) assert.ok(!/\d\.\d\d/.test(line), line);
  assert.equal(countsText(bandCounts([{ band: "strong" }, { band: "weak" }, { band: "strong" }])), "2 strong, 1 weak");
  assert.equal(countsText(bandCounts([])), "No matches");
});

test("esc escapes everything that could become markup", () => {
  assert.equal(esc(`<script>"a" & 'b'</script>`), "&lt;script&gt;&quot;a&quot; &amp; &#39;b&#39;&lt;/script&gt;");
});

test("directory searches names, other names, email, phone digits and address; filters by kind", async () => {
  const s = await start();
  const acme = await s.ok("POST", "/contacts", { name: "Acme Widgets LLC", kind: "company", email: "info@acme.example", phone: "(316) 555-0101" });
  const jo = await s.ok("POST", "/contacts", { name: "Jo Smith", kind: "person" });
  await s.ok("POST", `/conflicts/contacts/${jo.id}/aliases`, { name: "Josephine Smythe", kind: "former_name" });
  await s.ok("POST", `/contacts/${jo.id}/details`, { kind: "address", label: "Home", line1: "12 Elm St", city: "Topeka", region: "KS", postalCode: "66603" });
  const names = async (q: string, kind = "") => (await s.ok("GET", `/directory?q=${encodeURIComponent(q)}&kind=${kind}`)).contacts.map((c: any) => c.name);
  assert.deepEqual(await names("smythe"), ["Jo Smith"]);
  assert.deepEqual(await names("acme.example"), ["Acme Widgets LLC"]);
  assert.deepEqual(await names("316.555.0101"), ["Acme Widgets LLC"]);
  assert.deepEqual(await names("elm topeka"), ["Jo Smith"]);
  assert.deepEqual(await names("", "company"), ["Acme Widgets LLC"]);
  const all = await s.ok("GET", "/directory");
  assert.equal(all.total, 2);
  const row = all.contacts.find((c: any) => c.id === jo.id);
  assert.deepEqual(row.aliases, ["Josephine Smythe"]);
  assert.equal(row.city, "Topeka, KS");
  assert.equal(all.contacts.find((c: any) => c.id === acme.id).matters, 0);
});

test("contact details: add, validate, edit, remove, all logged", async () => {
  const s = await start();
  const c = await s.ok("POST", "/contacts", { name: "Pat Lee" });
  const phone = await s.ok("POST", `/contacts/${c.id}/details`, { kind: "phone", label: "Cell", value: "785-555-0123" });
  assert.equal(phone.value, "785-555-0123");
  assert.equal((await s.call("POST", `/contacts/${c.id}/details`, { kind: "email", value: "not-an-email" })).status, 400);
  assert.equal((await s.call("POST", `/contacts/${c.id}/details`, { kind: "phone", value: "12" })).status, 400);
  assert.equal((await s.call("POST", `/contacts/${c.id}/details`, { kind: "address", label: "Home" })).status, 400);
  assert.equal((await s.call("POST", `/contacts/${c.id}/details`, { kind: "fax", value: "1" })).status, 400);
  assert.equal((await s.call("POST", `/contacts/999/details`, { kind: "phone", value: "785-555-0123" })).status, 404);
  const edited = await s.ok("PATCH", `/contact-details/${phone.id}`, { label: "Work" });
  assert.equal(edited.label, "Work");
  assert.equal(edited.value, "785-555-0123");
  await s.ok("DELETE", `/contact-details/${phone.id}`);
  assert.equal((await s.call("DELETE", `/contact-details/${phone.id}`)).status, 404);
  const log = s.db.prepare("SELECT kind FROM activity WHERE kind LIKE 'contact_detail_%' ORDER BY id").all().map((r: any) => r.kind);
  assert.deepEqual(log, ["contact_detail_added", "contact_detail_changed", "contact_detail_removed"]);
});

test("profile shows matters with roles, relationships both ways, and checks that found the contact", async () => {
  const s = await start();
  const client = await s.ok("POST", "/contacts", { name: "Prairie Bakery LLC", kind: "company" });
  const owner = await s.ok("POST", "/contacts", { name: "Dana Ruiz", kind: "person" });
  const other = await s.ok("POST", "/contacts", { name: "Oven Supply Co", kind: "company" });
  const m = await s.ok("POST", "/matters", { name: "Lease", clientId: client.id });
  await s.ok("POST", `/conflicts/matters/${m.id}/parties`, { contactId: other.id, role: "adverse_party" });
  await s.ok("POST", "/conflicts/relationships", { fromContactId: owner.id, toContactId: client.id, kind: "owner" });
  const k = await s.ok("POST", "/conflict-checks", { terms: [{ name: "Oven Supply Company", role: "client" }] });
  assert.ok(k.results.some((h: any) => h.contactId === other.id && h.plain.length && h.bandLabel));

  const pc = await s.ok("GET", `/contacts/${client.id}/profile`);
  assert.deepEqual(pc.matters.map((x: any) => [x.name, x.role]), [["Lease", "client"]]);
  assert.equal(pc.relationships[0].direction, "to");
  assert.equal(pc.relationships[0].other_name, "Dana Ruiz");
  const po = await s.ok("GET", `/contacts/${owner.id}/profile`);
  assert.equal(po.relationships[0].direction, "from");
  const pa = await s.ok("GET", `/contacts/${other.id}/profile`);
  assert.equal(pa.matters[0].roleLabel, "adverse party");
  assert.deepEqual(pa.checks.map((x: any) => x.id), [k.id]);
  assert.equal((await s.call("GET", "/contacts/999/profile")).status, 404);
});

test("saved checks: history filters, plain results, decision and link", async () => {
  const s = await start({ withSeed: true });
  const { users, matters, checks } = s.demo!;
  // Intake leads add their own checks; these assertions are about the two seeded here.
  const seeded = (id: number) => id === checks.intakeCheck || id === checks.leaseCheck;
  const all = await s.ok("GET", "/conflict-checks");
  assert.deepEqual(all.map((k: any) => k.id).filter(seeded), [checks.intakeCheck, checks.leaseCheck]);
  assert.deepEqual((await s.ok("GET", "/conflict-checks?decision=pending")).map((k: any) => k.id).filter(seeded), [checks.intakeCheck]);
  assert.deepEqual((await s.ok("GET", "/conflict-checks?decision=cleared")).map((k: any) => k.id).filter(seeded), [checks.leaseCheck]);
  assert.deepEqual((await s.ok("GET", "/conflict-checks?q=cottonwood")).map((k: any) => k.id).filter(seeded), [checks.leaseCheck]);
  // The lease check also finds the same client on another of the firm's matters, so it has a strong match too.
  assert.ok((await s.ok("GET", "/conflict-checks?hits=strong")).some((k: any) => k.id === checks.intakeCheck));
  assert.ok((await s.ok("GET", "/conflict-checks?hits=none")).every((k: any) => k.hit_count === 0 || k.hitCount === 0 || !seeded(k.id)));
  assert.deepEqual((await s.ok("GET", "/conflict-checks?linked=yes")).map((k: any) => k.id).filter(seeded), [checks.leaseCheck]);
  assert.deepEqual((await s.ok("GET", `/conflict-checks?matterId=${matters.m3}`)).map((k: any) => k.id).filter(seeded), [checks.leaseCheck]);
  assert.equal((await s.ok("GET", "/conflict-checks?from=2026-11-18&to=2026-11-18")).filter((k: any) => seeded(k.id)).length, 1);
  assert.equal((await s.call("GET", "/conflict-checks?from=yesterday")).status, 400);
  assert.equal((await s.call("GET", "/conflict-checks?decision=maybe")).status, 400);

  // The seeded intake check: a current client named as adverse party, and a related contact.
  const k = await s.ok("GET", `/conflict-checks/${checks.intakeCheck}`);
  assert.ok(k.counts.strong >= 1 && k.counts.strong + k.counts.possible + k.counts.weak >= 2, JSON.stringify(k.counts));
  const strong = k.results.find((h: any) => h.band === "strong");
  assert.match(strong.concerns[0], /Proposed adverse party is a current client/);
  assert.ok(k.results.every((h: any) => Array.isArray(h.plain) && h.plain.length > 0), "every result explains itself in plain words");

  // Decide and link through the conflicts API; the history reflects it.
  await s.ok("POST", `/conflicts/checks/${checks.intakeCheck}/decision`, { decision: "declined" }, users.riley);
  await s.ok("PATCH", `/conflicts/checks/${checks.intakeCheck}`, { matterId: matters.m2 });
  const row = (await s.ok("GET", `/conflict-checks?matterId=${matters.m2}`))[0];
  assert.equal(row.decision, "declined");
  assert.equal(row.decidedByName, "Riley Chen");
});

test("the printable report is self-contained, escaped and downloadable", async () => {
  const s = await start();
  const evil = await s.ok("POST", "/contacts", { name: `<img src=x onerror=alert(1)> Ltd`, kind: "company" });
  const k = await s.ok("POST", "/conflict-checks", { terms: [{ name: "<img src=x onerror=alert(1)> Ltd", kind: "company", role: "adverse_party" }] });
  assert.equal(k.results[0].contactId, evil.id);
  await s.ok("POST", `/conflicts/checks/${k.id}/decision`, { decision: "waived", note: "Consent <filed> in drawer 2" });
  const r = await s.call("GET", `/conflict-checks/${k.id}/report`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type")!, /text\/html/);
  assert.match(r.headers.get("content-security-policy")!, /default-src 'none'/);
  const html: string = r.data;
  assert.ok(!html.includes("<img"), "names are escaped");
  assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt; Ltd"));
  assert.ok(html.includes("Consent &lt;filed&gt; in drawer 2"));
  assert.ok(html.includes("Waived") && html.includes("Adverse party") && html.includes("Strong matches"));
  assert.ok(!/<script/i.test(html) && !/<link/i.test(html), "no scripts or outside files");
  const dl = await s.call("GET", `/conflict-checks/${k.id}/report?download=1`);
  assert.match(dl.headers.get("content-disposition")!, /attachment; filename="conflict-check-\d+\.html"/);
  assert.equal((await s.call("GET", "/conflict-checks/999/report")).status, 404);
});

test("the demo seed has other names, relationships, parties, details and saved checks", async () => {
  const s = await start({ withSeed: true });
  const count = (t: string) => (s.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as any).n;
  assert.ok(count("conflicts_aliases") >= 5);
  assert.ok(count("conflicts_relationships") >= 4);
  assert.ok(count("conflicts_matter_parties") >= 6);
  assert.ok(count("contacts_details") >= 5);
  assert.equal((s.db.prepare("SELECT COUNT(*) AS n FROM conflicts_checks WHERE id NOT IN (SELECT conflict_check_id FROM intake_leads WHERE conflict_check_id IS NOT NULL)").get() as any).n, 2);
  // Seeded parties predate the seeded check, so the matter page does not warn about them.
  const late = s.db.prepare("SELECT COUNT(*) AS n FROM conflicts_matter_parties p JOIN conflicts_checks k ON k.matter_id = p.matter_id WHERE p.created_at > k.run_at AND k.id NOT IN (SELECT conflict_check_id FROM intake_leads WHERE conflict_check_id IS NOT NULL)").get() as any;
  assert.equal(late.n, 0);
  // Every seeded contact is marked as made-up (the app shows a "Demo data" banner).
  for (const c of s.db.prepare("SELECT notes FROM contacts").all() as any[]) assert.match(c.notes ?? "", /Fictional demo data/);
});
