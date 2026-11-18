import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { readdirSync } from "node:fs";
import { createServer } from "../../src/server.ts";
import { routes } from "../../src/email/routes.ts";
import { buildMessage } from "../../src/email/mime.ts";
import { setup } from "./helpers.ts";

test("routes: no two email routes collide", () => {
  const seen = new Set<string>();
  for (const r of routes) {
    const k = `${r.method} ${r.path.replace(/:[^/]+/g, ":")}`;
    assert.ok(!seen.has(k), k);
    seen.add(k);
  }
});

test("routes: settings, test email, prefs, compose, log, import and outbox over HTTP", async () => {
  const s = setup();
  const saved = { ...process.env };
  Object.assign(process.env, s.env);
  delete process.env.LAWDESK_SMTP_PASSWORD;
  delete process.env.LAWDESK_MAIL_TRANSPORT;
  const server = createServer(s.db, { today: () => "2026-11-18", log: () => {} });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, {
      method,
      headers: { "Content-Type": "application/json", "X-Lawdesk-User": String(s.avery) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, data: (await res.json()) as any };
  };
  try {
    let r = await call("GET", "/email/settings");
    assert.equal(r.data.transport, "dev");
    assert.equal(r.data.passwordSet, false);
    assert.ok(r.data.providers.gmail);

    r = await call("PUT", "/email/settings", { user: "office", password: "do-not-echo-123", appUrl: "https://lawdesk.example.test" });
    assert.equal(r.status, 200);
    assert.equal(r.data.passwordSet, true);
    assert.ok(!JSON.stringify(r.data).includes("do-not-echo-123"));
    const act = s.db.prepare("SELECT detail FROM activity WHERE kind = 'email_settings_changed'").get() as any;
    assert.match(act.detail, /password changed/);
    assert.ok(!act.detail.includes("do-not-echo"));

    r = await call("POST", "/email/settings/test", { to: "avery@firm.example.test" });
    assert.equal(r.data.ok, true);
    assert.equal(readdirSync(s.mailDir).length, 1);
    r = await call("POST", "/email/settings/test", { to: "nope" });
    assert.equal(r.status, 400);

    r = await call("PUT", `/email/prefs/${s.pat}`, { digest: false, digestTime: "09:15" });
    assert.equal(r.data.digest, false);
    assert.equal((await call("GET", `/email/prefs/${s.pat}`)).data.digestTime, "09:15");

    r = await call("GET", `/matters/${s.matterId}/communications`);
    assert.equal(r.data.recipients[0].isClient, true);
    assert.equal(r.data.templates.length, 2);

    r = await call("POST", `/matters/${s.matterId}/communications/preview`, { to: ["dana@client.example.test"], subject: "{{matter.number}}", body: "Hi {{client.name}}" });
    assert.equal(r.data.subject, "2026-0042");
    assert.equal(r.data.body, "Hi Dana Client (demo)");

    r = await call("POST", `/matters/${s.matterId}/communications/email`, { to: ["Dana <dana@client.example.test>"], subject: "Update", body: "Hello" });
    assert.equal(r.status, 200);
    r = await call("POST", `/matters/${s.matterId}/communications/email`, { to: ["Dana <dana@client.example.test>"], subject: "Update", body: "{{matter.description}}" });
    assert.equal(r.status, 422);

    r = await call("POST", `/matters/${s.matterId}/communications/log`, { kind: "meeting", participants: "Dana, Avery", durationMinutes: 45, notes: "Went over the schedule." });
    assert.equal(r.status, 200);
    const meetingId = r.data.id;

    const eml = buildMessage({ from: { address: "dana@client.example.test" }, to: [{ address: "avery@firm.example.test" }], subject: "Question", text: "Can we talk?" }).raw;
    r = await call("POST", `/matters/${s.matterId}/communications/import`, { filename: "q.eml", contentBase64: eml.toString("base64") });
    assert.equal(r.status, 200);
    assert.equal(r.data.subject, "Question");

    r = await call("GET", `/matters/${s.matterId}/communications`);
    assert.deepEqual(r.data.entries.map((e: any) => e.kind).sort(), ["email", "email", "meeting"]);

    assert.equal((await call("DELETE", `/communications/${meetingId}`)).status, 200);
    const emailId = r.data.entries.find((e: any) => e.kind === "email").id;
    assert.equal((await call("DELETE", `/communications/${emailId}`)).status, 409);

    r = await call("POST", "/email/outbox/run");
    assert.equal(r.data.sent, 1);
    r = await call("GET", "/email/outbox");
    assert.equal(r.data[0].status, "sent");
    assert.equal(r.data[0].matter_number, "2026-0042");
    assert.equal(r.data[0].raw, undefined);
  } finally {
    server.close();
    process.env = saved;
    s.cleanup();
  }
});
