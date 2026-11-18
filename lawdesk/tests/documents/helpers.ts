// Shared fixtures for the document tests. All data is made up.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { openDb } from "../../src/db.ts";
import { Engine } from "../../src/engine.ts";
import { SCHEMA } from "../../src/documents/schema.ts";
import { Documents, type DocumentsOptions } from "../../src/documents/documents.ts";
import { writeZip, type ZipEntry } from "../../src/documents/zip.ts";

export const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

/** A minimal but complete .docx: the parts Word needs to open a file. */
export function makeDocx(bodyXml: string, extra: ZipEntry[] = [], opts: { header?: string } = {}): Buffer {
  const rels = opts.header
    ? `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>`
    : "";
  const sect = opts.header ? `<w:sectPr><w:headerReference w:type="default" r:id="rId1"/></w:sectPr>` : `<w:sectPr/>`;
  const entries: ZipEntry[] = [
    {
      name: "[Content_Types].xml",
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
${opts.header ? '<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>' : ""}
</Types>`,
      ),
    },
    {
      name: "_rels/.rels",
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
      ),
    },
    {
      name: "word/_rels/document.xml.rels",
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`,
      ),
    },
    {
      name: "word/document.xml",
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${W_NS}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${bodyXml}${sect}</w:body></w:document>`,
      ),
    },
  ];
  if (opts.header) {
    entries.push({
      name: "word/header1.xml",
      data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:hdr xmlns:w="${W_NS}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${opts.header}</w:hdr>`),
    });
  }
  return writeZip([...entries, ...extra]);
}

/** A paragraph with one plain run. */
export const p = (text: string) => `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;

/** A minimal .xlsx-shaped zip (only what type detection looks at). */
export function makeXlsx(): Buffer {
  return writeZip([
    { name: "[Content_Types].xml", data: Buffer.from("<Types/>") },
    { name: "xl/workbook.xml", data: Buffer.from("<workbook/>") },
  ]);
}

export const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");
export const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
export const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0]);

export function tempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "lawdesk-docs-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function setup(opts: DocumentsOptions = {}) {
  const db = openDb();
  db.exec(SCHEMA);
  const now = "2026-11-18";
  const engine = new Engine(db, { today: () => now });
  const atty = engine.addUser("Avery Attorney", "attorney", "avery@example.test");
  const para = engine.addUser("Pat Paralegal", "paralegal");
  engine.addDateField("closing_date", "Closing date");
  engine.addDateField("filing_date", "Filing date");
  const client = engine.addContact("Smith & Sons <Holdings>", "company", "office@example.test");
  const matterId = engine.createMatter({
    name: "Smith asset purchase",
    number: "2026-0042",
    clientId: client,
    roles: { attorney: atty, paralegal: para },
    dates: { closing_date: "2026-12-15" },
  } as any);
  const other = engine.createMatter({ name: "Jones estate plan", number: "2026-0043" } as any);
  const { dir, cleanup } = tempDir();
  const docs = new Documents(db, { dir, today: () => now, ...opts });
  return { db, engine, docs, atty, para, client, matterId: matterId as number, other: other as number, dir, cleanup };
}

let pyDocx: boolean | null = null;
/** Is python-docx installed here? (Used to prove generated files parse as Word documents.) */
export function hasPythonDocx(): boolean {
  if (pyDocx === null) {
    const r = spawnSync("python3", ["-I", "-c", "import docx"], { encoding: "utf8" });
    pyDocx = r.status === 0;
  }
  return pyDocx;
}

export function hasSoffice(): boolean {
  const r = spawnSync("soffice", ["--version"], { encoding: "utf8", timeout: 30000 });
  return r.status === 0;
}
