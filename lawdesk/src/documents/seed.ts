// DEMO DATA ONLY. Fictional documents and one Word template for the demo matters.
// The files are built here in code (a small PDF, a PNG, Word files via the module's zip writer)
// so the demo needs no binary fixtures. Nothing here is a real client document.

import { deflateSync } from "node:zlib";
import type { DB } from "../db.ts";
import type { Documents } from "./documents.ts";
import { escapeXml } from "./text.ts";
import { crc32, writeZip } from "./zip.ts";

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

type Para = string | { text: string; bold?: boolean; size?: number; center?: boolean; space?: number };

/** A minimal Word document: the parts Word needs, Times New Roman 12pt, one paragraph per entry. */
export function buildDocx(paras: Para[]): Buffer {
  const body = paras
    .map((raw) => {
      const p = typeof raw === "string" ? { text: raw } : raw;
      const ppr = `<w:pPr>${p.center ? '<w:jc w:val="center"/>' : ""}<w:spacing w:after="${p.space ?? 200}"/></w:pPr>`;
      const rpr = `<w:rPr>${p.bold ? "<w:b/>" : ""}${p.size ? `<w:sz w:val="${p.size * 2}"/>` : ""}</w:rPr>`;
      return `<w:p>${ppr}<w:r>${rpr}<w:t xml:space="preserve">${escapeXml(p.text)}</w:t></w:r></w:p>`;
    })
    .join("");
  const xml = (s: string) => Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${s}`, "utf8");
  return writeZip(
    [
      {
        name: "[Content_Types].xml",
        data: xml(
          `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`,
        ),
      },
      {
        name: "_rels/.rels",
        data: xml(
          `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
        ),
      },
      {
        name: "word/_rels/document.xml.rels",
        data: xml(
          `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
        ),
      },
      {
        name: "word/styles.xml",
        data: xml(
          `<w:styles xmlns:w="${W_NS}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:cs="Times New Roman"/><w:sz w:val="24"/></w:rPr></w:rPrDefault></w:docDefaults></w:styles>`,
        ),
      },
      {
        name: "word/document.xml",
        data: xml(
          `<w:document xmlns:w="${W_NS}"><w:body>${body}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`,
        ),
      },
    ],
    { date: new Date(Date.UTC(2026, 0, 1)) },
  );
}

/** A one-page Letter-size PDF of plain text lines (Times), with a correct cross-reference table. */
export function buildPdf(lines: { text: string; size?: number; bold?: boolean }[]): Buffer {
  const esc = (s: string) => s.replace(/[\\()]/g, (c) => "\\" + c).replace(/[^\x20-\x7e]/g, "?");
  let y = 720;
  const ops: string[] = ["BT"];
  for (const l of lines) {
    const size = l.size ?? 11;
    ops.push(`/${l.bold ? "F2" : "F1"} ${size} Tf 1 0 0 1 72 ${y} Tm (${esc(l.text)}) Tj`);
    y -= Math.round(size * 1.6);
  }
  ops.push("ET");
  const stream = ops.join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Times-Roman >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Times-Bold >>",
    `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`,
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out, "latin1"));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

/** A small PNG: a navy field with a gold band (stands in for a site photo). */
export function buildPng(width = 240, height = 150): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x++) {
      const sky = y < height * 0.55;
      const band = y >= height * 0.55 && y < height * 0.62;
      const [r, g, b] = band ? [165, 131, 63] : sky ? [29 + (y >> 2), 53 + (y >> 2), 87 + (y >> 2)] : [226, 220, 207];
      row[1 + x * 3] = r;
      row[2 + x * 3] = g;
      row[3 + x * 3] = b;
    }
    rows.push(row);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** The demo engagement-letter template (fictional firm wording, not legal advice). */
export function engagementTemplate(): Buffer {
  return buildDocx([
    { text: "Reyes & Chen, Attorneys at Law (demo firm)", bold: true, center: true, size: 14, space: 80 },
    { text: "Wichita, Kansas", center: true, space: 360 },
    "{{today}}",
    "{{client.name}}",
    "{{#if client.email}}By email: {{client.email}}{{/if}}",
    { text: "Re: Engagement for {{matter.name}} (matter {{matter.number}})", bold: true },
    "Dear {{client.name}}:",
    "Thank you for choosing our firm. This letter confirms that we will represent you in {{matter.name}}. {{matter.roles.attorney}} will be the attorney responsible for your matter, assisted by {{matter.roles.paralegal}}.",
    "Our work on this matter is expected to include the steps described in our conversation and in the enclosed scope of services. If the scope changes, we will confirm the change with you in writing.",
    "Please sign and return a copy of this letter so we can begin.",
    "Sincerely,",
    { text: "{{user.name}}", space: 480 },
    "Agreed: ______________________________   Date: ______________",
    { text: "DEMO TEMPLATE. Fictional firm; not for use with real clients.", size: 9 },
  ]);
}

interface SeedRefs {
  users: { jordan: number; riley: number; sam: number; casey: number };
  matters: { m1: number; m2: number; m3: number; m4: number; m5: number; m6: number };
}

/** Add the demo documents and template. Returns their ids. */
export function seedDocuments(docs: Documents, _db: DB, refs: SeedRefs) {
  const { jordan, riley, sam, casey } = refs.users;
  const { m1, m2, m4 } = refs.matters;
  const DEMO = "Fictional demo document. Not a real client.";

  const template = docs.createTemplate(
    {
      name: "Engagement letter",
      filename: "Engagement letter.docx",
      data: engagementTemplate(),
      description: "Standard engagement letter. Fills in the client, matter and responsible attorney.",
      category: "Letters",
    },
    jordan,
  );

  // Riverside Plaza purchase (real estate closing).
  const title = docs.upload({
    matterId: m4,
    filename: "Title commitment.pdf",
    folder: "Title",
    category: "Title",
    tags: ["title", "lender"],
    userId: sam,
    data: buildPdf([
      { text: "COMMITMENT FOR TITLE INSURANCE (DEMO)", bold: true, size: 15 },
      { text: "Demo Title Company of Kansas - fictional document" },
      { text: " " },
      { text: "Property: Riverside Plaza, a small retail strip (fictional)" },
      { text: "Proposed insured: Bluestem Holdings LLC (demo)" },
      { text: " " },
      { text: "Schedule B, Part I - Requirements", bold: true },
      { text: "1. Warranty deed from the current owner to the proposed insured." },
      { text: "2. Payoff and release of the existing mortgage of record." },
      { text: " " },
      { text: "Schedule B, Part II - Exceptions", bold: true },
      { text: "1. Utility easement along the north 10 feet, as shown on the plat." },
      { text: "2. Taxes for the current year, not yet due and payable." },
      { text: " " },
      { text: DEMO, size: 9 },
    ]),
  });
  docs.upload({
    matterId: m4,
    filename: "Site photo - front.png",
    folder: "Survey",
    category: "Photos",
    tags: ["survey"],
    userId: sam,
    data: buildPng(),
  });
  docs.upload({
    matterId: m4,
    filename: "Letter to lender.txt",
    folder: "Correspondence",
    category: "Correspondence",
    tags: ["lender"],
    userId: riley,
    data: Buffer.from(
      `Demo Bank (fictional)\nAttn: Commercial Loan Closing\n\nRe: Riverside Plaza purchase\n\nWe enclose the title commitment and ask that the lender confirm its required endorsements before the closing date. The survey is not required by the buyer.\n\n${DEMO}\n`,
    ),
  });
  docs.generate({ templateId: template.id, matterId: m4, userId: riley, folder: "Correspondence", tags: ["engagement"] });

  // Sunflower Coffee Roasters formation: a draft with two versions, and a trashed duplicate.
  const articles = docs.upload({
    matterId: m1,
    filename: "Articles of organization - draft.docx",
    folder: "Formation",
    category: "Formation",
    tags: ["draft"],
    userId: sam,
    data: buildDocx([
      { text: "ARTICLES OF ORGANIZATION (DEMO DRAFT)", bold: true, center: true },
      "1. The name of the limited liability company is Sunflower Coffee Roasters LLC (demo).",
      "2. The company will be managed by its members.",
      DEMO,
    ]),
  });
  docs.addVersion(articles.id, {
    filename: "Articles of organization - draft.docx",
    userId: jordan,
    note: "Attorney comments addressed",
    data: buildDocx([
      { text: "ARTICLES OF ORGANIZATION (DEMO DRAFT 2)", bold: true, center: true },
      "1. The name of the limited liability company is Sunflower Coffee Roasters LLC (demo).",
      "2. The company will be managed by its members, as set out in the operating agreement.",
      "3. The registered office and resident agent are listed on the attached sheet.",
      DEMO,
    ]),
  });
  docs.upload({
    matterId: m1,
    filename: "Formation questionnaire.txt",
    folder: "Intake",
    category: "Intake",
    userId: casey,
    data: Buffer.from(`Formation questionnaire (demo)\n\nOwners: two members, equal shares.\nBusiness: small-batch coffee roasting and wholesale.\nPreferred name: Sunflower Coffee Roasters LLC.\n\n${DEMO}\n`),
  });
  const dup = docs.upload({
    matterId: m1,
    filename: "Questionnaire - old copy.txt",
    folder: "Intake",
    userId: casey,
    data: Buffer.from(`An older copy of the questionnaire.\n\n${DEMO}\n`),
  });
  docs.delete(dup.id, casey);

  // Supply agreement review: a redline with the clause the demo search finds.
  docs.upload({
    matterId: m2,
    filename: "Supply agreement - redline.docx",
    folder: "Drafts",
    category: "Contracts",
    tags: ["redline", "draft"],
    userId: jordan,
    data: buildDocx([
      { text: "PANEL SUPPLY AGREEMENT (DEMO REDLINE)", bold: true, center: true },
      "Section 9. Indemnification. Each party will indemnify the other against third-party claims arising from its breach. The supplier's total liability under this section is capped at the fees paid in the twelve months before the claim.",
      "Section 10. Warranty. The supplier warrants that the panels will be free from defects for the warranty period stated in Exhibit B.",
      "Comment (JR): ask the client whether the indemnity cap is acceptable.",
      DEMO,
    ]),
  });
  docs.createFolder(m2, "Signed", jordan);

  return { templateId: template.id, titleDocId: title.id, articlesDocId: articles.id };
}
