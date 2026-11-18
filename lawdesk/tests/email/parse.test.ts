import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMessage } from "../../src/email/parse.ts";

// Hand-written messages in the shapes common mail programs produce. All names are made up.

const crlf = (s: string) => s.replace(/\r?\n/g, "\r\n");

test("parse: Latin-1 quoted-printable plain text with folded headers", () => {
  const raw = Buffer.from(
    crlf(`Return-Path: <dana@client.example.test>
From: =?iso-8859-1?Q?Dana_Cl=E9ment?= <dana@client.example.test>
To: "Avery Attorney" <avery@firm.example.test>,
 pat@firm.example.test
Subject: =?iso-8859-1?Q?Re:_Caf=E9_lease?=
 =?iso-8859-1?Q?_renewal?=
Date: Tue, 17 Nov 2026 09:15:00 -0600 (CST)
Message-ID: <abc123@client.example.test>
In-Reply-To: <orig@firm.example.test>
MIME-Version: 1.0
Content-Type: text/plain; charset="iso-8859-1"
Content-Transfer-Encoding: quoted-printable

Bonjour,=0D=0A
The caf=E9 lease is signed. This line is long and has a soft br=
eak in the middle.
`),
    "latin1",
  );
  const p = parseMessage(raw);
  assert.equal(p.subject, "Re: Café lease renewal");
  assert.deepEqual(p.from, [{ name: "Dana Clément", address: "dana@client.example.test" }]);
  assert.deepEqual(
    p.to.map((a) => a.address),
    ["avery@firm.example.test", "pat@firm.example.test"],
  );
  assert.equal(p.date, "2026-11-17T15:15:00.000Z");
  assert.equal(p.messageId, "<abc123@client.example.test>");
  assert.equal(p.inReplyTo, "<orig@firm.example.test>");
  assert.match(p.text, /The café lease is signed\. This line is long and has a soft break in the middle\./);
  assert.equal(p.attachments.length, 0);
});

test("parse: Outlook-style nested multipart with inline image, attachment and forwarded email", () => {
  const inner = crlf(`From: Someone <s@x.test>
Subject: Original offer
Content-Type: text/plain

Offer text.
`);
  const raw = Buffer.from(
    crlf(`From: Dana <dana@client.example.test>
To: avery@firm.example.test
Subject: =?utf-8?B?U2lnbmVkIGFncmVlbWVudCDinJQ=?=
Date: Wed, 18 Nov 2026 10:00:00 +0000
Content-Type: multipart/mixed; boundary="outer"

This is a multi-part message in MIME format.

--outer
Content-Type: multipart/related; boundary=rel

--rel
Content-Type: multipart/alternative; boundary="alt"

--alt
Content-Type: text/plain; charset=utf-8
Content-Transfer-Encoding: base64

${Buffer.from("Please find the signed agreement attached. — Dana").toString("base64")}
--alt
Content-Type: text/html; charset=utf-8

<p>Please find the <b>signed</b> agreement attached.</p><img src="cid:logo">
--alt--

--rel
Content-Type: image/png; name="logo.png"
Content-Disposition: inline; filename="logo.png"
Content-ID: <logo>
Content-Transfer-Encoding: base64

iVBORw0KGgo=
--rel--

--outer
Content-Type: application/pdf; name="=?utf-8?Q?Agreement_=E2=80=93_signed.pdf?="
Content-Disposition: attachment; filename*=utf-8''Agreement%20%E2%80%93%20signed.pdf
Content-Transfer-Encoding: base64

${Buffer.from("%PDF-1.4 fake").toString("base64")}
--outer
Content-Type: message/rfc822

${inner}
--outer--
`),
    "latin1",
  );
  const p = parseMessage(raw);
  assert.equal(p.subject, "Signed agreement ✔");
  assert.equal(p.text, "Please find the signed agreement attached. — Dana");
  assert.match(p.html!, /<b>signed<\/b>/);
  assert.deepEqual(
    p.attachments.map((a) => [a.filename, a.contentType, a.inline]),
    [
      ["logo.png", "image/png", true],
      ["Agreement – signed.pdf", "application/pdf", false],
      ["Original offer.eml", "message/rfc822", false],
    ],
  );
  assert.equal(p.attachments[1].data.toString(), "%PDF-1.4 fake");
  assert.match(p.attachments[2].data.toString(), /Offer text\./);
});

test("parse: HTML-only message gets a text version; raw UTF-8 headers; LF line ends", () => {
  const raw = Buffer.from(
    `From: Zoë <zoe@x.test>\nSubject: Grüße\nContent-Type: text/html; charset=utf-8\n\n<html><body><p>Line one</p><p>Line &amp; two</p><script>bad()</script></body></html>\n`,
    "utf8",
  );
  const p = parseMessage(raw);
  assert.equal(p.subject, "Grüße");
  assert.equal(p.from[0].name, "Zoë");
  assert.equal(p.text, "Line one\nLine & two");
});

test("parse: malformed input never throws", () => {
  for (const s of ["", "garbage", "Content-Type: multipart/mixed; boundary=x\r\n\r\n--x\r\nno end", "Subject: =?bogus?Q?=ZZ?=\r\n\r\nx"]) {
    const p = parseMessage(Buffer.from(s));
    assert.equal(typeof p.text, "string");
  }
  // A missing closing boundary keeps the last part.
  const p = parseMessage(Buffer.from("Content-Type: multipart/mixed; boundary=x\r\n\r\n--x\r\nContent-Type: text/plain\r\n\r\nhello\r\n"));
  assert.equal(p.text.trim(), "hello");
});
