import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildMessage,
  encodeQuotedPrintable,
  encodeWords,
  foldHeader,
  formatAddress,
  formatDate,
  isValidAddress,
  parseAddressList,
  textToHtml,
} from "../../src/email/mime.ts";
import { decodeCharset, decodeQuotedPrintable, decodeWords, parseMessage, parseParams } from "../../src/email/parse.ts";

const from = { name: "Example Law Office", address: "office@firm.example.test" };

test("mime: address checks", () => {
  assert.ok(isValidAddress("ann.smith+x@example.test"));
  for (const bad of ["", "ann", "ann@", "@x.test", "ann@x", "a b@x.test", "ann@x.test\r\nBcc: evil@x.test", "a..b@x.test", ".a@x.test"]) {
    assert.ok(!isValidAddress(bad), bad);
  }
});

test("mime: display names are quoted or encoded", () => {
  assert.equal(formatAddress({ name: "Ann Smith", address: "ann@x.test" }), "Ann Smith <ann@x.test>");
  assert.equal(formatAddress({ name: 'Smith, Ann "AJ"', address: "ann@x.test" }), '"Smith, Ann \\"AJ\\"" <ann@x.test>');
  const enc = formatAddress({ name: "José Núñez", address: "jose@x.test" });
  assert.match(enc, /^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?= <jose@x\.test>$/);
  assert.equal(decodeWords(enc.split(" <")[0]), "José Núñez");
});

test("mime: encoded words stay within 75 characters and never split a character", () => {
  const long = "Résumé — ".repeat(20) + "😀";
  const enc = encodeWords(long);
  for (const w of enc.split("\r\n ")) assert.ok(w.length <= 75, `${w.length}`);
  assert.equal(decodeWords(enc), long);
});

test("mime: long ASCII headers fold at spaces", () => {
  const f = foldHeader("Subject", "word ".repeat(40).trim());
  for (const line of f.split("\r\n")) assert.ok(line.length <= 78);
  assert.equal(f.replace(/\r\n /g, " "), "Subject: " + "word ".repeat(40).trim());
});

test("mime: quoted-printable round-trips and keeps lines at 76", () => {
  const s = "Total due: $1,000 = paid?\nCafé crème — naïve. Trailing space \n" + "x".repeat(200);
  const qp = encodeQuotedPrintable(s);
  for (const line of qp.split("\r\n")) assert.ok(line.length <= 76, line);
  assert.match(qp, /=3D/);
  assert.match(qp, /space=20\r\n/);
  assert.equal(decodeQuotedPrintable(qp).toString("utf8"), s.replace(/\n/g, "\r\n"));
});

test("mime: RFC 5322 date", () => {
  assert.equal(formatDate(new Date("2026-11-18T15:04:05Z")), "Wed, 18 Nov 2026 15:04:05 +0000");
});

test("mime: header injection is refused", () => {
  assert.throws(() => buildMessage({ from, to: [{ address: "a@x.test" }], subject: "Hi\r\nBcc: evil@x.test", text: "x" }), /line breaks/);
  assert.throws(() => buildMessage({ from, to: [{ address: "a@x.test\r\nBcc: e@x.test" }], subject: "Hi", text: "x" }), /not a valid/);
  assert.throws(() => buildMessage({ from, to: [], subject: "Hi", text: "x" }), /recipient/);
});

test("mime: text + html + attachments build and parse back", () => {
  const pdf = Buffer.from("%PDF-1.4\n" + "0123456789".repeat(50));
  const built = buildMessage({
    from,
    to: [{ name: "Dana Client", address: "dana@client.example.test" }],
    cc: [{ address: "pat@firm.example.test" }],
    bcc: [{ address: "file@firm.example.test" }],
    replyTo: { name: "Avery Attorney", address: "avery@firm.example.test" },
    subject: "Closing documents for “Main St.” — please review",
    text: "Dear Dana,\n\nPlease review the attached.\n.\nThanks",
    html: textToHtml("Dear Dana,\n\nPlease review <the> attached."),
    attachments: [
      { filename: "Purchase agreement.pdf", contentType: "application/pdf", data: pdf },
      { filename: "Notes für Dana.txt", contentType: "text/plain", data: Buffer.from("ünïcode") },
    ],
    date: new Date("2026-11-18T15:00:00Z"),
  });
  const raw = built.raw.toString("latin1");
  assert.ok(/^[\x00-\x7f]*$/.test(raw), "the message is 7-bit");
  assert.ok(!/\r(?!\n)|(?<!\r)\n/.test(raw), "only CRLF line ends");
  assert.ok(!/^Bcc:/m.test(raw), "no Bcc header");
  assert.deepEqual(built.envelope.to, ["dana@client.example.test", "pat@firm.example.test", "file@firm.example.test"]);
  assert.match(raw, /^Message-ID: <[0-9a-f]+\.[0-9a-z]+@firm\.example\.test>$/m);
  assert.match(raw, /^MIME-Version: 1\.0$/m);
  assert.match(raw, /multipart\/mixed/);
  assert.match(raw, /multipart\/alternative/);
  assert.match(raw, /filename\*=UTF-8''Notes%20f%C3%BCr%20Dana\.txt/);

  const p = parseMessage(built.raw);
  assert.equal(p.subject, "Closing documents for “Main St.” — please review");
  assert.deepEqual(p.from, [{ name: "Example Law Office", address: "office@firm.example.test" }]);
  assert.deepEqual(p.to, [{ name: "Dana Client", address: "dana@client.example.test" }]);
  assert.equal(p.cc[0].address, "pat@firm.example.test");
  assert.equal(p.replyTo[0].name, "Avery Attorney");
  assert.equal(p.date, "2026-11-18T15:00:00.000Z");
  assert.equal(p.messageId, built.messageId);
  assert.equal(p.text, "Dear Dana,\n\nPlease review the attached.\n.\nThanks");
  assert.match(p.html!, /&lt;the&gt;/);
  assert.equal(p.attachments.length, 2);
  assert.equal(p.attachments[0].filename, "Purchase agreement.pdf");
  assert.ok(p.attachments[0].data.equals(pdf));
  assert.equal(p.attachments[1].filename, "Notes für Dana.txt");
  assert.equal(p.attachments[1].data.toString("utf8"), "ünïcode");
});

test("mime: address lists with quotes, comments and groups", () => {
  assert.deepEqual(parseAddressList('"Smith, Ann" <ann@x.test>, bob@x.test; carl@x.test (Carl C)'), [
    { name: "Smith, Ann", address: "ann@x.test" },
    { name: null, address: "bob@x.test" },
    { name: "Carl C", address: "carl@x.test" },
  ]);
  assert.deepEqual(parseAddressList("undisclosed-recipients:;"), []);
});

test("mime: textToHtml escapes", () => {
  const h = textToHtml(`<script>alert("x")</script>\nline two`);
  assert.ok(!h.includes("<script>"));
  assert.match(h, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;<br>line two/);
});

test("parse: params with quotes, RFC 2231 continuations and charsets", () => {
  const p = parseParams(`attachment; filename*0*=iso-8859-1''Caf%E9%20; filename*1="menu.pdf"; size=12`);
  assert.equal(p.value, "attachment");
  assert.equal(p.params.filename, "Café menu.pdf");
  assert.equal(parseParams(`text/plain; charset="UTF-8"; name="a;b.txt"`).params.name, "a;b.txt");
});

test("parse: charsets", () => {
  assert.equal(decodeCharset(Buffer.from([0x43, 0x61, 0x66, 0xe9]), "iso-8859-1"), "Café");
  assert.equal(decodeCharset(Buffer.from("Café", "utf8"), "utf-8"), "Café");
  assert.equal(decodeCharset(Buffer.from([0x93, 0x68, 0x69, 0x94]), "windows-1252"), "“hi”");
  // Unknown label, bytes not UTF-8: read as Windows-1252.
  assert.equal(decodeCharset(Buffer.from([0x43, 0x61, 0x66, 0xe9]), "x-unknown"), "Café");
  assert.equal(decodeWords("=?iso-8859-1?Q?Caf=E9_cr=E8me?= =?utf-8?B?4oCU?= done"), "Café crème— done");
});
