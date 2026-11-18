// The contact book: a searchable list, one contact's full record, extra phone numbers /
// emails / addresses, and the history of saved conflict checks with filters.

import type { DB } from "../db.ts";
import { EngineError } from "../engine.ts";
import { listAliases, listRelationships, logActivity, contactName } from "../conflicts/store.ts";
import { DETAIL_KINDS } from "./schema.ts";
import { bandCounts, roleLabel } from "./plain.ts";

type Row = Record<string, any>;

const now = () => new Date().toISOString();

function text(v: unknown, what: string, max = 300): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string" && typeof v !== "number") throw new EngineError(`${what} must be text`);
  const s = String(v).trim();
  if (s.length > max) throw new EngineError(`${what} is too long`);
  return s || null;
}

/** Fold for searching: lower case, accents off, punctuation to spaces. */
export function foldSearch(s: string): string {
  return String(s ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9@.]+/g, " ")
    .trim();
}

// ------------------------------------------------------------- directory

export interface DirectoryFilter {
  q?: string | null;
  kind?: string | null;
  limit?: number;
}

/**
 * Every contact with what the list screen shows: other names, the best phone and email,
 * city, and matter counts. Search looks at names, other names, emails, phone numbers
 * (digits only) and addresses. Small firms have thousands of contacts, not millions, so
 * this filters in memory after one pass over each table.
 */
export function directory(db: DB, f: DirectoryFilter = {}) {
  const contacts = db.prepare("SELECT * FROM contacts ORDER BY name COLLATE NOCASE").all() as Row[];
  const aliases = new Map<number, string[]>();
  for (const a of db.prepare("SELECT contact_id, name FROM conflicts_aliases ORDER BY id").all() as Row[]) {
    (aliases.get(a.contact_id) ?? aliases.set(a.contact_id, []).get(a.contact_id)!).push(a.name);
  }
  const details = new Map<number, Row[]>();
  for (const d of db.prepare("SELECT * FROM contacts_details ORDER BY id").all() as Row[]) {
    (details.get(d.contact_id) ?? details.set(d.contact_id, []).get(d.contact_id)!).push(d);
  }
  const counts = new Map<number, { open: number; total: number }>();
  const rows = db
    .prepare(
      `SELECT x.contact_id, m.status FROM (
         SELECT contact_id, matter_id FROM conflicts_matter_parties
         UNION SELECT client_id, id FROM matters WHERE client_id IS NOT NULL
       ) x JOIN matters m ON m.id = x.matter_id`,
    )
    .all() as Row[];
  for (const r of rows) {
    const c = counts.get(r.contact_id) ?? { open: 0, total: 0 };
    c.total++;
    if (r.status === "open") c.open++;
    counts.set(r.contact_id, c);
  }

  const needle = foldSearch(f.q ?? "");
  const digits = String(f.q ?? "").replace(/\D/g, "");
  const kind = f.kind === "person" || f.kind === "company" ? f.kind : null;
  const out: Row[] = [];
  let total = 0;
  for (const c of contacts) {
    if (kind && c.kind !== kind) continue;
    const ds = details.get(c.id) ?? [];
    const al = aliases.get(c.id) ?? [];
    if (needle) {
      const hay = foldSearch(
        [c.name, ...al, c.email, ...ds.map((d) => [d.value, d.line1, d.line2, d.city, d.postal_code].filter(Boolean).join(" "))].filter(Boolean).join(" | "),
      );
      const phones = [c.phone, ...ds.filter((d) => d.kind === "phone").map((d) => d.value)].map((p) => String(p ?? "").replace(/\D/g, ""));
      const words = needle.split(" ").filter(Boolean);
      const textHit = words.every((w) => hay.includes(w));
      const phoneHit = digits.length >= 3 && phones.some((p) => p.includes(digits));
      if (!textHit && !phoneHit) continue;
    }
    total++;
    if (out.length >= (f.limit ?? 500)) continue;
    const addr = ds.find((d) => d.kind === "address");
    const n = counts.get(c.id) ?? { open: 0, total: 0 };
    out.push({
      id: c.id,
      name: c.name,
      kind: c.kind,
      email: c.email ?? ds.find((d) => d.kind === "email")?.value ?? null,
      phone: c.phone ?? ds.find((d) => d.kind === "phone")?.value ?? null,
      city: addr ? [addr.city, addr.region].filter(Boolean).join(", ") || null : null,
      aliases: al,
      openMatters: n.open,
      matters: n.total,
    });
  }
  return { total, contacts: out };
}

// --------------------------------------------------------------- profile

/** Everything the contact page shows. */
export function profile(db: DB, id: number) {
  const contact = db.prepare("SELECT * FROM contacts WHERE id = ?").get(id) as Row | undefined;
  if (!contact) throw new EngineError("Contact not found", 404);
  const matters = db
    .prepare(
      `SELECT m.id, m.number, m.name, m.status, m.opened_on, m.closed_on, x.role, x.note, x.party_id
         FROM (
           SELECT matter_id, role, note, id AS party_id FROM conflicts_matter_parties WHERE contact_id = ?
           UNION ALL
           SELECT id, 'client', NULL, NULL FROM matters m2 WHERE client_id = ?
             AND NOT EXISTS (SELECT 1 FROM conflicts_matter_parties p WHERE p.matter_id = m2.id AND p.contact_id = ? AND p.role = 'client')
         ) x JOIN matters m ON m.id = x.matter_id
        ORDER BY m.status = 'closed', m.opened_on DESC, m.id DESC`,
    )
    .all(id, id, id) as Row[];
  for (const m of matters) m.roleLabel = roleLabel(m.role);
  const relationships = listRelationships(db, id).map((r) => ({
    ...r,
    direction: r.from_contact_id === id ? "from" : "to",
    other_id: r.from_contact_id === id ? r.to_contact_id : r.from_contact_id,
    other_name: r.from_contact_id === id ? r.to_name : r.from_name,
  }));
  const checks = db
    .prepare(
      `SELECT DISTINCT k.id, k.run_at, k.decision, k.matter_id, m.name AS matter_name, m.number AS matter_number,
              json_extract(j.value, '$.band') AS band
         FROM conflicts_checks k, json_each(k.results) j LEFT JOIN matters m ON m.id = k.matter_id
        WHERE json_extract(j.value, '$.contactId') = ? ORDER BY k.id DESC LIMIT 20`,
    )
    .all(id) as Row[];
  return {
    contact,
    details: db.prepare("SELECT * FROM contacts_details WHERE contact_id = ? ORDER BY kind, id").all(id) as Row[],
    aliases: listAliases(db, id),
    relationships,
    matters,
    checks,
  };
}

// --------------------------------------------------------------- details

export interface DetailInput {
  kind?: string;
  label?: string | null;
  value?: string | null;
  line1?: string | null;
  line2?: string | null;
  city?: string | null;
  region?: string | null;
  postalCode?: string | null;
  country?: string | null;
}

function cleanDetail(input: DetailInput, kind: string) {
  const d = {
    label: text(input.label, "Label", 60),
    value: text(input.value, kind === "address" ? "Value" : cap(kind), 300),
    line1: text(input.line1, "Street", 200),
    line2: text(input.line2, "Street (line 2)", 200),
    city: text(input.city, "City", 100),
    region: text(input.region, "State", 60),
    postalCode: text(input.postalCode, "ZIP code", 20),
    country: text(input.country, "Country", 60),
  };
  if (kind === "address") {
    d.value = null;
    if (!d.line1 && !d.city) throw new EngineError("An address needs a street or a city");
  } else {
    d.line1 = d.line2 = d.city = d.region = d.postalCode = d.country = null;
    if (!d.value) throw new EngineError(`Enter the ${kind === "website" ? "web address" : kind === "email" ? "email address" : "phone number"}`);
    if (kind === "email" && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(d.value)) throw new EngineError("That email address doesn't look right");
    if (kind === "phone" && (d.value.replace(/\D/g, "").length < 7)) throw new EngineError("That phone number looks too short");
  }
  return d;
}

function cap(s: string) {
  return s[0].toUpperCase() + s.slice(1);
}

export function describeDetail(d: Row): string {
  if (d.kind !== "address") return d.value;
  const cityLine = [d.city, [d.region, d.postal_code].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  return [d.line1, d.line2, cityLine, d.country].filter(Boolean).join(", ");
}

export function addDetail(db: DB, contactId: number, input: DetailInput, userId: number | null = null) {
  const who = contactName(db, contactId);
  const kind = String(input?.kind ?? "");
  if (!(DETAIL_KINDS as readonly string[]).includes(kind)) throw new EngineError(`Kind must be one of: ${DETAIL_KINDS.join(", ")}`);
  const d = cleanDetail(input, kind);
  const id = Number(
    db
      .prepare(
        "INSERT INTO contacts_details (contact_id, kind, label, value, line1, line2, city, region, postal_code, country, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(contactId, kind, d.label, d.value, d.line1, d.line2, d.city, d.region, d.postalCode, d.country, now()).lastInsertRowid,
  );
  const row = db.prepare("SELECT * FROM contacts_details WHERE id = ?").get(id) as Row;
  logActivity(db, "contact_detail_added", `Added ${kind} for ${who}: ${describeDetail(row)}`, { userId });
  return row;
}

export function updateDetail(db: DB, id: number, input: DetailInput, userId: number | null = null) {
  const cur = db.prepare("SELECT * FROM contacts_details WHERE id = ?").get(id) as Row | undefined;
  if (!cur) throw new EngineError("Contact detail not found", 404);
  const merged: DetailInput = {
    label: input.label !== undefined ? input.label : cur.label,
    value: input.value !== undefined ? input.value : cur.value,
    line1: input.line1 !== undefined ? input.line1 : cur.line1,
    line2: input.line2 !== undefined ? input.line2 : cur.line2,
    city: input.city !== undefined ? input.city : cur.city,
    region: input.region !== undefined ? input.region : cur.region,
    postalCode: input.postalCode !== undefined ? input.postalCode : cur.postal_code,
    country: input.country !== undefined ? input.country : cur.country,
  };
  const d = cleanDetail(merged, cur.kind);
  db.prepare("UPDATE contacts_details SET label=?, value=?, line1=?, line2=?, city=?, region=?, postal_code=?, country=? WHERE id=?").run(
    d.label, d.value, d.line1, d.line2, d.city, d.region, d.postalCode, d.country, id,
  );
  const row = db.prepare("SELECT * FROM contacts_details WHERE id = ?").get(id) as Row;
  logActivity(db, "contact_detail_changed", `Changed ${cur.kind} for ${contactName(db, cur.contact_id)}: ${describeDetail(row)}`, { userId });
  return row;
}

export function deleteDetail(db: DB, id: number, userId: number | null = null) {
  const cur = db.prepare("SELECT * FROM contacts_details WHERE id = ?").get(id) as Row | undefined;
  if (!cur) throw new EngineError("Contact detail not found", 404);
  db.prepare("DELETE FROM contacts_details WHERE id = ?").run(id);
  logActivity(db, "contact_detail_removed", `Removed ${cur.kind} for ${contactName(db, cur.contact_id)}: ${describeDetail(cur)}`, { userId });
}

// ------------------------------------------------------- saved checks

export interface CheckFilter {
  decision?: string | null; // pending | cleared | waived | declined
  q?: string | null;
  from?: string | null; // YYYY-MM-DD, inclusive (UTC date of run_at)
  to?: string | null;
  matterId?: number | null;
  linked?: "yes" | "no" | null;
  hits?: "any" | "strong" | "none" | null;
  limit?: number;
}

/** Saved checks, newest first, with the filters the history screen offers. */
export function checkHistory(db: DB, f: CheckFilter = {}) {
  const where: string[] = [];
  const p: any[] = [];
  if (f.decision === "pending") where.push("k.decision IS NULL");
  else if (f.decision) {
    if (!["cleared", "waived", "declined"].includes(f.decision)) throw new EngineError("Decision must be pending, cleared, waived or declined");
    where.push("k.decision = ?");
    p.push(f.decision);
  }
  for (const [v, op, what] of [[f.from, ">=", "From"], [f.to, "<=", "To"]] as const) {
    if (!v) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new EngineError(`${what} must be a date like 2026-01-31`);
    where.push(`substr(k.run_at, 1, 10) ${op} ?`);
    p.push(v);
  }
  if (f.matterId != null) (where.push("k.matter_id = ?"), p.push(f.matterId));
  if (f.linked === "yes") where.push("k.matter_id IS NOT NULL");
  if (f.linked === "no") where.push("k.matter_id IS NULL");
  if (f.hits === "none") where.push("k.hit_count = 0");
  const rows = db
    .prepare(
      `SELECT k.*, m.name AS matter_name, m.number AS matter_number, ru.name AS run_by_name, du.name AS decided_by_name
         FROM conflicts_checks k LEFT JOIN matters m ON m.id = k.matter_id
         LEFT JOIN users ru ON ru.id = k.run_by LEFT JOIN users du ON du.id = k.decided_by
         ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY k.id DESC`,
    )
    .all(...p) as Row[];
  const needle = foldSearch(f.q ?? "");
  const out: Row[] = [];
  for (const r of rows) {
    const terms = JSON.parse(r.terms) as Row[];
    const results = JSON.parse(r.results) as Row[];
    if (needle) {
      const hay = foldSearch([...terms.map((t) => t.name), ...results.map((h) => h.name), r.matter_name, r.matter_number, r.decision_note].filter(Boolean).join(" | "));
      if (!needle.split(" ").every((w) => hay.includes(w))) continue;
    }
    const counts = bandCounts(results);
    if (f.hits === "strong" && !counts.strong) continue;
    if (f.hits === "any" && !results.length) continue;
    out.push({
      id: r.id,
      runAt: r.run_at,
      runByName: r.run_by_name,
      matterId: r.matter_id,
      matterName: r.matter_name,
      matterNumber: r.matter_number,
      terms: terms.map((t) => ({ name: t.name, role: t.role ?? null, roleLabel: roleLabel(t.role) })),
      hitCount: r.hit_count,
      counts,
      decision: r.decision,
      decisionNote: r.decision_note,
      decidedAt: r.decided_at,
      decidedByName: r.decided_by_name,
    });
    if (out.length >= Math.min(Math.max(1, f.limit ?? 200), 1000)) break;
  }
  return out;
}
