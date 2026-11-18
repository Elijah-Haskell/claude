// Who may do what. Two layers:
//
// 1. Route level, checked by the server before any handler runs (see guard.ts):
//      - every /api route needs a signed-in admin, attorney or staff account, unless the
//        route says `public: true` (sign-in screens, the calendar feed whose URL token is
//        its own secret);
//      - a route with `roles: [...]` is open only to those roles, e.g. `roles: ADMIN`;
//      - the `client` role (for a future client portal) reaches only routes that list it.
//
// 2. Matter level, checked by handlers: a matter can be restricted to named people (an
//    ethical wall, a sensitive client). Use canSeeMatter / assertCanSeeMatter before
//    returning or changing anything that belongs to a matter, and hiddenMatterIds to filter
//    lists. Admins always see every matter, because they can change the list anyway; every
//    change to the list is in the activity log.

import { EngineError } from "../engine.ts";
import type { DB } from "../db.ts";

export type Role = "admin" | "attorney" | "staff" | "client";
export const ROLES: Role[] = ["admin", "attorney", "staff", "client"];
export const ROLE_LABELS: Record<Role, string> = {
  admin: "Administrator",
  attorney: "Attorney",
  staff: "Staff",
  client: "Client (portal)",
};

/** Ready-made `roles` lists for routes. */
export const ADMIN: Role[] = ["admin"];
export const ATTORNEYS: Role[] = ["admin", "attorney"];
export const STAFF: Role[] = ["admin", "attorney", "staff"];
export const CLIENT_PORTAL: Role[] = ["client"];

export function roleOf(db: DB, userId: number | null | undefined): Role | null {
  if (userId == null) return null;
  const r = db.prepare("SELECT role FROM auth_accounts WHERE user_id = ? AND disabled = 0").get(userId) as { role: Role } | undefined;
  return r?.role ?? null;
}

export function isRestricted(db: DB, matterId: number): boolean {
  return !!db.prepare("SELECT 1 FROM auth_matter_access WHERE matter_id = ? LIMIT 1").get(matterId);
}

/**
 * True when this person may see the matter: it isn't restricted, they're on its list, or
 * they're an admin. A null user (no session: scripts, tests calling handlers directly)
 * sees only unrestricted matters.
 */
export function canSeeMatter(db: DB, userId: number | null | undefined, matterId: number | null | undefined): boolean {
  if (matterId == null) return true;
  if (!isRestricted(db, matterId)) return true;
  if (userId == null) return false;
  if (roleOf(db, userId) === "admin") return true;
  return !!db.prepare("SELECT 1 FROM auth_matter_access WHERE matter_id = ? AND user_id = ?").get(matterId, userId);
}

/** Throws the same 404 as a missing matter, so a restricted matter's existence isn't revealed. */
export function assertCanSeeMatter(db: DB, userId: number | null | undefined, matterId: number | null | undefined) {
  if (!canSeeMatter(db, userId, matterId)) throw new EngineError("Matter not found", 404);
}

/** Ids of restricted matters this person may not see; filter lists with it. */
export function hiddenMatterIds(db: DB, userId: number | null | undefined): Set<number> {
  if (userId != null && roleOf(db, userId) === "admin") return new Set();
  const rows = db
    .prepare(
      `SELECT DISTINCT matter_id FROM auth_matter_access a
       WHERE NOT EXISTS (SELECT 1 FROM auth_matter_access b WHERE b.matter_id = a.matter_id AND b.user_id IS ?)`,
    )
    .all(userId ?? null) as { matter_id: number }[];
  return new Set(rows.map((r) => r.matter_id));
}

/** Drop rows whose `matter_id` (or another key) is a matter this person can't see. */
export function filterVisible<T extends Record<string, any>>(db: DB, userId: number | null | undefined, rows: T[], key = "matter_id"): T[] {
  const hidden = hiddenMatterIds(db, userId);
  if (!hidden.size) return rows;
  return rows.filter((r) => r[key] == null || !hidden.has(r[key]));
}

export function matterAccessList(db: DB, matterId: number): { user_id: number; name: string }[] {
  return db
    .prepare("SELECT a.user_id, u.name FROM auth_matter_access a JOIN users u ON u.id = a.user_id WHERE a.matter_id = ? ORDER BY u.name")
    .all(matterId) as { user_id: number; name: string }[];
}
