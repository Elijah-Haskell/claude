// Extra contact details (phone numbers, email addresses, postal addresses, websites).
// The core `contacts` table keeps one email and one phone; this holds any number more,
// each with a label such as "work" or "mailing".

export const DETAIL_KINDS = ["phone", "email", "address", "website"] as const;

const q = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(",");

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS contacts_details (
  id INTEGER PRIMARY KEY,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN (${q(DETAIL_KINDS)})),
  label TEXT,                      -- work, home, cell, mailing, billing...
  value TEXT,                      -- the number, email or web address (not used for addresses)
  line1 TEXT,
  line2 TEXT,
  city TEXT,
  region TEXT,                     -- state or province
  postal_code TEXT,
  country TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS contacts_details_contact ON contacts_details(contact_id, kind);
`;
