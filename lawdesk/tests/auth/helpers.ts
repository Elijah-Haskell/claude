// Test helpers: sign in without the HTTP round-trip (and without slow password hashing).

import type { DB } from "../../src/db.ts";
import { SCHEMA } from "../../src/auth/schema.ts";
import { createSession } from "../../src/auth/accounts.ts";
import type { Role } from "../../src/auth/access.ts";

/**
 * Give `userId` (or a new "Test admin") an account with `role` if they don't have one,
 * open a session, and return the Cookie header value to send.
 */
export function signedInAs(db: DB, userId?: number, role: Role = "admin"): { userId: number; cookie: string; sessionId: number } {
  db.exec(SCHEMA);
  let uid = userId;
  if (uid == null) uid = Number(db.prepare("INSERT INTO users (name, default_role, email) VALUES ('Test admin', NULL, NULL)").run().lastInsertRowid);
  if (!db.prepare("SELECT 1 FROM auth_accounts WHERE user_id = ?").get(uid)) {
    db.prepare("INSERT INTO auth_accounts (user_id, email, role, password_hash, created_at) VALUES (?,?,?,?,?)").run(
      uid,
      `user${uid}.${Math.random().toString(36).slice(2)}@test.invalid`,
      role,
      "scrypt$x", // never matches: these accounts can't sign in with a password
      Date.now(),
    );
  }
  const s = createSession(db, uid);
  return { userId: uid, cookie: `lawdesk_session=${s.token}`, sessionId: s.id };
}
