// Tables for the built-in electronic signature flow. See docs/esign.md.

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS esign_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  contact_email TEXT,                 -- where signers ask for paper copies or withdraw consent
  contact_phone TEXT,
  paper_copy_fee_cents INTEGER NOT NULL DEFAULT 0 CHECK (paper_copy_fee_cents >= 0),
  default_days INTEGER NOT NULL DEFAULT 14 CHECK (default_days BETWEEN 1 AND 90),
  updated_at TEXT,
  updated_by INTEGER REFERENCES users(id)
);
INSERT OR IGNORE INTO esign_settings (id) VALUES (1);

-- One document sent to one signer. The link token is stored only as a hash.
CREATE TABLE IF NOT EXISTS esign_requests (
  id INTEGER PRIMARY KEY,
  matter_id INTEGER NOT NULL REFERENCES matters(id),
  document_id INTEGER NOT NULL REFERENCES doc_documents(id),
  version_id INTEGER NOT NULL REFERENCES doc_versions(id),   -- the exact version sent
  version INTEGER NOT NULL,
  doc_name TEXT NOT NULL,
  doc_sha256 TEXT NOT NULL,           -- hash of the file when sent
  signer_name TEXT NOT NULL,
  signer_email TEXT,
  message TEXT,
  provider TEXT NOT NULL DEFAULT 'builtin',
  external_id TEXT,
  token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sent','viewed','signed','declined','cancelled','expired')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id),
  consent_version TEXT,
  consent_sha256 TEXT,
  consent_text TEXT,                  -- the disclosure exactly as shown when the signer agreed
  consent_at TEXT,
  signed_at TEXT,
  typed_name TEXT,
  signature_kind TEXT CHECK (signature_kind IS NULL OR signature_kind IN ('drawn','typed')),
  signature_sha256 TEXT,              -- PNG of the drawn signature, in the document blob store
  signed_doc_sha256 TEXT,             -- hash of the file re-read at the moment of signing
  certificate_document_id INTEGER REFERENCES doc_documents(id),
  certificate_sha256 TEXT,
  closed_reason TEXT
);

-- Audit trail. Append-only: the triggers refuse changes, and each row carries a hash of
-- the previous row so a removed or altered row is detectable.
CREATE TABLE IF NOT EXISTS esign_events (
  id INTEGER PRIMARY KEY,
  request_id INTEGER NOT NULL REFERENCES esign_requests(id),
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  ip TEXT,
  user_agent TEXT,
  user_id INTEGER REFERENCES users(id),
  detail TEXT,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS esign_events_req ON esign_events(request_id, id);
CREATE INDEX IF NOT EXISTS esign_requests_matter ON esign_requests(matter_id);
CREATE INDEX IF NOT EXISTS esign_requests_doc ON esign_requests(document_id);

CREATE TRIGGER IF NOT EXISTS esign_events_no_update BEFORE UPDATE ON esign_events
BEGIN SELECT RAISE(ABORT, 'The signature audit trail cannot be changed'); END;
CREATE TRIGGER IF NOT EXISTS esign_events_no_delete BEFORE DELETE ON esign_events
BEGIN SELECT RAISE(ABORT, 'The signature audit trail cannot be changed'); END;
`;
