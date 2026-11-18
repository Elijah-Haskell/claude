// Email tables. Run after the core schema (they reference users and matters).

export const SCHEMA = `
-- Firm-wide email settings, one row per key. The SMTP password is stored here only when it
-- is not given in the environment (LAWDESK_SMTP_PASSWORD); the API never returns it.
CREATE TABLE IF NOT EXISTS email_settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- Small bits of state for the background job (e.g. how far calendar reminders were checked).
CREATE TABLE IF NOT EXISTS email_state (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- Every message the app sends goes through this queue.
CREATE TABLE IF NOT EXISTS email_outbox (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,                      -- matter, task_assigned, digest, reminder, password_reset, test
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sending','sent','failed','cancelled')),
  message_id TEXT NOT NULL,
  from_addr TEXT NOT NULL,
  recipients TEXT NOT NULL,                -- JSON array of envelope addresses (To, Cc and Bcc)
  subject TEXT NOT NULL,
  raw BLOB,                                -- the complete message; cleared after sending when sensitive
  sensitive INTEGER NOT NULL DEFAULT 0,    -- password resets: never shown, raw dropped once sent
  matter_id INTEGER REFERENCES matters(id),
  user_id INTEGER REFERENCES users(id),    -- who caused it (null for automatic notices)
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  last_error TEXT,
  response TEXT,
  created_at TEXT NOT NULL,
  sent_at TEXT
);
CREATE INDEX IF NOT EXISTS email_outbox_due ON email_outbox(status, next_attempt_at);

-- Per-person notification choices. No row = the defaults below.
CREATE TABLE IF NOT EXISTS email_prefs (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  task_assigned INTEGER NOT NULL DEFAULT 1,
  digest INTEGER NOT NULL DEFAULT 1,
  digest_time TEXT NOT NULL DEFAULT '07:30',   -- HH:MM, America/Chicago
  digest_weekends INTEGER NOT NULL DEFAULT 0,
  reminders INTEGER NOT NULL DEFAULT 1,
  last_digest_on TEXT
);

-- Which (task, assignee) pairs have already been told, so each assignment is announced once.
CREATE TABLE IF NOT EXISTS email_assign_seen (
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL,
  PRIMARY KEY (task_id, user_id)
);

-- Calendar reminders already emailed, so none repeats.
CREATE TABLE IF NOT EXISTS email_reminders_sent (
  event_id INTEGER NOT NULL,
  occurrence TEXT NOT NULL,
  minutes_before INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  outbox_id INTEGER,
  sent_at TEXT NOT NULL,
  PRIMARY KEY (event_id, occurrence, minutes_before, user_id)
);

-- Message templates with merge fields ({{client.name}}, {{matter.number}} ...).
CREATE TABLE IF NOT EXISTS email_templates (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

-- A matter's communication log: emails sent and filed, phone calls, meetings.
CREATE TABLE IF NOT EXISTS email_comm_log (
  id INTEGER PRIMARY KEY,
  matter_id INTEGER NOT NULL REFERENCES matters(id),
  kind TEXT NOT NULL CHECK (kind IN ('email','phone','meeting','note')),
  direction TEXT CHECK (direction IN ('in','out')),
  occurred_at TEXT NOT NULL,               -- UTC instant
  subject TEXT,
  from_addr TEXT,
  to_addrs TEXT,                           -- display text, e.g. "Ann Smith <ann@example.test>, ..."
  cc_addrs TEXT,
  participants TEXT,                       -- calls and meetings: who took part
  duration_minutes INTEGER,
  body TEXT,                               -- plain text (email body or call notes)
  message_id TEXT,
  outbox_id INTEGER REFERENCES email_outbox(id),
  document_id INTEGER,                     -- the filed .eml in Documents
  attachment_ids TEXT NOT NULL DEFAULT '[]',   -- JSON array of document ids
  time_entry_id INTEGER,                   -- TODO(billing): set when a time entry is made from this
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS email_comm_matter ON email_comm_log(matter_id, occurred_at);
CREATE INDEX IF NOT EXISTS email_comm_msgid ON email_comm_log(matter_id, message_id);
`;
