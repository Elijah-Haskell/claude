// The built-in signing flow: send, view, consent, sign, certificate, audit trail.
// All people and documents are made up.

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { setup as docSetup, PDF } from "../documents/helpers.ts";
import { ESign, requestMeta } from "../../src/esign/esign.ts";
import { CONSENT_VERSION, consentHash } from "../../src/esign/consent.ts";
import { encodePng } from "../../src/esign/png.ts";
import { esignProvider } from "../../src/esign/providers.ts";
import { routes } from "../../src/esign/routes.ts";
import { sha256 } from "../../src/documents/files.ts";

const BASE = "http://lawdesk.test";
const SIGNER = { ip: "203.0.113.7", userAgent: "Mozilla/5.0 (Test) Demo/1.0" };

function signaturePng(): string {
  const w = 40;
  const h = 12;
  const px = Buffer.alloc(w * h * 4);
  for (let x = 0; x < w; x++) px.set([20, 30, 60, 255], ((x % h) * w + x) * 4); // a diagonal stroke
  return "data:image/png;base64," + encodePng(w, h, px).toString("base64");
}

function setup() {
  const d = docSetup();
  let now = new Date("2026-11-18T16:00:00Z");
  const es = new ESign(d.db, { engine: d.engine, documents: d.docs, now: () => now });
  es.updateSettings({ contactEmail: "office@firm.example", contactPhone: "(785) 555-0100" }, d.atty);
  const doc = d.docs.upload({ matterId: d.matterId, filename: "Engagement letter.pdf", data: PDF, folder: "Engagement", userId: d.atty });
  return { ...d, es, doc, setNow: (iso: string) => (now = new Date(iso)) };
}

const tokenOf = (url: string) => new URL(url).searchParams.get("t")!;

test("send, open, consent, sign: the certificate is saved and the trail is complete", async (t) => {
  const c = setup();
  t.after(c.cleanup);
  const { url, request } = await c.es.send({ documentId: c.doc.id, signerName: "Pat Client", signerEmail: "pat@example.test", message: "Please sign." }, c.atty, BASE);
  assert.match(url, /^http:\/\/lawdesk\.test\/sign\.html\?t=[A-Za-z0-9_-]{32}$/);
  const token = tokenOf(url);
  assert.equal(request.status, "sent");
  assert.equal(request.doc_sha256, sha256(PDF));
  assert.equal(request.expires_at, "2026-12-02T16:00:00.000Z"); // 14 days by default
  assert.equal(JSON.stringify(c.db.prepare("SELECT * FROM esign_requests").all()).includes(token), false);

  const v = c.es.view(token, SIGNER);
  assert.equal(v.documentName, "Engagement letter.pdf");
  assert.equal(v.status, "sent");
  assert.equal(v.consentVersion, CONSENT_VERSION);
  assert.match(v.consentText, /paper copy to sign by hand, for no charge/);
  assert.match(v.consentText, /office@firm\.example or \(785\) 555-0100/);
  assert.match(v.consentText, /covers only this document/);

  // Consent needs the document opened first (it shows the signer can access it).
  assert.throws(() => c.es.consent(token, { agree: true, canAccess: true, consentVersion: CONSENT_VERSION }, SIGNER), /open the document first/);
  const file = c.es.document(token, SIGNER);
  assert.deepEqual(file.data, PDF);
  assert.equal(file.mime, "application/pdf");
  assert.throws(() => c.es.consent(token, { agree: true, canAccess: false, consentVersion: CONSENT_VERSION }, SIGNER), /Tick both/);
  assert.throws(() => c.es.consent(token, { agree: true, canAccess: true, consentVersion: "old" }, SIGNER), /changed/);
  assert.throws(() => c.es.sign(token, { typedName: "Pat Client", intent: true }, SIGNER), /Agree to sign electronically first/);
  c.setNow("2026-11-18T16:05:00Z");
  c.es.consent(token, { agree: true, canAccess: true, consentVersion: CONSENT_VERSION }, SIGNER);
  assert.throws(() => c.es.sign(token, { typedName: "Pat Client", intent: false }, SIGNER), /intend to sign/);
  assert.throws(() => c.es.sign(token, { typedName: " ", intent: true }, SIGNER), /required/);
  assert.throws(() => c.es.sign(token, { typedName: "Pat Client", intent: true, signaturePng: "data:image/jpeg;base64,AAAA" }, SIGNER), /PNG/);
  const blank = "data:image/png;base64," + encodePng(5, 5, Buffer.alloc(100)).toString("base64");
  assert.throws(() => c.es.sign(token, { typedName: "Pat Client", intent: true, signaturePng: blank }, SIGNER), /empty/);

  c.setNow("2026-11-18T16:06:00Z");
  const done = c.es.sign(token, { typedName: "Pat Q. Client", intent: true, signaturePng: signaturePng() }, SIGNER);
  assert.equal(done.status, "signed");

  const r = c.es.request(request.id);
  assert.equal(r.status, "signed");
  assert.equal(r.signature_kind, "drawn");
  assert.equal(r.typed_name, "Pat Q. Client");
  assert.equal(r.signed_doc_sha256, r.doc_sha256);
  assert.equal(r.consent_sha256, consentHash(r.consent_text));
  assert.equal(r.chain_intact, true);
  assert.deepEqual(
    r.events.map((e: any) => e.kind),
    ["sent", "opened", "document_viewed", "consented", "signed", "certificate_created"],
  );
  const signed = r.events.find((e: any) => e.kind === "signed");
  assert.equal(signed.ip, "203.0.113.7");
  assert.equal(signed.user_agent, "Mozilla/5.0 (Test) Demo/1.0");
  assert.equal(signed.at, "2026-11-18T16:06:00.000Z");

  // The certificate is a PDF in the same folder of the matter's documents.
  const cert = c.docs.get(r.certificate_document_id);
  assert.equal(cert.name, "Engagement letter - certificate of completion.pdf");
  assert.equal(cert.folder, "Engagement");
  assert.equal(cert.mime, "application/pdf");
  assert.deepEqual(cert.tags, ["e-signature"]);
  const certBytes = c.docs.download(cert.id).data.toString("latin1");
  assert.ok(certBytes.startsWith("%PDF-1.4"));
  assert.match(certBytes, /\/Subtype \/Image/);
  assert.equal(sha256(c.docs.download(cert.id).data), r.certificate_sha256);
  // The original document is not altered.
  assert.equal(c.docs.get(c.doc.id).version, 1);
  assert.equal(c.docs.get(c.doc.id).sha256, sha256(PDF));

  // The signer keeps copies; signing again is refused.
  const after = c.es.view(token, SIGNER);
  assert.equal(after.status, "signed");
  assert.equal(after.copiesAvailable, true);
  assert.equal(c.es.certificate(token).mime, "application/pdf");
  assert.throws(() => c.es.sign(token, { typedName: "Pat", intent: true }, SIGNER), /already been signed/);
  assert.ok(c.es.signatureImage(request.id)!.subarray(1, 4).toString() === "PNG");
  const acts = c.db.prepare("SELECT kind FROM activity WHERE kind LIKE 'esign_%' ORDER BY id").all().map((a: any) => a.kind);
  assert.deepEqual(acts, ["esign_settings", "esign_sent", "esign_viewed", "esign_signed"]);
  assert.equal(c.es.forMatter(c.matterId).length, 1);
});

test("typed-name signature, and the audit trail cannot be edited", async (t) => {
  const c = setup();
  t.after(c.cleanup);
  const { url, request } = await c.es.send({ documentId: c.doc.id, signerName: "Lee Signer" }, c.atty, BASE);
  const token = tokenOf(url);
  c.es.view(token, SIGNER);
  c.es.document(token, SIGNER);
  c.es.consent(token, { agree: true, canAccess: true, consentVersion: CONSENT_VERSION }, SIGNER);
  c.es.sign(token, { typedName: "Lee Signer", intent: true }, SIGNER);
  const r = c.es.request(request.id);
  assert.equal(r.signature_kind, "typed");
  assert.equal(r.signature_sha256, null);
  assert.throws(() => c.db.prepare("UPDATE esign_events SET ip = '1.1.1.1'").run(), /cannot be changed/);
  assert.throws(() => c.db.prepare("DELETE FROM esign_events").run(), /cannot be changed/);
});

test("a file changed after sending can't be signed", async (t) => {
  const c = setup();
  t.after(c.cleanup);
  const { url } = await c.es.send({ documentId: c.doc.id, signerName: "Pat" }, c.atty, BASE);
  const token = tokenOf(url);
  c.es.document(token, SIGNER);
  c.es.consent(token, { agree: true, canAccess: true, consentVersion: CONSENT_VERSION }, SIGNER);
  const h = sha256(PDF);
  writeFileSync(join(c.dir, h.slice(0, 2), h.slice(2, 4), h), Buffer.from("%PDF-1.4 tampered"));
  assert.throws(() => c.es.sign(token, { typedName: "Pat", intent: true }, SIGNER), /changed after it was sent/);
});

test("decline, cancel, expiry and resend", async (t) => {
  const c = setup();
  t.after(c.cleanup);
  const a = await c.es.send({ documentId: c.doc.id, signerName: "A" }, c.atty, BASE);
  c.es.decline(tokenOf(a.url), { reason: "Prefer paper" }, SIGNER);
  assert.equal(c.es.view(tokenOf(a.url), SIGNER).status, "declined");
  assert.throws(() => c.es.document(tokenOf(a.url), SIGNER), /on paper/);

  const b = await c.es.send({ documentId: c.doc.id, signerName: "B" }, c.atty, BASE);
  c.es.cancel(b.request.id, "Wrong version", c.atty);
  assert.throws(() => c.es.consent(tokenOf(b.url), { agree: true, canAccess: true, consentVersion: CONSENT_VERSION }, SIGNER), /withdrawn by the firm/);
  assert.throws(() => c.es.cancel(b.request.id, "", c.atty), /already cancelled/);

  const d = await c.es.send({ documentId: c.doc.id, signerName: "D", expiresDays: 1 }, c.atty, BASE);
  c.setNow("2026-11-19T16:00:01Z");
  assert.equal(c.es.view(tokenOf(d.url), SIGNER).status, "expired");
  assert.throws(() => c.es.document(tokenOf(d.url), SIGNER), /expired/);
  const again = c.es.resend(d.request.id, c.atty, BASE);
  assert.notEqual(tokenOf(again.url), tokenOf(d.url));
  assert.throws(() => c.es.view(tokenOf(d.url), SIGNER), /not valid/);
  assert.equal(c.es.view(tokenOf(again.url), SIGNER).status, "sent");

  assert.throws(() => c.es.view("x", SIGNER), /not valid/);
  await assert.rejects(c.es.send({ documentId: c.doc.id, signerName: "" }, c.atty, BASE), /required/);
  await assert.rejects(c.es.send({ documentId: c.doc.id, signerName: "E", signerEmail: "nope" }, c.atty, BASE), /email/);
  await assert.rejects(c.es.send({ documentId: c.doc.id, signerName: "E", expiresDays: 91 }, c.atty, BASE), /1 to 90/);
});

test("a newer version uploaded after sending is flagged, and the signer still gets the sent version", async (t) => {
  const c = setup();
  t.after(c.cleanup);
  const { url, request } = await c.es.send({ documentId: c.doc.id, signerName: "Pat" }, c.atty, BASE);
  const v2 = Buffer.from("%PDF-1.4\n% version two\n%%EOF\n");
  c.docs.addVersion(c.doc.id, { filename: "Engagement letter.pdf", data: v2, userId: c.atty });
  assert.equal(c.es.forMatter(c.matterId)[0].newer_version_exists, true);
  assert.deepEqual(c.es.document(tokenOf(url), SIGNER).data, PDF);
  assert.equal(c.es.request(request.id).version, 1);
});

test("providers: built-in works; DocuSign and Dropbox Sign are stubs that refuse", async () => {
  assert.deepEqual(await esignProvider("builtin").send({} as any), { externalId: null });
  await assert.rejects(esignProvider("docusign").send({} as any), /not connected/);
  await assert.rejects(esignProvider("dropboxsign").send({} as any), /not connected/);
  assert.throws(() => esignProvider("other"), /Unknown/);
});

test("routes: only the signer's routes are public", () => {
  const pub = routes.filter((r) => r.public).map((r) => r.path);
  assert.ok(pub.length === 6 && pub.every((p) => p.startsWith("/esign/public/")));
  assert.ok(routes.filter((r) => !r.public).every((r) => !r.path.startsWith("/esign/public/")));
});

test("request metadata: socket address unless told to trust a proxy", () => {
  const req = { headers: { "user-agent": "UA", "x-forwarded-for": "198.51.100.1, 10.0.0.1" }, socket: { remoteAddress: "127.0.0.1" } };
  assert.deepEqual(requestMeta(req, {}), { ip: "127.0.0.1", userAgent: "UA" });
  assert.deepEqual(requestMeta(req, { LAWDESK_TRUST_PROXY: "1" }), { ip: "198.51.100.1", userAgent: "UA" });
});
