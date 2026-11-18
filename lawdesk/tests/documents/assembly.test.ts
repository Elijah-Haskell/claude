import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fillDocx, fillText, fillWordXml, inspectTemplate, longDate, normalizeRuns } from "../../src/documents/assembly.ts";
import { readZip } from "../../src/documents/zip.ts";
import { docxToText } from "../../src/documents/text.ts";
import { hasPythonDocx, hasSoffice, makeDocx, p, tempDir } from "./helpers.ts";

const data = {
  today: "November 18, 2026",
  today_iso: "2026-11-18",
  client: { name: "Smith & Sons <Holdings>", email: "office@example.test", phone: null },
  matter: { number: "2026-0042", name: "Smith asset purchase", dates: { closing_date: "2026-12-15", filing_date: null }, roles: { attorney: "Avery Attorney" } },
  user: { name: "Avery Attorney" },
  custom: { address: "100 Main St\nTopeka, KS 66603", price: 250000 },
};

const docXml = (r: { output: Buffer }) => readZip(r.output).find((e) => e.name === "word/document.xml")!.data.toString("utf8");

test("assembly: plain-text values, filters and missing fields", () => {
  const r = fillText("Re: {{matter.number}} for {{client.name}} closing {{ matter.dates.closing_date | long }} {{client.name|upper}} {{nope.field}}", data);
  assert.equal(r.output, "Re: 2026-0042 for Smith & Sons <Holdings> closing December 15, 2026 SMITH & SONS <HOLDINGS> ");
  assert.deepEqual(r.unknown, ["nope.field"]);
  assert.deepEqual(r.empty, []);
  assert.equal(fillText("{{custom.price}}", data).output, "250000");
  assert.equal(fillText("{{matter}}", data).output, "", "an object renders empty");
  assert.equal(longDate("2026-02-01"), "February 1, 2026");
  assert.equal(longDate("not a date"), "not a date");
});

test("assembly: #if / else / not, nesting, and block tags on their own line take the line", () => {
  const tpl = [
    "Dear {{client.name}},",
    "{{#if client.email}}",
    "Email: {{client.email}}",
    "{{/if}}",
    "{{#if client.phone}}",
    "Phone: {{client.phone}}",
    "{{else}}",
    "No phone on file.",
    "{{/if}}",
    "{{#if not matter.dates.filing_date}}Not yet filed.{{/if}}",
    "{{#if matter.number}}A{{#if client.phone}}B{{else}}C{{/if}}D{{/if}}",
    "End",
  ].join("\n");
  const r = fillText(tpl, data);
  assert.equal(r.output, "Dear Smith & Sons <Holdings>,\nEmail: office@example.test\nNo phone on file.\nNot yet filed.\nACD\nEnd");
  assert.deepEqual(r.empty, ["client.phone", "matter.dates.filing_date"]);
  // An unknown field in #if is treated as empty and reported
  const u = fillText("{{#if client.fax}}fax{{/if}}x", data);
  assert.equal(u.output, "x");
  assert.deepEqual(u.unknown, ["client.fax"]);
});

test("assembly: HTML templates escape values; text templates do not", () => {
  const r = fillText("<p>{{client.name}}</p><address>{{custom.address}}</address>", data, { html: true });
  assert.equal(r.output, "<p>Smith &amp; Sons &lt;Holdings&gt;</p><address>100 Main St<br>\nTopeka, KS 66603</address>");
  assert.equal(fillText("{{client.name}}", data).output, "Smith & Sons <Holdings>");
});

test("assembly: malformed templates give clear errors", () => {
  const bad: [string, RegExp][] = [
    ["{{#if client.name}}never closed", /never closed/],
    ["stray {{/if}}", /no matching/],
    ["stray {{else}}", /no matching/],
    ["{{#if a}}x{{else}}y{{else}}z{{/if}}", /two \{\{else\}\}/],
    ["{{#each items}}{{/each}}", /not supported/],
    ["{{client name}}", /not a valid field/],
    ["{{client.name|shout}}", /unknown filter/],
    ["{{#if}}x{{/if}}", /needs a field/],
    ["{{a|upper|lower}}", /at most one filter/],
  ];
  for (const [tpl, re] of bad) assert.throws(() => fillText(tpl, data), re, tpl);
  assert.deepEqual(inspectTemplate("txt", Buffer.from("{{b}} {{#if a.c}}{{/if}} {{b|upper}}")).fields, ["a.c", "b"]);
});

test("assembly: Word runs split mid-tag (spell-check, formatting) are merged into the first run", () => {
  const xml =
    `<w:document xmlns:w="w"><w:body><w:p w:rsidR="00A1">` +
    `<w:r><w:rPr><w:b/></w:rPr><w:t>Dear {</w:t></w:r>` +
    `<w:r w:rsidR="00B2"><w:t>{cli</w:t></w:r><w:proofErr w:type="spellStart"/>` +
    `<w:r><w:rPr><w:i/></w:rPr><w:t>ent.na</w:t></w:r><w:proofErr w:type="spellEnd"/>` +
    `<w:r><w:t xml:space="preserve">me}}, about {{matter.</w:t></w:r><w:r><w:t>number}} today</w:t></w:r>` +
    `</w:p></w:body></w:document>`;
  const norm = normalizeRuns(xml);
  assert.match(norm, /<w:t xml:space="preserve">Dear \{\{client\.name\}\}<\/w:t>/);
  assert.match(norm, /<w:t xml:space="preserve">, about \{\{matter\.number\}\}<\/w:t>/);
  assert.match(norm, /<w:t xml:space="preserve"> today<\/w:t>/);
  const r = fillWordXml(xml, data);
  assert.match(r.output, /<w:rPr><w:b\/><\/w:rPr><w:t xml:space="preserve">Dear Smith &amp; Sons &lt;Holdings&gt;<\/w:t>/);
  assert.match(r.output, /2026-0042/);
  assert.doesNotMatch(r.output, /\{\{|\}\}/);
  // Paragraphs without tags are left byte-for-byte alone
  const plain = `<w:body><w:p><w:r><w:t>Nothing {here}</w:t></w:r></w:p></w:body>`;
  assert.equal(normalizeRuns(plain), plain);
});

test("assembly: docx #if blocks remove whole paragraphs; inline #if stays in its paragraph", () => {
  const body =
    p("Dear {{client.name}},") +
    p("{{#if client.phone}}") +
    p("Call us at {{client.phone}}.") +
    p("{{else}}") +
    p("Please send us a phone number.") +
    p("{{/if}}") +
    `<w:p><w:r><w:t xml:space="preserve">Closing {{#if matter.dates.closing_date}}on {{matter.dates.closing_date|long}}{{else}}TBD{{/if}}.</w:t></w:r></w:p>` +
    p("{{#if client.email}}") +
    p("Email: {{client.email}}") +
    p("{{/if}}") +
    p("Sincerely,");
  const r = fillDocx(makeDocx(body), data);
  const xml = docXml(r);
  const text = docxToText(r.output);
  assert.equal(text, "Dear Smith & Sons <Holdings>,\nPlease send us a phone number.\nClosing on December 15, 2026.\nEmail: office@example.test\nSincerely,");
  assert.equal((xml.match(/<w:p>/g) ?? []).length, 5, "the block-tag paragraphs are gone");
});

test("assembly: #if across a run split and across paragraphs with inline tags", () => {
  const body =
    `<w:p><w:r><w:t xml:space="preserve">Intro {{#if cli</w:t></w:r><w:r><w:t>ent.phone}}phone part</w:t></w:r></w:p>` +
    p("still conditional") +
    `<w:p><w:r><w:t xml:space="preserve">end{{/if}} after</w:t></w:r></w:p>`;
  const r = fillDocx(makeDocx(body), data);
  assert.equal(docxToText(r.output), "Intro  after");
});

test("assembly: multi-line values become line breaks; tabs become tabs; XML-invalid characters are dropped", () => {
  const r = fillDocx(makeDocx(p("To: {{custom.address}}") + p("{{custom.tabbed}}")), { ...data, custom: { ...data.custom, tabbed: "a\tb\u0001c" } });
  const xml = docXml(r);
  assert.match(xml, /100 Main St<\/w:t><w:br\/><w:t xml:space="preserve">Topeka, KS 66603/);
  assert.match(xml, /a<\/w:t><w:tab\/><w:t xml:space="preserve">bc/);
  assert.equal(docxToText(r.output), "To: 100 Main St\nTopeka, KS 66603\na\tbc");
});

test("assembly: headers are filled; table cells keep a paragraph; blocks may not cross table boundaries", () => {
  const cell = (inner: string) => `<w:tbl><w:tr><w:tc>${inner}</w:tc></w:tr></w:tbl>`;
  const r = fillDocx(
    makeDocx(cell(p("{{#if client.phone}}") + p("phone") + p("{{/if}}")) + p("Body"), [], { header: p("Matter {{matter.number}}") }),
    data,
  );
  const entries = readZip(r.output);
  assert.match(entries.find((e) => e.name === "word/header1.xml")!.data.toString(), /Matter 2026-0042/);
  const xml = docXml(r);
  assert.match(xml, /<w:tc><w:p>/, "the cell still has a paragraph");
  assert.doesNotMatch(xml, /phone/);

  const crossing = makeDocx(p("{{#if client.phone}}") + cell(p("inside {{/if}}")));
  assert.throws(() => fillDocx(crossing, data), /crosses a table/);
});

test("assembly: output is a valid zip with every original part, and the template is untouched", () => {
  const tpl = makeDocx(p("{{client.name}}"), [{ name: "word/media/image1.png", data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]) }]);
  const before = Buffer.from(tpl);
  const r = fillDocx(tpl, data);
  assert.deepEqual(
    readZip(r.output).map((e) => e.name),
    readZip(tpl).map((e) => e.name),
  );
  assert.ok(readZip(r.output).find((e) => e.name === "word/media/image1.png")!.data.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])));
  assert.ok(tpl.equals(before));
  assert.throws(() => fillDocx(Buffer.from("not a zip"), data));
});

const WORD_TEMPLATE_BODY =
  `<w:p><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">Engagement of </w:t></w:r><w:r><w:t>{{cli</w:t></w:r><w:proofErr w:type="spellStart"/><w:r><w:t>ent.name}}</w:t></w:r></w:p>` +
  p("Matter {{matter.number}}: {{matter.name}}") +
  p("{{#if client.phone}}") +
  p("Phone {{client.phone}}") +
  p("{{/if}}") +
  p("Closing: {{matter.dates.closing_date|long}}") +
  p("Address: {{custom.address}}");

test("assembly: python-docx opens the generated file and sees the filled text", { skip: !hasPythonDocx() && "python-docx not installed" }, () => {
  const { dir, cleanup } = tempDir();
  try {
    const out = join(dir, "filled.docx");
    writeFileSync(out, fillDocx(makeDocx(WORD_TEMPLATE_BODY), data).output);
    const r = spawnSync(
      "python3",
      ["-I", "-c", "import docx,sys\nd=docx.Document(sys.argv[1])\nprint('\\n'.join(p.text for p in d.paragraphs))", out],
      { encoding: "utf8" },
    );
    assert.equal(r.status, 0, r.stderr);
    assert.equal(
      r.stdout.trimEnd(),
      "Engagement of Smith & Sons <Holdings>\nMatter 2026-0042: Smith asset purchase\nClosing: December 15, 2026\nAddress: 100 Main St\nTopeka, KS 66603",
    );
  } finally {
    cleanup();
  }
});

test("assembly: a template saved by python-docx (a real Word writer) fills correctly", { skip: !hasPythonDocx() && "python-docx not installed" }, () => {
  const { dir, cleanup } = tempDir();
  try {
    const src = join(dir, "tpl.docx");
    const made = spawnSync(
      "python3",
      [
        "-I",
        "-c",
        [
          "import docx,sys",
          "d=docx.Document()",
          "par=d.add_paragraph('Dear ')",
          "r=par.add_run('{{client.'); r.bold=True",
          "par.add_run('name}},')",
          "d.add_paragraph('{{#if client.phone}}')",
          "d.add_paragraph('Phone: {{client.phone}}')",
          "d.add_paragraph('{{/if}}')",
          "t=d.add_table(rows=1, cols=2)",
          "t.cell(0,0).text='Matter'",
          "t.cell(0,1).text='{{matter.number}}'",
          "d.sections[0].header.paragraphs[0].text='{{matter.name}}'",
          "d.save(sys.argv[1])",
        ].join("\n"),
        src,
      ],
      { encoding: "utf8" },
    );
    assert.equal(made.status, 0, made.stderr);
    const out = join(dir, "out.docx");
    writeFileSync(out, fillDocx(readFileSync(src), data).output);
    const r = spawnSync(
      "python3",
      [
        "-I",
        "-c",
        "import docx,sys\nd=docx.Document(sys.argv[1])\nprint('|'.join(p.text for p in d.paragraphs))\nprint(d.tables[0].cell(0,1).text)\nprint(d.sections[0].header.paragraphs[0].text)",
        out,
      ],
      { encoding: "utf8" },
    );
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.stdout.trimEnd().split("\n"), ["Dear Smith & Sons <Holdings>,", "2026-0042", "Smith asset purchase"]);
  } finally {
    cleanup();
  }
});

test("assembly: LibreOffice opens the generated file", { skip: !hasSoffice() && "LibreOffice not installed", timeout: 120_000 }, () => {
  const { dir, cleanup } = tempDir();
  try {
    const out = join(dir, "filled.docx");
    writeFileSync(out, fillDocx(makeDocx(WORD_TEMPLATE_BODY), data).output);
    const r = spawnSync("soffice", [`-env:UserInstallation=file://${dir}/profile`, "--headless", "--convert-to", "txt:Text", "--outdir", dir, out], {
      encoding: "utf8",
      timeout: 110_000,
    });
    assert.equal(r.status, 0, r.stderr);
    const txt = readFileSync(join(dir, "filled.txt"), "utf8").replace(/^﻿/, "");
    assert.match(txt, /Engagement of Smith & Sons <Holdings>/);
    assert.match(txt, /Closing: December 15, 2026/);
    assert.doesNotMatch(txt, /\{\{/);
  } finally {
    cleanup();
  }
});
