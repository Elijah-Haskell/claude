import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BlobStore, MIME, checkFilename, checkFolder, checkTypeMatchesName, detectMime, sha256 } from "../../src/documents/files.ts";
import { extractText, htmlToText, wordXmlToText } from "../../src/documents/text.ts";
import { writeZip } from "../../src/documents/zip.ts";
import { JPG, PDF, PNG, makeDocx, makeXlsx, p, tempDir } from "./helpers.ts";

test("files: file names that could act as paths or break Windows are refused", () => {
  assert.equal(checkFilename("Engagement letter (signed).pdf"), "Engagement letter (signed).pdf");
  assert.equal(checkFilename("Résumé.docx"), "Résumé.docx");
  assert.equal(checkFilename("Café.txt"), "Café.txt"); // normalised to NFC
  for (const bad of [
    "",
    "   ",
    "../etc/passwd",
    "..",
    ".",
    "a/b.pdf",
    "a\\b.pdf",
    "C:evil.pdf",
    "nul\u0000.pdf",
    "line\nbreak.txt",
    "what?.pdf",
    "trailing.",
    " leading.pdf",
    "CON",
    "com1.txt",
    "x".repeat(201),
    42,
    null,
  ]) {
    assert.throws(() => checkFilename(bad as any), (e: any) => e.status === 400, `should refuse ${JSON.stringify(bad)}`);
  }
});

test("files: folder paths are normalised and checked segment by segment", () => {
  assert.equal(checkFolder(undefined), "");
  assert.equal(checkFolder(""), "");
  assert.equal(checkFolder("/Pleadings//Drafts/"), "Pleadings/Drafts");
  assert.throws(() => checkFolder("Pleadings/../../etc"));
  assert.throws(() => checkFolder("a\\b"));
  assert.throws(() => checkFolder("1/2/3/4/5/6/7/8/9/10/11"));
});

test("files: type comes from the bytes, not the extension", () => {
  assert.equal(detectMime(PDF, "x.pdf"), MIME.pdf);
  assert.equal(detectMime(PDF, "x.txt"), MIME.pdf);
  assert.equal(detectMime(PNG, "x.png"), MIME.png);
  assert.equal(detectMime(JPG, "photo.jpeg"), MIME.jpg);
  assert.equal(detectMime(makeDocx(p("hi")), "letter.docx"), MIME.docx);
  assert.equal(detectMime(makeDocx(p("hi")), "letter.zip"), MIME.docx);
  assert.equal(detectMime(makeXlsx(), "book.xlsx"), MIME.xlsx);
  assert.equal(detectMime(writeZip([{ name: "a.txt", data: Buffer.from("a") }]), "bundle.zip"), MIME.zip);
  assert.equal(detectMime(Buffer.from("plain words"), "notes.txt"), MIME.txt);
  assert.equal(detectMime(Buffer.from("# Heading"), "notes.md"), MIME.md);
  assert.equal(detectMime(Buffer.from("<p>hi</p>"), "page.html"), MIME.html);
  assert.equal(detectMime(Buffer.from("no extension"), "README"), MIME.txt);
  assert.equal(detectMime(Buffer.from([0, 1, 2, 3, 0xff]), "blob.dat"), MIME.bin);
  assert.equal(detectMime(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0]), "old.doc"), MIME.doc);
  // UTF-8 text whose 64 KB sample ends mid-character is still text
  assert.equal(detectMime(Buffer.from("é".repeat(40_000)), "long.txt"), MIME.txt);
});

test("files: a file whose contents do not match its extension is refused", () => {
  assert.throws(() => checkTypeMatchesName(MIME.html, "invoice.pdf"), (e: any) => e.status === 415);
  assert.throws(() => checkTypeMatchesName(MIME.bin, "letter.docx"), /do not match/);
  assert.throws(() => checkTypeMatchesName(MIME.zip, "letter.docx"), /do not match/);
  checkTypeMatchesName(MIME.pdf, "scan.pdf");
  checkTypeMatchesName(MIME.docx, "letter.docx");
  checkTypeMatchesName(MIME.bin, "something.custom"); // unknown extensions are allowed
});

test("files: blob store is content-addressed, deduplicates and detects tampering", () => {
  const { dir, cleanup } = tempDir();
  try {
    const store = new BlobStore(dir);
    const data = Buffer.from("Purchase agreement draft");
    const h = store.put(data);
    assert.equal(h, sha256(data));
    const path = join(dir, h.slice(0, 2), h.slice(2, 4), h);
    assert.ok(existsSync(path));
    assert.equal(store.put(Buffer.from("Purchase agreement draft")), h);
    assert.deepEqual(readdirSync(join(dir, h.slice(0, 2), h.slice(2, 4))), [h], "no temp files left, stored once");
    assert.ok(store.get(h).equals(data));
    writeFileSync(path, "tampered");
    assert.throws(() => store.get(h), /damaged/);
    assert.throws(() => store.get("../../etc/passwd"), /Bad file hash/);
    assert.throws(() => store.get("0".repeat(64)), /missing/);
  } finally {
    cleanup();
  }
});

test("text: extraction from docx, html, markdown and plain text", () => {
  const docx = makeDocx(
    `<w:p><w:r><w:t>First</w:t></w:r><w:r><w:tab/><w:t>tabbed</w:t></w:r></w:p>` +
      `<w:p><w:r><w:t xml:space="preserve">Smith &amp; Sons </w:t></w:r><w:r><w:t>agreement</w:t></w:r></w:p>` +
      `<w:p><w:r><w:delText>deleted words</w:delText></w:r></w:p>`,
    [],
    { header: p("Confidential header") },
  );
  const t = extractText(docx, MIME.docx)!;
  assert.match(t, /First\ttabbed\nSmith & Sons agreement/);
  assert.match(t, /Confidential header/);
  assert.doesNotMatch(t, /deleted words/);
  assert.equal(
    htmlToText("<html><head><title>T</title><style>p{}</style></head><body><p>Hello&nbsp;<b>there</b></p><script>alert(1)</script><p>x &lt; y</p></body></html>"),
    "Hello there\nx < y".replace(" ", " "),
  );
  assert.equal(extractText(Buffer.from("﻿BOM text"), MIME.txt), "BOM text");
  assert.equal(extractText(Buffer.from("# Title"), MIME.md), "# Title");
  assert.equal(extractText(PDF, MIME.pdf), null);
  assert.equal(extractText(Buffer.from("PK broken"), MIME.docx), null, "never throws");
  assert.equal(wordXmlToText("<w:p><w:r><w:t>a</w:t></w:r><w:r><w:br/><w:t>b</w:t></w:r></w:p>"), "a\nb");
});
