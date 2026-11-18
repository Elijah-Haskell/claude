// Conflict search over a small made-up firm, and the audit trail of checks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../../src/db.ts";
import { Engine, EngineError } from "../../src/engine.ts";
import { SCHEMA } from "../../src/conflicts/schema.ts";
import { addAlias, addParty, addRelationship, listParties, listRelationships } from "../../src/conflicts/store.ts";
import { decideCheck, getCheck, linkCheck, listChecks, runCheck, searchConflicts, type Hit } from "../../src/conflicts/search.ts";

function firm() {
  let now = "2025-03-10";
  const db = openDb();
  db.exec(SCHEMA);
  const e = new Engine(db, { today: () => now });
  const setToday = (d: string) => (now = d);
  const atty = e.addUser("Attorney A", "attorney");
  const para = e.addUser("Paralegal P", "paralegal");
  const c = {
    acme: e.addContact("Acme Widgets, L.L.C.", "company"),
    john: e.addContact("Smith, John Q.", "person"),
    mary: e.addContact("Mary Johnson", "person"),
    prairie: e.addContact("Prairie Wind Holdings, Inc.", "company"),
    prairieSub: e.addContact("Prairie Wind Energy LLC", "company"),
    bob: e.addContact("Robert Kowalski", "person"),
    kate: e.addContact("Katherine Brennan", "person"),
    opp: e.addContact("Hale & Moss, Chartered", "company"),
    walt: e.addContact("Walter Ostrowski", "person"),
    smithson: e.addContact("Smithson Consulting", "company"),
    plumb: e.addContact("Dale Harper d/b/a Harper Plumbing", "person"),
    nobody: e.addContact("Quentin Unrelated", "person"),
  };
  // 2023: Acme formation for client Acme (closed 2024)
  const formation = e.createMatter({ name: "Acme formation", number: "2023-004", clientId: c.acme, openedOn: "2023-02-01" });
  setToday("2024-06-30");
  e.closeMatter(formation);
  // 2024: Brennan v. Kowalski, we represent Brennan, Hale & Moss is opposing counsel (open)
  const brennan = e.createMatter({ name: "Brennan v. Kowalski", number: "2024-017", clientId: c.kate, openedOn: "2024-03-01" });
  addParty(db, brennan, { contactId: c.bob, role: "adverse_party" });
  addParty(db, brennan, { contactId: c.opp, role: "opposing_counsel" });
  addParty(db, brennan, { contactId: c.walt, role: "witness" });
  // A consultation that did not become an engagement
  const consult = e.createMatter({ name: "Johnson consultation", number: "2024-031", openedOn: "2024-08-01" });
  addParty(db, consult, { contactId: c.mary, role: "prospective_client" });
  setToday("2024-08-02");
  e.closeMatter(consult);
  // Prairie Wind Energy is a current client; its parent is Prairie Wind Holdings
  const energy = e.createMatter({ name: "Energy lease review", number: "2025-002", clientId: c.prairieSub, openedOn: "2025-01-05" });
  addRelationship(db, { fromContactId: c.prairie, toContactId: c.prairieSub, kind: "parent" });
  addRelationship(db, { fromContactId: c.john, toContactId: c.acme, kind: "owner" });
  addAlias(db, c.mary, { name: "Mary Peterson", kind: "maiden_name" });
  addAlias(db, c.acme, { name: "Acme Tools", kind: "trade_name" });
  setToday("2025-03-10");
  return { db, e, atty, para, c, m: { formation, brennan, consult, energy }, setToday };
}

const find = (hits: Hit[], id: number) => hits.find((h) => h.contactId === id);

test("finds a client by a variant spelling and reports the closed matter with its year", () => {
  const { db, c } = firm();
  const { hits } = searchConflicts(db, { terms: ["ACME WIDGETS LLC"] });
  const h = find(hits, c.acme)!;
  assert.ok(h, "Acme found");
  assert.equal(h.band, "strong");
  assert.equal(h.match, "direct");
  assert.ok(h.reasons.some((r) => r === "Client in matter 2023-004 Acme formation (closed 2024)"), h.reasons.join(" | "));
});

test("searching an owner flags the company he owns and its client matter (one hop)", () => {
  const { db, c } = firm();
  const { hits } = searchConflicts(db, { terms: [{ name: "John Smith", role: "adverse_party" }] });
  const john = find(hits, c.john)!;
  assert.equal(john.match, "direct");
  assert.ok(john.matches[0].rules.includes("last, first"));
  const acme = find(hits, c.acme)!;
  assert.ok(acme, "Acme reached through the relationship");
  assert.equal(acme.match, "related");
  assert.equal(acme.rule, "relationship");
  assert.ok(acme.score < john.score);
  assert.ok(
    acme.reasons.includes("Smith, John Q. is an owner of Acme Widgets, L.L.C., which is a client in matter 2023-004 Acme formation (closed 2024)"),
    acme.reasons.join(" | "),
  );
  assert.ok(acme.concerns.some((x) => x.includes("former client")));
  // related: false turns the hop off
  assert.equal(find(searchConflicts(db, { terms: ["John Smith"], related: false }).hits, c.acme), undefined);
});

test("parent/subsidiary: an adverse party's parent being a current client is high severity", () => {
  const { db, c } = firm();
  const { hits } = searchConflicts(db, { terms: [{ name: "Prairie Wind Holdings", kind: "company", role: "adverse_party" }] });
  const sub = find(hits, c.prairieSub)!;
  assert.ok(sub, JSON.stringify(hits.map((h) => h.name)));
  assert.equal(sub.severity, "high");
  assert.ok(sub.reasons.some((r) => r.startsWith("Prairie Wind Holdings, Inc. is the parent company of Prairie Wind Energy LLC, which is a client in matter 2025-002")));
  // Prairie Wind Energy also matches directly (weakly: shared distinctive words)
  assert.ok(sub.matches.length >= 1);
});

test("maiden-name alias finds the contact and says so", () => {
  const { db, c } = firm();
  const { hits } = searchConflicts(db, { terms: ["Peterson, Mary"] });
  const h = find(hits, c.mary)!;
  assert.ok(h);
  assert.equal(h.matches[0].via, "alias");
  assert.equal(h.rule, "alias: exact");
  assert.deepEqual(h.matches[0].rules, ["exact", "last, first"]);
  assert.ok(h.reasons[0].includes('"Mary Peterson", a maiden name of Mary Johnson'), h.reasons[0]);
  assert.ok(h.concerns.includes("Was a prospective client in matter 2024-031 Johnson consultation"));
  assert.equal(h.severity, "medium");
});

test("trade-name alias and d/b/a inside a contact name are both searched", () => {
  const { db, c } = firm();
  assert.ok(find(searchConflicts(db, { terms: ["Acme Tools Inc"] }).hits, c.acme));
  const h = find(searchConflicts(db, { terms: ["Harper Plumbing LLC"] }).hits, c.plumb)!;
  assert.ok(h, "d/b/a part of the name matched");
  assert.equal(h.matches[0].aliasKind, "also known as");
  // a d/b/a in the search term is split the same way
  assert.ok(find(searchConflicts(db, { terms: ["Bob Kowalski dba Kowalski Roofing"] }).hits, c.bob));
});

test("nickname + adverse role: proposed client was adverse to a firm client in an open matter", () => {
  const { db, c } = firm();
  const { hits } = searchConflicts(db, { terms: [{ name: "Bob Kowalski", role: "client" }] });
  const h = find(hits, c.bob)!;
  assert.equal(h.band, "strong");
  assert.deepEqual(h.matches[0].rules, ["nickname"]);
  assert.equal(h.severity, "high");
  assert.ok(h.concerns[0].startsWith("Proposed client was adverse to a firm client in matter 2024-017"));
});

test("proposed adverse party that is a current client is high severity; typos still match", () => {
  const { db, c } = firm();
  const { hits } = searchConflicts(db, { terms: [{ name: "Kathryn Brenan", role: "adverse_party" }] });
  const h = find(hits, c.kate)!;
  assert.ok(h, "typo + spelling variant found");
  assert.equal(h.severity, "high");
  assert.ok(h.concerns.includes("Proposed adverse party is a current client (matter 2024-017 Brennan v. Kowalski)"));
});

test("opposing counsel and witnesses are found with their roles", () => {
  const { db, c } = firm();
  const { hits } = searchConflicts(db, { terms: ["Hale and Moss", "Walt Ostrowsky"] });
  assert.ok(find(hits, c.opp)!.reasons.includes("Opposing counsel in matter 2024-017 Brennan v. Kowalski (open)"));
  const w = find(hits, c.walt)!;
  assert.ok(w.reasons.includes("Witness in matter 2024-017 Brennan v. Kowalski (open)"));
  assert.equal(w.severity, "low");
});

test("false-positive control: Smith Construction does not hit Smithson Consulting", () => {
  const { db, c } = firm();
  const { hits } = searchConflicts(db, { terms: ["Smith Construction"] });
  assert.equal(find(hits, c.smithson), undefined, "score is 0, so it is not listed");
  // and the person John Smith comes up only weakly (one shared word), not as a strong hit
  const j = find(hits, c.john);
  if (j) assert.notEqual(j.band, "strong");
  // a lower minScore cannot surface it either: nothing pairs
  assert.equal(find(searchConflicts(db, { terms: ["Smith Construction"], minScore: 0.01 }).hits, c.smithson), undefined);
});

test("unrelated names produce no hits; results are ranked by score", () => {
  const { db } = firm();
  assert.equal(searchConflicts(db, { terms: ["Zebulon Fairweather"] }).hits.length, 0);
  const { hits } = searchConflicts(db, { terms: ["Acme Widgets", "Prairie Wind"] });
  for (let i = 1; i < hits.length; i++) assert.ok(hits[i - 1].score >= hits[i].score);
});

test("proposed matter: its own parties become the terms and are not reported against themselves", () => {
  const { db, e, c } = firm();
  const newMatter = e.createMatter({ name: "Acme v. Kowalsky", clientId: c.acme });
  const bobby = e.addContact("Bobby Kowalsky", "person");
  addParty(db, newMatter, { contactId: bobby, role: "adverse_party" });
  const { terms, hits } = searchConflicts(db, { matterId: newMatter });
  assert.deepEqual(
    terms.map((t) => [t.name, t.role]).sort(),
    [["Acme Tools", "client"], ["Acme Widgets, L.L.C.", "client"], ["Bobby Kowalsky", "adverse_party"]],
  );
  // Bobby Kowalsky only matches himself and is on no other matter: dropped
  assert.equal(find(hits, bobby), undefined);
  // ...but Robert Kowalski, adverse to our client in 2024-017, is found
  const bob = find(hits, c.bob)!;
  assert.ok(bob);
  assert.ok(bob.matches[0].rules.includes("nickname") && bob.matches[0].rules.includes("typo"), bob.matches[0].rules.join());
  // Acme's involvement in the new matter is listed separately, not as an involvement
  const acme = find(hits, c.acme)!;
  assert.deepEqual(acme.onProposedMatter, ["client"]);
  assert.ok(acme.involvements.every((i) => i.matterId !== newMatter));
});

test("bad input is refused", () => {
  const { db } = firm();
  assert.throws(() => searchConflicts(db, { terms: [] }), EngineError);
  assert.throws(() => searchConflicts(db, { terms: ["  "] }), EngineError);
  assert.throws(() => searchConflicts(db, { terms: [{ name: "X", role: "judge" as any }] }), EngineError);
  assert.throws(() => searchConflicts(db, { terms: ["X"], matterId: 999 }), /Matter not found/);
  assert.throws(() => searchConflicts(db, { terms: ["X"], minScore: 2 }), EngineError);
});

test("relationships and parties are validated", () => {
  const { db, c, m } = firm();
  assert.throws(() => addRelationship(db, { fromContactId: c.john, toContactId: c.john, kind: "owner" }), /itself/);
  assert.throws(() => addRelationship(db, { fromContactId: c.john, toContactId: c.acme, kind: "owner" }), /already/);
  assert.throws(() => addRelationship(db, { fromContactId: c.john, toContactId: c.acme, kind: "boss" as any }), /kind/);
  assert.throws(() => addParty(db, m.brennan, { contactId: c.bob, role: "adverse_party" }), /already/);
  assert.throws(() => addParty(db, m.brennan, { contactId: 999, role: "witness" }), /Contact not found/);
  assert.throws(() => addAlias(db, c.john, { name: "" }), /needs a name/);
  assert.equal(listRelationships(db, c.acme)[0].description, "Smith, John Q. is an owner of Acme Widgets, L.L.C.");
  const parties = listParties(db, m.brennan);
  assert.deepEqual(parties.map((p) => p.role), ["client", "adverse_party", "opposing_counsel", "witness"]);
});

// ------------------------------------------------------------------ audit trail

test("audit trail: a check is saved with who, when, terms and results, and logged", () => {
  const { db, atty, m } = firm();
  const r = runCheck(db, { terms: [{ name: "Bob Kowalski", role: "client" }] }, atty);
  assert.ok(r.checkId > 0);
  const k = getCheck(db, r.checkId);
  assert.equal(k.runBy, atty);
  assert.equal(k.runByName, "Attorney A");
  assert.match(k.runAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(k.terms.map((t: any) => t.name), ["Bob Kowalski"]);
  assert.equal(k.hitCount, r.hits.length);
  assert.deepEqual(k.results, JSON.parse(JSON.stringify(r.hits)));
  assert.equal(k.decision, null);
  assert.equal(k.matterId, null);
  const log = db.prepare("SELECT * FROM activity WHERE kind = 'conflict_check'").all() as any[];
  assert.equal(log.length, 1);
  assert.equal(log[0].user_id, atty);
  assert.match(log[0].detail, /Conflict check #\d+ for Bob Kowalski: \d+ hit\(s\)/);
  void m;
});

test("audit trail: decisions are recorded with history; waiver needs a note", () => {
  const { db, atty, para, e } = firm();
  const matter = e.createMatter({ name: "New engagement" });
  const { checkId } = runCheck(db, { terms: ["Mary Peterson"], matterId: matter }, para);
  assert.throws(() => decideCheck(db, checkId, "waived", "  ", atty), /waived/);
  assert.throws(() => decideCheck(db, checkId, "maybe", null, atty), /Decision must be/);
  decideCheck(db, checkId, "declined", "Prospective client in 2024 consult; declining", atty);
  const k = decideCheck(db, checkId, "waived", "Written informed consent from both, filed in matter folder 2025-03-10", atty);
  assert.equal(k.decision, "waived");
  assert.equal(k.decidedBy, atty);
  assert.equal(k.decidedByName, "Attorney A");
  assert.deepEqual(k.decisions.map((d: any) => d.decision), ["declined", "waived"]);
  const log = (db.prepare("SELECT detail, matter_id FROM activity WHERE kind = 'conflict_decision' ORDER BY id").all() as any[]);
  assert.equal(log.length, 2);
  assert.equal(log[1].matter_id, matter);
  assert.match(log[1].detail, /waived \(was declined\)/);
  // visible in the matter's activity through the engine
  assert.ok(e.getMatter(matter).activity.some((a: any) => a.kind === "conflict_check"));
});

test("audit trail: stored results do not change when contacts change later", () => {
  const { db, atty, c } = firm();
  const { checkId } = runCheck(db, { terms: ["Acme Widgets"] }, atty);
  db.prepare("UPDATE contacts SET name = 'Renamed Co' WHERE id = ?").run(c.acme);
  const k = getCheck(db, checkId);
  assert.equal(k.results.find((h: any) => h.contactId === c.acme).name, "Acme Widgets, L.L.C.");
  // and a fresh search sees the rename (the name cache does not go stale)
  assert.equal(find(searchConflicts(db, { terms: ["Acme Widgets"] }).hits, c.acme), undefined);
  assert.ok(find(searchConflicts(db, { terms: ["Renamed Company"] }).hits, c.acme));
});

test("audit trail: intake checks are linked to the matter later; list filters", () => {
  const { db, atty, e } = firm();
  const a = runCheck(db, { terms: ["Quentin Unrelated"] }, atty).checkId;
  const b = runCheck(db, { terms: ["Someone Else"] }, atty).checkId;
  const matter = e.createMatter({ name: "Unrelated estate plan" });
  linkCheck(db, a, matter, atty);
  assert.throws(() => linkCheck(db, a, e.createMatter({ name: "Other" }), atty), /already linked/);
  assert.deepEqual(listChecks(db, { matterId: matter }).map((k) => k.id), [a]);
  decideCheck(db, a, "cleared", null, atty);
  assert.deepEqual(listChecks(db, { pending: true }).map((k) => k.id), [b]);
  assert.deepEqual(listChecks(db).map((k) => k.id), [b, a]);
  assert.equal(listChecks(db)[0].results, undefined, "list leaves out the full results");
  assert.ok(e.getMatter(matter).activity.some((x: any) => x.kind === "conflict_check_linked"));
});

test("performance: 50,000 contacts search in reasonable time", () => {
  const db = openDb();
  db.exec(SCHEMA);
  const first = ["James", "Mary", "John", "Patricia", "Robert", "Jennifer", "Michael", "Linda", "William", "Elizabeth", "David", "Barbara", "Richard", "Susan", "Joseph", "Jessica", "Thomas", "Sarah", "Charles", "Karen"];
  const last = ["Smith", "Johnson", "Williams", "Brown", "Jones", "Garcia", "Miller", "Davis", "Rodriguez", "Martinez", "Hernandez", "Lopez", "Gonzalez", "Wilson", "Anderson", "Thomas", "Taylor", "Moore", "Jackson", "Martin"];
  const words = ["Prairie", "Sunflower", "Flint", "Hills", "Kaw", "Valley", "Cottonwood", "Bluestem", "Plains", "Heartland", "Midway", "Arrow", "Summit", "Harvest", "Ridge"];
  const trades = ["Construction", "Farms", "Consulting", "Holdings", "Realty", "Auto", "Grain", "Dental", "Roofing", "Logistics"];
  const ins = db.prepare("INSERT INTO contacts (name, kind) VALUES (?, ?)");
  let seed = 42;
  const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), seed % n);
  db.exec("BEGIN");
  for (let i = 0; i < 50_000; i++) {
    if (i % 3 === 0) ins.run(`${words[rnd(15)]} ${words[rnd(15)]} ${trades[rnd(10)]} ${["LLC", "Inc.", "Co."][rnd(3)]} ${i}`, "company");
    else ins.run(`${first[rnd(20)]} ${String.fromCharCode(65 + rnd(26))}. ${last[rnd(20)]}${i % 7 === 0 ? "-" + last[rnd(20)] : ""} ${i}`, "person");
  }
  db.exec("COMMIT");
  const target = Number(ins.run("Bartholomew Quackenbush", "person").lastInsertRowid);
  const t0 = performance.now();
  const r1 = searchConflicts(db, { terms: ["Barth Quackenbusch", "Prairie Summit Construction"] });
  const cold = performance.now() - t0;
  const t1 = performance.now();
  searchConflicts(db, { terms: ["Bart Quackenbusch"] });
  const warm = performance.now() - t1;
  const t = find(r1.hits, target)!;
  assert.ok(t, "short form + typo still found among 50k");
  assert.deepEqual([...t.matches[0].rules].sort(), ["short form", "typo"]);
  // generous bounds so slow CI does not flake; typical is far lower (see report)
  assert.ok(cold < 15_000, `cold search took ${cold}ms`);
  assert.ok(warm < 5_000, `warm search took ${warm}ms`);
  console.log(`# 50k contacts: cold ${cold.toFixed(0)}ms, warm ${warm.toFixed(0)}ms`);
});
