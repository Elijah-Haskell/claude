// Tables for client intake and lead tracking (the Clio Grow equivalent).
// They sit beside the core tables and reference users, contacts, practice areas and matters.
// Run after the core, conflicts, calendar and documents schemas.

export const STATUSES = [
  { key: "new", label: "New" },
  { key: "contacted", label: "Contacted" },
  { key: "consult_scheduled", label: "Consultation scheduled" },
  { key: "engagement_sent", label: "Engagement sent" },
  { key: "hired", label: "Hired" },
  { key: "not_hired", label: "Not hired" },
] as const;
export type Status = (typeof STATUSES)[number]["key"];
export const STATUS_KEYS = STATUSES.map((s) => s.key) as readonly string[];
export const statusLabel = (k: string) => STATUSES.find((s) => s.key === k)?.label ?? k;

/** Where a lead heard about the firm. The firm can type something else too. */
export const SOURCES = ["Referral from a client", "Referral from another lawyer", "Web search", "Firm website", "Social media", "Returning client", "Event or talk", "Other"];

export const NOT_HIRED_REASONS = [
  "Hired another firm",
  "Conflict of interest",
  "Not a matter we handle",
  "Could not reach them",
  "Fees or budget",
  "Decided not to go ahead",
  "Other",
];

export const FIELD_TYPES = ["short", "long", "email", "phone", "date", "choice", "yesno"] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

/** What a form answer fills in on the lead. "none" keeps it only as an answer. */
export const FIELD_MAPS = ["none", "name", "email", "phone", "source", "summary", "opposing_party"] as const;
export type FieldMap = (typeof FIELD_MAPS)[number];

const q = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(",");

export const SCHEMA = `
-- One row: the firm's intake settings. secret signs the "form opened at" stamp used against spam bots.
CREATE TABLE IF NOT EXISTS intake_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  firm_name TEXT NOT NULL DEFAULT '',
  booking_token TEXT,
  booking_intro TEXT,
  min_notice_hours INTEGER NOT NULL DEFAULT 24,
  days_ahead INTEGER NOT NULL DEFAULT 14,
  new_lead_task_days INTEGER NOT NULL DEFAULT 0,      -- first-call reminder due this many days after a lead arrives
  engagement_followup_days INTEGER NOT NULL DEFAULT 3, -- reminder + follow-up email this many days after a letter goes out
  default_owner_id INTEGER REFERENCES users(id),
  secret TEXT
);

CREATE TABLE IF NOT EXISTS intake_forms (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  practice_area_id INTEGER REFERENCES practice_areas(id) ON DELETE SET NULL,
  token TEXT NOT NULL UNIQUE,         -- the public URL's key
  intro TEXT,
  thanks TEXT,
  owner_id INTEGER REFERENCES users(id),  -- who new leads from this form go to
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS intake_form_fields (
  id INTEGER PRIMARY KEY,
  form_id INTEGER NOT NULL REFERENCES intake_forms(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  label TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN (${q(FIELD_TYPES)})),
  required INTEGER NOT NULL DEFAULT 0,
  help TEXT,
  options TEXT NOT NULL DEFAULT '[]',  -- JSON array of choices (type = choice)
  maps_to TEXT NOT NULL DEFAULT 'none' CHECK (maps_to IN (${q(FIELD_MAPS)}))
);

CREATE TABLE IF NOT EXISTS intake_leads (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'person' CHECK (kind IN ('person','company')),
  email TEXT,
  phone TEXT,
  source TEXT,
  practice_area_id INTEGER REFERENCES practice_areas(id) ON DELETE SET NULL,
  summary TEXT,
  opposing TEXT NOT NULL DEFAULT '[]',   -- JSON array of other parties' names
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN (${q(STATUS_KEYS)})),
  not_hired_reason TEXT,
  owner_id INTEGER REFERENCES users(id),
  form_id INTEGER REFERENCES intake_forms(id) ON DELETE SET NULL,
  answers TEXT NOT NULL DEFAULT '[]',    -- JSON array of {label, value} as submitted
  public_token TEXT NOT NULL UNIQUE,     -- for the lead's own booking link
  conflict_check_id INTEGER REFERENCES conflicts_checks(id) ON DELETE SET NULL,
  earlier_hits TEXT NOT NULL DEFAULT '[]', -- other leads whose names match (JSON)
  received_on TEXT NOT NULL,             -- YYYY-MM-DD, firm time
  created_at TEXT NOT NULL,
  status_changed_at TEXT NOT NULL,
  hired_on TEXT,
  closed_on TEXT,                        -- the day it was marked hired or not hired
  contact_id INTEGER REFERENCES contacts(id),
  matter_id INTEGER REFERENCES matters(id),
  position REAL NOT NULL DEFAULT 0       -- order within a pipeline column
);

CREATE TABLE IF NOT EXISTS intake_notes (
  id INTEGER PRIMARY KEY,
  lead_id INTEGER NOT NULL REFERENCES intake_leads(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id),
  at TEXT NOT NULL
);

-- The lead's history. Copied into the matter's activity log when the lead is converted.
CREATE TABLE IF NOT EXISTS intake_activity (
  id INTEGER PRIMARY KEY,
  lead_id INTEGER NOT NULL REFERENCES intake_leads(id) ON DELETE CASCADE,
  at TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id),
  kind TEXT NOT NULL,
  detail TEXT NOT NULL
);

-- Follow-up reminders are ordinary tasks (no matter yet) assigned to the lead's owner.
CREATE TABLE IF NOT EXISTS intake_lead_tasks (
  lead_id INTEGER NOT NULL REFERENCES intake_leads(id) ON DELETE CASCADE,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'follow_up',
  PRIMARY KEY (lead_id, task_id)
);

-- Emails waiting to go out. The email module sends rows whose send_after has passed
-- (see dueEmails / markEmailSent in leads.ts). Nothing here sends mail by itself.
CREATE TABLE IF NOT EXISTS intake_email_queue (
  id INTEGER PRIMARY KEY,
  lead_id INTEGER REFERENCES intake_leads(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                 -- follow_up, engagement_follow_up, booking_confirmation, ...
  to_name TEXT,
  to_address TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  engagement_id INTEGER,              -- attach this engagement letter, if set
  send_after TEXT NOT NULL,           -- ISO instant
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','cancelled','failed')),
  error TEXT,
  created_at TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id),
  sent_at TEXT
);

-- Engagement letters made from a document template before the matter exists.
-- Filed into the matter's documents when the lead is converted.
CREATE TABLE IF NOT EXISTS intake_engagements (
  id INTEGER PRIMARY KEY,
  lead_id INTEGER NOT NULL REFERENCES intake_leads(id) ON DELETE CASCADE,
  template_id INTEGER REFERENCES doc_templates(id) ON DELETE SET NULL,
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,
  data BLOB NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','signed','declined')),
  signature_ref TEXT,                 -- set by the e-signature module when it sends the letter
  created_at TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id),
  sent_at TEXT,
  document_id INTEGER                 -- doc_documents.id once filed to the matter
);

-- Who takes consultations, and how long one is.
CREATE TABLE IF NOT EXISTS intake_booking_people (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  consult_minutes INTEGER NOT NULL DEFAULT 30,
  location TEXT,
  active INTEGER NOT NULL DEFAULT 1
);

-- Weekly windows when a person takes consultations, in firm time (America/Chicago).
CREATE TABLE IF NOT EXISTS intake_availability (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  weekday INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),  -- 0 = Sunday
  start_time TEXT NOT NULL,           -- HH:MM
  end_time TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS intake_consultations (
  id INTEGER PRIMARY KEY,
  lead_id INTEGER NOT NULL REFERENCES intake_leads(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  event_id INTEGER REFERENCES cal_events(id) ON DELETE SET NULL,
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  booked_via TEXT NOT NULL CHECK (booked_via IN ('public','staff')),
  status TEXT NOT NULL DEFAULT 'booked' CHECK (status IN ('booked','cancelled')),
  created_at TEXT NOT NULL
);

-- Public submissions per address, for the rate limit. Only a hash of the address is kept.
CREATE TABLE IF NOT EXISTS intake_submit_log (
  id INTEGER PRIMARY KEY,
  ip_hash TEXT NOT NULL,
  at INTEGER NOT NULL,                -- epoch ms
  outcome TEXT NOT NULL               -- accepted, spam, limited
);

CREATE INDEX IF NOT EXISTS intake_leads_status ON intake_leads(status, position);
CREATE INDEX IF NOT EXISTS intake_activity_lead ON intake_activity(lead_id, id);
CREATE INDEX IF NOT EXISTS intake_notes_lead ON intake_notes(lead_id, id);
CREATE INDEX IF NOT EXISTS intake_queue_status ON intake_email_queue(status, send_after);
CREATE INDEX IF NOT EXISTS intake_avail_user ON intake_availability(user_id, weekday);
CREATE INDEX IF NOT EXISTS intake_submit_ip ON intake_submit_log(ip_hash, at);
INSERT OR IGNORE INTO intake_settings (id) VALUES (1);
`;
