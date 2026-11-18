import { test } from "node:test";
import assert from "node:assert/strict";
import { setup } from "./helpers.ts";
import { createForm, defaultFields, getForm, publicForm, submitForm, updateForm, newFormLink, deleteForm, checkAnswer, RATE, MIN_FILL_MS } from "../../src/intake/forms.ts";

function answersFor(form: any, values: Record<string, string>) {
  const out: Record<number, string> = {};
  for (const f of form.fields) if (values[f.mapsTo] !== undefined) out[f.id] = values[f.mapsTo];
  return out;
}

test("form builder validates questions", () => {
  const { it, jordan, area } = setup();
  const f = createForm(it, { name: "Business inquiries", practiceAreaId: area.id, ownerId: jordan }, jordan);
  assert.equal(f.fields.length, defaultFields().length);
  assert.match(f.publicPath, /^\/intake\/form\.html\?f=/);
  assert.throws(() => createForm(it, { name: "Bad", fields: [] }, jordan), /at least one question/);
  assert.throws(() => createForm(it, { name: "No name", fields: [{ label: "Email", type: "email", mapsTo: "email" }] }, jordan), /name/);
  assert.throws(
    () => createForm(it, { name: "No contact", fields: [{ label: "Name", type: "short", mapsTo: "name" }] }, jordan),
    /email address or a phone/,
  );
  assert.throws(
    () => createForm(it, { name: "Choice", fields: [{ label: "Name", type: "short", mapsTo: "name" }, { label: "E", type: "email", mapsTo: "email" }, { label: "Pick", type: "choice", options: ["only"] }] }, jordan),
    /two choices/,
  );
  assert.throws(() => createForm(it, { name: "Type", fields: [{ label: "Name", type: "long", mapsTo: "name" }] }, jordan), /Short text/);
});

test("editing keeps question ids, so a half-filled form still submits", () => {
  const { it, jordan } = setup();
  const f = createForm(it, { name: "General" }, jordan);
  const fields = f.fields.map((x: any) => ({ ...x }));
  fields[0].label = "Full name";
  fields.push({ label: "Is this urgent?", type: "yesno" });
  const g = updateForm(it, f.id, { fields }, jordan);
  assert.equal(g.fields[0].id, f.fields[0].id);
  assert.equal(g.fields[0].label, "Full name");
  assert.equal(g.fields.length, f.fields.length + 1);
  const h = updateForm(it, f.id, { fields: g.fields.slice(0, -1) }, jordan);
  assert.equal(h.fields.length, f.fields.length);
});

test("public form: definition, submission creates a lead with mapped fields", () => {
  const { it, clock, jordan, area } = setup();
  it.updateSettings({ firmName: "Ellis & Ortiz, P.A." }, jordan);
  const f = createForm(it, { name: "Business inquiries", practiceAreaId: area.id, ownerId: jordan, thanks: "Thanks, we'll call." }, jordan);
  const pub = publicForm(it, f.token);
  assert.equal(pub.firmName, "Ellis & Ortiz, P.A.");
  assert.ok(!("ownerId" in pub) && !("mapsTo" in pub.fields[0]), "nothing internal is exposed");
  clock.now += 20_000;
  const r = submitForm(
    it,
    f.token,
    {
      stamp: pub.stamp,
      answers: answersFor(f, {
        name: "Riley Chen",
        email: "riley@example.test",
        phone: "(785) 555-0142",
        source: "Web search",
        summary: "Starting a bakery with a partner.",
        opposing_party: "Sunrise Ovens LLC\nDale Chen",
      }),
    },
    "198.51.100.7",
  ) as any;
  assert.equal(r.thanks, "Thanks, we'll call.");
  const lead = it.getLead(r.leadId);
  assert.equal(lead.name, "Riley Chen");
  assert.equal(lead.practiceAreaId, area.id);
  assert.equal(lead.ownerId, jordan);
  assert.equal(lead.source, "Web search");
  assert.deepEqual(lead.opposing, ["Sunrise Ovens LLC", "Dale Chen"]);
  assert.equal(lead.formId, f.id);
  assert.ok(lead.answers.length >= 5);
  assert.ok(lead.conflictCheck);
  assert.match(lead.activity.at(-1).detail, /Business inquiries/);
});

test("spam: honeypot, time to submit, forged stamp, rate limit", () => {
  const { it, clock, jordan } = setup();
  const f = createForm(it, { name: "General" }, jordan);
  const good = answersFor(f, { name: "Pat Smith", email: "pat@example.test", summary: "Help" });
  const count = () => it.listLeads().length;

  // Honeypot: looks like success, saves nothing.
  let pub = publicForm(it, f.token);
  clock.now += 10_000;
  const hp = submitForm(it, f.token, { stamp: pub.stamp, website: "http://spam.example", answers: good }, "1.1.1.1") as any;
  assert.equal(hp.ok, true);
  assert.equal(hp.leadId, undefined);
  assert.equal(count(), 0);

  // Too fast.
  pub = publicForm(it, f.token);
  clock.now += MIN_FILL_MS - 1000;
  assert.throws(() => submitForm(it, f.token, { stamp: pub.stamp, answers: good }, "1.1.1.1"), /very quickly/);

  // Forged or missing stamp.
  assert.throws(() => submitForm(it, f.token, { answers: good }, "1.1.1.1"), /expired/);
  assert.throws(() => submitForm(it, f.token, { stamp: `${clock.now - 60_000}.AAAAAAAAAAAAAAAAAAAAAA`, answers: good }, "1.1.1.1"), /expired/);
  // Stale.
  pub = publicForm(it, f.token);
  clock.now += 25 * 3600_000;
  assert.throws(() => submitForm(it, f.token, { stamp: pub.stamp, answers: good }, "1.1.1.1"), /expired/);

  // Rate limit per address.
  for (let i = 0; i < RATE.perTenMinutes; i++) {
    pub = publicForm(it, f.token);
    clock.now += 5000;
    submitForm(it, f.token, { stamp: pub.stamp, answers: good }, "2.2.2.2");
  }
  pub = publicForm(it, f.token);
  clock.now += 5000;
  assert.throws(
    () => submitForm(it, f.token, { stamp: pub.stamp, answers: good }, "2.2.2.2"),
    (e: any) => e.status === 429,
  );
  // A different address is unaffected; the first one recovers after ten minutes.
  submitForm(it, f.token, { stamp: pub.stamp, answers: good }, "3.3.3.3");
  clock.now += 11 * 60_000;
  pub = publicForm(it, f.token);
  clock.now += 5000;
  submitForm(it, f.token, { stamp: pub.stamp, answers: good }, "2.2.2.2");
  assert.equal(count(), RATE.perTenMinutes + 2);
  // Addresses are stored only as hashes.
  const raw = it.all("SELECT ip_hash FROM intake_submit_log");
  assert.ok(raw.every((r) => !r.ip_hash.includes("2.2.2.2")));
});

test("answers are checked against their question", () => {
  assert.equal(checkAnswer({ label: "Name", type: "short", required: true }, "  Ann   Lee "), "Ann Lee");
  assert.throws(() => checkAnswer({ label: "Name", type: "short", required: true }, ""), /Please answer/);
  assert.throws(() => checkAnswer({ label: "When", type: "date" }, "tomorrow"), /date/);
  assert.equal(checkAnswer({ label: "When", type: "date" }, "2026-12-01"), "2026-12-01");
  assert.throws(() => checkAnswer({ label: "Pick", type: "choice", options: ["A", "B"] }, "C"), /Choose one/);
  assert.equal(checkAnswer({ label: "Urgent", type: "yesno" }, true), "yes");
  assert.throws(() => checkAnswer({ label: "Urgent", type: "yesno" }, "maybe"), /yes or no/);
  assert.throws(() => checkAnswer({ label: "Long", type: "long" }, "x".repeat(9000)), /too long/);
  assert.throws(() => checkAnswer({ label: "Obj", type: "short" }, { a: 1 }), /can't read/);
});

test("inactive, deleted and relinked forms stop working", () => {
  const { it, jordan } = setup();
  const f = createForm(it, { name: "General" }, jordan);
  updateForm(it, f.id, { active: false }, jordan);
  assert.throws(() => publicForm(it, f.token), /isn't available/);
  updateForm(it, f.id, { active: true }, jordan);
  const g = newFormLink(it, f.id, jordan);
  assert.notEqual(g.token, f.token);
  assert.throws(() => publicForm(it, f.token), /isn't available/);
  publicForm(it, g.token);
  deleteForm(it, f.id, jordan);
  assert.throws(() => getForm(it, f.id), /not found/);
  assert.throws(() => publicForm(it, g.token), /isn't available/);
  assert.throws(() => publicForm(it, "../../etc"), /isn't available/);
});
