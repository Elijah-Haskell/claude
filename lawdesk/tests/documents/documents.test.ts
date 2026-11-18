import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { Documents, decodeBase64 } from "../../src/documents/documents.ts";
import { MIME } from "../../src/documents/files.ts";
import { docxToText } from "../../src/documents/text.ts";
import { JPG, PDF, PNG, makeDocx, makeXlsx, p, setup } from "./helpers.ts";

const activity = (db: any, kind?: string) =>
  (db.prepare(`SELECT * FROM activity WHERE kind LIKE ? ORDER BY id`).all(kind ?? "%") as any[]).map((r) => ({ ...r, detail: JSON.parse(r.detail) }));

test("documents: upload stores the file content-addressed and logs who and when", () => {
  const s = setup();
  try {
    const d = s.docs.upload({
      matterId: s.matterId,
      filename: "Letter of intent.pdf",
      data: PDF,
      folder: "Correspondence/Outgoing",
      category: "Correspondence",
      tags: ["LOI", "signed", "loi"],
      userId: s.atty,
    });
    assert.equal(d.name, "Letter of intent.pdf");
    assert.equal(d.folder, "Correspondence/Outgoing");
    assert.equal(d.mime, MIME.pdf);
    assert.equal(d.version, 1);
    assert.equal(d.size, PDF.length);
    assert.deepEqual(d.tags, ["loi", "signed"], "tags are de-duplicated ignoring case");
    assert.equal(d.matterNumber, "2026-0042");
    assert.ok(s.docs.store.has(d.sha256!));
    const log = activity(s.db, "document_%");
    assert.equal(log.length, 1);
    assert.equal(log[0].kind, "document_uploaded");
    assert.equal(log[0].user_id, s.atty);
    assert.equal(log[0].matter_id, s.matterId);
    assert.equal(log[0].detail.documentId, d.id);
    // Same bytes on another matter are stored once
    s.docs.upload({ matterId: s.other, filename: "copy.pdf", data: PDF });
    const files = readdirSync(s.dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile());
    assert.equal(files.length, 1);
  } finally {
    s.cleanup();
  }
});

test("documents: uploads are validated (matter, name, size, type, empty, user)", () => {
  const s = setup({ maxBytes: 5000 });
  try {
    const up = (o: any) => s.docs.upload({ matterId: s.matterId, filename: "a.pdf", data: PDF, ...o });
    assert.throws(() => up({ matterId: 999 }), (e: any) => e.status === 404);
    assert.throws(() => up({ filename: "../../secret.pdf" }), (e: any) => e.status === 400);
    assert.throws(() => up({ filename: "evil/../x.pdf" }), (e: any) => e.status === 400);
    assert.throws(() => up({ folder: "../.." }), (e: any) => e.status === 400);
    assert.throws(() => up({ data: Buffer.alloc(5001, 65), filename: "big.txt" }), (e: any) => e.status === 413);
    assert.throws(() => up({ data: Buffer.alloc(0) }), /empty/);
    assert.throws(() => up({ data: Buffer.from("<script>alert(1)</script>"), filename: "invoice.pdf" }), (e: any) => e.status === 415);
    assert.throws(() => up({ data: PNG, filename: "photo.jpg" }), (e: any) => e.status === 415);
    assert.throws(() => up({ userId: 999 }), /User not found/);
    assert.throws(() => up({ tags: ["ok", "<bad>"] }), /Tag/);
    assert.throws(() => up({ onConflict: "overwrite" }), /onConflict/);
    // Nothing was stored or logged by the failures
    assert.equal(s.docs.list(s.matterId).documents.length, 0);
    assert.equal(activity(s.db, "document_%").length, 0);
    // Common types are recognised from their bytes
    assert.equal(up({ filename: "p.png", data: PNG }).mime, MIME.png);
    assert.equal(up({ filename: "j.jpg", data: JPG }).mime, MIME.jpg);
    assert.equal(up({ filename: "w.docx", data: makeDocx(p("hi")) }).mime, MIME.docx);
    assert.equal(up({ filename: "x.xlsx", data: makeXlsx() }).mime, MIME.xlsx);
  } finally {
    s.cleanup();
  }
});

test("documents: name conflicts error, become a version, or get renamed", () => {
  const s = setup();
  try {
    const first = s.docs.upload({ matterId: s.matterId, filename: "Notes.txt", data: Buffer.from("one") });
    assert.throws(() => s.docs.upload({ matterId: s.matterId, filename: "notes.TXT", data: Buffer.from("two") }), (e: any) => e.status === 409);
    // Same name in another folder is fine
    s.docs.upload({ matterId: s.matterId, filename: "Notes.txt", data: Buffer.from("other"), folder: "Drafts" });
    const v = s.docs.upload({ matterId: s.matterId, filename: "Notes.txt", data: Buffer.from("two"), onConflict: "version" });
    assert.equal(v.id, first.id);
    assert.equal(v.version, 2);
    const r = s.docs.upload({ matterId: s.matterId, filename: "Notes.txt", data: Buffer.from("three"), onConflict: "rename" });
    assert.equal(r.name, "Notes (2).txt");
    const r2 = s.docs.upload({ matterId: s.matterId, filename: "Notes.txt", data: Buffer.from("four"), onConflict: "rename" });
    assert.equal(r2.name, "Notes (3).txt");
  } finally {
    s.cleanup();
  }
});

test("documents: versions keep who/when/size/hash/filename; old versions can be downloaded and restored", () => {
  const s = setup();
  try {
    const d = s.docs.upload({ matterId: s.matterId, filename: "APA.txt", data: Buffer.from("draft one"), userId: s.para });
    s.docs.addVersion(d.id, { filename: "APA v2.txt", data: Buffer.from("draft two"), userId: s.atty });
    const vs = s.docs.versions(d.id);
    assert.deepEqual(
      vs.map((v: any) => [v.version, v.filename, v.uploadedByName, v.size]),
      [
        [2, "APA v2.txt", "Avery Attorney", 9],
        [1, "APA.txt", "Pat Paralegal", 9],
      ],
    );
    assert.ok(vs.every((v: any) => /^[0-9a-f]{64}$/.test(v.sha256) && v.uploadedAt));
    assert.equal(s.docs.download(d.id).data.toString(), "draft two");
    const old = s.docs.download(d.id, { version: 1 });
    assert.equal(old.data.toString(), "draft one");
    assert.equal(old.filename, "APA (version 1).txt");
    assert.throws(() => s.docs.download(d.id, { version: 9 }), (e: any) => e.status === 404);

    const restored = s.docs.restoreVersion(d.id, 1, s.atty);
    assert.equal(restored.version, 3);
    assert.equal(s.docs.download(d.id).data.toString(), "draft one");
    const v3 = s.docs.versions(d.id)[0];
    assert.equal(v3.restoredFrom, 1);
    assert.equal(v3.note, "Restored from version 1");
    assert.equal(s.docs.versions(d.id).length, 3, "nothing was lost");
    assert.throws(() => s.docs.restoreVersion(d.id, 3), (e: any) => e.status === 409);
    assert.throws(() => s.docs.restoreVersion(d.id, 7), (e: any) => e.status === 404);
    const kinds = activity(s.db, "document_%").map((a) => a.kind);
    assert.deepEqual(kinds, [
      "document_uploaded",
      "document_version_added",
      "document_downloaded",
      "document_downloaded",
      "document_version_restored",
      "document_downloaded",
    ]);
  } finally {
    s.cleanup();
  }
});

test("documents: a new version with a different type follows its extension", () => {
  const s = setup();
  try {
    const d = s.docs.upload({ matterId: s.matterId, filename: "Deed.docx", data: makeDocx(p("deed draft")) });
    const v = s.docs.addVersion(d.id, { filename: "Deed (signed scan).pdf", data: PDF });
    assert.equal(v.name, "Deed.pdf");
    assert.equal(v.mime, MIME.pdf);
    assert.throws(() => s.docs.addVersion(d.id, { filename: "x.pdf", data: Buffer.from("not a pdf") }), (e: any) => e.status === 415);
    const back = s.docs.restoreVersion(d.id, 1);
    assert.equal(back.name, "Deed.docx");
    assert.equal(back.mime, MIME.docx);
  } finally {
    s.cleanup();
  }
});

test("documents: rename, move, categorise and tag, with the changes logged", () => {
  const s = setup();
  try {
    const d = s.docs.upload({ matterId: s.matterId, filename: "scan.pdf", data: PDF, tags: ["inbox"] });
    s.docs.upload({ matterId: s.matterId, filename: "Taken.pdf", data: PDF, folder: "Closing" });
    const u = s.docs.update(d.id, { name: "Title commitment.pdf", folder: "Title", category: "Title work", tags: ["title", "Review"] }, s.para);
    assert.equal(u.name, "Title commitment.pdf");
    assert.equal(u.folder, "Title");
    assert.equal(u.category, "Title work");
    assert.deepEqual(u.tags, ["Review", "title"]);
    const log = activity(s.db, "document_updated");
    assert.equal(log.length, 1);
    assert.deepEqual(log[0].detail.name, { from: "scan.pdf", to: "Title commitment.pdf" });
    assert.deepEqual(log[0].detail.tags, { from: ["inbox"], to: ["title", "Review"] });
    assert.throws(() => s.docs.update(d.id, { name: "Taken.pdf", folder: "Closing" }), (e: any) => e.status === 409);
    assert.throws(() => s.docs.update(d.id, { name: "now-a.docx" }), (e: any) => e.status === 415, "rename must keep the type honest");
    assert.throws(() => s.docs.update(d.id, { name: "../x.pdf" }), (e: any) => e.status === 400);
    s.docs.update(d.id, { category: "Title work" });
    assert.equal(activity(s.db, "document_updated").length, 1, "no-op updates are not logged");
    const list = s.docs.list(s.matterId);
    assert.deepEqual(list.folders, ["Closing", "Title"]);
    assert.deepEqual(s.docs.list(s.matterId, { folder: "Title" }).documents.map((x: any) => x.name), ["Title commitment.pdf"]);
  } finally {
    s.cleanup();
  }
});

test("documents: soft delete hides a document; restore brings it back (renamed if its name was reused)", () => {
  const s = setup();
  try {
    const d = s.docs.upload({ matterId: s.matterId, filename: "Memo.txt", data: Buffer.from("privileged memo text") });
    s.docs.delete(d.id, s.atty);
    assert.equal(s.docs.list(s.matterId).documents.length, 0);
    assert.equal(s.docs.list(s.matterId, { deleted: "only" }).documents.length, 1);
    assert.equal(s.docs.search({ q: "privileged" }).results.length, 0);
    assert.equal(s.docs.search({ q: "privileged", includeDeleted: true }).results.length, 1);
    assert.throws(() => s.docs.download(d.id), (e: any) => e.status === 409);
    assert.throws(() => s.docs.addVersion(d.id, { filename: "Memo.txt", data: Buffer.from("x") }), (e: any) => e.status === 409);
    assert.throws(() => s.docs.delete(d.id), (e: any) => e.status === 409);
    // The name is free again while it is in the trash
    s.docs.upload({ matterId: s.matterId, filename: "Memo.txt", data: Buffer.from("new memo") });
    const r = s.docs.restore(d.id, s.atty);
    assert.equal(r.name, "Memo (2).txt");
    assert.equal(r.deletedAt, null);
    assert.equal(s.docs.search({ q: "privileged" }).results.length, 1);
    assert.throws(() => s.docs.restore(d.id), (e: any) => e.status === 409);
    const log = activity(s.db, "document_restored");
    assert.equal(log[0].detail.renamedFrom, "Memo.txt");
    assert.equal(activity(s.db, "document_deleted")[0].user_id, s.atty);
    // Files are never removed by a delete
    assert.ok(s.docs.store.has(r.sha256!));
  } finally {
    s.cleanup();
  }
});

function searchFixture(docs: Documents, matterId: number, other: number) {
  docs.upload({
    matterId,
    filename: "Asset Purchase Agreement.docx",
    data: makeDocx(p("The Seller shall convey the warehouse equipment.") + p("Indemnification survives closing.")),
    category: "Agreements",
    tags: ["draft"],
  });
  docs.upload({ matterId, filename: "Closing checklist.md", data: Buffer.from("# Closing\n- wire instructions\n- bill of sale"), folder: "Closing" });
  docs.upload({ matterId, filename: "Email.html", data: Buffer.from("<p>Please review the <b>escrow</b> terms.</p><script>secretword()</script>"), folder: "Closing/Email" });
  docs.upload({ matterId: other, filename: "Will.txt", data: Buffer.from("Last will and testament. The warehouse goes to my niece."), tags: ["estate"] });
  docs.upload({ matterId, filename: "Photo.png", data: PNG, tags: ["exhibit"], category: "Evidence" });
}

for (const fts of [true, false]) {
  test(`documents: search by text, name, tag, category, folder and matter (${fts ? "FTS5" : "LIKE fallback"})`, () => {
    const s = setup({ fts });
    try {
      assert.equal(s.docs.ftsAvailable, fts);
      searchFixture(s.docs, s.matterId, s.other);
      const names = (q: any) => s.docs.search(q).results.map((r: any) => r.name).sort();
      assert.deepEqual(names({ q: "warehouse" }), ["Asset Purchase Agreement.docx", "Will.txt"]);
      assert.deepEqual(names({ q: "warehouse", matterId: s.matterId }), ["Asset Purchase Agreement.docx"]);
      assert.deepEqual(names({ q: "indemnif" }), ["Asset Purchase Agreement.docx"], "prefix match");
      assert.deepEqual(names({ q: "escrow" }), ["Email.html"]);
      assert.deepEqual(names({ q: "secretword" }), [], "script contents are not indexed");
      assert.deepEqual(names({ q: "wire instructions" }), ["Closing checklist.md"]);
      assert.deepEqual(names({ q: "wire nonexistentword" }), [], "every word must match");
      assert.deepEqual(names({ q: "purchase" }), ["Asset Purchase Agreement.docx"], "names are searched");
      assert.deepEqual(names({ q: "exhibit" }), ["Photo.png"], "tags are searched");
      assert.deepEqual(names({ tag: "DRAFT" }), ["Asset Purchase Agreement.docx"]);
      assert.deepEqual(names({ category: "evidence" }), ["Photo.png"]);
      assert.deepEqual(names({ folder: "Closing" }), ["Closing checklist.md", "Email.html"], "folder includes subfolders");
      assert.deepEqual(names({ name: "check" }), ["Closing checklist.md"]);
      assert.deepEqual(names({ name: "100%_" }), [], "LIKE wildcards are escaped");
      assert.deepEqual(names({ matterId: s.other }), ["Will.txt"]);
      assert.deepEqual(names({ q: "\"' OR 1=1 --" }), [], "punctuation-only input is harmless");
      assert.deepEqual(names({ q: 'NEAR("a" "b")' }), [], "FTS syntax in input is treated as words");
      if (fts) {
        assert.deepEqual(names({ q: '"survives closing"' }), ["Asset Purchase Agreement.docx"], "quoted phrase");
        assert.deepEqual(names({ q: '"closing survives"' }), [], "phrase order matters");
        const hit = s.docs.search({ q: "indemnification" }).results[0];
        assert.match(hit.snippet!, /\[Indemnification\]/);
      }
      // A new version replaces the indexed text; a rename updates the indexed name
      const apa = s.docs.search({ q: "warehouse", matterId: s.matterId }).results[0];
      s.docs.addVersion(apa.id, { filename: "APA.docx", data: makeDocx(p("Seller conveys the inventory.")) });
      assert.deepEqual(names({ q: "warehouse" }), ["Will.txt"]);
      assert.deepEqual(names({ q: "inventory" }), ["Asset Purchase Agreement.docx"]);
      s.docs.update(apa.id, { name: "Final APA.docx" });
      assert.deepEqual(names({ q: "final" }), ["Final APA.docx"]);
    } finally {
      s.cleanup();
    }
  });
}

test("documents: decodeBase64 checks the size before decoding and rejects junk", () => {
  assert.equal(decodeBase64(Buffer.from("hello").toString("base64"), 100).toString(), "hello");
  assert.equal(decodeBase64("aGVs\nbG8=", 100).toString(), "hello", "line breaks are allowed");
  assert.throws(() => decodeBase64("not base64!!", 100), /not valid base64/);
  assert.throws(() => decodeBase64(undefined, 100), /required/);
  assert.throws(() => decodeBase64("A".repeat(2000), 100), (e: any) => e.status === 413);
});

test("templates: create, list, update, delete and restore; bad templates are refused", () => {
  const s = setup();
  try {
    const t = s.docs.createTemplate(
      { name: "Engagement letter", filename: "engagement.docx", data: makeDocx(p("Dear {{client.name}}, re {{matter.number}}")), category: "Letters" },
      s.atty,
    );
    assert.equal(t.kind, "docx");
    assert.deepEqual(t.fields, ["client.name", "matter.number"]);
    const t2 = s.docs.createTemplate({ name: "Cover email", filename: "cover.html", data: Buffer.from("<p>{{client.name}}</p>") });
    assert.equal(t2.kind, "html");
    assert.equal(s.docs.createTemplate({ name: "Notes", filename: "notes.md", data: Buffer.from("{{matter.name}}") }).kind, "txt");
    assert.deepEqual(s.docs.listTemplates().map((x: any) => x.name), ["Cover email", "Engagement letter", "Notes"]);
    assert.deepEqual(s.docs.listTemplates({ category: "letters" }).map((x: any) => x.name), ["Engagement letter"]);

    assert.throws(() => s.docs.createTemplate({ name: "Bad", filename: "bad.txt", data: Buffer.from("{{#if x}}open") }), /never closed/);
    assert.throws(() => s.docs.createTemplate({ name: "Pdf", filename: "form.pdf", data: PDF }), (e: any) => e.status === 415);
    assert.throws(() => s.docs.createTemplate({ name: "", filename: "a.txt", data: Buffer.from("x") }), /needs a name/);
    assert.throws(() => s.docs.createTemplate({ name: "Fake", filename: "fake.docx", data: Buffer.from("text") }), (e: any) => e.status === 415);

    const u = s.docs.updateTemplate(t.id, { name: "Engagement letter (flat fee)", data: makeDocx(p("{{client.name}} {{custom.fee}}")) }, s.para);
    assert.equal(u.name, "Engagement letter (flat fee)");
    assert.deepEqual(u.fields, ["client.name", "custom.fee"]);
    assert.equal(u.updatedBy, s.para);
    assert.match(docxToText(s.docs.downloadTemplate(t.id).data), /custom\.fee/);
    assert.throws(() => s.docs.updateTemplate(t.id, { filename: "x.docx" }), /contents/);

    s.docs.deleteTemplate(t.id, s.atty);
    assert.equal(s.docs.listTemplates().length, 2);
    assert.throws(() => s.docs.getTemplate(t.id), (e: any) => e.status === 404);
    assert.throws(() => s.docs.generate({ templateId: t.id, matterId: s.matterId }), (e: any) => e.status === 404);
    s.docs.restoreTemplate(t.id);
    assert.equal(s.docs.listTemplates().length, 3);
    assert.deepEqual(
      activity(s.db, "template_%").map((a) => a.kind),
      ["template_created", "template_created", "template_created", "template_updated", "template_deleted", "template_restored"],
    );
  } finally {
    s.cleanup();
  }
});

test("assembly: merge data comes from the matter, its client, dates, roles and the user", () => {
  const s = setup();
  try {
    const m = s.docs.mergeData(s.matterId, s.para, { fee: 1500, nested: { a: "b" }, flag: true });
    assert.equal(m.today, "November 18, 2026");
    assert.equal(m.today_iso, "2026-11-18");
    assert.deepEqual(m.user, { name: "Pat Paralegal", email: null });
    assert.equal((m.client as any).name, "Smith & Sons <Holdings>");
    assert.equal((m.matter as any).number, "2026-0042");
    assert.deepEqual((m.matter as any).dates, { closing_date: "2026-12-15", filing_date: null });
    assert.deepEqual((m.matter as any).roles, { attorney: "Avery Attorney", paralegal: "Pat Paralegal" });
    assert.deepEqual(m.custom, { fee: 1500, nested: { a: "b" }, flag: "yes" });
    assert.throws(() => s.docs.mergeData(s.matterId, null, { "bad key": "x" }), /custom field name/);
    assert.throws(() => s.docs.mergeData(s.matterId, null, { list: [1, 2] } as any), /must be text/);
    assert.throws(() => s.docs.mergeData(999), (e: any) => e.status === 404);
    const bare = s.docs.mergeData(s.other);
    assert.deepEqual(bare.client, { name: null, email: null, phone: null, kind: null });
  } finally {
    s.cleanup();
  }
});

test("assembly: generate a docx from a template and save it on the matter", () => {
  const s = setup();
  try {
    const body =
      `<w:p><w:r><w:t xml:space="preserve">Dear {{cli</w:t></w:r><w:proofErr w:type="spellStart"/><w:r><w:t>ent.name}},</w:t></w:r></w:p>` +
      p("Closing is set for {{matter.dates.closing_date|long}}.") +
      p("{{#if custom.fee}}") +
      p("Flat fee: ${{custom.fee}}") +
      p("{{/if}}") +
      p("{{user.name}}, {{today}}");
    const t = s.docs.createTemplate({ name: "Engagement letter", filename: "engagement.docx", data: makeDocx(body), category: "Letters" }, s.atty);
    const g = s.docs.generate({ templateId: t.id, matterId: s.matterId, userId: s.atty, custom: { fee: "1,500" }, folder: "Generated", tags: ["engagement"] });
    assert.deepEqual(g.unknown, []);
    assert.deepEqual(g.empty, []);
    assert.equal(g.document.name, "Engagement letter - 2026-0042.docx");
    assert.equal(g.document.category, "Letters", "category defaults to the template's");
    assert.equal(g.document.templateId, t.id);
    assert.equal(g.document.mime, MIME.docx);
    const file = s.docs.download(g.document.id);
    assert.equal(
      docxToText(file.data),
      "Dear Smith & Sons <Holdings>,\nClosing is set for December 15, 2026.\nFlat fee: $1,500\nAvery Attorney, November 18, 2026",
    );
    assert.equal(s.docs.versions(g.document.id)[0].note, 'Generated from template "Engagement letter"');
    // Generating again does not overwrite: it gets a new name
    const again = s.docs.generate({ templateId: t.id, matterId: s.matterId, folder: "Generated" });
    assert.equal(again.document.name, "Engagement letter - 2026-0042 (2).docx");
    // Generated documents are searchable
    assert.deepEqual(s.docs.search({ q: "flat fee", matterId: s.matterId }).results.map((r: any) => r.id), [g.document.id]);
    const log = activity(s.db, "document_generated");
    assert.equal(log.length, 2);
    assert.equal(log[0].detail.templateId, t.id);
    assert.deepEqual(log[1].detail.empty, ["user.name"]);
    assert.deepEqual(log[1].detail.unknown, ["custom.fee"], "custom values not supplied this time");
  } finally {
    s.cleanup();
  }
});

test("assembly: generate from .txt and .html templates; strict mode and file names", () => {
  const s = setup();
  try {
    const txt = s.docs.createTemplate({ name: "File memo", filename: "memo.txt", data: Buffer.from("Matter {{matter.number}}\n{{#if client.phone}}\nPhone {{client.phone}}\n{{/if}}\nClient {{client.name}}\n{{oops}}") });
    const g = s.docs.generate({ templateId: txt.id, matterId: s.matterId, filename: "Memo to file.txt" });
    assert.equal(s.docs.download(g.document.id).data.toString(), "Matter 2026-0042\nClient Smith & Sons <Holdings>\n");
    assert.deepEqual(g.unknown, ["oops"]);
    assert.equal(g.document.name, "Memo to file.txt");
    assert.throws(() => s.docs.generate({ templateId: txt.id, matterId: s.matterId, strict: true }), /do not exist: oops/);
    assert.throws(() => s.docs.generate({ templateId: txt.id, matterId: s.matterId, filename: "memo.pdf" }), /must end in \.txt/);
    assert.throws(() => s.docs.generate({ templateId: txt.id, matterId: s.matterId, filename: "../memo.txt" }), (e: any) => e.status === 400);

    const html = s.docs.createTemplate({ name: "Cover: email/letter", filename: "cover.html", data: Buffer.from("<p>Hello {{client.name}}</p>") });
    const h = s.docs.generate({ templateId: html.id, matterId: s.other });
    assert.equal(h.document.name, "Cover- email-letter - 2026-0043.html", "unsafe characters in the template name are replaced");
    assert.equal(s.docs.download(h.document.id).data.toString(), "<p>Hello </p>");
    assert.deepEqual(h.empty, ["client.name"]);
  } finally {
    s.cleanup();
  }
});
