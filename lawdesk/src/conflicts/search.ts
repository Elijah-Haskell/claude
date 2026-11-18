// Conflict search and the audit trail of checks.
//
// A search compares each name against every contact and every alias, then reports each
// contact that matches with its involvement in open and closed matters, and follows
// recorded relationships one hop out (an owner's company, a subsidiary's parent, a spouse).
// Each search is saved with its results so the firm can show what was checked, when, by
// whom, what came up, and what the lawyer decided.

import { type DB, tx } from "../db.ts";
import { EngineError } from "../engine.ts";
import {
  BANDS, band, prepare, scoreNames, splitNames, tokenSimilarity,
  type NameKind, type NameRule, type Prepared, type TokenMatch,
} from "./names.ts";
import { DECISIONS, PARTY_ROLES } from "./schema.ts";
import { ROLE_LABELS, RELATIONSHIP_PHRASES, logActivity, matterLabel, type PartyRole, type RelationshipKind } from "./store.ts";

type Row = Record<string, any>;

export interface SearchTerm {
  name: string;
  kind?: NameKind | null;
  /** The role this name would have in the proposed matter, if known. */
  role?: PartyRole | null;
  /** Set when the term came from a contact already on the proposed matter. */
  contactId?: number | null;
}

export interface SearchInput {
  terms?: (SearchTerm | string)[];
  /** The proposed matter. Its own parties are not reported as involvements, and when no
   *  terms are given its parties (and their aliases) become the terms. */
  matterId?: number | null;
  /** Hits below this are dropped. Default 0.6 (the "weak" band). */
  minScore?: number;
  /** Follow relationships one hop out. Default true. */
  related?: boolean;
  limit?: number;
}

export interface Involvement {
  matterId: number;
  matter: string;
  status: "open" | "closed";
  closedOn: string | null;
  role: PartyRole;
  text: string;
}

export interface NameMatch {
  term: string;
  matchedName: string;
  via: "name" | "alias";
  aliasKind: string | null;
  score: number;
  rules: NameRule[];
}

export interface Hit {
  contactId: number;
  name: string;
  kind: NameKind;
  score: number;
  band: "strong" | "possible" | "weak";
  /** "direct": the name matched; "related": reached through a relationship to a matched contact. */
  match: "direct" | "related";
  /** The single rule that best explains the score (first rule of the best match). */
  rule: string;
  matches: NameMatch[];
  relations: { text: string; viaContactId: number; viaScore: number }[];
  involvements: Involvement[];
  /** Roles this contact already has on the proposed matter (not counted as involvements). */
  onProposedMatter: PartyRole[];
  concerns: string[];
  severity: "high" | "medium" | "low" | "none";
  reasons: string[];
}

/** A related contact scores this fraction of the match that led to it. */
export const RELATED_FACTOR = 0.85;
/** Only matches at least this good are followed to related contacts. */
export const RELATED_MIN = BANDS.possible;
const DEFAULT_MIN = BANDS.weak;
const SEVERITY_RANK = { high: 3, medium: 2, low: 1, none: 0 } as const;

// ------------------------------------------------------------- the index

interface Entry {
  contactId: number;
  aliasId: number | null;
  aliasKind: string | null;
  name: string;
  kind: NameKind;
  p: Prepared;
}

interface Index {
  entries: Entry[];
  byToken: Map<string, number[]>;
  byJoined: Map<string, number[]>;
}

/** Prepared names, kept per database so a search over 50k contacts only re-normalises what changed. */
const prepCache = new WeakMap<DB, Map<string, Prepared>>();

function prepCached(db: DB, name: string, kind: NameKind): Prepared {
  let m = prepCache.get(db);
  if (!m) prepCache.set(db, (m = new Map()));
  const key = kind + "\u0000" + name;
  let p = m.get(key);
  if (!p) m.set(key, (p = prepare(name, kind)));
  return p;
}

function buildIndex(db: DB): Index {
  const entries: Entry[] = [];
  const byToken = new Map<string, number[]>();
  const byJoined = new Map<string, number[]>();
  const add = (e: Entry) => {
    if (!e.p.tokens.length) return;
    const i = entries.push(e) - 1;
    for (const t of new Set(e.p.tokens)) {
      const l = byToken.get(t);
      l ? l.push(i) : byToken.set(t, [i]);
    }
    const l = byJoined.get(e.p.joined);
    l ? l.push(i) : byJoined.set(e.p.joined, [i]);
  };
  for (const c of db.prepare("SELECT id, name, kind FROM contacts").all() as Row[]) {
    const parts = splitNames(c.name);
    parts.forEach((part, k) =>
      add({ contactId: c.id, aliasId: null, aliasKind: k === 0 ? null : "also known as", name: part, kind: c.kind, p: prepCached(db, part, c.kind) }),
    );
  }
  const aliases = db
    .prepare("SELECT a.id, a.contact_id, a.name, a.kind, c.kind AS contact_kind FROM conflicts_aliases a JOIN contacts c ON c.id = a.contact_id")
    .all() as Row[];
  for (const a of aliases) {
    for (const part of splitNames(a.name)) {
      add({ contactId: a.contact_id, aliasId: a.id, aliasKind: a.kind, name: part, kind: a.contact_kind, p: prepCached(db, part, a.contact_kind) });
    }
  }
  return { entries, byToken, byJoined };
}

/** For one query token, every indexed token it could pair with. */
function tokenMatches(index: Index, qt: string): Map<string, TokenMatch> {
  const out = new Map<string, TokenMatch>();
  for (const vt of index.byToken.keys()) {
    const m = tokenSimilarity(qt, vt);
    if (m) out.set(vt, m);
  }
  return out;
}

// ---------------------------------------------------------- involvements

function involvementsFor(db: DB, contactIds: number[]): Map<number, (Involvement & { matterIdRaw: number })[]> {
  const out = new Map<number, (Involvement & { matterIdRaw: number })[]>();
  if (!contactIds.length) return out;
  const ids = JSON.stringify(contactIds);
  const rows = db
    .prepare(
      `SELECT p.contact_id, p.role, m.id AS matter_id, m.number, m.name, m.status, m.closed_on
         FROM conflicts_matter_parties p JOIN matters m ON m.id = p.matter_id
        WHERE p.contact_id IN (SELECT value FROM json_each(?))
       UNION
       SELECT m.client_id AS contact_id, 'client' AS role, m.id, m.number, m.name, m.status, m.closed_on
         FROM matters m WHERE m.client_id IN (SELECT value FROM json_each(?))
       ORDER BY 1, 3`,
    )
    .all(ids, ids) as Row[];
  for (const r of rows) {
    const status = r.status === "closed" ? `closed${r.closed_on ? " " + String(r.closed_on).slice(0, 4) : ""}` : "open";
    const inv = {
      matterId: r.matter_id,
      matterIdRaw: r.matter_id,
      matter: matterLabel(r as any),
      status: r.status,
      closedOn: r.closed_on ?? null,
      role: r.role as PartyRole,
      text: `${ROLE_LABELS[r.role as PartyRole]} in matter ${matterLabel(r as any)} (${status})`,
    };
    const l = out.get(r.contact_id);
    l ? l.push(inv) : out.set(r.contact_id, [inv]);
  }
  return out;
}

/** Factual flags comparing the role proposed for a name with roles the contact already has. */
function concernsFor(invs: Involvement[], proposedRoles: Set<string>): { concerns: string[]; severity: Hit["severity"] } {
  const concerns: string[] = [];
  let sev = 0;
  const bump = (n: number) => (sev = Math.max(sev, n));
  const adverseProposed = proposedRoles.has("adverse_party");
  const clientProposed = proposedRoles.has("client") || proposedRoles.has("prospective_client");
  const unknown = proposedRoles.size === 0;
  for (const i of invs) {
    const open = i.status === "open";
    if (i.role === "prospective_client") {
      concerns.push(`Was a prospective client in matter ${i.matter}`);
      bump(2);
    } else if (i.role === "client") {
      if (adverseProposed) {
        concerns.push(open ? `Proposed adverse party is a current client (matter ${i.matter})` : `Proposed adverse party is a former client (matter ${i.matter})`);
        bump(open ? 3 : 2);
      } else if (unknown) {
        concerns.push(`${open ? "Current" : "Former"} client (matter ${i.matter})`);
        bump(2);
      } else bump(1);
    } else if (i.role === "adverse_party") {
      if (clientProposed) {
        concerns.push(`Proposed client was adverse to a firm client in matter ${i.matter}${open ? " (still open)" : ""}`);
        bump(open ? 3 : 2);
      } else if (unknown) {
        concerns.push(`Adverse party in matter ${i.matter}`);
        bump(2);
      } else bump(1);
    } else bump(1);
  }
  return { concerns, severity: (["none", "low", "medium", "high"] as const)[sev] };
}

// ---------------------------------------------------------------- search

function cleanTerms(db: DB, input: SearchInput): SearchTerm[] {
  const raw = input.terms ?? [];
  if (!Array.isArray(raw)) throw new EngineError("terms must be a list of names");
  const terms: SearchTerm[] = [];
  for (const t of raw) {
    const term: SearchTerm = typeof t === "string" ? { name: t } : { ...t };
    term.name = String(term.name ?? "").trim();
    if (!term.name) continue;
    if (term.kind != null && term.kind !== "person" && term.kind !== "company") throw new EngineError("kind must be person or company");
    if (term.role != null && !(PARTY_ROLES as readonly string[]).includes(term.role)) {
      throw new EngineError(`role must be one of: ${PARTY_ROLES.join(", ")}`);
    }
    terms.push({ name: term.name, kind: term.kind ?? null, role: term.role ?? null, contactId: term.contactId ?? null });
  }
  if (!terms.length && input.matterId != null) {
    // Use the proposed matter's own parties and their aliases.
    const rows = db
      .prepare(
        `SELECT c.id, c.name, c.kind, p.role FROM conflicts_matter_parties p JOIN contacts c ON c.id = p.contact_id WHERE p.matter_id = ?
         UNION SELECT c.id, c.name, c.kind, 'client' FROM matters m JOIN contacts c ON c.id = m.client_id WHERE m.id = ?`,
      )
      .all(input.matterId, input.matterId) as Row[];
    for (const r of rows) {
      terms.push({ name: r.name, kind: r.kind, role: r.role, contactId: r.id });
      for (const a of db.prepare("SELECT name FROM conflicts_aliases WHERE contact_id = ?").all(r.id) as Row[]) {
        terms.push({ name: a.name, kind: r.kind, role: r.role, contactId: r.id });
      }
    }
  }
  if (!terms.length) throw new EngineError("Give at least one name to search for");
  if (terms.length > 200) throw new EngineError("Too many names in one search (200 at most)");
  return terms;
}

/** Run a conflict search without saving it. Most callers want runCheck(). */
export function searchConflicts(db: DB, input: SearchInput): { terms: SearchTerm[]; hits: Hit[] } {
  const matterId = input.matterId ?? null;
  if (matterId != null && !db.prepare("SELECT id FROM matters WHERE id = ?").get(matterId)) throw new EngineError("Matter not found", 404);
  const terms = cleanTerms(db, input);
  const minScore = input.minScore ?? DEFAULT_MIN;
  if (typeof minScore !== "number" || minScore < 0 || minScore > 1) throw new EngineError("minScore must be between 0 and 1");
  const index = buildIndex(db);

  // best match per contact, per term
  const direct = new Map<number, { matches: NameMatch[]; best: number; roles: Set<string>; selfOnly: boolean }>();
  const tokCache = new Map<string, Map<string, TokenMatch>>();
  const tokFor = (t: string) => {
    let m = tokCache.get(t);
    if (!m) tokCache.set(t, (m = tokenMatches(index, t)));
    return m;
  };

  for (const term of terms) {
    for (const piece of splitNames(term.name)) {
      const q = prepare(piece, term.kind ?? undefined);
      if (!q.tokens.length) continue;
      const maps = new Map<string, Map<string, TokenMatch>>();
      for (const t of q.tokens) maps.set(t, tokFor(t));
      const sim = (a: string, b: string) => maps.get(a)?.get(b) ?? null;
      const cand = new Set<number>(index.byJoined.get(q.joined) ?? []);
      for (const [qt, m] of maps) {
        if (qt.length < 2) continue; // initials alone never make a hit
        for (const vt of m.keys()) {
          if (vt.length < 2) continue;
          for (const i of index.byToken.get(vt)!) cand.add(i);
        }
      }
      // A term typed as "Last, First" with no kind may be a person; score the other reading too.
      const qCompany = term.kind == null && q.reordered ? prepare(piece, "company") : q;
      const perContact = new Map<number, NameMatch>();
      for (const i of cand) {
        const e = index.entries[i];
        const s = scoreNames(e.kind === "company" ? qCompany : q, e.p, e.kind, sim);
        if (s.score < minScore) continue;
        const prev = perContact.get(e.contactId);
        if (prev && prev.score >= s.score) continue;
        perContact.set(e.contactId, {
          term: term.name,
          matchedName: e.name,
          via: e.aliasId != null || e.aliasKind ? "alias" : "name",
          aliasKind: e.aliasKind,
          score: s.score,
          rules: s.rules,
        });
      }
      for (const [cid, m] of perContact) {
        let d = direct.get(cid);
        if (!d) direct.set(cid, (d = { matches: [], best: 0, roles: new Set(), selfOnly: true }));
        const dup = d.matches.find((x) => x.term === m.term);
        if (dup) {
          if (dup.score < m.score) Object.assign(dup, m);
        } else d.matches.push(m);
        d.best = Math.max(d.best, m.score);
        if (term.role) d.roles.add(term.role);
        if (term.contactId !== cid) d.selfOnly = false;
      }
    }
  }

  // relationships one hop out from good matches
  type Rel = { text: string; viaContactId: number; viaScore: number; score: number; roles: Set<string> };
  const related = new Map<number, Rel[]>();
  if (input.related !== false) {
    const strong = [...direct].filter(([, d]) => d.best >= RELATED_MIN).map(([id]) => id);
    if (strong.length) {
      const ids = JSON.stringify(strong);
      const rels = db
        .prepare(
          `SELECT r.*, f.name AS from_name, t.name AS to_name FROM conflicts_relationships r
           JOIN contacts f ON f.id = r.from_contact_id JOIN contacts t ON t.id = r.to_contact_id
           WHERE r.from_contact_id IN (SELECT value FROM json_each(?)) OR r.to_contact_id IN (SELECT value FROM json_each(?))`,
        )
        .all(ids, ids) as Row[];
      for (const r of rels) {
        for (const [via, other] of [
          [r.from_contact_id, r.to_contact_id],
          [r.to_contact_id, r.from_contact_id],
        ] as [number, number][]) {
          const d = direct.get(via);
          if (!d || d.best < RELATED_MIN) continue;
          const text = `${r.from_name} is ${RELATIONSHIP_PHRASES[r.kind as RelationshipKind]} ${r.to_name}`;
          const l = related.get(other) ?? [];
          if (!l.some((x) => x.text === text)) l.push({ text, viaContactId: via, viaScore: d.best, score: Math.round(d.best * RELATED_FACTOR * 1000) / 1000, roles: d.roles });
          related.set(other, l);
        }
      }
    }
  }

  const allIds = [...new Set([...direct.keys(), ...related.keys()])];
  const invs = involvementsFor(db, allIds);
  const contacts = new Map<number, Row>();
  if (allIds.length) {
    for (const c of db.prepare("SELECT id, name, kind FROM contacts WHERE id IN (SELECT value FROM json_each(?))").all(JSON.stringify(allIds)) as Row[]) {
      contacts.set(c.id, c);
    }
  }

  const hits: Hit[] = [];
  for (const id of allIds) {
    const c = contacts.get(id);
    if (!c) continue;
    const d = direct.get(id);
    const rels = related.get(id) ?? [];
    const all = invs.get(id) ?? [];
    const involvements = all.filter((i) => i.matterIdRaw !== matterId).map(({ matterIdRaw, ...i }) => i);
    const onProposedMatter = all.filter((i) => i.matterIdRaw === matterId).map((i) => i.role);
    // A matter's own party matching itself, with nothing else on record, is not news.
    if (d && d.selfOnly && !involvements.length && !rels.length && d.matches.every((m) => m.score === 1)) continue;
    const relScore = rels.reduce((s, r) => Math.max(s, r.score), 0);
    const score = Math.max(d?.best ?? 0, relScore);
    if (!d && score < minScore) continue;
    const roles = new Set<string>([...(d?.roles ?? []), ...rels.flatMap((r) => [...r.roles])]);
    const { concerns, severity } = concernsFor(involvements, roles);

    const reasons: string[] = [];
    const matches = (d?.matches ?? []).sort((a, b) => b.score - a.score);
    for (const m of matches) {
      const how = m.rules.length ? m.rules.join(", ") : "exact";
      if (m.via === "alias") {
        const kind = m.aliasKind ? m.aliasKind.replace("_", " ") : "alias";
        reasons.push(`"${m.term}" matches "${m.matchedName}", ${kind === "also known as" ? "a name" : `${kind === "other" ? "an alias" : `${articled(kind)}`}`} of ${c.name} (${how}, ${m.score.toFixed(2)})`);
      } else {
        reasons.push(`"${m.term}" matches ${c.name} (${how}, ${m.score.toFixed(2)})`);
      }
    }
    if (d) for (const i of involvements) reasons.push(i.text[0].toUpperCase() + i.text.slice(1));
    for (const r of rels) {
      if (involvements.length) for (const i of involvements) reasons.push(`${r.text}, which is ${articled(ROLE_LABELS[i.role])} ${i.text.slice(ROLE_LABELS[i.role].length + 1)}`);
      else reasons.push(r.text);
    }
    const best = matches[0];
    hits.push({
      contactId: id,
      name: c.name,
      kind: c.kind,
      score,
      band: band(score) as Hit["band"],
      match: d && d.best >= relScore ? "direct" : "related",
      rule: d && d.best >= relScore ? (best.via === "alias" ? `alias: ${best.rules[0] ?? "exact"}` : best.rules[0] ?? "exact") : "relationship",
      matches,
      relations: rels.map(({ text, viaContactId, viaScore }) => ({ text, viaContactId, viaScore })),
      involvements,
      onProposedMatter,
      concerns,
      severity,
      reasons,
    });
  }
  hits.sort((a, b) => b.score - a.score || SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || a.name.localeCompare(b.name));
  return { terms, hits: hits.slice(0, input.limit ?? 500) };
}

function articled(label: string): string {
  return (/^[aeiou]/.test(label) ? "an " : "a ") + label;
}

// ------------------------------------------------------------ audit trail

const now = () => new Date().toISOString();

/** Search and save the check, with who ran it, the terms, and the results as shown. */
export function runCheck(db: DB, input: SearchInput, userId: number | null = null) {
  return tx(db, () => {
    const { terms, hits } = searchConflicts(db, input);
    const id = Number(
      db
        .prepare("INSERT INTO conflicts_checks (matter_id, run_by, run_at, terms, results, hit_count) VALUES (?,?,?,?,?,?)")
        .run(input.matterId ?? null, userId, now(), JSON.stringify(terms), JSON.stringify(hits), hits.length).lastInsertRowid,
    );
    const names = terms.map((t) => t.name).slice(0, 5).join("; ") + (terms.length > 5 ? `; and ${terms.length - 5} more` : "");
    logActivity(db, "conflict_check", `Conflict check #${id} for ${names}: ${hits.length} hit(s)`, { userId, matterId: input.matterId ?? null });
    return { checkId: id, terms, hits };
  });
}

function checkRow(r: Row, full: boolean) {
  const out: Row = {
    id: r.id,
    matterId: r.matter_id,
    matterName: r.matter_name ?? null,
    runBy: r.run_by,
    runByName: r.run_by_name ?? null,
    runAt: r.run_at,
    terms: JSON.parse(r.terms),
    hitCount: r.hit_count,
    decision: r.decision,
    decisionNote: r.decision_note,
    decidedBy: r.decided_by,
    decidedByName: r.decided_by_name ?? null,
    decidedAt: r.decided_at,
  };
  if (full) out.results = JSON.parse(r.results);
  return out;
}

const CHECK_SELECT = `SELECT k.*, m.name AS matter_name, ru.name AS run_by_name, du.name AS decided_by_name
  FROM conflicts_checks k LEFT JOIN matters m ON m.id = k.matter_id
  LEFT JOIN users ru ON ru.id = k.run_by LEFT JOIN users du ON du.id = k.decided_by`;

export function listChecks(db: DB, filter: { matterId?: number | null; pending?: boolean; limit?: number } = {}) {
  const where: string[] = [];
  const params: any[] = [];
  if (filter.matterId != null) {
    where.push("k.matter_id = ?");
    params.push(filter.matterId);
  }
  if (filter.pending) where.push("k.decision IS NULL");
  const rows = db
    .prepare(`${CHECK_SELECT} ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY k.id DESC LIMIT ?`)
    .all(...params, Math.min(Math.max(1, filter.limit ?? 100), 1000)) as Row[];
  return rows.map((r) => checkRow(r, false));
}

export function getCheck(db: DB, id: number) {
  const r = db.prepare(`${CHECK_SELECT} WHERE k.id = ?`).get(id) as Row | undefined;
  if (!r) throw new EngineError("Conflict check not found", 404);
  const out = checkRow(r, true);
  out.decisions = db
    .prepare(
      `SELECT d.id, d.decision, d.note, d.decided_by AS decidedBy, u.name AS decidedByName, d.decided_at AS decidedAt
       FROM conflicts_decisions d LEFT JOIN users u ON u.id = d.decided_by WHERE d.check_id = ? ORDER BY d.id`,
    )
    .all(id);
  return out;
}

/**
 * Record the lawyer's decision on a check. A waiver needs a note (for example, where the
 * written consent is filed). Deciding again keeps the earlier decisions in the history.
 */
export function decideCheck(db: DB, id: number, decision: string, note: string | null | undefined, userId: number | null = null) {
  return tx(db, () => {
    const k = db.prepare("SELECT * FROM conflicts_checks WHERE id = ?").get(id) as Row | undefined;
    if (!k) throw new EngineError("Conflict check not found", 404);
    if (!(DECISIONS as readonly string[]).includes(decision)) throw new EngineError(`Decision must be one of: ${DECISIONS.join(", ")}`);
    const n = note == null ? null : String(note).trim() || null;
    if (decision === "waived" && !n) throw new EngineError("Say how the conflict was waived (for example, where the consent is filed)");
    const at = now();
    db.prepare("UPDATE conflicts_checks SET decision = ?, decision_note = ?, decided_by = ?, decided_at = ? WHERE id = ?").run(decision, n, userId, at, id);
    db.prepare("INSERT INTO conflicts_decisions (check_id, decision, note, decided_by, decided_at) VALUES (?,?,?,?,?)").run(id, decision, n, userId, at);
    const was = k.decision ? ` (was ${k.decision})` : "";
    logActivity(db, "conflict_decision", `Conflict check #${id} ${decision}${was}${n ? ": " + n : ""}`, { userId, matterId: k.matter_id });
    return getCheck(db, id);
  });
}

/** Attach a check run at intake (before the matter existed) to the matter it was for. */
export function linkCheck(db: DB, id: number, matterId: number, userId: number | null = null) {
  return tx(db, () => {
    const k = db.prepare("SELECT * FROM conflicts_checks WHERE id = ?").get(id) as Row | undefined;
    if (!k) throw new EngineError("Conflict check not found", 404);
    const m = db.prepare("SELECT * FROM matters WHERE id = ?").get(matterId) as Row | undefined;
    if (!m) throw new EngineError("Matter not found", 404);
    if (k.matter_id != null && k.matter_id !== matterId) throw new EngineError("That check is already linked to another matter", 409);
    db.prepare("UPDATE conflicts_checks SET matter_id = ? WHERE id = ?").run(matterId, id);
    logActivity(db, "conflict_check_linked", `Conflict check #${id} (run ${String(k.run_at).slice(0, 10)}) linked to this matter`, { userId, matterId });
    return getCheck(db, id);
  });
}
