// API for sign-in, My account, account management (admins) and matter access lists.

import { EngineError } from "../engine.ts";
import { intParam, type Ctx, type Route } from "../http.ts";
import {
  accountCount,
  adminSetPassword,
  beginTwoFactor,
  changePassword,
  completeTwoFactor,
  createAccount,
  createResetToken,
  disableTwoFactor,
  enableTwoFactor,
  getAccount,
  listSessions,
  publicAccount,
  recoveryCodesLeft,
  regenerateRecoveryCodes,
  revokeAllSessions,
  revokeSession,
  setupFirstAdmin,
  signIn,
  signOut,
  unlockAccount,
  updateAccount,
  checkRole,
  checkEmail,
  useResetToken,
  type SignInResult,
} from "./accounts.ts";
import { passwordProblem } from "./passwords.ts";
import { ADMIN, ATTORNEYS, ROLES, ROLE_LABELS, STAFF, assertCanSeeMatter, matterAccessList } from "./access.ts";
import { clearCookie, sessionCookie } from "./guard.ts";

const ANYONE_SIGNED_IN = [...ROLES];

type Row = Record<string, any>;

function json(value: unknown, cookie?: string) {
  return {
    __raw: true,
    status: 200,
    contentType: "application/json; charset=utf-8",
    headers: cookie ? { "Set-Cookie": cookie } : {},
    body: JSON.stringify(value),
  };
}

const client = (ctx: Ctx) => ({ ip: ctx.client?.ip ?? null, userAgent: ctx.client?.userAgent ?? null });
const secure = (ctx: Ctx) => !!ctx.client?.secure;

function me(ctx: Ctx): number {
  if (ctx.userId == null) throw new EngineError("Please sign in.", 401);
  return ctx.userId;
}

function status(ctx: Ctx, userId: number | null) {
  const a = userId != null ? getAccount(ctx.db, userId) : undefined;
  return {
    setupNeeded: accountCount(ctx.db) === 0,
    signedIn: !!a,
    user: a ? { id: a.user_id, ...publicAccount(a) } : null,
  };
}

function signedIn(ctx: Ctx, r: SignInResult) {
  if (r.status === "two_factor") return json({ twoFactor: true, challenge: r.challenge });
  return json(status(ctx, r.userId), sessionCookie(r.token, secure(ctx)));
}

function accountsList(ctx: Ctx) {
  const rows = ctx.db
    .prepare(
      `SELECT u.id, u.name, u.email AS user_email, u.default_role, u.active, a.*,
        (SELECT COUNT(*) FROM auth_sessions s WHERE s.user_id = u.id) AS sessions
       FROM users u LEFT JOIN auth_accounts a ON a.user_id = u.id ORDER BY u.active DESC, u.name`,
    )
    .all() as Row[];
  return rows.map((r) => ({
    userId: r.id,
    name: r.name,
    active: !!r.active,
    defaultRole: r.default_role,
    account: r.user_id ? { ...publicAccount({ ...r, name: r.name }), sessions: r.sessions } : null,
    email: r.email ?? r.user_email,
  }));
}

export const routes: Route[] = [
  // ------------------------------------------------------------- signing in
  { method: "GET", path: "/auth/status", public: true, handler: (ctx) => status(ctx, ctx.userId) },
  {
    method: "POST",
    path: "/auth/setup",
    public: true,
    handler: async (ctx) => {
      const a = await setupFirstAdmin(ctx.db, ctx.engine, ctx.body);
      const r = await signIn(ctx.db, ctx.engine, { email: a.email, password: ctx.body.password }, client(ctx));
      return signedIn(ctx, r);
    },
  },
  {
    method: "POST",
    path: "/auth/sign-in",
    public: true,
    handler: async (ctx) => signedIn(ctx, await signIn(ctx.db, ctx.engine, ctx.body, client(ctx))),
  },
  {
    method: "POST",
    path: "/auth/sign-in/code",
    public: true,
    handler: (ctx) => signedIn(ctx, completeTwoFactor(ctx.db, ctx.engine, ctx.body, client(ctx))),
  },
  {
    // Public so a browser with an expired session can still clear its cookie.
    method: "POST",
    path: "/auth/sign-out",
    public: true,
    handler: (ctx) => {
      if (ctx.userId != null && ctx.sessionId != null) signOut(ctx.db, ctx.engine, ctx.userId, ctx.sessionId);
      return json({ ok: true }, clearCookie(secure(ctx)));
    },
  },
  {
    method: "POST",
    path: "/auth/reset",
    public: true,
    handler: async (ctx) => {
      await useResetToken(ctx.db, ctx.engine, ctx.body.token, ctx.body.password);
      return { ok: true };
    },
  },

  // ------------------------------------------------------------ my account
  {
    method: "GET",
    path: "/auth/me",
    roles: ANYONE_SIGNED_IN,
    handler: (ctx) => {
      const uid = me(ctx);
      return {
        ...status(ctx, uid),
        sessions: listSessions(ctx.db, uid, ctx.sessionId ?? null),
        recoveryCodesLeft: recoveryCodesLeft(ctx.db, uid),
      };
    },
  },
  {
    method: "POST",
    path: "/auth/password",
    roles: ANYONE_SIGNED_IN,
    handler: async (ctx) => {
      const uid = me(ctx);
      await changePassword(ctx.db, ctx.engine, uid, ctx.body.currentPassword, ctx.body.newPassword, ctx.sessionId ?? null);
      return status(ctx, uid);
    },
  },
  {
    method: "DELETE",
    path: "/auth/sessions/:id",
    roles: ANYONE_SIGNED_IN,
    handler: (ctx) => {
      const uid = me(ctx);
      const sid = intParam(ctx, "id");
      if (!revokeSession(ctx.db, uid, sid)) throw new EngineError("That session has already ended", 404);
      ctx.engine.log("auth_sign_out", sid === ctx.sessionId ? "Signed out" : "Signed out another device", { userId: uid });
      return { sessions: listSessions(ctx.db, uid, ctx.sessionId ?? null) };
    },
  },
  {
    method: "POST",
    path: "/auth/sessions/sign-out-others",
    roles: ANYONE_SIGNED_IN,
    handler: (ctx) => {
      const uid = me(ctx);
      const n = revokeAllSessions(ctx.db, uid, ctx.sessionId ?? null);
      ctx.engine.log("auth_sessions_revoked", `Signed out everywhere else (${n} session${n === 1 ? "" : "s"})`, { userId: uid });
      return { signedOut: n, sessions: listSessions(ctx.db, uid, ctx.sessionId ?? null) };
    },
  },
  { method: "POST", path: "/auth/two-factor/setup", roles: ANYONE_SIGNED_IN, handler: (ctx) => beginTwoFactor(ctx.db, me(ctx)) },
  {
    method: "POST",
    path: "/auth/two-factor/enable",
    roles: ANYONE_SIGNED_IN,
    handler: (ctx) => ({ recoveryCodes: enableTwoFactor(ctx.db, ctx.engine, me(ctx), ctx.body.code) }),
  },
  {
    method: "POST",
    path: "/auth/two-factor/disable",
    roles: ANYONE_SIGNED_IN,
    handler: async (ctx) => {
      await disableTwoFactor(ctx.db, ctx.engine, me(ctx), ctx.body.password);
      return { ok: true };
    },
  },
  {
    method: "POST",
    path: "/auth/two-factor/recovery-codes",
    roles: ANYONE_SIGNED_IN,
    handler: async (ctx) => ({ recoveryCodes: await regenerateRecoveryCodes(ctx.db, ctx.engine, me(ctx), ctx.body.password) }),
  },

  // ------------------------------------------------------- managing people
  {
    method: "GET",
    path: "/auth/accounts",
    roles: ADMIN,
    handler: (ctx) => ({ accounts: accountsList(ctx), roles: ROLES.map((r) => ({ value: r, label: ROLE_LABELS[r] })) }),
  },
  {
    // Invite: give someone a sign-in with a temporary password they must change. Either
    // an existing person (userId) or a new one (name).
    method: "POST",
    path: "/auth/accounts",
    roles: ADMIN,
    handler: async (ctx) => {
      const b = ctx.body;
      let userId = b.userId == null || b.userId === "" ? null : Number(b.userId);
      if (userId != null && (!Number.isInteger(userId) || userId <= 0)) throw new EngineError("Pick a person", 400);
      const role = checkRole(b.role);
      if (userId == null) {
        const name = typeof b.name === "string" ? b.name.trim() : "";
        if (!name) throw new EngineError("Enter the person's name", 400);
        if (name.length > 200) throw new EngineError("That name is too long", 400);
        // Check the parts that can fail before adding the person.
        const email = checkEmail(b.email);
        const p = passwordProblem(b.temporaryPassword, email);
        if (p) throw new EngineError(p, 400);
        if (ctx.db.prepare("SELECT 1 FROM auth_accounts WHERE email = ?").get(email)) throw new EngineError("Another account already uses that email address", 409);
        userId = ctx.engine.addUser(name, typeof b.defaultRole === "string" && b.defaultRole.trim() ? b.defaultRole.trim().slice(0, 60) : role === "attorney" ? "attorney" : null, email);
        ctx.engine.log("user_added", `Added person "${name}"`, { userId: ctx.userId });
      }
      const a = await createAccount(ctx.db, ctx.engine, { userId, email: b.email, role, password: b.temporaryPassword, mustChangePassword: true }, ctx.userId);
      return publicAccount(a);
    },
  },
  {
    method: "PATCH",
    path: "/auth/accounts/:userId",
    roles: ADMIN,
    handler: (ctx) => publicAccount(updateAccount(ctx.db, ctx.engine, ctx.userId, intParam(ctx, "userId"), ctx.body)),
  },
  {
    method: "POST",
    path: "/auth/accounts/:userId/password",
    roles: ADMIN,
    handler: async (ctx) => {
      const uid = intParam(ctx, "userId");
      await adminSetPassword(ctx.db, ctx.engine, ctx.userId, uid, ctx.body.temporaryPassword, { turnOffTwoFactor: !!ctx.body.turnOffTwoFactor });
      return publicAccount(getAccount(ctx.db, uid)!);
    },
  },
  {
    // A one-time link instead of a temporary password; the admin passes it on (email later).
    method: "POST",
    path: "/auth/accounts/:userId/reset-link",
    roles: ADMIN,
    handler: (ctx) => {
      const token = createResetToken(ctx.db, intParam(ctx, "userId"), { createdBy: ctx.userId, engine: ctx.engine });
      return { token, path: `/#/reset/${token}` };
    },
  },
  {
    method: "POST",
    path: "/auth/accounts/:userId/unlock",
    roles: ADMIN,
    handler: (ctx) => {
      const uid = intParam(ctx, "userId");
      unlockAccount(ctx.db, ctx.engine, ctx.userId, uid);
      return publicAccount(getAccount(ctx.db, uid)!);
    },
  },
  {
    method: "POST",
    path: "/auth/accounts/:userId/sign-out",
    roles: ADMIN,
    handler: (ctx) => {
      const uid = intParam(ctx, "userId");
      const a = getAccount(ctx.db, uid);
      if (!a) throw new EngineError("That person has no sign-in account", 404);
      const n = revokeAllSessions(ctx.db, uid, uid === ctx.userId ? ctx.sessionId ?? null : null);
      ctx.engine.log("auth_sessions_revoked", `Signed ${a.name} out everywhere (${n} session${n === 1 ? "" : "s"})`, { userId: ctx.userId });
      return { signedOut: n };
    },
  },

  // ----------------------------------------------------- matter access lists
  {
    method: "GET",
    path: "/matters/:id/access",
    roles: STAFF,
    handler: (ctx) => {
      const mid = intParam(ctx, "id");
      ctx.engine.getMatter(mid); // 404 if missing
      assertCanSeeMatter(ctx.db, ctx.userId, mid);
      const users = matterAccessList(ctx.db, mid);
      return { restricted: users.length > 0, users };
    },
  },
  {
    // Restrict a matter to these people (an empty list lifts the restriction). Whoever
    // sets it stays on the list, so nobody locks themselves out by accident.
    method: "PUT",
    path: "/matters/:id/access",
    roles: ATTORNEYS,
    handler: (ctx) => {
      const mid = intParam(ctx, "id");
      const m = ctx.engine.getMatter(mid).matter;
      assertCanSeeMatter(ctx.db, ctx.userId, mid);
      const raw = ctx.body.userIds;
      if (!Array.isArray(raw) || raw.length > 500) throw new EngineError("Send the list of people who may see this matter", 400);
      const ids = new Set<number>();
      for (const v of raw) {
        const n = Number(v);
        if (!Number.isInteger(n) || n <= 0 || !ctx.db.prepare("SELECT 1 FROM users WHERE id = ?").get(n)) throw new EngineError("One of those people wasn't found", 400);
        ids.add(n);
      }
      if (ids.size && ctx.userId != null) ids.add(ctx.userId);
      const before = matterAccessList(ctx.db, mid);
      ctx.db.exec("BEGIN");
      try {
        ctx.db.prepare("DELETE FROM auth_matter_access WHERE matter_id = ?").run(mid);
        for (const uid of ids) ctx.db.prepare("INSERT INTO auth_matter_access (matter_id, user_id) VALUES (?,?)").run(mid, uid);
        const after = matterAccessList(ctx.db, mid);
        const names = after.map((u) => u.name).join(", ");
        if (!after.length && before.length) ctx.engine.log("matter_access_changed", "Removed the access restriction: everyone at the firm can see this matter", { userId: ctx.userId, matterId: mid });
        else if (after.length && names !== before.map((u) => u.name).join(", "))
          ctx.engine.log("matter_access_changed", `Restricted "${m.name}" to ${names}`, { userId: ctx.userId, matterId: mid });
        ctx.db.exec("COMMIT");
        return { restricted: after.length > 0, users: after };
      } catch (e) {
        ctx.db.exec("ROLLBACK");
        throw e;
      }
    },
  },
];
