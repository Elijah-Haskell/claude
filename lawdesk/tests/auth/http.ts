// Headers that let a test talk to the real server as a signed-in person: the session cookie
// plus the X-Requested-With header the server requires on writes (its CSRF check).

import type { DB } from "../../src/db.ts";
import type { Role } from "../../src/auth/access.ts";
import { signedInAs } from "./helpers.ts";

const cache = new WeakMap<DB, Map<string, string>>();

/**
 * Sign in as `userId` (default: the first person in the database, or a new "Test admin" if
 * there is nobody yet) with `role`, once per database and person, and return the headers to send.
 */
export function authHeaders(db: DB, userId?: number | null, role: Role = "admin"): Record<string, string> {
  let uid = userId ?? undefined;
  if (uid == null) uid = (db.prepare("SELECT id FROM users ORDER BY id LIMIT 1").get() as { id: number } | undefined)?.id;
  const key = `${uid ?? "new"}:${role}`;
  let byDb = cache.get(db);
  if (!byDb) cache.set(db, (byDb = new Map()));
  let cookie = byDb.get(key);
  if (!cookie) {
    cookie = signedInAs(db, uid, role).cookie;
    byDb.set(key, cookie);
  }
  return { Cookie: cookie, "X-Requested-With": "lawdesk" };
}
