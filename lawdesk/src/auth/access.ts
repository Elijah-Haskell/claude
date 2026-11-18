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

const withAuthTables = new WeakSet<DB>();
/** False while the sign-in tables aren't there (a module's tests open a bare database): nothing is restricted then. */
function authTables(db: DB): boolean {
  if (withAuthTables.has(db)) return true;
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'auth_matter_access'").get()) return false;
  withAuthTables.add(db);
  return true;
}

export function isRestricted(db: DB, matterId: number): boolean {
  if (!authTables(db)) return false;
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
  if (!authTables(db)) return new Set();
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

/**
 * The matter a row belongs to, looked up by the row's id: a number, null (the row has no
 * matter), or undefined (no such row, or the module's table isn't there). `table` and
 * `column` are names from code, never from a request.
 */
export function matterOfRow(db: DB, table: string, id: number, column = "matter_id"): number | null | undefined {
  try {
    const r = db.prepare(`SELECT ${column} AS m FROM ${table} WHERE id = ?`).get(id) as { m: number | null } | undefined;
    return r === undefined ? undefined : r.m;
  } catch {
    return undefined;
  }
}

/**
 * Throws "<what> not found" (404) when the row with this id belongs to a matter this person
 * may not see: the same answer as for a row that doesn't exist. Rows that don't exist, or
 * have no matter, are left to the handler.
 */
export function assertCanSeeRow(db: DB, userId: number | null | undefined, table: string, id: number, what: string, column = "matter_id") {
  const m = matterOfRow(db, table, id, column);
  if (m != null && !canSeeMatter(db, userId, m)) throw new EngineError(`${what} not found`, 404);
}

/**
 * The matter ids a request names in the usual places: a `/matters/:x` path segment (in any
 * module: /matters/:id/documents, /billing/matters/:matterId, /trust/matters/:id/ledgers),
 * a `matterId` or `matter` query parameter, and a `matterId` in a JSON body. The server
 * checks each of them before a non-public handler runs (guard.ts `assertMatterAccess`), so a
 * route that takes its matter in one of these places needs no code of its own.
 */
export function matterIdsInRequest(routePath: string, params: Record<string, string>, query: URLSearchParams, body: unknown): number[] {
  const ids: number[] = [];
  const add = (v: unknown) => {
    const n = typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : NaN;
    if (Number.isInteger(n) && n > 0) ids.push(n);
  };
  const segs = routePath.split("/").filter(Boolean);
  for (let i = 0; i < segs.length - 1; i++) if (segs[i] === "matters" && segs[i + 1].startsWith(":")) add(params[segs[i + 1].slice(1)]);
  add(query.get("matterId"));
  add(query.get("matter"));
  if (body && typeof body === "object" && !Array.isArray(body)) add((body as Record<string, unknown>).matterId);
  return ids;
}

/**
 * Conflict-check results must still search every matter (a walled matter's adverse party is
 * still a conflict), but must not name a matter this person can't see. This walks a result
 * and rewrites each involvement `{ matterId, matter, text, ... }` on a hidden matter to
 * "a restricted matter", without its id, so the hit stays and the matter stays private.
 */
export function maskHiddenInvolvements<T>(db: DB, userId: number | null | undefined, value: T): T {
  const hidden = hiddenMatterIds(db, userId);
  if (!hidden.size) return value;
  // Plain-English lines ("Adverse party in matter T-2 Sealed acquisition") name matters too.
  const names: string[] = [];
  for (const id of hidden) {
    const m = db.prepare("SELECT number, name FROM matters WHERE id = ?").get(id) as { number: string | null; name: string } | undefined;
    if (!m) continue;
    if (m.number) names.push(`${m.number} ${m.name}`);
    if (m.name.length >= 4) names.push(m.name);
  }
  names.sort((a, b) => b.length - a.length);
  const scrub = (s: string) => {
    let out = s;
    for (const n of names) out = out.split(`matter ${n}`).join("a restricted matter").split(n).join("a restricted matter");
    return out;
  };
  const walk = (v: any): any => {
    if (typeof v === "string") return names.length ? scrub(v) : v;
    if (Array.isArray(v)) return v.map(walk);
    if (!v || typeof v !== "object") return v;
    if (typeof v.matterId === "number" && hidden.has(v.matterId) && typeof v.matter === "string") {
      const role = typeof v.text === "string" ? v.text.replace(/ in matter .*$/s, "") : "Involved";
      return { ...v, matterId: null, matter: "Restricted matter", restricted: true, text: `${role} in a restricted matter (ask an administrator)` };
    }
    const out: any = {};
    for (const [k, x] of Object.entries(v)) out[k] = walk(x);
    return out;
  };
  return walk(value);
}

/**
 * Report-style results: drop rows that belong to hidden matters and re-add the plain sums.
 * `matterOf(row)` says which matter a row is about (null: none). Returns how many went.
 */
export function hideRows<T extends Record<string, any>>(db: DB, userId: number | null | undefined, rows: T[], matterOf: (r: T) => number | null | undefined): { rows: T[]; hidden: number } {
  const hidden = hiddenMatterIds(db, userId);
  if (!hidden.size) return { rows, hidden: 0 };
  const out = rows.filter((r) => {
    const m = matterOf(r);
    return m == null || !hidden.has(m);
  });
  return { rows: out, hidden: rows.length - out.length };
}
