import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, TODAY } from "./helpers.ts";
import { dueEmails, markEmailSent, looksLikeCompany, parseParties, intakeHooks } from "../../src/intake/leads.ts";

test("a new lead gets a conflict check, a first-call reminder and history", () => {
  const { it, engine, jordan } = setup();
  const acme = engine.addContact("Acme Widgets LLC", "company");
  const m = engine.createMatter({ name: "Acme general", clientId: acme });
  void m;
  const lead = it.createLead({ name: "Pat Rivera", email: "pat@example.test", source: "Web search", opposing: ["Acme Widgets, LLC"], ownerId: jordan }, jordan);
  assert.equal(lead.status, "new");
  assert.ok(lead.conflictCheck, "conflict check ran");
  assert.ok(lead.conflictCheck.hitCount >= 1, "found the existing client as a possible conflict");
  assert.equal(lead.conflictCheck.decision, null);
  assert.equal(lead.tasks.length, 1);
  assert.equal(lead.tasks[0].dueDate, TODAY);
  assert.equal(lead.tasks[0].assigneeId, jordan);
  assert.match(lead.tasks[0].title, /Call new lead: Pat Rivera/);
  assert.ok(lead.activity.some((a: any) => a.kind === "lead_created"));
  assert.ok(lead.activity.some((a: any) => a.kind === "conflict_check"));
});

test("validation of contact details and parties", () => {
  const { it } = setup();
  assert.throws(() => it.createLead({ name: "" }), /Name is required/);
  assert.throws(() => it.createLead({ name: "X", email: "not-an-email" }), /email/);
  assert.throws(() => it.createLead({ name: "X", phone: "call me" }), /phone/);
  assert.deepEqual(parseParties("Bob Smith\nbob smith; Acme Inc"), ["Bob Smith", "Acme Inc"]);
  assert.ok(looksLikeCompany("Prairie Holdings, LLC"));
  assert.ok(!looksLikeCompany("Maria Lopez"));
  assert.equal(it.createLead({ name: "Flint Hills Bank" }).kind, "company");
});

test("pipeline moves; Not hired needs a reason and closes follow-ups; Hired only via convert", () => {
  const { it, jordan } = setup();
  const l = it.createLead({ name: "Chris Doe", email: "chris@example.test", ownerId: jordan });
  assert.equal(it.setStatus(l.id, "contacted", {}, jordan).status, "contacted");
  assert.throws(() => it.setStatus(l.id, "hired", {}, jordan), /Convert to client/);
  assert.throws(() => it.setStatus(l.id, "bogus", {}, jordan), /Status must be/);
  assert.throws(() => it.setStatus(l.id, "not_hired", {}, jordan), /Reason is required/);
  it.queueEmail(l.id, { subject: "Checking in", body: "Hi" }, jordan);
  const done = it.setStatus(l.id, "not_hired", { reason: "Hired another firm", note: "Went local" }, jordan);
  assert.equal(done.status, "not_hired");
  assert.equal(done.notHiredReason, "Hired another firm: Went local");
  assert.equal(done.closedOn, TODAY);
  assert.ok(done.tasks.every((t: any) => t.status === "skipped"), "reminders skipped");
  assert.ok(done.emails.every((e: any) => e.status === "cancelled"), "emails cancelled");
  // Reopening is allowed and clears the reason.
  const back = it.setStatus(l.id, "contacted", {}, jordan);
  assert.equal(back.notHiredReason, null);
});

test("editing the name or parties re-runs the conflict check; owner change moves reminders", () => {
  const { it, jordan, sam } = setup();
  const l = it.createLead({ name: "Dana Lee", ownerId: jordan });
  const first = l.conflictCheckId;
  const u = it.updateLead(l.id, { opposing: "Big Co Inc" }, jordan);
  assert.notEqual(u.conflictCheckId, first);
  assert.deepEqual(u.opposing, ["Big Co Inc"]);
  const o = it.updateLead(l.id, { ownerId: sam }, jordan);
  assert.equal(o.tasks[0].assigneeId, sam);
  assert.ok(o.activity[0].detail.includes("owner (now Sam Ortiz)"));
});

test("earlier inquiries with similar names are listed", () => {
  const { it } = setup();
  const a = it.createLead({ name: "Robert Hayes", opposing: ["Sunflower Grain Co"] });
  const b = it.createLead({ name: "Bob Hayes" });
  assert.ok(b.earlierInquiries.some((x: any) => x.leadId === a.id), "nickname match on an earlier lead");
  const c = it.createLead({ name: "Jamie Park", opposing: ["Sunflower Grain Company"] });
  assert.ok(c.earlierInquiries.some((x: any) => x.leadId === a.id && x.matchedAs === "an other party"));
});

test("conflict decision flow and convert to client + matter", () => {
  const { it, engine, db, jordan, sam, area } = setup();
  // An automation on the practice area's first stage, to prove conversion fires it.
  const list = engine.createList({ name: "New matter steps", items: [{ key: "open_file", title: "Open the file" }] });
  db.prepare("INSERT INTO automations (name, trigger, trigger_ref, action, action_ref) VALUES (?,?,?,?,?)").run("Intake steps", "stage_entered", area.stageIds[0], "apply_list", list);
  const l = it.createLead({ name: "Morgan Price", email: "morgan@example.test", phone: "785-555-0100", practiceAreaId: area.id, opposing: ["Harbor Supply LLC"], ownerId: jordan, summary: "Wants to form an LLC" }, jordan);
  it.addNote(l.id, "Spoke by phone; sending engagement letter.", jordan);
  assert.throws(() => it.convert(l.id, {}, jordan), /Clear \(or waive\)/);
  assert.throws(() => it.decideConflict(l.id, "waived", "", jordan), /waived/);
  it.decideConflict(l.id, "cleared", null, jordan);
  const r = it.convert(l.id, { roles: { paralegal: sam } }, jordan);
  const lead = r.lead;
  assert.equal(lead.status, "hired");
  assert.equal(lead.hiredOn, TODAY);
  assert.equal(lead.matterId, r.matterId);
  const m = (engine.getMatter(r.matterId) as any).matter;
  assert.equal(m.name, "Morgan Price – Business formation");
  const contact = db.prepare("SELECT * FROM contacts WHERE id = ?").get(r.contactId) as any;
  assert.equal(contact.email, "morgan@example.test");
  // Automation fired: the checklist task exists on the matter.
  const tasks = db.prepare("SELECT title FROM tasks WHERE matter_id = ?").all(r.matterId) as any[];
  assert.ok(tasks.some((t) => t.title === "Open the file"));
  // Conflict check is linked and parties recorded.
  const k = db.prepare("SELECT matter_id FROM conflicts_checks WHERE id = ?").get(lead.conflictCheckId) as any;
  assert.equal(k.matter_id, r.matterId);
  const parties = db.prepare("SELECT c.name, p.role FROM conflicts_matter_parties p JOIN contacts c ON c.id = p.contact_id WHERE matter_id = ?").all(r.matterId) as any[];
  assert.deepEqual(parties.map((p) => p.role).sort(), ["adverse_party", "client"]);
  // Roles: owner became the attorney.
  const roles = db.prepare("SELECT role, user_id FROM matter_roles WHERE matter_id = ? ORDER BY role").all(r.matterId) as any[];
  assert.deepEqual(roles.map((x) => [x.role, x.user_id]), [["attorney", jordan], ["paralegal", sam]]);
  // History copied into the matter's log.
  const acts = db.prepare("SELECT kind, detail FROM activity WHERE matter_id = ?").all(r.matterId) as any[];
  assert.ok(acts.some((a) => a.kind === "lead_history" && /Added by hand/.test(a.detail)));
  assert.ok(acts.some((a) => a.kind === "lead_note" && /Spoke by phone/.test(a.detail)));
  assert.ok(acts.some((a) => a.kind === "lead_converted"));
  // First-call reminder is no longer open.
  assert.ok(lead.tasks.every((t: any) => t.status !== "open"));
  assert.throws(() => it.convert(l.id, {}, jordan), /already been converted/);
  assert.throws(() => it.setStatus(l.id, "new", {}, jordan), /already a client/);
  assert.throws(() => it.deleteLead(l.id, jordan), /can't be deleted/);
});

test("declined conflict blocks conversion; existing contact can be reused", () => {
  const { it, engine, jordan } = setup();
  const l = it.createLead({ name: "Taylor Brooks" });
  it.decideConflict(l.id, "declined", "Adverse to a current client", jordan);
  assert.throws(() => it.convert(l.id, {}, jordan), /declined/);
  const l2 = it.createLead({ name: "Taylor Brooks" });
  it.decideConflict(l2.id, "waived", "Consent filed in the client folder", jordan);
  const existing = engine.addContact("Taylor Brooks");
  const r = it.convert(l2.id, { contactId: existing, matterName: "Brooks estate plan" }, jordan);
  assert.equal(r.contactId, existing);
});

test("engagement letter from a template, sent with follow-ups, filed on conversion", async () => {
  const { it, docs, db, jordan } = setup();
  const t = docs.createTemplate(
    { name: "Engagement letter", filename: "engagement.txt", data: Buffer.from("{{today}}\nDear {{client.name}},\nRe: {{matter.name}}\n{{firm.name}}\n{{lead.summary}}") },
    jordan,
  ) as any;
  const l = it.createLead({ name: "Alex Kim", email: "alex@example.test", summary: "Lease review", ownerId: jordan });
  const { engagementId, lead } = it.createEngagement(l.id, t.id, jordan);
  assert.equal(lead.engagements.length, 1);
  const f = it.engagementFile(engagementId);
  const text = f.data.toString("utf8");
  assert.match(text, /Dear Alex Kim/);
  assert.match(text, /November 18, 2026/);
  assert.match(text, /Lease review/);
  const sent = await it.sendEngagement(engagementId, {}, jordan);
  assert.equal(sent.status, "engagement_sent");
  assert.equal(sent.engagements[0].status, "sent");
  const kinds = sent.emails.map((e: any) => e.kind).sort();
  assert.deepEqual(kinds, ["engagement_follow_up", "engagement_letter"]);
  const follow = sent.emails.find((e: any) => e.kind === "engagement_follow_up");
  assert.equal(follow.sendAfter.slice(0, 10), "2026-11-23", "3 business days later");
  assert.ok(sent.tasks.some((x: any) => x.kind === "engagement_follow_up" && x.dueDate === "2026-11-23"));
  // Email module hook: only the letter email is due now.
  const due = dueEmails(db, "2026-11-18T16:00:00Z");
  assert.deepEqual(due.map((e) => e.kind), ["engagement_letter"]);
  markEmailSent(db, due[0].id);
  assert.equal(dueEmails(db, "2026-11-18T16:00:00Z").length, 0);
  it.decideConflict(l.id, "cleared", null, jordan);
  const r = it.convert(l.id, {}, jordan);
  const doc = db.prepare("SELECT * FROM doc_documents WHERE matter_id = ?").get(r.matterId) as any;
  assert.ok(doc, "letter filed to the matter");
  assert.equal(doc.folder, "Intake");
  // Unsent follow-up cancelled once hired.
  assert.equal(r.lead.emails.find((e: any) => e.kind === "engagement_follow_up").status, "cancelled");
});

test("the e-signature hook receives the letter when registered", async () => {
  const { it, docs, jordan } = setup();
  const t = docs.createTemplate({ name: "EL", filename: "el.txt", data: Buffer.from("Hello {{client.name}}") }, jordan) as any;
  const l = it.createLead({ name: "Sky Patel", email: "sky@example.test" });
  const { engagementId } = it.createEngagement(l.id, t.id, jordan);
  const seen: any[] = [];
  intakeHooks.sendForSignature = (req) => (seen.push(req), { ref: "sig-123" });
  try {
    const lead = await it.sendEngagement(engagementId, {}, jordan);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].data.toString(), "Hello Sky Patel");
    assert.equal(lead.engagements[0].signatureRef, "sig-123");
    assert.ok(!lead.emails.some((e: any) => e.kind === "engagement_letter"), "no plain email when e-signature sends it");
  } finally {
    intakeHooks.sendForSignature = null;
  }
});

test("reminders, queued emails and cancelling", () => {
  const { it, jordan } = setup();
  const l = it.createLead({ name: "Jo March", email: "jo@example.test", ownerId: jordan });
  const tid = it.addReminder(l.id, { title: "Call back after the holiday", dueDate: "2026-11-30" }, jordan);
  assert.ok(tid > 0);
  assert.throws(() => it.addReminder(l.id, { dueDate: "next week" }, jordan), /date/);
  const eid = it.queueEmail(l.id, { subject: "Following up", body: "Hello again", sendAfter: "2026-11-25" }, jordan);
  const lead = it.cancelEmail(eid, jordan);
  assert.equal(lead.emails[0].status, "cancelled");
  assert.throws(() => it.cancelEmail(eid, jordan), /hasn't gone out/);
  const noEmail = it.createLead({ name: "No Email" });
  assert.throws(() => it.queueEmail(noEmail.id, { subject: "x", body: "y" }, jordan), /no email address/);
});

test("listing filters and search", () => {
  const { it, jordan, sam } = setup();
  it.createLead({ name: "Ann One", ownerId: jordan, source: "Referral from a client" });
  const b = it.createLead({ name: "Ben Two", ownerId: sam });
  it.setStatus(b.id, "contacted", {}, jordan);
  assert.equal(it.listLeads({ status: "contacted" }).length, 1);
  assert.equal(it.listLeads({ ownerId: jordan }).length, 1);
  assert.equal(it.listLeads({ q: "referral" })[0].name, "Ann One");
  assert.equal(it.listLeads({ q: "100%" }).length, 0);
});
