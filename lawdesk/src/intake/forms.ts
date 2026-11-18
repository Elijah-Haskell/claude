// Intake forms: the firm builds a form per practice area, puts its public link on the website
// or sends it, and each submission becomes a lead. Spam protection without third parties:
// a hidden "website" field people never see (bots fill it), a signed "opened at" stamp so a
// form sent within a few seconds of loading is refused, and a per-address rate limit.

import { createHash } from "node:crypto";
import { tx } from "../db.ts";
import { isISODate } from "../dates.ts";
import { FIELD_MAPS, FIELD_TYPES, type FieldMap, type FieldType } from "./schema.ts";
import { type Intake, bad, cleanEmail, cleanPhone, cleanText, token } from "./leads.ts";

type Row = Record<string, any>;

export interface FieldInput {
  id?: number | null;
  label: string;
  type: FieldType;
  required?: boolean;
  help?: string | null;
  options?: string[];
  mapsTo?: FieldMap;
}

export interface FormInput {
  name?: string;
  practiceAreaId?: number | null;
  intro?: string | null;
  thanks?: string | null;
  ownerId?: number | null;
  active?: boolean;
  fields?: FieldInput[];
}

/** A form must be open this long before it is sent (people take longer; most bots don't). */
export const MIN_FILL_MS = 3000;
/** A stamp older than this is stale: reload the page. */
export const MAX_FILL_MS = 24 * 3600_000;
/** Accepted submissions allowed per address: this many in 10 minutes, and per day. */
export const RATE = { perTenMinutes: 5, perDay: 20 };
export const HONEYPOT = "website";

export function defaultFields(): FieldInput[] {
  return [
    { label: "Your name", type: "short", required: true, mapsTo: "name" },
    { label: "Email", type: "email", required: true, mapsTo: "email" },
    { label: "Phone", type: "phone", required: false, mapsTo: "phone", help: "A number where we can reach you during the day." },
    { label: "How did you hear about us?", type: "choice", options: ["A friend or family member", "Another lawyer", "Web search", "Our website", "Social media", "Other"], mapsTo: "source" },
    { label: "Briefly, how can we help?", type: "long", required: true, mapsTo: "summary", help: "A few sentences is plenty. Please don't send confidential documents yet." },
    { label: "Other people or businesses involved", type: "long", mapsTo: "opposing_party", help: "One name per line. We use this to check for conflicts of interest before we talk." },
  ];
}

function checkFields(list: unknown): FieldInput[] {
  if (!Array.isArray(list) || !list.length) bad("A form needs at least one question");
  if (list.length > 60) bad("A form can have at most 60 questions");
  const out: FieldInput[] = [];
  for (const [i, f] of list.entries()) {
    const n = i + 1;
    if (!f || typeof f !== "object") bad(`Question ${n} is not valid`);
    const label = cleanText(f.label, `Question ${n}'s wording`, 300, true)!;
    if (!(FIELD_TYPES as readonly string[]).includes(f.type)) bad(`Question ${n} has an unknown answer type`);
    const mapsTo = f.mapsTo ?? "none";
    if (!(FIELD_MAPS as readonly string[]).includes(mapsTo)) bad(`Question ${n} fills in an unknown lead field`);
    let options: string[] = [];
    if (f.type === "choice") {
      options = (Array.isArray(f.options) ? f.options : String(f.options ?? "").split("\n"))
        .map((o: unknown) => cleanText(o, `A choice in question ${n}`, 200))
        .filter((o: string | null): o is string => !!o);
      options = options.filter((o, j) => options.indexOf(o) === j);
      if (options.length < 2) bad(`Question ${n} (“${label}”) needs at least two choices`);
      if (options.length > 50) bad(`Question ${n} has too many choices`);
    }
    if (mapsTo === "email" && f.type !== "email") bad(`“${label}” fills in the email address, so its answer type must be Email`);
    if (mapsTo === "phone" && f.type !== "phone") bad(`“${label}” fills in the phone number, so its answer type must be Phone`);
    if (mapsTo === "name" && f.type !== "short") bad(`“${label}” fills in the name, so its answer type must be Short text`);
    out.push({
      id: f.id == null ? null : Number(f.id),
      label,
      type: f.type,
      required: !!f.required || mapsTo === "name",
      help: cleanText(f.help, `Question ${n}'s help text`, 1000),
      options,
      mapsTo,
    });
  }
  const names = out.filter((f) => f.mapsTo === "name").length;
  if (names !== 1) bad("Exactly one question must ask for the person's name (set “Fills in” to Name)");
  for (const m of ["email", "phone", "source"]) if (out.filter((f) => f.mapsTo === m).length > 1) bad(`Only one question can fill in the ${m}`);
  if (!out.some((f) => f.mapsTo === "email" || f.mapsTo === "phone")) bad("Ask for an email address or a phone number, so the firm can reply");
  return out;
}

function formOut(it: Intake, f: Row, withFields = true): Row {
  const out: Row = {
    id: f.id,
    name: f.name,
    practiceAreaId: f.practice_area_id,
    practiceArea: f.practice_area_id ? it.one("SELECT name FROM practice_areas WHERE id = ?", f.practice_area_id)?.name ?? null : null,
    token: f.token,
    intro: f.intro,
    thanks: f.thanks,
    ownerId: f.owner_id,
    active: !!f.active,
    createdAt: f.created_at,
    updatedAt: f.updated_at,
    submissions: it.one("SELECT COUNT(*) AS n FROM intake_leads WHERE form_id = ?", f.id)!.n,
    publicPath: `/intake/form.html?f=${f.token}`,
  };
  if (withFields) out.fields = fieldsOf(it, f.id);
  return out;
}

function fieldsOf(it: Intake, formId: number): Row[] {
  return it.all("SELECT * FROM intake_form_fields WHERE form_id = ? ORDER BY position, id", formId).map((x) => ({
    id: x.id,
    label: x.label,
    type: x.type,
    required: !!x.required,
    help: x.help,
    options: JSON.parse(x.options),
    mapsTo: x.maps_to,
  }));
}

function formRow(it: Intake, id: number): Row {
  const f = it.one("SELECT * FROM intake_forms WHERE id = ? AND deleted_at IS NULL", id);
  if (!f) bad("Form not found", 404);
  return f;
}

export function listForms(it: Intake): Row[] {
  return it.all("SELECT * FROM intake_forms WHERE deleted_at IS NULL ORDER BY lower(name)").map((f) => formOut(it, f, false));
}

export function getForm(it: Intake, id: number): Row {
  return formOut(it, formRow(it, id));
}

export function createForm(it: Intake, input: FormInput, userId: number | null): Row {
  return tx(it.db, () => {
    const name = cleanText(input.name, "Form name", 200, true)!;
    const fields = checkFields(input.fields ?? defaultFields());
    const now = it.nowIso();
    const id = it.run(
      "INSERT INTO intake_forms (name, practice_area_id, token, intro, thanks, owner_id, active, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
      name,
      it.checkArea(input.practiceAreaId),
      token(12),
      cleanText(input.intro, "Introduction", 4000),
      cleanText(input.thanks, "Thank-you message", 4000),
      it.checkUser(input.ownerId),
      input.active === false ? 0 : 1,
      now,
      now,
    );
    saveFields(it, id, fields);
    it.engine.log("intake_form", `Created intake form “${name}”`, { userId });
    return getForm(it, id);
  });
}

function saveFields(it: Intake, formId: number, fields: FieldInput[]) {
  const existing = new Set(it.all("SELECT id FROM intake_form_fields WHERE form_id = ?", formId).map((r) => r.id as number));
  const kept = new Set<number>();
  fields.forEach((f, pos) => {
    const vals = [pos, f.label, f.type, f.required ? 1 : 0, f.help ?? null, JSON.stringify(f.options ?? []), f.mapsTo ?? "none"];
    if (f.id && existing.has(f.id)) {
      it.run("UPDATE intake_form_fields SET position = ?, label = ?, type = ?, required = ?, help = ?, options = ?, maps_to = ? WHERE id = ?", ...vals, f.id);
      kept.add(f.id);
    } else {
      it.run("INSERT INTO intake_form_fields (form_id, position, label, type, required, help, options, maps_to) VALUES (?,?,?,?,?,?,?,?)", formId, ...vals);
    }
  });
  for (const id of existing) if (!kept.has(id)) it.run("DELETE FROM intake_form_fields WHERE id = ?", id);
}

export function updateForm(it: Intake, id: number, input: FormInput, userId: number | null): Row {
  return tx(it.db, () => {
    const f = formRow(it, id);
    const name = input.name !== undefined ? cleanText(input.name, "Form name", 200, true)! : f.name;
    it.run(
      "UPDATE intake_forms SET name = ?, practice_area_id = ?, intro = ?, thanks = ?, owner_id = ?, active = ?, updated_at = ? WHERE id = ?",
      name,
      input.practiceAreaId !== undefined ? it.checkArea(input.practiceAreaId) : f.practice_area_id,
      input.intro !== undefined ? cleanText(input.intro, "Introduction", 4000) : f.intro,
      input.thanks !== undefined ? cleanText(input.thanks, "Thank-you message", 4000) : f.thanks,
      input.ownerId !== undefined ? it.checkUser(input.ownerId) : f.owner_id,
      input.active !== undefined ? (input.active ? 1 : 0) : f.active,
      it.nowIso(),
      id,
    );
    if (input.fields !== undefined) saveFields(it, id, checkFields(input.fields));
    it.engine.log("intake_form", `Changed intake form “${name}”`, { userId });
    return getForm(it, id);
  });
}

export function deleteForm(it: Intake, id: number, userId: number | null) {
  const f = formRow(it, id);
  it.run("UPDATE intake_forms SET deleted_at = ?, active = 0 WHERE id = ?", it.nowIso(), id);
  it.engine.log("intake_form", `Deleted intake form “${f.name}”`, { userId });
}

/** Give a form a new public link (the old one stops working). */
export function newFormLink(it: Intake, id: number, userId: number | null) {
  const f = formRow(it, id);
  it.run("UPDATE intake_forms SET token = ? WHERE id = ?", token(12), id);
  it.engine.log("intake_form", `Made a new public link for intake form “${f.name}”`, { userId });
  return getForm(it, id);
}

// ------------------------------------------------------------ public side

function publicFormRow(it: Intake, tok: string): Row {
  const f = typeof tok === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(tok) ? it.one("SELECT * FROM intake_forms WHERE token = ? AND deleted_at IS NULL", tok) : undefined;
  if (!f || !f.active) bad("This form isn't available. Please contact the firm directly.", 404);
  return f;
}

/** What the public form page needs. No ids of people or internal settings. */
export function publicForm(it: Intake, tok: string) {
  const f = publicFormRow(it, tok);
  return {
    firmName: it.firmName(),
    title: f.name,
    intro: f.intro,
    fields: fieldsOf(it, f.id).map(({ id, label, type, required, help, options }) => ({ id, label, type, required, help, options })),
    stamp: it.stamp(`form:${f.id}`),
  };
}

export function hashIp(ip: string | null | undefined): string {
  return createHash("sha256").update(`lawdesk-intake:${ip || "unknown"}`).digest("hex").slice(0, 32);
}

/** Refuse when this address has sent too many accepted submissions lately. Throws 429. */
export function rateLimit(it: Intake, ip: string | null | undefined) {
  const h = hashIp(ip);
  const now = it.now();
  it.run("DELETE FROM intake_submit_log WHERE at < ?", now - 2 * 86_400_000);
  const recent = it.one("SELECT COUNT(*) AS n FROM intake_submit_log WHERE ip_hash = ? AND outcome = 'accepted' AND at > ?", h, now - 600_000)!.n;
  const day = it.one("SELECT COUNT(*) AS n FROM intake_submit_log WHERE ip_hash = ? AND outcome = 'accepted' AND at > ?", h, now - 86_400_000)!.n;
  if (recent >= RATE.perTenMinutes || day >= RATE.perDay) {
    it.run("INSERT INTO intake_submit_log (ip_hash, at, outcome) VALUES (?,?,?)", h, now, "limited");
    bad("We've received several messages from this connection already. Please try again later, or call the firm.", 429);
  }
  return h;
}

/**
 * The spam checks shared by forms and booking. Returns "spam" when the honeypot was filled
 * (the caller answers as if it worked and saves nothing), otherwise the address hash.
 */
export function spamCheck(it: Intake, purpose: string, body: Row, ip: string | null | undefined): "spam" | string {
  const h = hashIp(ip);
  if (body?.[HONEYPOT]) {
    it.run("INSERT INTO intake_submit_log (ip_hash, at, outcome) VALUES (?,?,?)", h, it.now(), "spam");
    return "spam";
  }
  const age = it.stampAge(purpose, body?.stamp);
  if (age === null || age > MAX_FILL_MS || age < -60_000) bad("This page has expired. Please reload it and try again.", 400);
  if (age < MIN_FILL_MS) bad("That was sent very quickly. Please check your answers and press Send again.", 400);
  rateLimit(it, ip);
  return h;
}

/** Check one answer against its question. Returns the cleaned text ("" when blank). */
export function checkAnswer(f: Row, raw: unknown): string {
  const label = f.label;
  let v: string;
  if (raw === undefined || raw === null) v = "";
  else if (typeof raw === "boolean") v = raw ? "yes" : "no";
  else if (typeof raw === "string" || typeof raw === "number") v = String(raw).replace(/\r\n/g, "\n").trim();
  else bad(`“${label}” has an answer we can't read`);
  if (!v) {
    if (f.required) bad(`Please answer “${label}”`);
    return "";
  }
  switch (f.type as FieldType) {
    case "short":
      if (v.length > 300) bad(`“${label}” is too long`);
      return v.replace(/\s+/g, " ");
    case "long":
      if (v.length > 8000) bad(`“${label}” is too long (at most 8,000 characters)`);
      return v;
    case "email":
      return cleanEmail(v, `“${label}”`)!;
    case "phone":
      return cleanPhone(v, `“${label}”`)!;
    case "date":
      if (!isISODate(v)) bad(`“${label}” must be a date`);
      return v;
    case "choice":
      if (!(f.options as string[]).includes(v)) bad(`Choose one of the options for “${label}”`);
      return v;
    case "yesno":
      if (v !== "yes" && v !== "no") bad(`Answer yes or no to “${label}”`);
      if (f.required && v !== "yes" && v !== "no") bad(`Please answer “${label}”`);
      return v;
  }
  return v;
}

/** A visitor sent the form. Creates the lead (with conflict check and first-call reminder). */
export function submitForm(it: Intake, tok: string, body: Row, ip: string | null | undefined) {
  const f = publicFormRow(it, tok);
  const thanks = f.thanks || `Thank you. ${it.firmName()} has received your message and will be in touch soon.`;
  const h = spamCheck(it, `form:${f.id}`, body, ip);
  if (h === "spam") return { ok: true, thanks };
  const answersIn = body?.answers && typeof body.answers === "object" && !Array.isArray(body.answers) ? body.answers : {};
  const lead: Row = { opposing: [] as string[], summary: [] as string[] };
  const answers: { label: string; value: string }[] = [];
  for (const q of fieldsOf(it, f.id)) {
    const v = checkAnswer(q, answersIn[q.id]);
    if (q.type === "yesno" && !v && !q.required) answers.push({ label: q.label, value: "" });
    else answers.push({ label: q.label, value: v });
    if (!v) continue;
    switch (q.mapsTo) {
      case "name":
      case "email":
      case "phone":
      case "source":
        lead[q.mapsTo] = v;
        break;
      case "summary":
        lead.summary.push(v);
        break;
      case "opposing_party":
        lead.opposing.push(...v.split(/\n|;/).map((s: string) => s.trim()).filter(Boolean));
        break;
    }
  }
  return tx(it.db, () => {
    const created = it.createLead(
      {
        name: lead.name,
        email: lead.email,
        phone: lead.phone,
        source: lead.source ?? null,
        summary: lead.summary.join("\n\n") || null,
        opposing: lead.opposing.slice(0, 20),
        practiceAreaId: f.practice_area_id,
        ownerId: f.owner_id,
        formId: f.id,
        answers: answers.filter((a) => a.value),
        via: `Sent the “${f.name}” form on the website`,
      },
      null,
    );
    it.run("INSERT INTO intake_submit_log (ip_hash, at, outcome) VALUES (?,?,?)", h, it.now(), "accepted");
    return { ok: true, thanks, leadId: created.id as number };
  });
}
