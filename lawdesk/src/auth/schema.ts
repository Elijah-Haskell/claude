// Tables for sign-in, sessions, two-factor and matter-level access.
// Times are milliseconds since 1970 (UTC) so expiry checks are plain comparisons.

export const SCHEMA = `
-- One sign-in account per person in users. The role is the access level, separate from
-- users.default_role (attorney, paralegal...) which only decides who checklist steps go to.
CREATE TABLE IF NOT EXISTS auth_accounts (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  email TEXT NOT NULL COLLATE NOCASE UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('admin','attorney','staff','client')),
  password_hash TEXT NOT NULL,             -- scrypt$N$r$p$salt$hash (base64)
  must_change_password INTEGER NOT NULL DEFAULT 0,
  disabled INTEGER NOT NULL DEFAULT 0,
  totp_secret TEXT,                        -- base32; set only while two-factor is on
  totp_pending_secret TEXT,                -- shown during set-up, until the first code is confirmed
  totp_last_step INTEGER,                  -- last accepted 30-second step, so a code can't be replayed
  failed_count INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER,
  created_at INTEGER NOT NULL,
  password_changed_at INTEGER,
  last_sign_in_at INTEGER
);

-- Only a SHA-256 of each session token is stored, so a copy of the database can't be
-- used to sign in.
CREATE TABLE IF NOT EXISTS auth_sessions (
  id INTEGER PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  ip TEXT,
  user_agent TEXT
);
CREATE INDEX IF NOT EXISTS auth_sessions_user ON auth_sessions(user_id);

-- Password accepted, waiting for the two-factor code (five minutes, five tries).
CREATE TABLE IF NOT EXISTS auth_challenges (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS auth_recovery_codes (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  code_hash TEXT NOT NULL,
  used_at INTEGER
);
CREATE INDEX IF NOT EXISTS auth_recovery_user ON auth_recovery_codes(user_id);

-- One-time password reset links (created by an admin now, emailed later).
CREATE TABLE IF NOT EXISTS auth_reset_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_by INTEGER REFERENCES users(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);

-- A matter with any rows here is restricted: only these people (and admins) can see it.
CREATE TABLE IF NOT EXISTS auth_matter_access (
  matter_id INTEGER NOT NULL REFERENCES matters(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  PRIMARY KEY (matter_id, user_id)
);
`;
