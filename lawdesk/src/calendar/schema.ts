// Firm calendar tables. Run after the core schema (they reference users and matters).

export const SCHEMA = `
-- One event, or one recurring series.
--   Timed events:  start_at / end_at are UTC instants (2026-03-09T14:00:00Z); time_zone is the
--                  IANA zone they were entered in, used for display and to expand recurrences on
--                  the local wall clock (so a weekly 9:00 meeting stays at 9:00 across DST).
--   All-day:       start_date / end_date (inclusive last day), time_zone = the firm's zone.
CREATE TABLE IF NOT EXISTS cal_events (
  id INTEGER PRIMARY KEY,
  uid TEXT NOT NULL UNIQUE,                 -- iCalendar UID, stable for the life of the event
  title TEXT NOT NULL,
  matter_id INTEGER REFERENCES matters(id) ON DELETE SET NULL,
  kind TEXT NOT NULL DEFAULT 'meeting'
    CHECK (kind IN ('court_deadline','hearing','meeting','statute_of_limitations','reminder','other')),
  source TEXT NOT NULL DEFAULT 'manual',    -- manual, ics_import, deadlines, ...
  source_ref TEXT,                          -- id in the source, e.g. the deadline rule that made it
  all_day INTEGER NOT NULL DEFAULT 0,
  start_at TEXT,
  end_at TEXT,
  start_date TEXT,
  end_date TEXT,
  time_zone TEXT NOT NULL DEFAULT 'America/Chicago',
  location TEXT,
  notes TEXT,
  reminders TEXT NOT NULL DEFAULT '[]',     -- JSON array of minutes before the start
  rrule TEXT,                               -- RFC 5545 RRULE value (supported subset), NULL = one-off
  sequence INTEGER NOT NULL DEFAULT 0,      -- iCalendar SEQUENCE, bumped on every change
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((all_day = 1 AND start_date IS NOT NULL AND end_date IS NOT NULL)
      OR (all_day = 0 AND start_at IS NOT NULL AND end_at IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS cal_attendees (
  event_id INTEGER NOT NULL REFERENCES cal_events(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  PRIMARY KEY (event_id, user_id)
);

-- A change to one occurrence of a recurring event, keyed by the occurrence's original start
-- (iCalendar RECURRENCE-ID form: 20260309T140000Z for timed, 20260309 for all-day).
-- cancelled = 1 removes that occurrence (EXDATE); otherwise non-NULL columns override the series.
CREATE TABLE IF NOT EXISTS cal_exceptions (
  event_id INTEGER NOT NULL REFERENCES cal_events(id) ON DELETE CASCADE,
  occurrence TEXT NOT NULL,
  cancelled INTEGER NOT NULL DEFAULT 0,
  title TEXT,
  start_at TEXT,
  end_at TEXT,
  start_date TEXT,
  end_date TEXT,
  location TEXT,
  notes TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (event_id, occurrence)
);

-- Secret calendar-feed URLs. Only the SHA-256 of the token is kept; the token itself is shown once.
CREATE TABLE IF NOT EXISTS cal_feed_tokens (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  scope TEXT NOT NULL DEFAULT 'mine' CHECK (scope IN ('mine','firm')),
  label TEXT,
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  last_used_at TEXT
);

CREATE INDEX IF NOT EXISTS cal_events_matter ON cal_events(matter_id);
CREATE INDEX IF NOT EXISTS cal_events_start ON cal_events(start_at);
CREATE INDEX IF NOT EXISTS cal_events_start_date ON cal_events(start_date);
CREATE INDEX IF NOT EXISTS cal_events_source ON cal_events(source, source_ref);
CREATE INDEX IF NOT EXISTS cal_attendees_user ON cal_attendees(user_id);
`;
