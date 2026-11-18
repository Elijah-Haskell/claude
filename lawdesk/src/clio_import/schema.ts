// Tables for importing from Clio Manage. Run after the core, billing and calendar schemas.

export const SCHEMA = `
-- Which Lawdesk record each Clio record became, so importing again updates instead of duplicating.
--   kind       user, contact, matter, task, event, activity
--   clio_key   "id:<Clio id>" when Clio's ID is known, else "csv:<name/number/...>"
--   record_hash  fingerprint of the values last imported; unchanged rows are left alone
--   clio_total_cents  Clio's own total for time and expense entries (for reconciliation)
CREATE TABLE IF NOT EXISTS clio_import_map (
  kind TEXT NOT NULL,
  clio_key TEXT NOT NULL,
  lawdesk_id INTEGER NOT NULL,
  target TEXT NOT NULL,          -- the Lawdesk table lawdesk_id is in
  record_hash TEXT,
  clio_total_cents INTEGER,
  first_run_id INTEGER,
  last_run_id INTEGER,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (kind, clio_key)
);
CREATE INDEX IF NOT EXISTS clio_import_map_target ON clio_import_map(kind, lawdesk_id);

-- One import: a CSV file or an API pull. The report is JSON (see report.ts).
CREATE TABLE IF NOT EXISTS clio_import_runs (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL CHECK (source IN ('csv','api')),
  kind TEXT NOT NULL,
  file_name TEXT,
  dry_run INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','done','failed','paused')),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  user_id INTEGER REFERENCES users(id),
  report TEXT
);

-- Time and expenses Clio had already billed. Kept as history only: they are not in the billing
-- tables, because Lawdesk has no invoice to attach them to and they must never be billed again.
CREATE TABLE IF NOT EXISTS clio_import_billed (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('time','expense')),
  matter_id INTEGER NOT NULL REFERENCES matters(id),
  user_id INTEGER REFERENCES users(id),
  date TEXT NOT NULL,
  minutes INTEGER NOT NULL DEFAULT 0,
  rate_cents INTEGER,
  amount_cents INTEGER NOT NULL DEFAULT 0,
  description TEXT NOT NULL DEFAULT '',
  bill_number TEXT,
  code TEXT,
  billable INTEGER NOT NULL DEFAULT 1,
  run_id INTEGER
);
CREATE INDEX IF NOT EXISTS clio_import_billed_matter ON clio_import_billed(matter_id, date);

-- Trust balances read from Clio's trust report. REPORT ONLY: nothing here is a trust entry.
-- Opening trust balances are entered in the trust module after the accountant signs off.
CREATE TABLE IF NOT EXISTS clio_import_trust_balances (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL,
  client_name TEXT,
  matter_ref TEXT,
  matter_id INTEGER REFERENCES matters(id),
  account TEXT,
  balance_cents INTEGER NOT NULL,
  as_of TEXT
);

-- OAuth tokens for the Clio API (one connection per Lawdesk install). Encrypted with
-- CLIO_TOKEN_KEY when it is set (AES-256-GCM); see api.ts.
CREATE TABLE IF NOT EXISTS clio_import_tokens (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  region TEXT NOT NULL,
  access_token TEXT NOT NULL,
  refresh_token TEXT,
  expires_at TEXT,
  encrypted INTEGER NOT NULL DEFAULT 0,
  connected_at TEXT NOT NULL,
  connected_by INTEGER REFERENCES users(id)
);

-- One-time "state" values for the OAuth sign-in round trip (protects against forged callbacks).
CREATE TABLE IF NOT EXISTS clio_import_oauth_states (
  state TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  user_id INTEGER
);

-- An API import in progress. Each page of results is saved in the same transaction as the
-- cursor, so an interrupted import resumes at the next unread page.
CREATE TABLE IF NOT EXISTS clio_import_api_jobs (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES clio_import_runs(id),
  status TEXT NOT NULL CHECK (status IN ('running','paused','done','failed')),
  step INTEGER NOT NULL DEFAULT 0,           -- index into the resource list
  next_url TEXT,                              -- next page of the current resource (NULL = first page)
  progress TEXT NOT NULL DEFAULT '{}',        -- JSON: per resource { pages, records }
  waiting_until TEXT,                         -- set while paused for Clio's rate limit
  error TEXT,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;
