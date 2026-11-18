// Tables for richer contacts and conflict-of-interest checks. They extend the core
// `contacts` and `matters` tables without altering them.

export const ALIAS_KINDS = ["former_name", "maiden_name", "dba", "trade_name", "nickname", "misspelling", "other"] as const;

export const RELATIONSHIP_KINDS = [
  "officer", "director", "owner", "member", "manager", "partner", "shareholder", "employee",
  "registered_agent", "parent", "affiliate", "spouse", "former_spouse", "family", "insurer", "other",
] as const;

export const PARTY_ROLES = [
  "client", "adverse_party", "opposing_counsel", "co_party", "witness", "related_party", "prospective_client",
] as const;

export const DECISIONS = ["cleared", "waived", "declined"] as const;

const q = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(",");

export const SCHEMA = `
-- Other names a contact is or was known by. Searched exactly like the contact's own name.
CREATE TABLE IF NOT EXISTS conflicts_aliases (
  id INTEGER PRIMARY KEY,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'other' CHECK (kind IN (${q(ALIAS_KINDS)})),
  note TEXT,
  created_at TEXT NOT NULL
);

-- "from is <kind> of to": John Smith is owner of Acme LLC; Acme Holdings is parent of Acme LLC.
CREATE TABLE IF NOT EXISTS conflicts_relationships (
  id INTEGER PRIMARY KEY,
  from_contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  to_contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN (${q(RELATIONSHIP_KINDS)})),
  note TEXT,
  created_at TEXT NOT NULL,
  CHECK (from_contact_id <> to_contact_id),
  UNIQUE (from_contact_id, to_contact_id, kind)
);

-- Who is involved in a matter and how. The matter's client_id also counts as a client.
CREATE TABLE IF NOT EXISTS conflicts_matter_parties (
  id INTEGER PRIMARY KEY,
  matter_id INTEGER NOT NULL REFERENCES matters(id) ON DELETE CASCADE,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN (${q(PARTY_ROLES)})),
  note TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (matter_id, contact_id, role)
);

-- Every conflict search that was run: the terms, the results as shown, and the lawyer's decision.
-- Results are stored as they were at the time, so later edits to contacts do not rewrite history.
CREATE TABLE IF NOT EXISTS conflicts_checks (
  id INTEGER PRIMARY KEY,
  matter_id INTEGER REFERENCES matters(id) ON DELETE SET NULL,
  run_by INTEGER REFERENCES users(id),
  run_at TEXT NOT NULL,
  terms TEXT NOT NULL,             -- JSON array of {name, kind?, role?}
  results TEXT NOT NULL,           -- JSON array of hits
  hit_count INTEGER NOT NULL,
  decision TEXT CHECK (decision IN (${q(DECISIONS)})),
  decision_note TEXT,
  decided_by INTEGER REFERENCES users(id),
  decided_at TEXT
);

-- Each decision ever recorded on a check, so a changed decision keeps its history.
CREATE TABLE IF NOT EXISTS conflicts_decisions (
  id INTEGER PRIMARY KEY,
  check_id INTEGER NOT NULL REFERENCES conflicts_checks(id) ON DELETE CASCADE,
  decision TEXT NOT NULL CHECK (decision IN (${q(DECISIONS)})),
  note TEXT,
  decided_by INTEGER REFERENCES users(id),
  decided_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS conflicts_aliases_contact ON conflicts_aliases(contact_id);
CREATE INDEX IF NOT EXISTS conflicts_rel_from ON conflicts_relationships(from_contact_id);
CREATE INDEX IF NOT EXISTS conflicts_rel_to ON conflicts_relationships(to_contact_id);
CREATE INDEX IF NOT EXISTS conflicts_parties_contact ON conflicts_matter_parties(contact_id);
CREATE INDEX IF NOT EXISTS conflicts_parties_matter ON conflicts_matter_parties(matter_id);
CREATE INDEX IF NOT EXISTS conflicts_checks_matter ON conflicts_checks(matter_id, id);
CREATE INDEX IF NOT EXISTS conflicts_decisions_check ON conflicts_decisions(check_id, id);
`;
