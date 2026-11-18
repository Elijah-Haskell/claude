// Tables for documents, their versions and document-assembly templates.
// The full-text index (doc_fts, SQLite FTS5) is created by ensureSearchIndex() in
// documents.ts, because FTS5 might not be compiled into every SQLite build.

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS doc_templates (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  category TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('docx','txt','html')),
  filename TEXT NOT NULL,          -- original file name of the current template file
  sha256 TEXT NOT NULL,
  size INTEGER NOT NULL,
  fields TEXT NOT NULL DEFAULT '[]',   -- JSON array of merge fields the template uses
  created_at TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL,
  updated_by INTEGER REFERENCES users(id),
  deleted_at TEXT,
  deleted_by INTEGER REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS doc_documents (
  id INTEGER PRIMARY KEY,
  matter_id INTEGER NOT NULL REFERENCES matters(id) ON DELETE CASCADE,
  name TEXT NOT NULL,                  -- display file name, e.g. "Engagement letter.docx"
  folder TEXT NOT NULL DEFAULT '',     -- virtual path inside the matter, '' = top level
  category TEXT,
  current_version_id INTEGER,          -- doc_versions.id of the newest version
  template_id INTEGER REFERENCES doc_templates(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL,
  deleted_at TEXT,                     -- soft delete; NULL = live
  deleted_by INTEGER REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS doc_versions (
  id INTEGER PRIMARY KEY,
  document_id INTEGER NOT NULL REFERENCES doc_documents(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,            -- 1, 2, 3... per document
  sha256 TEXT NOT NULL,
  size INTEGER NOT NULL,
  mime TEXT NOT NULL,                  -- detected from the bytes, not the extension
  filename TEXT NOT NULL,              -- the file name as uploaded
  uploaded_at TEXT NOT NULL,
  uploaded_by INTEGER REFERENCES users(id),
  note TEXT,                           -- e.g. "Restored from version 2", "Generated from template"
  restored_from INTEGER,               -- version number this one copies, if a restore
  UNIQUE (document_id, version)
);

CREATE TABLE IF NOT EXISTS doc_tags (
  document_id INTEGER NOT NULL REFERENCES doc_documents(id) ON DELETE CASCADE,
  tag TEXT NOT NULL COLLATE NOCASE,
  PRIMARY KEY (document_id, tag)
);

-- Extracted text of each document's newest version (for search and the LIKE fallback).
CREATE TABLE IF NOT EXISTS doc_text (
  document_id INTEGER PRIMARY KEY REFERENCES doc_documents(id) ON DELETE CASCADE,
  version_id INTEGER NOT NULL,
  body TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS doc_documents_matter ON doc_documents(matter_id, folder, name);
CREATE INDEX IF NOT EXISTS doc_versions_doc ON doc_versions(document_id, version);
CREATE INDEX IF NOT EXISTS doc_versions_hash ON doc_versions(sha256);
CREATE INDEX IF NOT EXISTS doc_tags_tag ON doc_tags(tag);
`;
