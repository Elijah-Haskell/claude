import { DatabaseSync } from "node:sqlite";

export type DB = DatabaseSync;

const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT,
  default_role TEXT,              -- e.g. attorney, paralegal, assistant
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'person' CHECK (kind IN ('person','company')),
  email TEXT,
  phone TEXT,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS practice_areas (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);

-- Ordered stages a matter moves through, per practice area.
CREATE TABLE IF NOT EXISTS stages (
  id INTEGER PRIMARY KEY,
  practice_area_id INTEGER NOT NULL REFERENCES practice_areas(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  position INTEGER NOT NULL
);

-- Matter-level date fields (closing date, filing date...) that task due dates can hang off.
CREATE TABLE IF NOT EXISTS date_fields (
  key TEXT PRIMARY KEY,          -- slug used by templates, e.g. closing_date
  label TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS matters (
  id INTEGER PRIMARY KEY,
  number TEXT UNIQUE,
  name TEXT NOT NULL,
  client_id INTEGER REFERENCES contacts(id),
  practice_area_id INTEGER REFERENCES practice_areas(id),
  stage_id INTEGER REFERENCES stages(id),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  opened_on TEXT NOT NULL,
  closed_on TEXT,
  description TEXT
);

-- Who fills each role on a matter (the paralegal on this matter is Jane).
CREATE TABLE IF NOT EXISTS matter_roles (
  matter_id INTEGER NOT NULL REFERENCES matters(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id),
  PRIMARY KEY (matter_id, role)
);

CREATE TABLE IF NOT EXISTS matter_dates (
  matter_id INTEGER NOT NULL REFERENCES matters(id) ON DELETE CASCADE,
  field_key TEXT NOT NULL REFERENCES date_fields(key),
  value TEXT NOT NULL,
  PRIMARY KEY (matter_id, field_key)
);

-- A reusable checklist ("New LLC formation", "Commercial lease review").
CREATE TABLE IF NOT EXISTS task_lists (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  practice_area_id INTEGER REFERENCES practice_areas(id)
);

-- One step in a checklist. Its due date is offset_days after its anchor:
--   applied     the day the list is added to a matter
--   after_deps  the day the last task it depends on is finished
--   field:<key> a matter date field, e.g. field:closing_date (negative offset = before)
CREATE TABLE IF NOT EXISTS task_templates (
  id INTEGER PRIMARY KEY,
  list_id INTEGER NOT NULL REFERENCES task_lists(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  role TEXT,
  anchor TEXT NOT NULL DEFAULT 'applied',
  offset_days INTEGER,           -- NULL = no due date
  business_days INTEGER NOT NULL DEFAULT 0,
  depends_on TEXT NOT NULL DEFAULT '[]',   -- JSON array of template keys in the same list
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high')),
  position INTEGER NOT NULL DEFAULT 0,
  UNIQUE (list_id, key)
);

CREATE TABLE IF NOT EXISTS list_applications (
  id INTEGER PRIMARY KEY,
  matter_id INTEGER NOT NULL REFERENCES matters(id) ON DELETE CASCADE,
  list_id INTEGER NOT NULL REFERENCES task_lists(id),
  applied_on TEXT NOT NULL,
  applied_by INTEGER REFERENCES users(id),
  completed_on TEXT                -- set once every task from it is done or skipped
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY,
  matter_id INTEGER REFERENCES matters(id) ON DELETE CASCADE,
  template_id INTEGER REFERENCES task_templates(id) ON DELETE SET NULL,
  application_id INTEGER REFERENCES list_applications(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  description TEXT,
  role TEXT,
  assignee_id INTEGER REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('waiting','open','done','skipped')),
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high')),
  anchor TEXT NOT NULL DEFAULT 'manual',
  offset_days INTEGER,
  business_days INTEGER NOT NULL DEFAULT 0,
  due_date TEXT,
  due_locked INTEGER NOT NULL DEFAULT 0,      -- set when someone types a due date by hand
  customized INTEGER NOT NULL DEFAULT 0,      -- set when someone edits title/description by hand
  created_on TEXT NOT NULL,
  completed_on TEXT,
  completed_by INTEGER REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS task_deps (
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, depends_on_id)
);

-- When X happens, do Y.
--   trigger stage_entered  (stage_id)  -> action apply_list (list_id)
--   trigger list_completed (list_id)   -> action set_stage  (stage_id)
CREATE TABLE IF NOT EXISTS automations (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  trigger TEXT NOT NULL CHECK (trigger IN ('stage_entered','list_completed')),
  trigger_ref INTEGER NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('apply_list','set_stage')),
  action_ref INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1
);

-- Days the firm is closed, for business-day due dates. The firm maintains this list.
CREATE TABLE IF NOT EXISTS holidays (
  date TEXT PRIMARY KEY,
  name TEXT
);

-- Every change, who made it and when.
CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id),
  matter_id INTEGER REFERENCES matters(id) ON DELETE CASCADE,
  task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  detail TEXT
);

CREATE INDEX IF NOT EXISTS tasks_matter ON tasks(matter_id);
CREATE INDEX IF NOT EXISTS tasks_assignee ON tasks(assignee_id, status);
CREATE INDEX IF NOT EXISTS deps_reverse ON task_deps(depends_on_id);
CREATE INDEX IF NOT EXISTS activity_matter ON activity(matter_id, id);
`;

export function openDb(path = ":memory:"): DB {
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  return db;
}

/** Run fn inside a transaction; roll back if it throws. Nested calls join the outer one. */
export function tx<T>(db: DB, fn: () => T): T {
  if (db.isTransaction) return fn();
  db.exec("BEGIN");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
