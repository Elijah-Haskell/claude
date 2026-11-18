import { test } from "node:test";
import assert from "node:assert/strict";
import {
  deleteCommunication,
  emlName,
  getCommunication,
  importEml,
  listCommunications,
  listTemplates,
  logCommunication,
  mergeDraft,
  recipientsFor,
  saveTemplate,
  sendFromMatter,
} from "../../src/email/comms.ts";
import { buildMessage } from "../../src/email/mime.ts";
import { parseMessage } from "../../src/email/parse.ts";
import { deliverDue } from "../../src/email/outbox.ts";
import { MemoryTransport, setup } from "./helpers.ts";

const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");

test("comms: templates, merge fields and recipients", () => {
  const { db, docs, avery, matterId, cleanup } = setup();
  try {
    const t = listTemplates(db) as any[];
    assert.deepEqual(t.map((x) => x.name), ["Request for documents", "Status update"]);
    assert.equal((listTemplates(db) as any[]).length, 2, "starter templates are added once");
    const status = t.find((x) => x.name === "Status update");
    const m = mergeDraft(docs, matterId, avery, { subject: status.subject, body: status.body, recipient: { name: "Dana Client (demo)", address: "dana@client.example.test" } });
    assert.equal(m.subject, "Client asset purchase: status update");
    assert.match(m.body, /^Dear Dana Client \(demo\),/);
    assert.match(m.body, /Sincerely,\nAvery Attorney$/);
    assert.deepEqual(m.unknown, []);
    const bad = mergeDraft(docs, matterId, avery, { subject: "x", body: "{{clinet.name}} {{matter.dates.nope}}" });
    assert.deepEqual(bad.unknown.sort(), ["clinet.name", "matter.dates.nope"]);
    const r = recipientsFor(db, matterId);
    assert.equal(r[0].isClient, true);
    assert.equal(r[0].email, "dana@client.example.test");
    assert.equal(r.length, 2);
    assert.throws(() => saveTemplate(db, null, { name: "", subject: "s", body: "b" }), /name/);
  } finally {
    cleanup();
  }
});

test("comms: send from a matter queues, logs and attaches documents", async () => {
  const { db, engine, docs, avery, matterId, env, cleanup } = setup();
  try {
    const doc = docs.upload({ matterId, filename: "Purchase agreement.pdf", data: PDF, userId: avery }) as any;
    const r = sendFromMatter(
      db,
      engine,
      docs,
      {
        matterId,
        to: ["Dana Client <dana@client.example.test>"],
        cc: "pat@firm.example.test",
        subject: "{{matter.name}}: agreement",
        body: "Dear {{recipient.name}},\n\nAttached is the agreement for {{matter.number}}.\n\n{{user.name}}",
        documentIds: [doc.id],
        userId: avery,
      },
      { env },
    );
    const log = listCommunications(db, matterId);
    assert.equal(log.length, 1);
    assert.equal(log[0].direction, "out");
    assert.equal(log[0].subject, "Client asset purchase: agreement");
    assert.equal(log[0].send_status, "queued");
    assert.deepEqual(log[0].attachment_ids, [doc.id]);
    const full = getCommunication(db, r.id);
    assert.equal(full.body, "Dear Dana Client,\n\nAttached is the agreement for 2026-0042.\n\nAvery Attorney");
    assert.equal(full.attachments[0].name, "Purchase agreement.pdf");

    const tr = new MemoryTransport();
    await deliverDue(db, { transport: tr, env });
    const p = parseMessage(Buffer.from(tr.sent[0].raw));
    assert.equal(p.replyTo[0].address, "avery@firm.example.test");
    assert.equal(p.from[0].address, "office@firm.example.test");
    assert.ok(p.attachments[0].data.equals(PDF));
    assert.equal(listCommunications(db, matterId)[0].send_status, "sent");
    const act = db.prepare("SELECT detail FROM activity WHERE kind = 'email_sent'").get() as any;
    assert.match(act.detail, /Emailed Dana Client <dana@client\.example\.test>: "Client asset purchase: agreement" with 1 attachment/);

    // Unknown fields are refused; empty ones need confirming.
    assert.throws(() => sendFromMatter(db, engine, docs, { matterId, to: ["dana@client.example.test"], subject: "x", body: "{{nope}}", userId: avery }, { env }), /do not exist/);
    assert.throws(
      () => sendFromMatter(db, engine, docs, { matterId, to: ["dana@client.example.test"], subject: "x", body: "{{matter.description}}", userId: avery }, { env }),
      (e: any) => e.status === 422,
    );
    assert.throws(() => sendFromMatter(db, engine, docs, { matterId, to: ["not an address"], subject: "x", body: "y" }, { env }), /valid email/);
    assert.throws(() => sendFromMatter(db, engine, docs, { matterId, to: [], subject: "x", body: "y" }, { env }), /recipient/);
  } finally {
    cleanup();
  }
});

test("comms: phone calls and meetings, with removal", () => {
  const { db, engine, avery, matterId, cleanup } = setup();
  try {
    const { id } = logCommunication(db, engine, {
      matterId,
      kind: "phone",
      direction: "in",
      occurredAt: "2026-11-18T09:30:00-06:00",
      durationMinutes: 12,
      participants: "Dana Client",
      subject: "Questions about closing",
      notes: "Wants to move closing to December.",
      userId: avery,
    });
    const e = getCommunication(db, id);
    assert.equal(e.occurred_at, "2026-11-18T15:30:00.000Z");
    assert.equal(e.duration_minutes, 12);
    assert.match((db.prepare("SELECT detail FROM activity WHERE kind = 'communication_logged'").get() as any).detail, /phone call with Dana Client \(12 min\)/);
    assert.throws(() => logCommunication(db, engine, { matterId, kind: "phone" }), /who it was with/);
    assert.throws(() => logCommunication(db, engine, { matterId, kind: "meeting", participants: "x", durationMinutes: -1 }), /minutes/);
    assert.throws(() => logCommunication(db, engine, { matterId, kind: "fax" as any, participants: "x" }), /Kind/);
    deleteCommunication(db, engine, id, avery);
    assert.equal(listCommunications(db, matterId).length, 0);
  } finally {
    cleanup();
  }
});

test("comms: import a saved .eml with attachments into the matter", () => {
  const { db, engine, docs, avery, matterId, cleanup } = setup();
  try {
    const eml = buildMessage({
      from: { name: "Dana Client", address: "dana@client.example.test" },
      to: [{ name: "Avery Attorney", address: "avery@firm.example.test" }],
      subject: "Signed: purchase agreement / final?",
      text: "Here is the signed copy.",
      attachments: [
        { filename: "Signed agreement.pdf", contentType: "application/pdf", data: PDF },
        { filename: "fake.pdf", contentType: "application/pdf", data: Buffer.from("<html>not a pdf</html>") },
      ],
      date: new Date("2026-11-17T16:00:00Z"),
    }).raw;
    const r = importEml(db, engine, docs, { matterId, filename: "x.eml", data: eml, userId: avery });
    assert.equal(r.subject, "Signed: purchase agreement / final?");
    assert.deepEqual(r.attachments.map((a) => a.name), ["Signed agreement.pdf"]);
    assert.equal(r.skipped.length, 1);
    assert.match(r.skipped[0].reason, /do not match/);
    const list = docs.list(matterId).documents.map((d: any) => `${d.folder}/${d.name}`);
    assert.deepEqual(list.sort(), ["Correspondence/2026-11-17 Signed purchase agreement final.eml", "Correspondence/Signed agreement.pdf"]);
    const log = listCommunications(db, matterId);
    assert.equal(log[0].direction, "in");
    assert.equal(log[0].occurred_at, "2026-11-17T16:00:00.000Z");
    assert.equal(log[0].from_addr, "Dana Client <dana@client.example.test>");
    assert.equal(log[0].preview, "Here is the signed copy.");
    assert.throws(() => importEml(db, engine, docs, { matterId, data: eml, userId: avery }), (e: any) => e.status === 409);
    assert.throws(() => importEml(db, engine, docs, { matterId, data: Buffer.from("\x00\x01\x02 binary"), userId: avery }), /does not look like/);
    // A message sent by someone at the firm is filed as outgoing.
    const ours = buildMessage({ from: { address: "pat@firm.example.test" }, to: [{ address: "dana@client.example.test" }], subject: "From us", text: "x" }).raw;
    importEml(db, engine, docs, { matterId, data: ours, userId: avery });
    assert.equal(listCommunications(db, matterId).find((e: any) => e.subject === "From us")!.direction, "out");
  } finally {
    cleanup();
  }
});

test("comms: eml file names are safe", () => {
  assert.equal(emlName("2026-11-17T16:00:00Z", 'Re: "Draft" <v2> / final?.'), "2026-11-17 Re Draft v2 final.eml");
  assert.equal(emlName(null, "").endsWith(" Email.eml"), true);
});
