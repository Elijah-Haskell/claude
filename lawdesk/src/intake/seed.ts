// DEMO DATA ONLY: made-up leads (one or more in each pipeline stage), an intake form,
// consultation hours and an engagement-letter template. Called from src/seed.ts.

import type { DB } from "../db.ts";
import { Engine } from "../engine.ts";
import { addDays, type ISODate } from "../dates.ts";
import { SCHEMA as CONFLICTS_SCHEMA } from "../conflicts/schema.ts";
import { SCHEMA as CALENDAR_SCHEMA } from "../calendar/schema.ts";
import { SCHEMA as DOCUMENTS_SCHEMA } from "../documents/schema.ts";
import { Documents } from "../documents/documents.ts";
import { SCHEMA } from "./schema.ts";
import { Intake } from "./leads.ts";
import { createForm } from "./forms.ts";
import { book, openSlots, setAvailability } from "./booking.ts";

const LETTER = `{{today}}

{{client.name}}
{{#if client.email}}{{client.email}}{{/if}}

Re: Engagement for {{matter.name}}

Dear {{client.name}},

Thank you for choosing {{firm.name}}. This letter sets out the work we have agreed to do and how we will bill for it.

Scope of the work: {{lead.summary}}

Responsible attorney: {{matter.roles.attorney}}

Please read this letter carefully. If it is acceptable, sign below and return it to us. Call us with any questions.

Sincerely,

{{firm.name}}

Agreed: ______________________________   Date: ____________
        {{client.name}}

(Demo template. Not legal advice and not a form approved for use.)
`;

export function seedIntake(db: DB, opts: { today: ISODate; users: { jordan: number; riley: number; sam: number; casey: number } }) {
  for (const s of [CONFLICTS_SCHEMA, CALENDAR_SCHEMA, DOCUMENTS_SCHEMA, SCHEMA]) db.exec(s);
  const { jordan, riley, sam } = opts.users;
  const engine = new Engine(db, { today: () => opts.today });
  const docs = new Documents(db, { today: () => opts.today });
  const it = new Intake(db, engine, { documents: docs });
  const area = (name: string) => (db.prepare("SELECT id FROM practice_areas WHERE name = ?").get(name) as { id: number } | undefined)?.id ?? null;
  const formation = area("Business formation");
  const contracts = area("Contracts");

  it.updateSettings({ firmName: "Reyes & Chen, Attorneys at Law (demo)", defaultOwnerId: jordan, bookingIntro: "Initial consultations are free and last about half an hour." }, jordan);
  setAvailability(it, jordan, { consultMinutes: 30, location: "Main office, 2nd floor conference room", windows: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start: "09:00", end: "12:00" })) }, jordan);
  setAvailability(it, riley, { consultMinutes: 45, location: "Main office or by phone", windows: [2, 4].map((weekday) => ({ weekday, start: "13:00", end: "16:00" })) }, jordan);

  const form = createForm(
    it,
    {
      name: "Business and contracts inquiry",
      practiceAreaId: formation,
      ownerId: jordan,
      intro: "Tell us a little about what you need. We read every message and will reply within one business day. Please don't send confidential documents through this form.",
      thanks: "Thank you. We've received your message and will be in touch within one business day.",
    },
    jordan,
  );
  const template = docs.createTemplate({ name: "Engagement letter (intake)", filename: "engagement-letter.txt", data: Buffer.from(LETTER), category: "Engagement" }, jordan) as { id: number };

  /** Back-date a lead and its history to `daysAgo`. */
  const backdate = (id: number, daysAgo: number) => {
    const day = addDays(opts.today, -daysAgo);
    const at = `${day}T15:00:00.000Z`;
    db.prepare("UPDATE intake_leads SET received_on = ?, created_at = ?, status_changed_at = ? WHERE id = ?").run(day, at, at, id);
    db.prepare("UPDATE intake_activity SET at = ? WHERE lead_id = ? AND kind IN ('lead_created','conflict_check')").run(at, id);
  };

  // New
  const harper = it.createLead(
    { name: "Harper Quinn (demo)", email: "harper.quinn@example.com", phone: "785-555-0131", source: "Web search", practiceAreaId: contracts,
      summary: "Supplier stopped delivering under a two-year agreement; wants to know options.", opposing: ["Sunflower Coffee Roasters LLC (demo)"], ownerId: jordan, formId: form.id,
      answers: [{ label: "Your name", value: "Harper Quinn (demo)" }, { label: "Briefly, how can we help?", value: "Supplier stopped delivering under a two-year agreement." }],
      via: "Sent the “Business and contracts inquiry” form on the website" },
    null,
  );
  backdate(harper.id, 0);
  const bakery = it.createLead(
    { name: "Prairie Sky Bakery LLC (demo)", kind: "company", email: "owner@prairiesky.example.com", source: "Referral from a client", practiceAreaId: formation,
      summary: "Two owners want an operating agreement before taking on an investor.", ownerId: riley },
    sam,
  );
  backdate(bakery.id, 1);

  // Contacted
  const devon = it.createLead({ name: "Devon Marsh (demo)", phone: "316-555-0177", source: "Referral from another lawyer", practiceAreaId: contracts, summary: "Commercial lease renewal for a retail shop.", opposing: ["Bluestem Holdings LLC (demo)"], ownerId: riley }, sam);
  backdate(devon.id, 4);
  it.setStatus(devon.id, "contacted", {}, riley);
  it.addNote(devon.id, "Called back; Devon will send the current lease. Possible conflict with Bluestem flagged for Riley.", riley);

  // Consultation scheduled
  const elena = it.createLead({ name: "Elena Ruiz (demo)", email: "elena.ruiz@example.com", phone: "913-555-0108", source: "Firm website", practiceAreaId: formation, summary: "Starting a landscaping company with her brother.", ownerId: jordan }, null);
  backdate(elena.id, 3);
  it.setStatus(elena.id, "contacted", {}, jordan);
  it.decideConflict(elena.id, "cleared", null, jordan);
  const slot = openSlots(it, { userId: jordan })[2];
  if (slot) book(it, elena.id, { userId: jordan, start: slot.start, via: "staff" }, jordan);

  // Engagement sent
  const owen = it.createLead({ name: "Owen Tate (demo)", email: "owen.tate@example.com", source: "Returning client", practiceAreaId: formation, summary: "Convert a sole proprietorship into an LLC.", ownerId: jordan }, jordan);
  backdate(owen.id, 9);
  it.decideConflict(owen.id, "cleared", null, jordan);
  it.setStatus(owen.id, "consult_scheduled", {}, jordan);
  const eng = it.createEngagement(owen.id, template.id, jordan);
  // sendEngagement is async only for the e-signature hook; with no hook it finishes at once.
  void it.sendEngagement(eng.engagementId, {}, jordan);

  // Hired: the demo matter "Brooks Consulting LLC formation" (D-1006) came in as a lead.
  // Linked directly rather than through convert(), so the demo keeps its own matters.
  const m5 = db.prepare("SELECT id, client_id FROM matters WHERE number = 'D-1006'").get() as { id: number; client_id: number } | undefined;
  let grace: { id: number } | null = null;
  if (m5) {
    grace = it.createLead({ name: "Taylor Brooks (demo)", email: "taylor@example.com", source: "Referral from a client", practiceAreaId: formation, summary: "Single-member LLC for a consulting business.", ownerId: jordan }, sam);
    backdate(grace.id, 6);
    it.setStatus(grace.id, "contacted", {}, jordan);
    it.decideConflict(grace.id, "cleared", null, jordan);
    db.prepare("UPDATE conflicts_checks SET matter_id = ? WHERE id = (SELECT conflict_check_id FROM intake_leads WHERE id = ?)").run(m5.id, grace.id);
    for (const t of db.prepare("SELECT task_id FROM intake_lead_tasks WHERE lead_id = ?").all(grace.id) as { task_id: number }[]) engine.completeTask(t.task_id, jordan);
    db.prepare("UPDATE intake_leads SET status = 'hired', hired_on = ?, closed_on = ?, contact_id = ?, matter_id = ? WHERE id = ?").run(opts.today, opts.today, m5.client_id, m5.id, grace.id);
    it.log(grace.id, "converted", "Contacted → Hired. Client and matter “Brooks Consulting LLC formation” opened", jordan);
  }

  // Not hired
  const marcus = it.createLead({ name: "Marcus Bell (demo)", email: "marcus.bell@example.com", source: "Social media", practiceAreaId: contracts, summary: "Dispute with a contractor over a home remodel.", ownerId: jordan }, null);
  backdate(marcus.id, 15);
  it.setStatus(marcus.id, "not_hired", { reason: "Not a matter we handle", note: "Referred to the county bar's lawyer referral service" }, jordan);

  return { formId: form.id, templateId: template.id, leads: { harper: harper.id, bakery: bakery.id, devon: devon.id, elena: elena.id, owen: owen.id, grace: grace?.id ?? null, marcus: marcus.id } };
}
