// Sign-in, sessions, two-factor, roles and matter access, over real HTTP.

import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { openDb } from "../../src/db.ts";
import { createServer } from "../../src/server.ts";
import { clock, LIMITS, createResetToken } from "../../src/auth/accounts.ts";
import { totp } from "../../src/auth/totp.ts";
import { canSeeMatter, hiddenMatterIds } from "../../src/auth/access.ts";
import { seed } from "../../src/seed.ts";
import { DEMO_PASSWORD } from "../../src/auth/seed.ts";

const servers: any[] = [];
after(() => servers.forEach((s) => s.close()));
beforeEach(() => {
  clock.now = () => Date.now();
});

const PW = "a long and sturdy passphrase";

async function start() {
  const db = openDb();
  const server = createServer(db, { today: () => "2026-11-18", log: () => {} });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  servers.push(server);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  /** A browser: keeps its own cookie. */
  function browser() {
    let cookie = "";
    const b = {
      lastSetCookie: "",
      async call(method: string, path: string, body?: unknown, opts: { csrf?: boolean } = {}) {
        const headers: Record<string, string> = {};
        if (cookie) headers.Cookie = cookie;
        if (opts.csrf !== false) headers["X-Requested-With"] = "lawdesk";
        if (body !== undefined) headers["Content-Type"] = "application/json";
        const res = await fetch(base + "/api" + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
        const set = res.headers.get("set-cookie");
        if (set) {
          b.lastSetCookie = set;
          const v = set.split(";")[0];
          cookie = v.endsWith("=") ? "" : v;
        }
        const text = await res.text();
        let data: any = text;
        try {
          data = JSON.parse(text);
        } catch {}
        return { status: res.status, data };
      },
      async ok(method: string, path: string, body?: unknown) {
        const r = await b.call(method, path, body);
        assert.equal(r.status, 200, `${method} ${path} -> ${r.status} ${JSON.stringify(r.data)}`);
        return r.data;
      },
      async signIn(email: string, password: string) {
        return b.call("POST", "/auth/sign-in", { email, password });
      },
      get cookie() {
        return cookie;
      },
    };
    return b;
  }
  const activity = (kind: string) => (db.prepare("SELECT * FROM activity WHERE kind = ? ORDER BY id").all(kind) as any[]);
  return { db, base, browser, activity };
}

async function withAdmin() {
  const s = await start();
  const admin = s.browser();
  await admin.ok("POST", "/auth/setup", { name: "Avery Admin", email: "avery@example.com", password: PW });
  return { ...s, admin };
}

async function invite(s: Awaited<ReturnType<typeof withAdmin>>, name: string, email: string, role: string) {
  const a = await s.admin.ok("POST", "/auth/accounts", { name, email, role, temporaryPassword: "temporary pass 123" });
  const b = s.browser();
  assert.equal((await b.signIn(email, "temporary pass 123")).status, 200);
  await b.ok("POST", "/auth/password", { currentPassword: "temporary pass 123", newPassword: PW + " " + name });
  return { id: a.userId as number, b, password: PW + " " + name };
}

test("first run: setup screen creates the first admin and signs them in; only once", async () => {
  const s = await start();
  const b = s.browser();
  let st = await b.ok("GET", "/auth/status");
  assert.equal(st.setupNeeded, true);
  assert.equal(st.signedIn, false);
  assert.equal((await b.call("GET", "/matters")).status, 401);
  assert.equal((await b.call("POST", "/auth/setup", { name: "Avery", email: "avery@example.com", password: "short" })).status, 400);
  const r = await b.call("POST", "/auth/setup", { name: "Avery Admin", email: "avery@example.com", password: PW });
  assert.equal(r.status, 200);
  assert.equal(r.data.user.role, "admin");
  assert.match(b.lastSetCookie, /^lawdesk_session=[\w-]{43}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=\d+$/);
  st = await b.ok("GET", "/auth/status");
  assert.equal(st.setupNeeded, false);
  assert.equal(st.user.name, "Avery Admin");
  assert.equal((await b.call("GET", "/matters")).status, 200);
  const again = await s.browser().call("POST", "/auth/setup", { name: "Mallory", email: "m@example.com", password: PW });
  assert.equal(again.status, 409);
  // Only the hash of the session token is stored.
  const token = b.cookie.split("=")[1];
  assert.equal((s.db.prepare("SELECT COUNT(*) AS n FROM auth_sessions WHERE token_hash = ?").get(token) as any).n, 0);
  assert.equal(s.activity("auth_account_created").length, 1);
  assert.equal(s.activity("auth_sign_in").length, 1);
});

test("setup links to an existing person with the same email (demo data, Clio import)", async () => {
  const s = await start();
  const uid = Number(s.db.prepare("INSERT INTO users (name, email) VALUES ('Pat Existing', 'pat@example.com')").run().lastInsertRowid);
  const r = await s.browser().ok("POST", "/auth/setup", { name: "Pat", email: "PAT@example.com", password: PW });
  assert.equal(r.user.id, uid);
  assert.equal(r.user.name, "Pat Existing");
});

test("CSRF: changes need the X-Requested-With header; reads don't", async () => {
  const s = await withAdmin();
  const r = await s.admin.call("POST", "/contacts", { name: "Acme" }, { csrf: false });
  assert.equal(r.status, 403);
  assert.match(r.data.error, /didn't come from the Lawdesk app/);
  assert.equal((await s.admin.call("POST", "/contacts", { name: "Acme" })).status, 200);
  assert.equal((await s.admin.call("GET", "/contacts", undefined, { csrf: false })).status, 200);
  // Sign-in is protected too (no logging someone into an attacker's account).
  assert.equal((await s.browser().call("POST", "/auth/sign-in", { email: "avery@example.com", password: PW }, { csrf: false })).status, 403);
});

test("sign-in: wrong password, lockout after five tries, admin unlock", async () => {
  const s = await withAdmin();
  const sam = await invite(s, "Sam Staff", "sam@example.com", "staff");
  const b = s.browser();
  const unknown = await b.signIn("nobody@example.com", PW);
  assert.equal(unknown.status, 401);
  const wrong = await b.signIn("sam@example.com", "not the password at all");
  assert.equal(wrong.status, 401);
  assert.equal(wrong.data.error, unknown.data.error, "same message whether or not the email exists");
  for (let i = 0; i < LIMITS.lockAfter - 1; i++) await b.signIn("SAM@example.com", "still not the password");
  const locked = await b.signIn("sam@example.com", sam.password);
  assert.equal(locked.status, 429, "locked even with the right password");
  assert.match(locked.data.error, /Try again in 15 minutes/);
  assert.equal(s.activity("auth_locked").length, 1);
  assert.ok(s.activity("auth_sign_in_failed").length >= 6);
  const list = await s.admin.ok("GET", "/auth/accounts");
  assert.equal(list.accounts.find((a: any) => a.userId === sam.id).account.locked, true);
  await s.admin.ok("POST", `/auth/accounts/${sam.id}/unlock`);
  assert.equal((await b.signIn("sam@example.com", sam.password)).status, 200);
  assert.equal((await b.ok("GET", "/auth/status")).user.email, "sam@example.com");
});

test("sign-in: the lock lifts by itself after 15 minutes", async () => {
  const s = await withAdmin();
  const sam = await invite(s, "Sam Staff", "sam@example.com", "staff");
  const b = s.browser();
  for (let i = 0; i < LIMITS.lockAfter; i++) await b.signIn("sam@example.com", "wrong password here");
  assert.equal((await b.signIn("sam@example.com", sam.password)).status, 429);
  const t0 = Date.now();
  clock.now = () => t0 + LIMITS.lockMs + 1000;
  assert.equal((await b.signIn("sam@example.com", sam.password)).status, 200);
});

test("sessions: idle and absolute timeouts, sign out, sign out everywhere else", async () => {
  const s = await withAdmin();
  const t0 = Date.now();
  clock.now = () => t0;
  const laptop = s.browser();
  const phone = s.browser();
  await laptop.signIn("avery@example.com", PW);
  await phone.signIn("avery@example.com", PW);
  const me = await laptop.ok("GET", "/auth/me");
  assert.equal(me.sessions.length, 3, "setup's session, laptop and phone");
  assert.equal(me.sessions.filter((x: any) => x.current).length, 1);

  // Idle: 8 hours without use ends a session; using it keeps it alive.
  clock.now = () => t0 + LIMITS.idleMs - 60_000;
  assert.equal((await laptop.call("GET", "/matters")).status, 200);
  clock.now = () => t0 + LIMITS.idleMs + 60_000;
  assert.equal((await laptop.call("GET", "/matters")).status, 200, "the laptop was used recently");
  assert.equal((await phone.call("GET", "/matters")).status, 401, "the phone sat idle");
  assert.equal((await s.admin.call("GET", "/matters")).status, 401);

  // Absolute: however busy, 24 hours after signing in.
  for (let h = 9; h <= 24; h += 4) {
    clock.now = () => t0 + h * 3600_000;
    assert.equal((await laptop.call("GET", "/matters")).status, 200);
  }
  clock.now = () => t0 + LIMITS.absoluteMs + 1000;
  assert.equal((await laptop.call("GET", "/matters")).status, 401);

  clock.now = () => Date.now();
  const a = s.browser();
  const b = s.browser();
  const c = s.browser();
  for (const x of [a, b, c]) await x.signIn("avery@example.com", PW);
  const out = await a.ok("POST", "/auth/sessions/sign-out-others");
  assert.equal(out.signedOut, 2);
  assert.equal((await b.call("GET", "/matters")).status, 401);
  assert.equal((await a.call("GET", "/matters")).status, 200);
  await a.ok("POST", "/auth/sign-out");
  assert.equal(a.cookie, "", "the cookie is cleared");
  assert.equal((await a.call("GET", "/matters")).status, 401);
  assert.equal(s.activity("auth_sign_out").length, 1);
});

test("roles: staff can work but not change firm settings; clients reach nothing yet; the .ics feed is public", async () => {
  const s = await withAdmin();
  const sam = await invite(s, "Sam Staff", "sam@example.com", "staff");
  const carla = await invite(s, "Carla Client", "carla@example.com", "client");
  assert.equal((await sam.b.call("GET", "/matters")).status, 200);
  assert.equal((await sam.b.call("POST", "/tasks", { title: "Call the court clerk" })).status, 200);
  for (const [m, p, body] of [
    ["POST", "/users", { name: "X" }],
    ["POST", "/practice-areas", { name: "Probate" }],
    ["POST", "/holidays", { date: "2026-12-24" }],
    ["POST", "/automations", { trigger: "stage_entered", action: "apply_list", triggerRef: 1, actionRef: 1 }],
    ["GET", "/auth/accounts", undefined],
  ] as const) {
    const r = await sam.b.call(m, p, body);
    assert.equal(r.status, 403, `${m} ${p}`);
  }
  assert.equal((await s.admin.call("POST", "/practice-areas", { name: "Probate" })).status, 200);
  assert.equal((await carla.b.call("GET", "/matters")).status, 403);
  assert.equal((await carla.b.call("GET", "/auth/me")).status, 200, "a client can still manage their own sign-in");
  const feed = await s.browser().call("GET", "/calendar/feed/not-a-real-token.ics");
  assert.equal(feed.status, 404, "reaches the feed handler without signing in (unknown token is 404, not 401)");
  // Non-admins don't see sign-in events in the activity feed.
  const act = await sam.b.ok("GET", "/activity");
  assert.ok(act.every((a: any) => !a.kind.startsWith("auth_")));
  assert.ok((await s.admin.ok("GET", "/activity")).some((a: any) => a.kind === "auth_sign_in"));
});

test("invite: the temporary password must be changed before anything else", async () => {
  const s = await withAdmin();
  const a = await s.admin.ok("POST", "/auth/accounts", { name: "Riley Attorney", email: "riley@example.com", role: "attorney", temporaryPassword: "temporary pass 123" });
  assert.equal(a.mustChangePassword, true);
  assert.equal((await s.admin.call("POST", "/auth/accounts", { name: "Dup", email: "RILEY@example.com", role: "staff", temporaryPassword: "temporary pass 123" })).status, 409);
  const b = s.browser();
  const r = await b.signIn("riley@example.com", "temporary pass 123");
  assert.equal(r.data.user.mustChangePassword, true);
  const blocked = await b.call("GET", "/matters");
  assert.equal(blocked.status, 403);
  assert.match(blocked.data.error, /new password/);
  assert.equal((await b.call("POST", "/auth/password", { currentPassword: "wrong", newPassword: PW })).status, 400);
  assert.equal((await b.call("POST", "/auth/password", { currentPassword: "temporary pass 123", newPassword: "temporary pass 123" })).status, 400);
  await b.ok("POST", "/auth/password", { currentPassword: "temporary pass 123", newPassword: PW });
  assert.equal((await b.call("GET", "/matters")).status, 200);
  assert.equal(s.activity("auth_password_changed").length, 1);
});

test("changing your password signs out your other devices", async () => {
  const s = await withAdmin();
  const other = s.browser();
  await other.signIn("avery@example.com", PW);
  await s.admin.ok("POST", "/auth/password", { currentPassword: PW, newPassword: PW + "!" });
  assert.equal((await other.call("GET", "/matters")).status, 401);
  assert.equal((await s.admin.call("GET", "/matters")).status, 200);
  assert.equal((await s.browser().signIn("avery@example.com", PW)).status, 401);
  assert.equal((await s.browser().signIn("avery@example.com", PW + "!")).status, 200);
});

test("admin password reset: temporary password, and one-time reset links", async () => {
  const s = await withAdmin();
  const sam = await invite(s, "Sam Staff", "sam@example.com", "staff");
  await s.admin.ok("POST", `/auth/accounts/${sam.id}/password`, { temporaryPassword: "fresh temp pass 456" });
  assert.equal((await sam.b.call("GET", "/matters")).status, 401, "signed out everywhere");
  const b = s.browser();
  assert.equal((await b.signIn("sam@example.com", "fresh temp pass 456")).data.user.mustChangePassword, true);
  assert.equal(s.activity("auth_password_reset").length, 1);

  // The email module will send this link; here the admin route hands it back.
  const link = await s.admin.ok("POST", `/auth/accounts/${sam.id}/reset-link`);
  assert.match(link.path, /^\/#\/reset\/[\w-]+$/);
  const anon = s.browser();
  assert.equal((await anon.call("POST", "/auth/reset", { token: link.token, password: "short" })).status, 400);
  await anon.ok("POST", "/auth/reset", { token: link.token, password: "chosen from the link" });
  assert.equal((await anon.call("POST", "/auth/reset", { token: link.token, password: "chosen again from link" })).status, 400, "one use only");
  const signed = await s.browser().signIn("sam@example.com", "chosen from the link");
  assert.equal(signed.status, 200);
  assert.equal(signed.data.user.mustChangePassword, false);

  // createResetToken is the function the email module calls; links expire.
  const t0 = Date.now();
  const token = createResetToken(s.db, sam.id, { ttlMs: 60_000 });
  clock.now = () => t0 + 120_000;
  assert.equal((await anon.call("POST", "/auth/reset", { token, password: "too late for this one" })).status, 400);
});

test("two-factor: set up with a code, sign in with a code or a recovery code, turn off", async () => {
  const s = await withAdmin();
  const setup = await s.admin.ok("POST", "/auth/two-factor/setup");
  assert.match(setup.uri, /^otpauth:\/\/totp\/Lawdesk%3Aavery%40example\.com\?secret=[A-Z2-7]{32}&issuer=Lawdesk/);
  const secret = setup.key.replace(/ /g, "");
  assert.equal((await s.admin.call("POST", "/auth/two-factor/enable", { code: "000000" })).status, 400);
  const t0 = Date.now();
  clock.now = () => t0;
  const { recoveryCodes } = await s.admin.ok("POST", "/auth/two-factor/enable", { code: totp(secret, t0) });
  assert.equal(recoveryCodes.length, 10);
  assert.match(recoveryCodes[0], /^[a-z2-7]{4}-[a-z2-7]{4}-[a-z2-7]{4}$/);
  assert.equal((await s.admin.ok("GET", "/auth/status")).user.twoFactor, true);

  // Password alone is no longer enough.
  const b = s.browser();
  clock.now = () => t0 + 60_000;
  const step1 = await b.signIn("avery@example.com", PW);
  assert.equal(step1.data.twoFactor, true);
  assert.equal(b.cookie, "", "no session yet");
  assert.equal((await b.call("POST", "/auth/sign-in/code", { challenge: step1.data.challenge, code: "123456" })).status, 401);
  const ok = await b.call("POST", "/auth/sign-in/code", { challenge: step1.data.challenge, code: totp(secret, t0 + 60_000) });
  assert.equal(ok.status, 200);
  assert.equal((await b.call("GET", "/matters")).status, 200);

  // The same code can't be used again, even with a new challenge.
  const again = await s.browser().signIn("avery@example.com", PW);
  assert.equal((await s.browser().call("POST", "/auth/sign-in/code", { challenge: again.data.challenge, code: totp(secret, t0 + 60_000) })).status, 401);

  // A recovery code works once.
  const c = s.browser();
  const ch = await c.signIn("avery@example.com", PW);
  assert.equal((await c.call("POST", "/auth/sign-in/code", { challenge: ch.data.challenge, code: recoveryCodes[3].toUpperCase() })).status, 200);
  const d = s.browser();
  const ch2 = await d.signIn("avery@example.com", PW);
  assert.equal((await d.call("POST", "/auth/sign-in/code", { challenge: ch2.data.challenge, code: recoveryCodes[3] })).status, 401);
  assert.equal((await c.ok("GET", "/auth/me")).recoveryCodesLeft, 9);
  assert.equal(s.activity("auth_recovery_used").length, 1);

  // Challenges expire.
  const e = s.browser();
  const ch3 = await e.signIn("avery@example.com", PW);
  clock.now = () => t0 + 60_000 + LIMITS.challengeMs + 1000;
  assert.equal((await e.call("POST", "/auth/sign-in/code", { challenge: ch3.data.challenge, code: totp(secret, clock.now()) })).status, 401);

  assert.equal((await c.call("POST", "/auth/two-factor/disable", { password: "wrong" })).status, 400);
  await c.ok("POST", "/auth/two-factor/disable", { password: PW });
  const plain = await s.browser().signIn("avery@example.com", PW);
  assert.equal(plain.status, 200);
  assert.equal(plain.data.twoFactor, undefined);
  assert.deepEqual(s.activity("auth_2fa_on").length + s.activity("auth_2fa_off").length, 2);
});

test("account management: role changes are logged; the last admin can't be removed; deactivation signs out", async () => {
  const s = await withAdmin();
  const sam = await invite(s, "Sam Staff", "sam@example.com", "staff");
  const me = (await s.admin.ok("GET", "/auth/status")).user.id;
  assert.equal((await s.admin.call("PATCH", `/auth/accounts/${me}`, { role: "attorney" })).status, 409);
  assert.equal((await s.admin.call("PATCH", `/auth/accounts/${me}`, { disabled: true })).status, 409);
  const changed = await s.admin.ok("PATCH", `/auth/accounts/${sam.id}`, { role: "attorney" });
  assert.equal(changed.role, "attorney");
  assert.match(s.activity("auth_role_changed")[0].detail, /Sam Staff: access changed from Staff to Attorney/);
  await s.admin.ok("PATCH", `/auth/accounts/${sam.id}`, { disabled: true });
  assert.equal((await sam.b.call("GET", "/matters")).status, 401);
  const r = await s.browser().signIn("sam@example.com", sam.password);
  assert.equal(r.status, 403);
  assert.match(r.data.error, /turned off/);
  await s.admin.ok("PATCH", `/auth/accounts/${sam.id}`, { disabled: false, role: "admin" });
  await s.admin.ok("PATCH", `/auth/accounts/${me}`, { role: "attorney" }); // now allowed: Sam is an admin
  assert.equal((await s.admin.call("GET", "/auth/accounts")).status, 403);
  // Give an existing person (no account yet) a sign-in.
  const uid = Number(s.db.prepare("INSERT INTO users (name) VALUES ('Casey Assistant')").run().lastInsertRowid);
  const sb = s.browser();
  await sb.signIn("sam@example.com", sam.password);
  const casey = await sb.ok("POST", "/auth/accounts", { userId: uid, email: "casey@example.com", role: "staff", temporaryPassword: "temporary pass 123" });
  assert.equal(casey.userId, uid);
  assert.equal((s.db.prepare("SELECT email FROM users WHERE id = ?").get(uid) as any).email, "casey@example.com");
});

test("matter access: a restricted matter and its tasks are hidden from everyone not on its list", async () => {
  const s = await withAdmin();
  const riley = await invite(s, "Riley Attorney", "riley@example.com", "attorney");
  const sam = await invite(s, "Sam Staff", "sam@example.com", "staff");
  const casey = await invite(s, "Casey Staff", "casey@example.com", "staff");
  const open = await s.admin.ok("POST", "/matters", { name: "Ordinary matter" });
  const secret = await riley.b.ok("POST", "/matters", { name: "Sensitive matter" });
  const task = (await riley.b.ok("POST", "/tasks", { matterId: secret.id, title: "Draft the sealed motion", assigneeId: sam.id })).task;
  await riley.b.ok("POST", "/tasks", { matterId: open.id, title: "Ordinary task", assigneeId: sam.id });

  assert.equal((await sam.b.call("PUT", `/matters/${secret.id}/access`, { userIds: [sam.id] })).status, 403, "staff can't restrict a matter");
  const set = await riley.b.ok("PUT", `/matters/${secret.id}/access`, { userIds: [sam.id] });
  assert.deepEqual(set.users.map((u: any) => u.name).sort(), ["Riley Attorney", "Sam Staff"], "the person restricting it stays on the list");
  assert.equal(s.activity("matter_access_changed").length, 1);

  // Casey isn't on the list: the matter and its task don't exist for her.
  const cm = await casey.b.ok("GET", "/matters");
  assert.deepEqual(cm.map((m: any) => m.name), ["Ordinary matter"]);
  assert.equal((await casey.b.call("GET", `/matters/${secret.id}`)).status, 404);
  assert.equal((await casey.b.call("PATCH", `/matters/${secret.id}`, { name: "x" })).status, 404);
  assert.equal((await casey.b.call("GET", `/tasks/${task.id}`)).status, 404);
  assert.equal((await casey.b.call("POST", `/tasks/${task.id}/complete`)).status, 404);
  assert.equal((await casey.b.call("POST", "/tasks", { matterId: secret.id, title: "x" })).status, 404);
  assert.equal((await casey.b.call("GET", `/matters/${secret.id}/access`)).status, 404);
  const firm = await casey.b.ok("GET", "/firm-tasks");
  assert.ok(firm.tasks.every((t: any) => t.matter_id !== secret.id));
  assert.ok(firm.tasks.some((t: any) => t.title === "Ordinary task"));
  const samsTasks = await casey.b.ok("GET", `/my-tasks?userId=${sam.id}`);
  const all = ["overdue", "dueToday", "upcoming", "later", "noDate", "waiting"].flatMap((k) => samsTasks[k]);
  assert.ok(all.every((t: any) => t.matter_id !== secret.id));
  assert.ok((await casey.b.ok("GET", "/activity")).every((a: any) => a.matter_id !== secret.id));

  // Sam is on the list; the admin always sees it.
  assert.equal((await sam.b.ok("GET", "/matters")).length, 2);
  assert.equal((await sam.b.ok("GET", `/tasks/${task.id}`)).title, "Draft the sealed motion");
  assert.equal((await s.admin.ok("GET", `/matters/${secret.id}`)).matter.name, "Sensitive matter");

  // The helper other modules use.
  assert.equal(canSeeMatter(s.db, casey.id, secret.id), false);
  assert.equal(canSeeMatter(s.db, sam.id, secret.id), true);
  assert.equal(canSeeMatter(s.db, null, secret.id), false);
  assert.equal(canSeeMatter(s.db, casey.id, open.id), true);
  assert.deepEqual([...hiddenMatterIds(s.db, casey.id)], [secret.id]);

  // Lifting the restriction.
  await riley.b.ok("PUT", `/matters/${secret.id}/access`, { userIds: [] });
  assert.equal((await casey.b.ok("GET", "/matters")).length, 2);
});

test("cookies are Secure when LAWDESK_SECURE_COOKIES=1", async () => {
  process.env.LAWDESK_SECURE_COOKIES = "1";
  try {
    const s = await start();
    const b = s.browser();
    await b.ok("POST", "/auth/setup", { name: "Avery", email: "avery@example.com", password: PW });
    assert.match(b.lastSetCookie, /; Secure$/);
  } finally {
    delete process.env.LAWDESK_SECURE_COOKIES;
  }
});

test("the demo seed creates sign-in accounts with the published demo password", async () => {
  const s = await start();
  seed(s.db, "2026-11-18");
  const b = s.browser();
  const r = await b.signIn("jordan@example.com", DEMO_PASSWORD);
  assert.equal(r.status, 200);
  assert.equal(r.data.user.role, "admin");
  assert.equal((await s.browser().signIn("sam@example.com", DEMO_PASSWORD)).data.user.role, "staff");
  assert.equal((await b.ok("GET", "/auth/status")).setupNeeded, false);
});
