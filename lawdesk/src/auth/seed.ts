// Sign-in accounts for the fictional demo people. Demo only: everyone shares one
// published password, which is why `npm run seed` prints it.

import { scryptSync, randomBytes } from "node:crypto";
import type { DB } from "../db.ts";
import { SCHEMA } from "./schema.ts";
import type { Role } from "./access.ts";

export const DEMO_PASSWORD = "lawdesk-demo-2026";

/** Same format as passwords.ts hashPassword, but synchronous so the seed stays one transaction. */
function hashSync(password: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(password.normalize("NFKC"), salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString("base64")}$${key.toString("base64")}`;
}

export function seedAccounts(db: DB, people: { userId: number; role: Role }[], password = DEMO_PASSWORD) {
  db.exec(SCHEMA);
  const now = Date.now();
  for (const p of people) {
    const u = db.prepare("SELECT email FROM users WHERE id = ?").get(p.userId) as { email: string | null } | undefined;
    if (!u?.email) continue;
    db.prepare(
      "INSERT INTO auth_accounts (user_id, email, role, password_hash, created_at, password_changed_at) VALUES (?,?,?,?,?,?)",
    ).run(p.userId, u.email, p.role, hashSync(password), now, now);
  }
}
