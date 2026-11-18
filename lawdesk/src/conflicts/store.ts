// Aliases, relationships between contacts, and the parties to each matter.

import { type DB, tx } from "../db.ts";
import { EngineError } from "../engine.ts";
import { ALIAS_KINDS, PARTY_ROLES, RELATIONSHIP_KINDS } from "./schema.ts";

type Row = Record<string, any>;

export type AliasKind = (typeof ALIAS_KINDS)[number];
export type RelationshipKind = (typeof RELATIONSHIP_KINDS)[number];
export type PartyRole = (typeof PARTY_ROLES)[number];

/** How each relationship reads, "<from> is <phrase> <to>". */
export const RELATIONSHIP_PHRASES: Record<RelationshipKind, string> = {
  officer: "an officer of",
  director: "a director of",
  owner: "an owner of",
  member: "a member of",
  manager: "a manager of",
  partner: "a partner in",
  shareholder: "a shareholder of",
  employee: "an employee of",
  registered_agent: "the registered agent of",
  parent: "the parent company of",
  affiliate: "an affiliate of",
  spouse: "the spouse of",
  former_spouse: "a former spouse of",
  family: "a family member of",
  insurer: "the insurer of",
  other: "related to",
};

export const ROLE_LABELS: Record<PartyRole, string> = {
  client: "client",
  adverse_party: "adverse party",
  opposing_counsel: "opposing counsel",
  co_party: "co-party",
  witness: "witness",
  related_party: "related party",
  prospective_client: "prospective client",
};

const now = () => new Date().toISOString();

function one(db: DB, sql: string, ...p: any[]): Row | undefined {
  return db.prepare(sql).get(...p) as Row | undefined;
}
function all(db: DB, sql: string, ...p: any[]): Row[] {
  return db.prepare(sql).all(...p) as Row[];
}
function run(db: DB, sql: string, ...p: any[]): number {
  return Number(db.prepare(sql).run(...p).lastInsertRowid);
}
function must(db: DB, sql: string, what: string, ...p: any[]): Row {
  const r = one(db, sql, ...p);
  if (!r) throw new EngineError(`${what} not found`, 404);
  return r;
}
function oneOf<T extends string>(value: unknown, allowed: readonly T[], what: string, fallback?: T): T {
  if ((value === undefined || value === null || value === "") && fallback !== undefined) return fallback;
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new EngineError(`${what} must be one of: ${allowed.join(", ")}`);
  }
  return value as T;
}
function text(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  return s ? s : null;
}

/** Write to the shared activity log. */
export function logActivity(db: DB, kind: string, detail: string, ids: { userId?: number | null; matterId?: number | null }) {
  run(
    db,
    "INSERT INTO activity (at, user_id, matter_id, kind, detail) VALUES (?,?,?,?,?)",
    now(),
    ids.userId ?? null,
    ids.matterId ?? null,
    kind,
    detail,
  );
}

export function contactName(db: DB, id: number): string {
  return must(db, "SELECT name FROM contacts WHERE id = ?", "Contact", id).name;
}

export function matterLabel(m: { number?: string | null; name: string }): string {
  return m.number ? `${m.number} ${m.name}` : m.name;
}

// --------------------------------------------------------------- aliases

export interface AliasInput {
  name: string;
  kind?: AliasKind;
  note?: string | null;
}

export function addAlias(db: DB, contactId: number, input: AliasInput, userId: number | null = null): number {
  const name = text(input?.name);
  if (!name) throw new EngineError("An alias needs a name");
  const kind = oneOf(input.kind, ALIAS_KINDS, "Alias kind", "other");
  const who = contactName(db, contactId);
  const id = run(
    db,
    "INSERT INTO conflicts_aliases (contact_id, name, kind, note, created_at) VALUES (?,?,?,?,?)",
    contactId,
    name,
    kind,
    text(input.note),
    now(),
  );
  logActivity(db, "alias_added", `Added ${kind.replace("_", " ")} "${name}" to ${who}`, { userId });
  return id;
}

export function listAliases(db: DB, contactId: number): Row[] {
  contactName(db, contactId);
  return all(db, "SELECT * FROM conflicts_aliases WHERE contact_id = ? ORDER BY id", contactId);
}

export function updateAlias(db: DB, id: number, patch: Partial<AliasInput>, userId: number | null = null) {
  const a = must(db, "SELECT * FROM conflicts_aliases WHERE id = ?", "Alias", id);
  const name = patch.name === undefined ? a.name : text(patch.name);
  if (!name) throw new EngineError("An alias needs a name");
  const kind = patch.kind === undefined ? a.kind : oneOf(patch.kind, ALIAS_KINDS, "Alias kind");
  const note = patch.note === undefined ? a.note : text(patch.note);
  run(db, "UPDATE conflicts_aliases SET name = ?, kind = ?, note = ? WHERE id = ?", name, kind, note, id);
  if (name !== a.name) logActivity(db, "alias_changed", `Alias "${a.name}" of ${contactName(db, a.contact_id)} is now "${name}"`, { userId });
  return one(db, "SELECT * FROM conflicts_aliases WHERE id = ?", id);
}

export function deleteAlias(db: DB, id: number, userId: number | null = null) {
  const a = must(db, "SELECT * FROM conflicts_aliases WHERE id = ?", "Alias", id);
  run(db, "DELETE FROM conflicts_aliases WHERE id = ?", id);
  logActivity(db, "alias_removed", `Removed alias "${a.name}" from ${contactName(db, a.contact_id)}`, { userId });
}

// --------------------------------------------------------- relationships

export interface RelationshipInput {
  fromContactId: number;
  toContactId: number;
  kind: RelationshipKind;
  note?: string | null;
}

export function addRelationship(db: DB, input: RelationshipInput, userId: number | null = null): number {
  const kind = oneOf(input?.kind, RELATIONSHIP_KINDS, "Relationship kind");
  const from = Number(input.fromContactId);
  const to = Number(input.toContactId);
  if (from === to) throw new EngineError("A contact cannot be related to itself");
  const a = contactName(db, from);
  const b = contactName(db, to);
  if (one(db, "SELECT id FROM conflicts_relationships WHERE from_contact_id = ? AND to_contact_id = ? AND kind = ?", from, to, kind)) {
    throw new EngineError("That relationship is already recorded", 409);
  }
  const id = run(
    db,
    "INSERT INTO conflicts_relationships (from_contact_id, to_contact_id, kind, note, created_at) VALUES (?,?,?,?,?)",
    from,
    to,
    kind,
    text(input.note),
    now(),
  );
  logActivity(db, "relationship_added", `${a} is ${RELATIONSHIP_PHRASES[kind]} ${b}`, { userId });
  return id;
}

/** Every relationship a contact is on either side of, phrased from the stored direction. */
export function listRelationships(db: DB, contactId: number): Row[] {
  contactName(db, contactId);
  const rows = all(
    db,
    `SELECT r.*, f.name AS from_name, t.name AS to_name FROM conflicts_relationships r
     JOIN contacts f ON f.id = r.from_contact_id JOIN contacts t ON t.id = r.to_contact_id
     WHERE r.from_contact_id = ? OR r.to_contact_id = ? ORDER BY r.id`,
    contactId,
    contactId,
  );
  for (const r of rows) r.description = `${r.from_name} is ${RELATIONSHIP_PHRASES[r.kind as RelationshipKind]} ${r.to_name}`;
  return rows;
}

export function updateRelationship(db: DB, id: number, patch: { kind?: RelationshipKind; note?: string | null }, userId: number | null = null) {
  const r = must(db, "SELECT * FROM conflicts_relationships WHERE id = ?", "Relationship", id);
  const kind = patch.kind === undefined ? r.kind : oneOf(patch.kind, RELATIONSHIP_KINDS, "Relationship kind");
  const note = patch.note === undefined ? r.note : text(patch.note);
  try {
    run(db, "UPDATE conflicts_relationships SET kind = ?, note = ? WHERE id = ?", kind, note, id);
  } catch (e: any) {
    if (String(e?.message).includes("UNIQUE")) throw new EngineError("That relationship is already recorded", 409);
    throw e;
  }
  if (kind !== r.kind) {
    logActivity(db, "relationship_changed", `${contactName(db, r.from_contact_id)} is now ${RELATIONSHIP_PHRASES[kind as RelationshipKind]} ${contactName(db, r.to_contact_id)}`, { userId });
  }
  return one(db, "SELECT * FROM conflicts_relationships WHERE id = ?", id);
}

export function deleteRelationship(db: DB, id: number, userId: number | null = null) {
  const r = must(db, "SELECT * FROM conflicts_relationships WHERE id = ?", "Relationship", id);
  run(db, "DELETE FROM conflicts_relationships WHERE id = ?", id);
  logActivity(
    db,
    "relationship_removed",
    `Removed: ${contactName(db, r.from_contact_id)} is ${RELATIONSHIP_PHRASES[r.kind as RelationshipKind]} ${contactName(db, r.to_contact_id)}`,
    { userId },
  );
}

// --------------------------------------------------------- matter parties

export interface PartyInput {
  contactId: number;
  role: PartyRole;
  note?: string | null;
}

export function addParty(db: DB, matterId: number, input: PartyInput, userId: number | null = null): number {
  return tx(db, () => {
    const m = must(db, "SELECT * FROM matters WHERE id = ?", "Matter", matterId);
    const role = oneOf(input?.role, PARTY_ROLES, "Role");
    const contactId = Number(input.contactId);
    const who = contactName(db, contactId);
    if (one(db, "SELECT id FROM conflicts_matter_parties WHERE matter_id = ? AND contact_id = ? AND role = ?", matterId, contactId, role)) {
      throw new EngineError(`${who} is already ${ROLE_LABELS[role]} on this matter`, 409);
    }
    const id = run(
      db,
      "INSERT INTO conflicts_matter_parties (matter_id, contact_id, role, note, created_at) VALUES (?,?,?,?,?)",
      m.id,
      contactId,
      role,
      text(input.note),
      now(),
    );
    logActivity(db, "party_added", `Added ${who} as ${ROLE_LABELS[role]}`, { userId, matterId });
    return id;
  });
}

/** Parties recorded for a matter, plus the matter's client_id when it is not already listed as client. */
export function listParties(db: DB, matterId: number): Row[] {
  const m = must(db, "SELECT * FROM matters WHERE id = ?", "Matter", matterId);
  const rows = all(
    db,
    `SELECT p.*, c.name AS contact_name, c.kind AS contact_kind FROM conflicts_matter_parties p
     JOIN contacts c ON c.id = p.contact_id WHERE p.matter_id = ? ORDER BY p.id`,
    matterId,
  );
  if (m.client_id != null && !rows.some((r) => r.contact_id === m.client_id && r.role === "client")) {
    const c = one(db, "SELECT name, kind FROM contacts WHERE id = ?", m.client_id);
    if (c) rows.unshift({ id: null, matter_id: matterId, contact_id: m.client_id, role: "client", note: "Client on the matter record", contact_name: c.name, contact_kind: c.kind });
  }
  return rows;
}

export function updateParty(db: DB, id: number, patch: { role?: PartyRole; note?: string | null }, userId: number | null = null) {
  const p = must(db, "SELECT * FROM conflicts_matter_parties WHERE id = ?", "Party", id);
  const role = patch.role === undefined ? p.role : oneOf(patch.role, PARTY_ROLES, "Role");
  const note = patch.note === undefined ? p.note : text(patch.note);
  try {
    run(db, "UPDATE conflicts_matter_parties SET role = ?, note = ? WHERE id = ?", role, note, id);
  } catch (e: any) {
    if (String(e?.message).includes("UNIQUE")) throw new EngineError("That party already has that role on this matter", 409);
    throw e;
  }
  if (role !== p.role) {
    logActivity(db, "party_changed", `${contactName(db, p.contact_id)} is now ${ROLE_LABELS[role as PartyRole]} (was ${ROLE_LABELS[p.role as PartyRole]})`, {
      userId,
      matterId: p.matter_id,
    });
  }
  return one(db, "SELECT * FROM conflicts_matter_parties WHERE id = ?", id);
}

export function deleteParty(db: DB, id: number, userId: number | null = null) {
  const p = must(db, "SELECT * FROM conflicts_matter_parties WHERE id = ?", "Party", id);
  run(db, "DELETE FROM conflicts_matter_parties WHERE id = ?", id);
  logActivity(db, "party_removed", `Removed ${contactName(db, p.contact_id)} as ${ROLE_LABELS[p.role as PartyRole]}`, { userId, matterId: p.matter_id });
}
