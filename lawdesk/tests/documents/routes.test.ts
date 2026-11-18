import { test } from "node:test";
import assert from "node:assert/strict";
import { matchPath, type Ctx } from "../../src/http.ts";
import { routes, setDocuments, documentsFor } from "../../src/documents/routes.ts";
import { Documents } from "../../src/documents/documents.ts";
import { docxToText } from "../../src/documents/text.ts";
import { PDF, makeDocx, p, setup } from "./helpers.ts";

/** Dispatch like the server will: first route whose method and path match. */
function client(s: ReturnType<typeof setup>, userId: number | null) {
  return async (method: string, url: string, body: any = {}) => {
    const u = new URL(url, "http://x");
    const path = u.pathname.replace(/^\/api/, "");
    for (const r of routes) {
      if (r.method !== method) continue;
      const params = matchPath(r.path, path);
      if (!params) continue;
      const ctx: Ctx = { db: s.db, engine: s.engine, params, query: u.searchParams, body, userId };
      try {
        return { status: 200, body: (await r.handler(ctx)) as any };
      } catch (e: any) {
        return { status: e.status ?? 500, body: { error: e.message } };
      }
    }
    return { status: 404, body: { error: "no route" } };
  };
}

const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64");

test("routes: every route has a unique method + path and search is matched before :id", () => {
  const keys = routes.map((r) => `${r.method} ${r.path}`);
  assert.equal(new Set(keys).size, keys.length);
  const search = keys.indexOf("GET /documents/search");
  const byId = keys.indexOf("GET /documents/:id");
  assert.ok(search >= 0 && search < byId);
});

test("routes: upload, list, versions, download, restore version, delete and restore over the API", async () => {
  const s = setup();
  setDocuments(s.db, s.docs);
  const api = client(s, s.atty);
  try {
    const up = await api("POST", `/api/matters/${s.matterId}/documents`, {
      filename: "Notes.txt",
      contentBase64: b64("first draft about the easement"),
      folder: "Research",
      tags: ["easement"],
    });
    assert.equal(up.status, 200, up.body.error);
    const id = up.body.id;
    assert.equal(up.body.createdBy, s.atty);

    const dup = await api("POST", `/api/matters/${s.matterId}/documents`, { filename: "Notes.txt", contentBase64: b64("x"), folder: "Research" });
    assert.equal(dup.status, 409);

    const v2 = await api("POST", `/api/documents/${id}/versions`, { filename: "Notes.txt", contentBase64: b64("second draft") });
    assert.equal(v2.body.version, 2);

    const list = await api("GET", `/api/matters/${s.matterId}/documents`);
    assert.deepEqual(list.body.documents.map((d: any) => d.name), ["Notes.txt"]);
    assert.deepEqual(list.body.folders, ["Research"]);

    const versions = await api("GET", `/api/documents/${id}/versions`);
    assert.deepEqual(versions.body.map((v: any) => v.version), [2, 1]);

    const dl = await api("GET", `/api/documents/${id}/download`);
    assert.equal(Buffer.from(dl.body.base64, "base64").toString(), "second draft");
    assert.equal(dl.body.filename, "Notes.txt");
    assert.equal(dl.body.mime, "text/plain");
    const dl1 = await api("GET", `/api/documents/${id}/download?version=1`);
    assert.equal(Buffer.from(dl1.body.base64, "base64").toString(), "first draft about the easement");

    const rv = await api("POST", `/api/documents/${id}/versions/1/restore`);
    assert.equal(rv.body.version, 3);

    const search = await api("GET", `/api/documents/search?q=easement&matter=${s.matterId}`);
    assert.equal(search.status, 200);
    assert.deepEqual(search.body.results.map((r: any) => r.id), [id]);
    assert.equal(search.body.fts, true);
    const byTag = await api("GET", `/api/documents/search?tag=easement`);
    assert.equal(byTag.body.results.length, 1);

    const patched = await api("PATCH", `/api/documents/${id}`, { name: "Easement research.txt", category: "Research" });
    assert.equal(patched.body.name, "Easement research.txt");

    assert.equal((await api("DELETE", `/api/documents/${id}`)).status, 200);
    assert.equal((await api("GET", `/api/matters/${s.matterId}/documents`)).body.documents.length, 0);
    assert.equal((await api("GET", `/api/matters/${s.matterId}/documents?deleted=only`)).body.documents.length, 1);
    assert.equal((await api("GET", `/api/documents/${id}/download`)).status, 409);
    assert.equal((await api("POST", `/api/documents/${id}/restore`)).body.deletedAt, null);
    assert.equal((await api("GET", `/api/documents/${id}`)).body.version, 3);

    // Errors carry the right status
    assert.equal((await api("GET", `/api/documents/abc`)).status, 400);
    assert.equal((await api("GET", `/api/documents/9999`)).status, 404);
    assert.equal((await api("GET", `/api/documents/search?matter=abc`)).status, 400);
    assert.equal((await api("POST", `/api/matters/${s.matterId}/documents`, { filename: "a.txt", contentBase64: "%%%" })).status, 400);
    assert.equal((await api("POST", `/api/matters/${s.matterId}/documents`, { filename: "a.txt" })).status, 400);
    assert.equal((await api("POST", `/api/matters/${s.matterId}/documents`, { filename: "../a.txt", contentBase64: b64("x") })).status, 400);
    assert.equal((await api("POST", `/api/matters/${s.matterId}/documents`, { filename: "a.pdf", contentBase64: b64("<html>") })).status, 415);
    assert.equal((await api("POST", `/api/matters/${s.matterId}/documents`, [] as any)).status, 400);
  } finally {
    s.cleanup();
  }
});

test("routes: the size limit applies to base64 uploads (413)", async () => {
  const s = setup();
  setDocuments(s.db, new Documents(s.db, { dir: s.dir, maxBytes: 100 }));
  const api = client(s, null);
  try {
    const r = await api("POST", `/api/matters/${s.matterId}/documents`, { filename: "big.txt", contentBase64: b64("x".repeat(500)) });
    assert.equal(r.status, 413);
    const ok = await api("POST", `/api/matters/${s.matterId}/documents`, { filename: "small.pdf", contentBase64: b64(PDF) });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.createdBy, null);
  } finally {
    s.cleanup();
  }
});

test("routes: templates CRUD and generate", async () => {
  const s = setup();
  setDocuments(s.db, s.docs);
  const api = client(s, s.para);
  try {
    const created = await api("POST", "/api/document-templates", {
      name: "Closing letter",
      filename: "closing.docx",
      contentBase64: b64(makeDocx(p("Dear {{client.name}}: closing {{matter.dates.closing_date|long}}. {{custom.note}}"))),
      category: "Letters",
    });
    assert.equal(created.status, 200, created.body.error);
    const tid = created.body.id;
    assert.deepEqual(created.body.fields, ["client.name", "custom.note", "matter.dates.closing_date"]);
    assert.equal((await api("GET", "/api/document-templates")).body.length, 1);
    assert.equal((await api("GET", `/api/document-templates/${tid}`)).body.name, "Closing letter");
    const renamed = await api("PATCH", `/api/document-templates/${tid}`, { description: "Sent a week before closing" });
    assert.equal(renamed.body.description, "Sent a week before closing");
    const dl = await api("GET", `/api/document-templates/${tid}/download`);
    assert.equal(dl.body.filename, "closing.docx");

    const fields = await api("GET", `/api/matters/${s.matterId}/merge-fields`);
    assert.equal(fields.body.user.name, "Pat Paralegal");

    const gen = await api("POST", `/api/matters/${s.matterId}/documents/generate`, { templateId: tid, custom: { note: "Bring ID." } });
    assert.equal(gen.status, 200, gen.body.error);
    assert.deepEqual(gen.body.unknown, []);
    const file = await api("GET", `/api/documents/${gen.body.document.id}/download`);
    assert.equal(docxToText(Buffer.from(file.body.base64, "base64")), "Dear Smith & Sons <Holdings>: closing December 15, 2026. Bring ID.");

    assert.equal((await api("POST", `/api/matters/${s.matterId}/documents/generate`, {})).status, 400);
    assert.equal((await api("POST", `/api/matters/${s.matterId}/documents/generate`, { templateId: tid, strict: true })).status, 400);
    assert.equal((await api("POST", `/api/matters/9999/documents/generate`, { templateId: tid })).status, 404);

    assert.equal((await api("DELETE", `/api/document-templates/${tid}`)).status, 200);
    assert.equal((await api("GET", "/api/document-templates")).body.length, 0);
    assert.equal((await api("GET", "/api/document-templates?deleted=1")).body.length, 1);
    assert.equal((await api("POST", `/api/document-templates/${tid}/restore`)).status, 200);
  } finally {
    s.cleanup();
  }
});

test("routes: documentsFor creates the doc_ tables on a fresh database", async () => {
  const s = setup();
  try {
    const { openDb } = await import("../../src/db.ts");
    const db = openDb();
    const prev = process.env.LAWDESK_FILES;
    process.env.LAWDESK_FILES = s.dir;
    try {
      const d = documentsFor({ db, engine: s.engine });
      assert.equal(d.store.dir, s.dir);
      assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name = 'doc_documents'").get());
      assert.equal(documentsFor({ db, engine: s.engine }), d, "one instance per database");
    } finally {
      if (prev === undefined) delete process.env.LAWDESK_FILES;
      else process.env.LAWDESK_FILES = prev;
    }
  } finally {
    s.cleanup();
  }
});
