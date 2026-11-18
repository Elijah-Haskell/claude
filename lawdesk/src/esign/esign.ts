// Built-in electronic signatures.
//
//   1. Staff send a matter document to a signer. Lawdesk records the exact version and its
//      SHA-256 and shows a private signing link once (only its hash is stored).
//   2. The signer opens the link, opens the document, reads the disclosure, agrees to sign
//      electronically (or asks for paper), types their name and optionally draws a
//      signature, and signs.
//   3. Lawdesk re-reads the file and checks its hash, records the signature, and saves a
//      Certificate of completion PDF to the matter's documents.
// Every step is written to an append-only, hash-chained audit trail with the time, IP
// address and browser. See docs/esign.md for the legal basis and its limits.

import { createHash, randomBytes } from "node:crypto";
import { type DB, tx } from "../db.ts";
import { type Engine, EngineError } from "../engine.ts";
import type { Documents } from "../documents/documents.ts";
import { sha256 } from "../documents/files.ts";
import { CONSENT_VERSION, consentHash, consentText } from "./consent.ts";
import { buildCertificate } from "./certificate.ts";
import { MAX_PNG_BYTES, decodePng, isBlank } from "./png.ts";
import { esignProvider } from "./providers.ts";
import { SCHEMA } from "./schema.ts";

type Row = Record<string, any>;

export interface Meta {
  ip: string | null;
  userAgent: string | null;
}

const NO_META: Meta = { ip: null, userAgent: null };
const TOKEN_RE = /^[A-Za-z0-9_-]{20,100}$/;
const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
/** How long after signing the signer can still download their copies. */
const COPY_DAYS = 90;

function bad(message: string, status = 400): never {
  throw new EngineError(message, status);
}

const hashToken = (t: string) => createHash("sha256").update(t, "utf8").digest("hex");

function clean(v: unknown, what: string, max: number, required = false): string | null {
  if (v == null || v === "") {
    if (required) bad(`${what} is required`);
    return null;
  }
  if (typeof v !== "string") bad(`${what} must be text`);
  const s = v.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim();
  if (!s && required) bad(`${what} is required`);
  if (s.length > max) bad(`${what} is too long`);
  return s || null;
}

export class ESign {
  readonly db: DB;
  private engine: Engine;
  private docs: Documents;
  private nowFn: () => Date;

  constructor(db: DB, opts: { engine: Engine; documents: Documents; now?: () => Date }) {
    this.db = db;
    db.exec(SCHEMA);
    this.engine = opts.engine;
    this.docs = opts.documents;
    this.nowFn = opts.now ?? (() => new Date());
  }

  private one(sql: string, ...p: any[]): Row | undefined {
    return this.db.prepare(sql).get(...p) as Row | undefined;
  }
  private all(sql: string, ...p: any[]): Row[] {
    return this.db.prepare(sql).all(...p) as Row[];
  }
  private run(sql: string, ...p: any[]): number {
    return Number(this.db.prepare(sql).run(...p).lastInsertRowid);
  }
  private nowIso() {
    return this.nowFn().toISOString();
  }

  // ---------------------------------------------------------------- settings

  settings(): Row {
    const s = this.one("SELECT * FROM esign_settings WHERE id = 1")!;
    return { contactEmail: s.contact_email, contactPhone: s.contact_phone, paperFeeCents: s.paper_copy_fee_cents, defaultDays: s.default_days, consentVersion: CONSENT_VERSION };
  }

  updateSettings(p: Record<string, unknown>, actor: number | null): Row {
    const s = this.one("SELECT * FROM esign_settings WHERE id = 1")!;
    let email = s.contact_email;
    let phone = s.contact_phone;
    let fee = s.paper_copy_fee_cents;
    let days = s.default_days;
    if (p.contactEmail !== undefined) {
      email = clean(p.contactEmail, "Contact email", 200);
      if (email && !EMAIL_RE.test(email)) bad("Contact email doesn't look like an email address");
    }
    if (p.contactPhone !== undefined) phone = clean(p.contactPhone, "Contact phone", 60);
    if (p.paperFeeCents !== undefined) {
      if (!Number.isSafeInteger(p.paperFeeCents) || (p.paperFeeCents as number) < 0) bad("Paper copy fee must be a whole number of cents");
      fee = p.paperFeeCents;
    }
    if (p.defaultDays !== undefined) {
      if (!Number.isInteger(p.defaultDays) || (p.defaultDays as number) < 1 || (p.defaultDays as number) > 90) bad("Links can last from 1 to 90 days");
      days = p.defaultDays;
    }
    this.run("UPDATE esign_settings SET contact_email = ?, contact_phone = ?, paper_copy_fee_cents = ?, default_days = ?, updated_at = ?, updated_by = ? WHERE id = 1", email, phone, fee, days, this.nowIso(), actor);
    this.engine.log("esign_settings", "Updated electronic signature settings", { userId: actor });
    return this.settings();
  }

  private firmName(): string {
    try {
      return (this.one("SELECT firm_name FROM billing_settings WHERE id = 1")?.firm_name as string) || "";
    } catch {
      return "";
    }
  }

  // --------------------------------------------------------------- audit trail

  private event(requestId: number, kind: string, meta: Meta, detail: Record<string, unknown> | null = null, userId: number | null = null) {
    const prev = this.one("SELECT hash FROM esign_events WHERE request_id = ? ORDER BY id DESC LIMIT 1", requestId)?.hash ?? "0".repeat(64);
    const at = this.nowIso();
    const ip = meta.ip ? meta.ip.slice(0, 100) : null;
    const ua = meta.userAgent ? meta.userAgent.slice(0, 500) : null;
    const d = detail ? JSON.stringify(detail) : null;
    const hash = createHash("sha256").update(JSON.stringify([prev, requestId, at, kind, ip, ua, userId, d]), "utf8").digest("hex");
    this.run("INSERT INTO esign_events (request_id, at, kind, ip, user_agent, user_id, detail, prev_hash, hash) VALUES (?,?,?,?,?,?,?,?,?)", requestId, at, kind, ip, ua, userId, d, prev, hash);
  }

  events(requestId: number): Row[] {
    return this.all("SELECT e.*, u.name AS user_name FROM esign_events e LEFT JOIN users u ON u.id = e.user_id WHERE request_id = ? ORDER BY e.id", requestId);
  }

  /** Recompute the hash chain. False if any row was altered, removed or reordered. */
  verifyChain(requestId: number): boolean {
    let prev = "0".repeat(64);
    for (const e of this.all("SELECT * FROM esign_events WHERE request_id = ? ORDER BY id", requestId)) {
      if (e.prev_hash !== prev) return false;
      const h = createHash("sha256").update(JSON.stringify([e.prev_hash, e.request_id, e.at, e.kind, e.ip, e.user_agent, e.user_id, e.detail]), "utf8").digest("hex");
      if (h !== e.hash) return false;
      prev = e.hash;
    }
    return true;
  }

  // ------------------------------------------------------------------ staff

  private row(id: number): Row {
    const r = this.one("SELECT * FROM esign_requests WHERE id = ?", id);
    if (!r) bad("Signature request not found", 404);
    return this.expireIfDue(r);
  }

  private expireIfDue(r: Row): Row {
    if ((r.status === "sent" || r.status === "viewed") && r.expires_at <= this.nowIso()) {
      this.run("UPDATE esign_requests SET status = 'expired' WHERE id = ?", r.id);
      return { ...r, status: "expired" };
    }
    return r;
  }

  private summary(r: Row): Row {
    const { token_hash, consent_text, ...rest } = r;
    const doc = this.one("SELECT current_version_id, deleted_at FROM doc_documents WHERE id = ?", r.document_id);
    return { ...rest, newer_version_exists: Boolean(doc && doc.current_version_id !== r.version_id), document_deleted: Boolean(doc?.deleted_at) };
  }

  request(id: number): Row {
    const r = this.row(id);
    return { ...this.summary(r), consent_text: r.consent_text, events: this.events(id).map(({ prev_hash, ...e }) => e), chain_intact: this.verifyChain(id) };
  }

  forMatter(matterId: number): Row[] {
    if (!this.one("SELECT 1 FROM matters WHERE id = ?", matterId)) bad("Matter not found", 404);
    return this.all("SELECT * FROM esign_requests WHERE matter_id = ? ORDER BY id DESC", matterId).map((r) => this.summary(this.expireIfDue(r)));
  }

  forDocument(documentId: number): Row[] {
    return this.all("SELECT * FROM esign_requests WHERE document_id = ? ORDER BY id DESC", documentId).map((r) => this.summary(this.expireIfDue(r)));
  }

  private signUrl(baseUrl: string, token: string) {
    return `${baseUrl}/sign.html?t=${token}`;
  }

  async send(
    input: { documentId: number; signerName: unknown; signerEmail?: unknown; message?: unknown; expiresDays?: unknown; provider?: string },
    actor: number | null,
    baseUrl: string,
  ) {
    const doc = this.docs.get(input.documentId);
    if (doc.deletedAt) bad("That document is in the trash", 409);
    const name = clean(input.signerName, "Signer's name", 200, true)!;
    const email = clean(input.signerEmail, "Signer's email", 200);
    if (email && !EMAIL_RE.test(email)) bad("Signer's email doesn't look like an email address");
    const message = clean(input.message, "Message", 2000);
    const s = this.settings();
    const days = input.expiresDays == null || input.expiresDays === "" ? s.defaultDays : Number(input.expiresDays);
    if (!Number.isInteger(days) || days < 1 || days > 90) bad("The link can last from 1 to 90 days");
    const v = this.one("SELECT * FROM doc_versions WHERE document_id = ? AND version = ?", doc.id, doc.version);
    if (!v) bad("That document has no file", 409);
    // Hash the bytes now rather than trusting the stored value.
    const bytes = this.docs.store.get(v.sha256);
    const hash = sha256(bytes);
    if (hash !== v.sha256) bad("The stored file does not match its recorded hash; it can't be sent for signature", 409);
    const provider = esignProvider(input.provider ?? "builtin");
    const token = randomBytes(24).toString("base64url");
    const expires = new Date(this.nowFn().getTime() + days * 86_400_000).toISOString();
    const id = tx(this.db, () => {
      const rid = this.run(
        `INSERT INTO esign_requests (matter_id, document_id, version_id, version, doc_name, doc_sha256, signer_name, signer_email, message, provider, token_hash, expires_at, created_at, created_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        doc.matterId,
        doc.id,
        v.id,
        v.version,
        doc.name,
        hash,
        name,
        email,
        message,
        provider.name,
        hashToken(token),
        expires,
        this.nowIso(),
        actor,
      );
      this.event(rid, "sent", NO_META, { document: doc.name, version: v.version, sha256: hash, signer: name, email, expires }, actor);
      this.engine.log("esign_sent", `Sent "${doc.name}" to ${name} for signature`, { userId: actor, matterId: doc.matterId });
      return rid;
    });
    const res = await provider.send({ requestId: id, documentName: doc.name, documentBytes: bytes, mime: v.mime, signer: { name, email }, message, expiresAt: expires });
    if (res.externalId) this.run("UPDATE esign_requests SET external_id = ? WHERE id = ?", res.externalId, id);
    return { url: this.signUrl(baseUrl, token), request: this.request(id) };
  }

  /** A fresh link (the old one stops working) with a new expiry. */
  resend(id: number, actor: number | null, baseUrl: string) {
    return tx(this.db, () => {
      const r = this.row(id);
      if (!["sent", "viewed", "expired"].includes(r.status)) bad(`This request is ${r.status}; send the document again instead`, 409);
      const token = randomBytes(24).toString("base64url");
      const days = this.settings().defaultDays;
      const expires = new Date(this.nowFn().getTime() + days * 86_400_000).toISOString();
      this.run("UPDATE esign_requests SET token_hash = ?, expires_at = ?, status = CASE status WHEN 'expired' THEN 'sent' ELSE status END WHERE id = ?", hashToken(token), expires, id);
      this.event(id, "resent", NO_META, { expires }, actor);
      this.engine.log("esign_resent", `Sent a new signing link for "${r.doc_name}" to ${r.signer_name}`, { userId: actor, matterId: r.matter_id });
      return { url: this.signUrl(baseUrl, token), request: this.request(id) };
    });
  }

  cancel(id: number, reason: unknown, actor: number | null) {
    return tx(this.db, () => {
      const r = this.row(id);
      if (!["sent", "viewed", "expired"].includes(r.status)) bad(`This request is already ${r.status}`, 409);
      const why = clean(reason, "Reason", 500);
      this.run("UPDATE esign_requests SET status = 'cancelled', closed_reason = ? WHERE id = ?", why, id);
      this.event(id, "cancelled", NO_META, { reason: why }, actor);
      this.engine.log("esign_cancelled", `Cancelled the signature request for "${r.doc_name}"${why ? `: ${why}` : ""}`, { userId: actor, matterId: r.matter_id });
      return this.request(id);
    });
  }

  signatureImage(id: number): Buffer | null {
    const r = this.row(id);
    return r.signature_sha256 ? this.docs.store.get(r.signature_sha256) : null;
  }

  // --------------------------------------------------------------- the signer

  private byToken(token: string): Row {
    if (typeof token !== "string" || !TOKEN_RE.test(token)) bad("This signing link is not valid", 404);
    const r = this.one("SELECT * FROM esign_requests WHERE token_hash = ?", hashToken(token));
    if (!r) bad("This signing link is not valid", 404);
    return this.expireIfDue(r);
  }

  private open(r: Row): void {
    if (r.status === "cancelled") bad("This signing request was withdrawn by the firm.", 410);
    if (r.status === "expired") bad("This signing link has expired. Please ask the firm for a new one.", 410);
    if (r.status === "declined") bad("You chose to sign on paper. The firm will be in touch.", 410);
    if (r.status === "signed") bad("This document has already been signed.", 409);
  }

  private consentFor(r: Row): string {
    const s = this.settings();
    return consentText({ firmName: this.firmName(), contactEmail: s.contactEmail, contactPhone: s.contactPhone, paperFeeCents: s.paperFeeCents, documentName: r.doc_name });
  }

  private copiesAvailable(r: Row): boolean {
    return r.status === "signed" && r.signed_at && Date.parse(r.signed_at) + COPY_DAYS * 86_400_000 > this.nowFn().getTime();
  }

  /** What the signing page shows. Logs that the page was opened. */
  view(token: string, meta: Meta) {
    const r = this.byToken(token);
    if (r.status === "sent" || r.status === "viewed") {
      tx(this.db, () => {
        this.event(r.id, "opened", meta);
        if (r.status === "sent") {
          this.run("UPDATE esign_requests SET status = 'viewed' WHERE id = ?", r.id);
          this.engine.log("esign_viewed", `${r.signer_name} opened the signing page for "${r.doc_name}"`, { matterId: r.matter_id });
        }
      });
    }
    const fresh = this.byToken(token);
    const text = this.one("SELECT body FROM doc_text WHERE document_id = ? AND version_id = ?", r.document_id, r.version_id)?.body ?? null;
    const viewed = Boolean(this.one("SELECT 1 FROM esign_events WHERE request_id = ? AND kind = 'document_viewed'", r.id));
    return {
      firmName: this.firmName() || "Your law firm",
      documentName: r.doc_name,
      signerName: r.signer_name,
      message: r.message,
      status: fresh.status === "viewed" ? "sent" : fresh.status,
      expiresAt: r.expires_at,
      consentText: fresh.status === "signed" ? fresh.consent_text : this.consentFor(r),
      consentVersion: CONSENT_VERSION,
      consented: Boolean(fresh.consent_at),
      documentViewed: viewed,
      previewText: text ? text.slice(0, 200_000) : null,
      signedAt: fresh.signed_at,
      copiesAvailable: this.copiesAvailable(fresh),
    };
  }

  /** The exact version that was sent. Logs that the signer opened it. */
  document(token: string, meta: Meta) {
    const r = this.byToken(token);
    if (!(r.status === "sent" || r.status === "viewed" || this.copiesAvailable(r))) this.open(r);
    const v = this.one("SELECT * FROM doc_versions WHERE id = ?", r.version_id);
    if (!v) bad("The document is no longer available", 410);
    const data = this.docs.store.get(v.sha256);
    if (r.status !== "signed") this.event(r.id, "document_viewed", meta, { sha256: sha256(data) });
    return { filename: r.doc_name, mime: v.mime, data };
  }

  certificate(token: string) {
    const r = this.byToken(token);
    if (!this.copiesAvailable(r) || !r.certificate_document_id) bad("The certificate is not available", 404);
    const f = this.docs.download(r.certificate_document_id, {});
    return { filename: f.filename, mime: f.mime, data: f.data };
  }

  /** "I'd rather sign on paper" / withdraw consent. */
  decline(token: string, input: { reason?: unknown }, meta: Meta) {
    const r = this.byToken(token);
    this.open(r);
    const why = clean(input.reason, "Reason", 1000);
    tx(this.db, () => {
      this.run("UPDATE esign_requests SET status = 'declined', closed_reason = ? WHERE id = ?", why, r.id);
      this.event(r.id, "declined", meta, { reason: why, consent_withdrawn: Boolean(r.consent_at) });
      this.engine.log("esign_declined", `${r.signer_name} asked to sign "${r.doc_name}" on paper instead${why ? `: ${why}` : ""}`, { matterId: r.matter_id });
    });
    return { status: "declined" };
  }

  consent(token: string, input: { agree?: unknown; canAccess?: unknown; consentVersion?: unknown }, meta: Meta) {
    const r = this.byToken(token);
    this.open(r);
    if (input.agree !== true || input.canAccess !== true) bad("Tick both boxes to agree to sign electronically, or choose to sign on paper");
    if (input.consentVersion !== CONSENT_VERSION) bad("The disclosure has changed since this page was loaded. Please reload the page.", 409);
    if (!this.one("SELECT 1 FROM esign_events WHERE request_id = ? AND kind = 'document_viewed'", r.id)) bad("Please open the document first, so you know you can read it", 409);
    const text = this.consentFor(r);
    const h = consentHash(text);
    tx(this.db, () => {
      this.run("UPDATE esign_requests SET consent_version = ?, consent_sha256 = ?, consent_text = ?, consent_at = ? WHERE id = ?", CONSENT_VERSION, h, text, this.nowIso(), r.id);
      this.event(r.id, "consented", meta, { consent_version: CONSENT_VERSION, consent_sha256: h });
    });
    return { consented: true };
  }

  sign(token: string, input: { typedName?: unknown; signaturePng?: unknown; intent?: unknown }, meta: Meta) {
    const r = this.byToken(token);
    this.open(r);
    if (!r.consent_at) bad("Agree to sign electronically first", 409);
    if (input.intent !== true) bad("Tick the box to confirm you intend to sign");
    const typed = clean(input.typedName, "Your name", 200, true)!;
    if (typed.length < 2) bad("Type your full name");
    let png: Buffer | null = null;
    if (input.signaturePng != null && input.signaturePng !== "") {
      if (typeof input.signaturePng !== "string") bad("The signature must be a PNG image");
      const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(input.signaturePng);
      if (!m || m[1].length > Math.ceil((MAX_PNG_BYTES * 4) / 3) + 4) bad("The signature must be a PNG image (at most 600 KB)");
      png = Buffer.from(m[1], "base64");
      const img = decodePng(png);
      if (isBlank(img)) bad("The signature box is empty. Draw your signature, or clear it to use your typed name.");
    }
    // Re-read the exact file sent and confirm it has not changed.
    const v = this.one("SELECT * FROM doc_versions WHERE id = ?", r.version_id);
    if (!v) bad("The document is no longer available", 410);
    let now = "";
    try {
      now = sha256(this.docs.store.get(v.sha256));
    } catch {
      now = "unreadable";
    }
    if (now !== r.doc_sha256) bad("The document changed after it was sent, so it can't be signed. Please contact the firm.", 409);

    const sigHash = png ? this.docs.store.put(png) : null;
    tx(this.db, () => {
      this.run(
        "UPDATE esign_requests SET status = 'signed', signed_at = ?, typed_name = ?, signature_kind = ?, signature_sha256 = ?, signed_doc_sha256 = ? WHERE id = ?",
        this.nowIso(),
        typed,
        png ? "drawn" : "typed",
        sigHash,
        now,
        r.id,
      );
      this.event(r.id, "signed", meta, { typed_name: typed, signature: png ? "drawn" : "typed", signature_sha256: sigHash, document_sha256: now });
      this.engine.log("esign_signed", `${r.signer_name} signed "${r.doc_name}" electronically`, { matterId: r.matter_id });
    });
    this.makeCertificate(r.id);
    return { status: "signed", signedAt: this.row(r.id).signed_at };
  }

  /** Build the certificate PDF and save it to the matter's documents, next to the signed document. */
  makeCertificate(id: number) {
    const r = this.row(id);
    if (r.status !== "signed") bad("Not signed yet", 409);
    const generatedAt = this.nowFn();
    this.event(id, "certificate_created", NO_META);
    const sig = r.signature_sha256 ? decodePng(this.docs.store.get(r.signature_sha256)) : null;
    const pdf = buildCertificate({ firmName: this.firmName(), request: this.row(id), events: this.events(id), signature: sig, chainIntact: this.verifyChain(id), generatedAt });
    const doc = this.one("SELECT folder FROM doc_documents WHERE id = ?", r.document_id);
    const base = r.doc_name.replace(/\.[A-Za-z0-9]{1,8}$/, "");
    const saved = this.docs.upload({
      matterId: r.matter_id,
      filename: `${base} - certificate of completion.pdf`.slice(0, 190),
      data: pdf,
      folder: doc?.folder ?? "",
      category: "Signature certificate",
      tags: ["e-signature"],
      onConflict: "rename",
      userId: null,
      note: `Certificate of completion for signature request ${id}`,
    });
    this.run("UPDATE esign_requests SET certificate_document_id = ?, certificate_sha256 = ? WHERE id = ?", saved.id, sha256(pdf), id);
    return saved;
  }
}

/** Client IP for the audit trail. Behind a reverse proxy set LAWDESK_TRUST_PROXY=1 to use X-Forwarded-For. */
export function requestMeta(req: { headers?: Record<string, any>; socket?: { remoteAddress?: string } } | undefined, env = process.env): Meta {
  if (!req) return NO_META;
  let ip = req.socket?.remoteAddress ?? null;
  if (env.LAWDESK_TRUST_PROXY === "1") {
    const xff = req.headers?.["x-forwarded-for"];
    const first = (Array.isArray(xff) ? xff[0] : xff)?.split(",")[0]?.trim();
    if (first) ip = first;
  }
  const ua = req.headers?.["user-agent"];
  return { ip, userAgent: typeof ua === "string" ? ua : null };
}
