// Binary uploads and downloads over real HTTP, the multipart parser, folders, template checks
// and search highlights. All data is made up.

import { test } from "node:test";
import assert from "node:assert/strict";
import { authHeaders } from "../auth/http.ts";

// Every call goes out signed in (session cookie plus the X-Requested-With header writes need).
let auth: Record<string, string> = {};
const fetch = (url: string, init: RequestInit = {}) => globalThis.fetch(url, { ...init, headers: { ...auth, ...(init.headers as Record<string, string> | undefined) } });
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createServer } from "../../src/server.ts";
import { setDocuments } from "../../src/documents/routes.ts";
import { Documents } from "../../src/documents/documents.ts";
import { contentDisposition, headerParams, parseMultipart, readStream } from "../../src/documents/transfer.ts";
import { docxToText } from "../../src/documents/text.ts";
import { JPG, PDF, PNG, makeDocx, p, setup, tempDir } from "./helpers.ts";
import { openDb } from "../../src/db.ts";
import { seed } from "../../src/seed.ts";

async function serve(opts: Parameters<typeof setup>[0] = {}) {
  const s = setup(opts);
  setDocuments(s.db, s.docs);
  const server = createServer(s.db, { today: () => "2026-11-18", log: () => {} });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const headers = authHeaders(s.db, s.atty);
  auth = headers;
  const close = () => {
    server.close();
    server.closeAllConnections?.();
    s.cleanup();
  };
  return { ...s, base, headers, close };
}

test("transfer: headerParams reads quoted, unquoted and RFC 5987 values", () => {
  const r = headerParams(`form-data; name="file"; filename="Smith \\"draft\\".pdf"`);
  assert.equal(r.value, "form-data");
  assert.equal(r.params.name, "file");
  assert.equal(r.params.filename, 'Smith "draft".pdf');
  const s = headerParams(`attachment; filename="x.pdf"; filename*=UTF-8''R%C3%A9sum%C3%A9.pdf`);
  assert.equal(s.params.filename, "Résumé.pdf");
  assert.equal(headerParams("multipart/form-data; boundary=abc").params.boundary, "abc");
});

test("transfer: parseMultipart keeps binary bytes exactly and reads text fields", () => {
  const bin = Buffer.from([0, 1, 2, 13, 10, 45, 45, 255, 254]);
  const b = "----lawdeskTest";
  const body = Buffer.concat([
    Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="folder"\r\n\r\nPleadings/Drafts\r\n`),
    Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="Exhibit Á.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`),
    bin,
    Buffer.from(`\r\n--${b}--\r\n`),
  ]);
  const r = parseMultipart(body, `multipart/form-data; boundary=${b}`);
  assert.equal(r.fields.folder, "Pleadings/Drafts");
  assert.equal(r.files.length, 1);
  assert.equal(r.files[0].filename, "Exhibit Á.bin");
  assert.deepEqual([...r.files[0].data], [...bin]);
  assert.throws(() => parseMultipart(body.subarray(0, body.length - 20), `multipart/form-data; boundary=${b}`), /cut off/);
  assert.throws(() => parseMultipart(body, "multipart/form-data"), /boundary/);
});

test("transfer: contentDisposition gives an ASCII fallback and the exact UTF-8 name", () => {
  const v = contentDisposition("attachment", 'Résumé "final".pdf');
  assert.match(v, /^attachment; filename="Resume final.pdf"; filename\*=UTF-8''R%C3%A9sum%C3%A9%20%22final%22.pdf$/);
});

test("transfer: readStream refuses a body past the limit", async () => {
  async function* gen() {
    yield Buffer.alloc(600);
    yield Buffer.alloc(600);
  }
  const src = Object.assign(gen(), { headers: {} });
  await assert.rejects(readStream(src, 1000), (e: any) => e.status === 413);
  const declared = Object.assign(gen(), { headers: { "content-length": "5000" } });
  await assert.rejects(readStream(declared, 1000), (e: any) => e.status === 413);
});

test("transfer: raw upload, multipart upload, download headers and inline preview", async () => {
  const s = await serve();
  try {
    // Raw bytes, name and metadata in the query.
    const raw = await fetch(`${s.base}/matters/${s.matterId}/documents/upload?name=${encodeURIComponent("Title commitment.pdf")}&folder=Title&tags=title,lender`, {
      method: "POST",
      headers: { ...s.headers, "Content-Type": "application/pdf" },
      body: PDF,
    });
    const doc = await raw.json();
    assert.equal(raw.status, 200, doc.error);
    assert.equal(doc.mime, "application/pdf");
    assert.equal(doc.folder, "Title");
    assert.deepEqual(doc.tags, ["lender", "title"]);
    assert.equal(doc.size, PDF.length);

    // Multipart, the way a browser form sends it.
    const fd = new FormData();
    fd.append("folder", "Photos");
    fd.append("category", "Site visit");
    fd.append("file", new Blob([PNG], { type: "image/png" }), "Front façade.png");
    const mp = await fetch(`${s.base}/matters/${s.matterId}/documents/upload`, { method: "POST", headers: s.headers, body: fd });
    const img = await mp.json();
    assert.equal(mp.status, 200, img.error);
    assert.equal(img.name, "Front façade.png");
    assert.equal(img.category, "Site visit");

    // Download: bytes, type, length, attachment, nosniff.
    const dl = await fetch(`${s.base}/documents/${doc.id}/file`, { headers: s.headers });
    assert.equal(dl.status, 200);
    assert.equal(dl.headers.get("content-type"), "application/pdf");
    assert.equal(dl.headers.get("content-length"), String(PDF.length));
    assert.equal(dl.headers.get("x-content-type-options"), "nosniff");
    assert.match(dl.headers.get("content-disposition")!, /^attachment; filename="Title commitment.pdf"/);
    assert.deepEqual(Buffer.from(await dl.arrayBuffer()), PDF);

    // Inline preview for a PDF may be framed by our own pages only.
    const pv = await fetch(`${s.base}/documents/${doc.id}/file?inline=1`, { headers: s.headers });
    assert.match(pv.headers.get("content-disposition")!, /^inline;/);
    assert.equal(pv.headers.get("x-frame-options"), "SAMEORIGIN");
    await pv.arrayBuffer();
    const viewed = s.db.prepare("SELECT kind FROM activity WHERE kind IN ('document_viewed','document_downloaded') ORDER BY id").all() as any[];
    assert.deepEqual(viewed.map((r) => r.kind), ["document_downloaded", "document_viewed"]);

    // An HTML file is never shown inline, even when asked.
    const html = await fetch(`${s.base}/matters/${s.matterId}/documents/upload?name=Note.html`, {
      method: "POST",
      headers: s.headers,
      body: "<script>alert(1)</script><p>hello</p>",
    }).then((r) => r.json());
    const hv = await fetch(`${s.base}/documents/${html.id}/file?inline=1`, { headers: s.headers });
    assert.match(hv.headers.get("content-disposition")!, /^attachment;/);
    assert.equal(hv.headers.get("content-type"), "text/html; charset=utf-8");
    assert.match(hv.headers.get("content-security-policy")!, /sandbox/);
    await hv.arrayBuffer();

    // A new version as bytes, then download the old one by number.
    const v2 = await fetch(`${s.base}/documents/${img.id}/versions/upload?name=${encodeURIComponent("Front façade.jpg")}`, {
      method: "POST",
      headers: s.headers,
      body: JPG,
    }).then((r) => r.json());
    assert.equal(v2.version, 2);
    assert.equal(v2.name, "Front façade.jpg");
    const old = await fetch(`${s.base}/documents/${img.id}/file?version=1`, { headers: s.headers });
    assert.equal(old.headers.get("content-type"), "image/png");
    assert.match(old.headers.get("content-disposition")!, /version 1/);
    assert.deepEqual(Buffer.from(await old.arrayBuffer()), PNG);

    // Missing name, wrong type for the extension.
    const noName = await fetch(`${s.base}/matters/${s.matterId}/documents/upload`, { method: "POST", headers: s.headers, body: PDF });
    assert.equal(noName.status, 400);
    await noName.arrayBuffer();
    const fake = await fetch(`${s.base}/matters/${s.matterId}/documents/upload?name=fake.pdf`, { method: "POST", headers: s.headers, body: "<html></html>" });
    assert.equal(fake.status, 415);
    await fake.arrayBuffer();
  } finally {
    s.close();
  }
});

test("transfer: the upload limit is configurable and refused with 413", async () => {
  const s = await serve({ maxBytes: 1024 });
  try {
    const big = await fetch(`${s.base}/matters/${s.matterId}/documents/upload?name=big.txt`, { method: "POST", headers: s.headers, body: "x".repeat(5000) });
    assert.equal(big.status, 413);
    assert.match((await big.json()).error, /1 KB limit/);
    // Without a Content-Length the stream is cut off as it passes the limit.
    const status = await new Promise<number>((resolve, reject) => {
      const u = new URL(`${s.base}/matters/${s.matterId}/documents/upload?name=big.txt`);
      const req = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method: "POST", headers: { ...s.headers, "Transfer-Encoding": "chunked" } }, (res) => {
        res.resume();
        resolve(res.statusCode!);
      });
      req.on("error", reject);
      req.write("x".repeat(800));
      req.write("x".repeat(800));
      req.end();
    });
    assert.equal(status, 413);
    const ok = await fetch(`${s.base}/matters/${s.matterId}/documents/upload?name=small.txt`, { method: "POST", headers: s.headers, body: "small" });
    assert.equal(ok.status, 200);
    await ok.arrayBuffer();
    assert.equal((await fetch(`${s.base}/documents/facets`).then((r) => r.json())).maxBytes, 1024);
  } finally {
    s.close();
  }
});

test("transfer: templates upload as bytes, list their fields and check a matter for blanks", async () => {
  const s = await serve();
  try {
    const docx = makeDocx(
      p("Dear {{client.name}},") + p("Closing on {{matter.dates.closing_date|long}}.") + p("Filed {{matter.dates.filing_date}}. {{custm.typo}}"),
    );
    const fd = new FormData();
    fd.append("templateName", "Closing letter");
    fd.append("category", "Letters");
    fd.append("file", new Blob([docx]), "Closing letter.docx");
    const t = await fetch(`${s.base}/document-templates/upload`, { method: "POST", headers: s.headers, body: fd }).then((r) => r.json());
    assert.equal(t.name, "Closing letter");
    assert.deepEqual(t.fields, ["client.name", "custm.typo", "matter.dates.closing_date", "matter.dates.filing_date"]);

    const check = await fetch(`${s.base}/matters/${s.matterId}/templates/${t.id}/check`, { headers: s.headers }).then((r) => r.json());
    const by = Object.fromEntries(check.fields.map((f: any) => [f.field, f]));
    assert.equal(by["client.name"].status, "filled");
    assert.equal(by["client.name"].value, "Smith & Sons <Holdings>");
    assert.equal(by["client.name"].label, "Client's name");
    assert.equal(by["matter.dates.filing_date"].status, "empty");
    assert.equal(by["custm.typo"].status, "unknown");
    assert.equal(check.suggestedName, "Closing letter - 2026-0042.docx");

    const catalog = await fetch(`${s.base}/document-templates/fields`).then((r) => r.json());
    const all = catalog.flatMap((g: any) => g.fields.map((f: any) => f.field));
    assert.ok(all.includes("matter.dates.closing_date"));
    assert.ok(all.includes("matter.roles.paralegal"));

    const file = await fetch(`${s.base}/document-templates/${t.id}/file`);
    assert.match(file.headers.get("content-disposition")!, /^attachment; filename="Closing letter.docx"/);
    assert.equal(file.headers.get("content-type"), "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), docx);

    // Generate, then read the text preview of the new document.
    const gen = await fetch(`${s.base}/matters/${s.matterId}/documents/generate`, {
      method: "POST",
      headers: { ...s.headers, "Content-Type": "application/json" },
      body: JSON.stringify({ templateId: t.id }),
    }).then((r) => r.json());
    const text = await fetch(`${s.base}/documents/${gen.document.id}/text`).then((r) => r.json());
    assert.match(text.text, /Dear Smith & Sons <Holdings>,/);
    assert.match(text.text, /Closing on December 15, 2026\./);
  } finally {
    s.close();
  }
});

test("folders: create empty, rename with contents (trash follows), refuse deleting a full one", () => {
  const s = setup();
  try {
    const { docs, matterId, atty } = s;
    docs.createFolder(matterId, "Correspondence/Outgoing", atty);
    assert.deepEqual(docs.list(matterId).folders, ["Correspondence", "Correspondence/Outgoing"]);
    const a = docs.upload({ matterId, filename: "Letter.txt", data: Buffer.from("dear sir"), folder: "Correspondence/Outgoing", userId: atty });
    const b = docs.upload({ matterId, filename: "Old.txt", data: Buffer.from("old"), folder: "Correspondence", userId: atty });
    docs.delete(b.id, atty);
    assert.throws(() => docs.deleteFolder(matterId, "Correspondence", atty), /still has a document/);
    const after = docs.renameFolder(matterId, "Correspondence", "Letters", atty);
    assert.deepEqual(after.folders, ["Letters", "Letters/Outgoing"]);
    assert.equal(docs.get(a.id).folder, "Letters/Outgoing");
    assert.equal(docs.restore(b.id, atty).folder, "Letters");
    assert.throws(() => docs.renameFolder(matterId, "Letters", "Letters/Inside", atty), /inside itself/);
    docs.delete(a.id, atty);
    docs.delete(b.id, atty);
    assert.deepEqual(docs.deleteFolder(matterId, "Letters", atty).folders, []);
    assert.throws(() => docs.createFolder(matterId, "bad:name", atty), /cannot contain/);
  } finally {
    s.cleanup();
  }
});

test("search: highlights come back as parts, with and without FTS5", () => {
  for (const fts of [true, false]) {
    const s = setup({ fts });
    try {
      s.docs.upload({ matterId: s.matterId, filename: "Memo.txt", data: Buffer.from("Notes [draft]: the indemnification cap is <b>two</b> million."), userId: s.atty });
      const r = s.docs.search({ q: "indemnification" });
      const hit = r.results[0] as any;
      assert.ok(hit.highlights, `highlights (fts ${fts})`);
      assert.deepEqual(
        hit.highlights.filter((x: any) => x.hit).map((x: any) => x.text.toLowerCase()),
        ["indemnification"],
      );
      assert.ok(hit.highlights.map((x: any) => x.text).join("").includes("<b>two</b>"), "text is returned as text, not markup");
    } finally {
      s.cleanup();
    }
  }
});

test("facets: categories, tags and matters with documents", () => {
  const s = setup();
  try {
    s.docs.upload({ matterId: s.matterId, filename: "A.txt", data: Buffer.from("a"), category: "Pleadings", tags: ["Draft"] });
    s.docs.upload({ matterId: s.other, filename: "B.txt", data: Buffer.from("b"), tags: ["draft", "Final"] });
    const f = s.docs.facets();
    assert.deepEqual(f.categories, ["Pleadings"]);
    assert.equal(f.tags.length, 2);
    assert.deepEqual(f.matters.map((m: any) => m.documents), [1, 1]);
  } finally {
    s.cleanup();
  }
});

test("seed: demo documents, versions, trash and a Word template, files built in code", () => {
  const db = openDb();
  const { dir, cleanup } = tempDir();
  try {
    const docs = new Documents(db, { dir, today: () => "2026-11-18" });
    setDocuments(db, docs);
    const demo = seed(db, "2026-11-18");
    const all = docs.search({ includeDeleted: true, limit: 200 }).results as any[];
    assert.ok(all.length >= 8);
    assert.ok(all.some((d) => d.deletedAt), "one document is in the trash");
    const pdf = all.find((d) => d.name === "Title commitment.pdf");
    assert.equal(pdf.mime, "application/pdf");
    const bytes = docs.download(pdf.id).data.toString("latin1");
    const xref = Number(/startxref\n(\d+)/.exec(bytes)![1]);
    assert.ok(bytes.slice(xref).startsWith("xref"), "the PDF's cross-reference offset is right");
    const png = all.find((d) => d.mime === "image/png");
    assert.ok(png, "a PNG to preview");
    const articles = all.find((d) => d.name.startsWith("Articles of organization"));
    assert.equal(articles.version, 2);
    const [t] = docs.listTemplates();
    assert.equal(t.kind, "docx");
    assert.ok(t.fields.includes("matter.roles.attorney"));
    const check = docs.checkTemplate(t.id, demo.matters.m1, demo.users.jordan);
    assert.deepEqual(check.unknown, []);
    const letter = all.find((d) => d.templateId === t.id);
    const text = docxToText(docs.download(letter.id).data);
    assert.match(text, /Dear Bluestem Holdings LLC \(demo\):/);
    assert.doesNotMatch(text, /\{\{/);
    assert.equal(docs.search({ q: "indemnification" }).results.length, 1);
  } finally {
    cleanup();
  }
});
