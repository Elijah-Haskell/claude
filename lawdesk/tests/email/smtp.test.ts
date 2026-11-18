import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SmtpError, dotStuff, plainString, sendSmtp, xoauth2String } from "../../src/email/smtp.ts";
import { buildMessage } from "../../src/email/mime.ts";
import { parseMessage } from "../../src/email/parse.ts";
import { DevTransport, RefreshTokenProvider, SmtpTransport } from "../../src/email/transport.ts";
import { fakeSmtp, tempDir, testCert } from "./helpers.ts";

const msg = () =>
  buildMessage({
    from: { name: "Example Law Office", address: "office@firm.example.test" },
    to: [{ name: "Dana", address: "dana@client.example.test" }],
    cc: [{ address: "nobody@client.example.test" }],
    subject: "Test – ünïcode",
    text: "Line one\n.leading dot\n..two dots\nend",
  });

const cert = testCert();

test("smtp: SASL strings", () => {
  // Example from Google's XOAUTH2 documentation.
  assert.equal(
    Buffer.from(xoauth2String("someuser@example.com", "ya29.vF9dft4qmTc2Nvb3RlckBhdHRhdmlzdGEuY29tCg"), "base64").toString(),
    "user=someuser@example.com\x01auth=Bearer ya29.vF9dft4qmTc2Nvb3RlckBhdHRhdmlzdGEuY29tCg\x01\x01",
  );
  assert.equal(Buffer.from(plainString("u", "p"), "base64").toString(), "\0u\0p");
  assert.equal(dotStuff(Buffer.from(".a\r\nb\r\n..c")).toString(), "..a\r\nb\r\n...c\r\n.\r\n");
});

test("smtp: plain connection without sign-in delivers and dot-stuffs", async () => {
  const srv = await fakeSmtp();
  try {
    const m = msg();
    const r = await sendSmtp({ host: "127.0.0.1", port: srv.port, security: "none" }, m.envelope, m.raw);
    assert.match(r.response, /^250 /);
    assert.equal(srv.messages.length, 1);
    const got = srv.messages[0];
    assert.equal(got.from, "office@firm.example.test");
    assert.deepEqual(got.to, ["dana@client.example.test", "nobody@client.example.test"]);
    assert.equal(got.data, m.raw.toString("latin1"));
    assert.equal(parseMessage(Buffer.from(got.data, "latin1")).text, "Line one\n.leading dot\n..two dots\nend");
    assert.ok(srv.transcript.includes("QUIT"));
  } finally {
    await srv.close();
  }
});

test("smtp: some recipients refused, the rest delivered", async () => {
  const srv = await fakeSmtp({ rejectRcpt: ["nobody@client.example.test"] });
  try {
    const m = msg();
    const r = await sendSmtp({ host: "127.0.0.1", port: srv.port, security: "none" }, m.envelope, m.raw);
    assert.deepEqual(r.accepted, ["dana@client.example.test"]);
    assert.equal(r.rejected[0].address, "nobody@client.example.test");
    assert.match(r.rejected[0].reply, /^550/);
  } finally {
    await srv.close();
  }
});

test("smtp: every recipient refused is a permanent error", async () => {
  const srv = await fakeSmtp({ rejectRcpt: ["dana@client.example.test", "nobody@client.example.test"] });
  try {
    const m = msg();
    await assert.rejects(sendSmtp({ host: "127.0.0.1", port: srv.port, security: "none" }, m.envelope, m.raw), (e: any) => e instanceof SmtpError && e.code === 550 && e.permanent);
  } finally {
    await srv.close();
  }
});

test("smtp: a 4xx reply is temporary", async () => {
  const srv = await fakeSmtp({ dataReply: "451 4.3.0 Try again later" });
  try {
    const m = msg();
    await assert.rejects(sendSmtp({ host: "127.0.0.1", port: srv.port, security: "none" }, m.envelope, m.raw), (e: any) => e.code === 451 && !e.permanent);
  } finally {
    await srv.close();
  }
});

test("smtp: refuses to send a password unencrypted to a remote host", async () => {
  const m = msg();
  await assert.rejects(
    sendSmtp({ host: "192.0.2.1", port: 25, security: "none", auth: { user: "u", pass: "p" }, timeoutMs: 200 }, m.envelope, m.raw),
    /Could not connect|Timed out|unencrypted/,
  );
});

test("smtp: AUTH PLAIN and AUTH LOGIN (local, unencrypted allowed)", async () => {
  for (const method of ["plain", "login"] as const) {
    const srv = await fakeSmtp({ user: "office", pass: "s3cret pass" });
    try {
      const m = msg();
      await sendSmtp({ host: "127.0.0.1", port: srv.port, security: "none", auth: { user: "office", pass: "s3cret pass", method } }, m.envelope, m.raw);
      assert.equal(srv.messages[0].auth, method.toUpperCase());
    } finally {
      await srv.close();
    }
  }
});

test("smtp: wrong password is permanent and the error does not contain it", async () => {
  const srv = await fakeSmtp({ user: "office", pass: "right" });
  try {
    const m = msg();
    await assert.rejects(
      sendSmtp({ host: "127.0.0.1", port: srv.port, security: "none", auth: { user: "office", pass: "wrong-PASSWORD-xyz" } }, m.envelope, m.raw),
      (e: any) => e.code === 535 && e.permanent && !e.message.includes("wrong-PASSWORD-xyz") && !e.message.includes(plainString("office", "wrong-PASSWORD-xyz")),
    );
  } finally {
    await srv.close();
  }
});

test("smtp: STARTTLS required but not offered", async () => {
  const srv = await fakeSmtp({ starttls: false });
  try {
    const m = msg();
    await assert.rejects(sendSmtp({ host: "127.0.0.1", port: srv.port, security: "starttls" }, m.envelope, m.raw), /does not offer STARTTLS/);
    assert.equal(srv.messages.length, 0);
  } finally {
    await srv.close();
  }
});

test("smtp: STARTTLS upgrade, then AUTH, with certificate checking", { skip: !cert && "openssl not installed" }, async () => {
  const srv = await fakeSmtp({ starttls: true, cert, user: "office", pass: "pw" });
  try {
    const m = msg();
    await sendSmtp({ host: "127.0.0.1", port: srv.port, security: "starttls", auth: { user: "office", pass: "pw" }, tlsOptions: { ca: cert!.cert } }, m.envelope, m.raw);
    assert.equal(srv.messages[0].tls, true);
    assert.equal(srv.messages[0].auth, "PLAIN");
    // The password went over TLS: it never appears in what the server read before the upgrade.
    const beforeTls = srv.transcript.slice(0, srv.transcript.indexOf("STARTTLS") + 1);
    assert.ok(!beforeTls.some((l) => l.startsWith("AUTH")));
    // Without the test CA the certificate is rejected.
    await assert.rejects(sendSmtp({ host: "127.0.0.1", port: srv.port, security: "starttls" }, m.envelope, m.raw), /encrypted connection/);
  } finally {
    await srv.close();
  }
});

test("smtp: implicit TLS (port 465 style) with XOAUTH2", { skip: !cert && "openssl not installed" }, async () => {
  const srv = await fakeSmtp({ implicitTls: true, cert, user: "office@firm.example.test", token: "tok-123" });
  try {
    const m = msg();
    const t = new SmtpTransport(
      { host: "127.0.0.1", port: srv.port, security: "tls", auth: { user: "office@firm.example.test" }, tlsOptions: { ca: cert!.cert } },
      { name: "test", accessToken: async () => "tok-123" },
    );
    await t.send(m.envelope, m.raw);
    assert.equal(srv.messages[0].auth, "XOAUTH2");
    assert.equal(srv.messages[0].tls, true);
    // A bad token: the server's 334 challenge is answered with an empty line, then 535.
    const bad = new SmtpTransport(
      { host: "127.0.0.1", port: srv.port, security: "tls", auth: { user: "office@firm.example.test" }, tlsOptions: { ca: cert!.cert } },
      { name: "test", accessToken: async () => "expired" },
    );
    await assert.rejects(bad.send(m.envelope, m.raw), (e: any) => e.code === 535);
  } finally {
    await srv.close();
  }
});

test("smtp: connection refused and timeouts are temporary errors", async () => {
  const srv = await fakeSmtp();
  const port = srv.port;
  await srv.close();
  const m = msg();
  await assert.rejects(sendSmtp({ host: "127.0.0.1", port, security: "none" }, m.envelope, m.raw), (e: any) => e instanceof SmtpError && !e.permanent);
});

test("transport: dev transport writes .eml files", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const m = msg();
    const r = await new DevTransport(dir).send(m.envelope, m.raw);
    const files = readdirSync(dir);
    assert.equal(files.length, 1);
    assert.match(files[0], /\.eml$/);
    assert.match(r.response, /Saved to/);
    const p = parseMessage(readFileSync(join(dir, files[0])));
    assert.equal(p.subject, "Test – ünïcode");
  } finally {
    cleanup();
  }
});

test("transport: refresh-token provider caches the access token and hides secrets on error", async () => {
  let calls = 0;
  let lastBody = "";
  const srv = http.createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      calls++;
      lastBody = b;
      const f = new URLSearchParams(b);
      res.setHeader("Content-Type", "application/json");
      if (f.get("refresh_token") === "good") res.end(JSON.stringify({ access_token: "at-" + calls, expires_in: 3600 }));
      else {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: "invalid_grant" }));
      }
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/token`;
  try {
    const p = new RefreshTokenProvider({ name: "Google", tokenUrl: url, clientId: "cid", clientSecret: "csecret", refreshToken: "good", scope: "https://mail.google.com/" });
    assert.equal(await p.accessToken(), "at-1");
    assert.equal(await p.accessToken(), "at-1");
    assert.equal(calls, 1);
    assert.match(lastBody, /grant_type=refresh_token/);
    const bad = new RefreshTokenProvider({ name: "Google", tokenUrl: url, clientId: "cid", clientSecret: "csecret", refreshToken: "revoked-SECRET" });
    await assert.rejects(bad.accessToken(), (e: any) => /invalid_grant/.test(e.message) && !e.message.includes("SECRET") && !e.message.includes("csecret"));
  } finally {
    await new Promise<void>((r) => srv.close(() => r()));
  }
});
