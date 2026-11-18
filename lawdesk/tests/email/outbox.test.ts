import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { MAX_ATTEMPTS, cancelOutbox, deliverDue, listOutbox, nextAttemptAt, queueEmail, retryOutbox } from "../../src/email/outbox.ts";
import { SmtpError } from "../../src/email/smtp.ts";
import { loadConfig, publicSettings, saveSettings } from "../../src/email/settings.ts";
import { MemoryTransport, setup } from "./helpers.ts";

const t0 = new Date("2026-11-18T15:00:00Z");
const plus = (min: number) => new Date(t0.getTime() + min * 60_000);

test("outbox: queue then deliver with the dev transport (default)", async () => {
  const { db, env, mailDir, cleanup } = setup();
  try {
    const q = queueEmail(db, { kind: "test", to: [{ address: "dana@client.example.test" }], subject: "Hello", text: "Hi" }, { now: t0, env });
    assert.ok(q.id > 0);
    assert.equal(listOutbox(db)[0].status, "queued");
    const r = await deliverDue(db, { now: t0, env });
    assert.deepEqual(r, { sent: 1, retrying: 0, failed: 0 });
    assert.equal(readdirSync(mailDir).length, 1);
    const row = listOutbox(db)[0];
    assert.equal(row.status, "sent");
    assert.equal(row.attempts, 1);
    assert.match(row.response, /Saved to/);
    // Nothing left to send.
    assert.deepEqual(await deliverDue(db, { now: plus(1), env }), { sent: 0, retrying: 0, failed: 0 });
  } finally {
    cleanup();
  }
});

test("outbox: temporary failures back off, then give up", async () => {
  const { db, env, cleanup } = setup();
  try {
    const tr = new MemoryTransport();
    tr.failWith = new SmtpError("Connection error: ECONNREFUSED");
    queueEmail(db, { kind: "test", to: [{ address: "dana@client.example.test" }], subject: "Hello", text: "Hi" }, { now: t0, env });
    let now = t0;
    const seen: string[] = [];
    for (let i = 1; i <= MAX_ATTEMPTS; i++) {
      const r = await deliverDue(db, { now, transport: tr, env });
      const row = listOutbox(db)[0];
      seen.push(row.status);
      if (i < MAX_ATTEMPTS) {
        assert.equal(r.retrying, 1, `attempt ${i}`);
        assert.equal(row.next_attempt_at, nextAttemptAt(i, now));
        // Not due yet a second before the retry time.
        assert.equal((await deliverDue(db, { now: new Date(Date.parse(row.next_attempt_at) - 1000), transport: tr, env })).retrying, 0);
        now = new Date(row.next_attempt_at);
      } else assert.equal(r.failed, 1);
    }
    assert.deepEqual(seen, ["queued", "queued", "queued", "queued", "queued", "failed"]);
    const row = listOutbox(db)[0];
    assert.equal(row.attempts, MAX_ATTEMPTS);
    assert.match(row.last_error, /ECONNREFUSED/);
    // Retry by hand works.
    tr.failWith = null;
    retryOutbox(db, row.id, now);
    assert.equal((await deliverDue(db, { now, transport: tr, env })).sent, 1);
  } finally {
    cleanup();
  }
});

test("outbox: permanent refusals fail at once; cancel; sensitive messages are hidden and purged", async () => {
  const { db, env, cleanup } = setup();
  try {
    const tr = new MemoryTransport();
    tr.failWith = new SmtpError("550 no such user", 550);
    queueEmail(db, { kind: "test", to: [{ address: "x@client.example.test" }], subject: "Bounce", text: "x" }, { now: t0, env });
    assert.equal((await deliverDue(db, { now: t0, transport: tr, env })).failed, 1);
    tr.failWith = null;
    const c = queueEmail(db, { kind: "test", to: [{ address: "y@client.example.test" }], subject: "Cancel me", text: "x" }, { now: t0, env });
    cancelOutbox(db, c.id);
    const s = queueEmail(db, { kind: "password_reset", to: [{ address: "z@client.example.test" }], subject: "Reset", text: "secret link", sensitive: true }, { now: t0, env });
    assert.equal((await deliverDue(db, { now: t0, transport: tr, env })).sent, 1);
    assert.equal(tr.sent.length, 1);
    const rows = listOutbox(db);
    assert.equal(rows.find((r) => r.id === c.id)!.status, "cancelled");
    const sens = rows.find((r) => r.id === s.id)!;
    assert.equal(sens.subject, "(password reset)");
    assert.equal((db.prepare("SELECT raw FROM email_outbox WHERE id = ?").get(s.id) as any).raw, null);
    assert.throws(() => retryOutbox(db, s.id), /no longer|Only/);
  } finally {
    cleanup();
  }
});

test("outbox: not set up yet leaves mail queued with a reason", async () => {
  const { db, cleanup } = setup();
  try {
    const env = { LAWDESK_MAIL_TRANSPORT: "smtp", LAWDESK_MAIL_FROM: "office@firm.example.test" };
    queueEmail(db, { kind: "test", to: [{ address: "a@client.example.test" }], subject: "Hi", text: "x" }, { now: t0, env });
    await deliverDue(db, { now: t0, env });
    const row = listOutbox(db)[0];
    assert.equal(row.status, "queued");
    assert.match(row.last_error, /mail server/);
  } finally {
    cleanup();
  }
});

test("outbox: a message left 'sending' by a crash is picked up again", async () => {
  const { db, env, cleanup } = setup();
  try {
    const q = queueEmail(db, { kind: "test", to: [{ address: "a@client.example.test" }], subject: "Hi", text: "x" }, { now: t0, env });
    db.prepare("UPDATE email_outbox SET status = 'sending' WHERE id = ?").run(q.id);
    const tr = new MemoryTransport();
    assert.equal((await deliverDue(db, { now: plus(5), transport: tr, env })).sent, 0);
    assert.equal((await deliverDue(db, { now: plus(11), transport: tr, env })).sent, 1);
  } finally {
    cleanup();
  }
});

test("settings: environment wins, password never returned, encrypted at rest with a key", () => {
  const { db, cleanup } = setup();
  try {
    const env: Record<string, string> = { LAWDESK_SECRET_KEY: "test-key-not-real" };
    const changed = saveSettings(db, { transport: "smtp", host: "smtp.example.test", port: 587, security: "starttls", user: "office", password: "hunter2-pw", fromAddress: "office@firm.example.test" }, env);
    assert.ok(changed.includes("password changed"));
    assert.ok(!JSON.stringify(changed).includes("hunter2"));
    const stored = (db.prepare("SELECT value FROM email_settings WHERE key = 'smtp_password'").get() as any).value;
    assert.match(stored, /^enc1:/);
    assert.ok(!stored.includes("hunter2"));
    assert.equal(loadConfig(db, env).password, "hunter2-pw");
    const pub = publicSettings(db, env);
    assert.equal(pub.passwordSet, true);
    assert.ok(!JSON.stringify(pub).includes("hunter2"));
    assert.equal(pub.host, "smtp.example.test");
    // Environment overrides.
    const env2 = { ...env, LAWDESK_SMTP_HOST: "mail.env.test", LAWDESK_SMTP_PASSWORD: "from-env" };
    assert.equal(loadConfig(db, env2).host, "mail.env.test");
    assert.equal(loadConfig(db, env2).password, "from-env");
    assert.deepEqual(publicSettings(db, env2).fromEnvironment.sort(), ["host", "password"]);
    // Wrong key: a clear message, not garbage.
    assert.throws(() => loadConfig(db, { LAWDESK_SECRET_KEY: "other" }).password, /could not be read/);
    // Validation.
    assert.throws(() => saveSettings(db, { port: 70000 }, env), /Port/);
    assert.throws(() => saveSettings(db, { host: "smtp.example.test\r\nX" }, env), /line breaks/);
    assert.throws(() => saveSettings(db, { fromAddress: "nope" }, env), /valid email/);
    saveSettings(db, { clearPassword: true }, env);
    assert.equal(publicSettings(db, env).passwordSet, false);
  } finally {
    cleanup();
  }
});
