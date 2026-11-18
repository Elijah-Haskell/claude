// API for aliases, relationships, matter parties and conflict checks. Mounted under /api.

import { type Ctx, type Route, intParam } from "../http.ts";
import { EngineError } from "../engine.ts";
import {
  addAlias, addParty, addRelationship, deleteAlias, deleteParty, deleteRelationship,
  listAliases, listParties, listRelationships, updateAlias, updateParty, updateRelationship,
} from "./store.ts";
import { decideCheck, getCheck, linkCheck, listChecks, runCheck, searchConflicts } from "./search.ts";
import { assertCanSeeRow, filterVisible, maskHiddenInvolvements } from "../auth/access.ts";

/** Who is acting. Until sign-in exists the body may name a user; the signed-in user always wins. */
function actor(ctx: Ctx): number | null {
  if (ctx.userId != null) return ctx.userId;
  if (ctx.body?.userId == null) return null;
  const n = Number(ctx.body.userId);
  if (!Number.isInteger(n) || n <= 0 || !ctx.db.prepare("SELECT id FROM users WHERE id = ?").get(n)) throw new EngineError("Unknown userId");
  return n;
}

// Matter restrictions (src/auth/access.ts). A check still searches every matter, so a walled
// matter's parties still raise a hit, but the hit doesn't name a matter this person can't see.
const mask = <T>(ctx: Ctx, v: T): T => maskHiddenInvolvements(ctx.db, ctx.userId, v);
function checkId(ctx: Ctx): number {
  const id = intParam(ctx, "id");
  assertCanSeeRow(ctx.db, ctx.userId, "conflicts_checks", id, "Conflict check");
  return id;
}
function partyId(ctx: Ctx): number {
  const id = intParam(ctx, "id");
  assertCanSeeRow(ctx.db, ctx.userId, "conflicts_matter_parties", id, "Party");
  return id;
}

function optInt(v: unknown, what: string): number | null {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new EngineError(`Bad ${what}`);
  return n;
}

export const routes: Route[] = [
  // aliases
  { method: "GET", path: "/conflicts/contacts/:id/aliases", handler: (ctx) => listAliases(ctx.db, intParam(ctx, "id")) },
  {
    method: "POST",
    path: "/conflicts/contacts/:id/aliases",
    handler: (ctx) => ({ id: addAlias(ctx.db, intParam(ctx, "id"), ctx.body, actor(ctx)) }),
  },
  { method: "PATCH", path: "/conflicts/aliases/:id", handler: (ctx) => updateAlias(ctx.db, intParam(ctx, "id"), ctx.body ?? {}, actor(ctx)) },
  {
    method: "DELETE",
    path: "/conflicts/aliases/:id",
    handler: (ctx) => (deleteAlias(ctx.db, intParam(ctx, "id"), actor(ctx)), { ok: true }),
  },

  // relationships
  { method: "GET", path: "/conflicts/contacts/:id/relationships", handler: (ctx) => listRelationships(ctx.db, intParam(ctx, "id")) },
  {
    method: "POST",
    path: "/conflicts/relationships",
    handler: (ctx) => ({
      id: addRelationship(
        ctx.db,
        {
          fromContactId: optInt(ctx.body?.fromContactId, "fromContactId") ?? 0,
          toContactId: optInt(ctx.body?.toContactId, "toContactId") ?? 0,
          kind: ctx.body?.kind,
          note: ctx.body?.note,
        },
        actor(ctx),
      ),
    }),
  },
  {
    method: "PATCH",
    path: "/conflicts/relationships/:id",
    handler: (ctx) => updateRelationship(ctx.db, intParam(ctx, "id"), ctx.body ?? {}, actor(ctx)),
  },
  {
    method: "DELETE",
    path: "/conflicts/relationships/:id",
    handler: (ctx) => (deleteRelationship(ctx.db, intParam(ctx, "id"), actor(ctx)), { ok: true }),
  },

  // matter parties
  { method: "GET", path: "/conflicts/matters/:id/parties", handler: (ctx) => listParties(ctx.db, intParam(ctx, "id")) },
  {
    method: "POST",
    path: "/conflicts/matters/:id/parties",
    handler: (ctx) => ({
      id: addParty(
        ctx.db,
        intParam(ctx, "id"),
        { contactId: optInt(ctx.body?.contactId, "contactId") ?? 0, role: ctx.body?.role, note: ctx.body?.note },
        actor(ctx),
      ),
    }),
  },
  { method: "PATCH", path: "/conflicts/parties/:id", handler: (ctx) => updateParty(ctx.db, partyId(ctx), ctx.body ?? {}, actor(ctx)) },
  {
    method: "DELETE",
    path: "/conflicts/parties/:id",
    handler: (ctx) => (deleteParty(ctx.db, partyId(ctx), actor(ctx)), { ok: true }),
  },

  // searching. POST /conflicts/search saves the check; preview=true runs it without saving
  // (for type-ahead while entering a contact; it is not a substitute for a recorded check).
  {
    method: "POST",
    path: "/conflicts/search",
    handler: (ctx) => {
      const b = ctx.body ?? {};
      const input = {
        terms: b.terms ?? (b.name ? [{ name: b.name, kind: b.kind, role: b.role }] : undefined),
        matterId: optInt(b.matterId, "matterId"),
        minScore: b.minScore === undefined ? undefined : Number(b.minScore),
        related: b.related,
        limit: b.limit === undefined ? undefined : Math.min(1000, Math.max(1, Number(b.limit) || 500)),
      };
      if (b.preview === true) return mask(ctx, { checkId: null, ...searchConflicts(ctx.db, input) });
      return mask(ctx, runCheck(ctx.db, input, actor(ctx)));
    },
  },

  // the audit trail
  {
    method: "GET",
    path: "/conflicts/checks",
    handler: (ctx) =>
      filterVisible(ctx.db, ctx.userId, listChecks(ctx.db, {
        matterId: optInt(ctx.query.get("matterId"), "matterId"),
        pending: ctx.query.get("pending") === "1" || ctx.query.get("pending") === "true",
        limit: ctx.query.get("limit") ? Number(ctx.query.get("limit")) : undefined,
      }), "matterId"),
  },
  { method: "GET", path: "/conflicts/checks/:id", handler: (ctx) => mask(ctx, getCheck(ctx.db, checkId(ctx))) },
  {
    method: "POST",
    path: "/conflicts/checks/:id/decision",
    handler: (ctx) => decideCheck(ctx.db, checkId(ctx), ctx.body?.decision, ctx.body?.note, actor(ctx)),
  },
  {
    method: "PATCH",
    path: "/conflicts/checks/:id",
    handler: (ctx) => {
      const matterId = optInt(ctx.body?.matterId, "matterId");
      if (matterId == null) throw new EngineError("Give the matterId to link this check to");
      return linkCheck(ctx.db, checkId(ctx), matterId, actor(ctx));
    },
  },
];
