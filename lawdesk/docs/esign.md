# Electronic signatures

Staff send a document on a matter for signature. The signer gets a private link, opens the
document, agrees to sign electronically (or asks for paper), types their name, optionally draws a
signature, confirms they intend to sign, and signs. Lawdesk keeps a tamper-evident audit trail
and saves a **Certificate of completion** PDF next to the document in the matter's documents.

This is software documentation, not legal advice. What follows is what the statutes say and what
the software does to line up with them. It is **not** a claim that any particular signature is
valid or enforceable; that depends on the document, the parties and the facts.

## How it works

1. **Send.** On the matter (Signatures card) or on a document, staff choose a PDF or Word document
   and enter the signer's name and email. Lawdesk hashes the exact stored file (SHA-256) and makes
   a random link (only the token's hash is stored) that works for 1 to 90 days (default 14, set in
   Settings > Electronic signatures). Staff copy the link or email it from their own mail program.
2. **Open.** The signing page shows the firm, the document name and any note. The signer must open
   the document (served from Lawdesk, with the version that was sent) before they can tick
   "I opened the document and could read it". A text preview is offered where available.
3. **Consent.** The signer reads the disclosure (below) and ticks two boxes: that they could open
   and read the document, and that they agree to electronic records and signatures for it. Or
   they choose "I'd rather sign on paper", which closes the link and tells the firm.
4. **Sign.** The signer types their full name, may draw a signature (stored as a PNG), and ticks
   "I intend to sign …". On signing, Lawdesk re-reads the stored file and checks its hash; if the
   file changed after it was sent, signing is refused.
5. **Certificate.** A PDF certificate is generated and saved to the same folder as
   "<document> - certificate of completion.pdf". It lists the document and its SHA-256 before and
   after signing, the signer, typed name, drawn signature image and its hash, the consent version,
   its full text and hash, every audit event (time in Central and UTC, IP address, browser) with
   its chain hash, and whether the chain verified. The signer can download the document and the
   certificate from the signing page for 90 days.

The signature itself is recorded in the certificate and audit trail. The original document file
is not altered, so its hash after signing equals its hash before; that is the evidence it was not
changed. (Stamping the signature onto the PDF's pages is not done; see Gaps.)

### Audit trail

`esign_events` is append-only (SQLite triggers refuse UPDATE and DELETE). Each row stores the
previous row's hash and its own hash over its contents, so editing any row breaks the chain;
`verifyChain` checks it and the certificate reports the result. Events: sent, resent, opened,
document_viewed, consented, signed, declined, cancelled, expired, certificate_created. Each
records time, IP address and user agent. Behind a reverse proxy, set `LAWDESK_TRUST_PROXY=1` so
the first `X-Forwarded-For` address is used; otherwise the socket address is recorded.

### Files

| Piece | File |
| --- | --- |
| Requests, consent, signing, audit chain | `src/esign/esign.ts` |
| Disclosure text (versioned) | `src/esign/consent.ts` |
| Certificate PDF | `src/esign/certificate.ts`, `src/esign/pdf.ts` |
| PNG check / decode for drawn signatures | `src/esign/png.ts` |
| Provider interface; DocuSign and Dropbox Sign stubs | `src/esign/providers.ts` |
| Tables and triggers | `src/esign/schema.ts` |
| Routes | `src/esign/routes.ts` |
| Signing page | `public/sign.html`, `public/js/public/sign.js` |
| Staff screens | `public/js/views/pay-esign.js` |

Only the built-in provider works. The DocuSign and Dropbox Sign classes implement the same
interface and refuse with "not available" so an integration can be added later without changing
callers.

### Routes that must be public

Signers have no Lawdesk sign-in. These routes are marked `public: true` in
`src/esign/routes.ts` and are protected only by the unguessable token; the sign-in module must let
them through:

- `GET /api/esign/public/:token` (page data), `GET …/document`, `GET …/certificate`
- `POST /api/esign/public/:token/consent`, `…/decline`, `…/sign`

Set `LAWDESK_PUBLIC_URL` so links point at the address signers can reach.

## The law

### Federal: ESIGN Act, 15 U.S.C. 7001 et seq.

- **Legal effect.** §7001(a): in a transaction in or affecting interstate or foreign commerce, a
  signature, contract or other record "may not be denied legal effect, validity, or enforceability
  solely because it is in electronic form", and a contract may not be denied effect solely because
  an electronic signature or record was used in its formation.
  <https://www.law.cornell.edu/uscode/text/15/7001>
- **No one is forced to go electronic.** §7001(b)(2): the Act does not require any person to agree
  to use or accept electronic records or signatures.
- **Consumer consent and disclosures.** §7001(c)(1): where a law requires information to be given
  to a consumer in writing, an electronic record satisfies it only if the consumer has
  affirmatively consented and, before consenting, was given a clear and conspicuous statement of:
  the right to have the record on paper; the right to withdraw consent and its conditions,
  consequences and any fees; whether consent covers only the particular transaction; how to
  withdraw consent and update contact information; how to get a paper copy and whether a fee is
  charged; and the hardware and software requirements. The consumer must consent, or confirm
  consent, electronically "in a manner that reasonably demonstrates that the consumer can access
  information in the electronic form that will be used". §7001(c)(3): failure to get that consent
  does not by itself deny effect to a contract.
- **Retention.** §7001(d)(1): where a law requires a record to be retained, an electronic record
  works if it "accurately reflects the information set forth in the contract or other record" and
  "remains accessible" to all entitled persons for the required period in a form capable of being
  accurately reproduced. §7001(e): if a law requires a contract to be in writing, an electronic
  record may be denied effect if it is not in a form "capable of being retained and accurately
  reproduced" by all parties entitled to retain it.
- **Exceptions.** §7003 (<https://www.law.cornell.edu/uscode/text/15/7003>): §7001 does not apply
  to records governed by laws on wills, codicils or testamentary trusts; by state laws on adoption,
  divorce or other family law matters; by the UCC other than §§1-107 and 1-206 and Articles 2 and
  2A; to court orders, notices and official court documents (including briefs and pleadings)
  required to be executed in connection with court proceedings; and to certain notices (utility
  cutoff, foreclosure and eviction, insurance cancellation, product recalls) and hazardous-material
  documents.
- **Definitions.** §7006 (<https://www.law.cornell.edu/uscode/text/15/7006>): an *electronic
  signature* is "an electronic sound, symbol, or process, attached to or logically associated with
  a contract or other record and executed or adopted by a person with the intent to sign the
  record"; also *consumer* (1), *electronic record* (4) and *record* (9).

### Kansas: Uniform Electronic Transactions Act, K.S.A. 16-1601 et seq.

- **Definitions**, K.S.A. 16-1602 (<https://ksrevisor.gov/statutes/chapters/ch16/016_016_0002.html>):
  electronic record, electronic signature ("an electronic sound, symbol, or process attached to or
  logically associated with a record and executed or adopted by a person with the intent to sign
  the record"), record, and *security procedure*.
- **Scope**, K.S.A. 16-1603 (<https://ksrevisor.gov/statutes/chapters/ch16/016_016_0003.html>): the
  Act does not apply to a transaction to the extent it is governed by the law on wills, codicils or
  testamentary trusts, or by the UCC other than K.S.A. 84-1-306 and Articles 2 and 2a; and a
  transaction under the Act "is also subject to other applicable substantive law".
- **Agreement to deal electronically**, K.S.A. 16-1605
  (<https://ksrevisor.gov/statutes/chapters/ch16/016_016_0005.html>): the Act applies only to
  transactions between parties "each of which has agreed to conduct transactions by electronic
  means", judged from "the context and surrounding circumstances, including the parties' conduct".
  A party that agreed once "may refuse to conduct other transactions by electronic means", and that
  right "may not be waived by agreement".
- **Legal recognition**, K.S.A. 16-1607 (<https://ksrevisor.gov/statutes/chapters/ch16/016_016_0007.html>):
  a record or signature may not be denied legal effect solely because it is electronic; if a law
  requires a record in writing or a signature, an electronic record or signature satisfies it.
- **Providing information in writing**, K.S.A. 16-1608(a)
  (<https://ksrevisor.gov/statutes/chapters/ch16/016_016_0008.html>): where the parties agreed to
  deal electronically and a law requires information to be provided in writing, an electronic
  record satisfies it only if it is capable of retention by the recipient when received; it is not
  if the sender inhibits the recipient's ability to print or store it.
- **Attribution**, K.S.A. 16-1609 (<https://ksrevisor.gov/statutes/chapters/ch16/016_016_0009.html>):
  an electronic signature is attributable to a person "if it was the act of the person", which
  "may be shown in any manner, including a showing of the efficacy of any security procedure".
- **Retention**, K.S.A. 16-1612 (<https://ksrevisor.gov/statutes/chapters/ch16/016_016_0012.html>):
  a retention requirement is met by an electronic record that accurately reflects the information
  and remains accessible for later reference.
- **Evidence**, K.S.A. 16-1613 (<https://ksrevisor.gov/statutes/chapters/ch16/016_016_0013.html>):
  a record or signature may not be excluded from evidence solely because it is electronic.

## How the software lines up with the sources

| Requirement | Source | What Lawdesk does |
| --- | --- | --- |
| Parties agree to deal electronically; may refuse | K.S.A. 16-1605; 15 U.S.C. 7001(b)(2) | Explicit consent step before signing; "I'd rather sign on paper" on every page until signed; declining closes the link and is logged. |
| Consumer disclosures before consent | 15 U.S.C. 7001(c)(1)(B), (C)(i) | The 7-item disclosure in `src/esign/consent.ts` covers paper option and fee, scope, withdrawal and its consequences, updating contact details, paper copies, and hardware/software. Shown to every signer, consumer or not. Its exact text, version and hash are stored with the signature. |
| Consent showing ability to access | 15 U.S.C. 7001(c)(1)(C)(ii) | The signer must open the document in the form used (logged as `document_viewed`) before the "I opened the document and could read it" box is enabled; consent is refused server-side otherwise. |
| Intent to sign | 15 U.S.C. 7006(5); K.S.A. 16-1602 | Separate "I intend to sign …" box plus the typed name; both required by the server. |
| Attribution | K.S.A. 16-1609 | Evidence only: unguessable single-purpose link sent to the signer, IP address, user agent, timestamps, hash-chained log. There is no identity check beyond possession of the link (no SMS code, no ID check). |
| Signer can keep a copy | 15 U.S.C. 7001(e); K.S.A. 16-1608(a) | Document and certificate downloadable from the signing page for 90 days; nothing blocks printing or saving. |
| Accurate, accessible retention | 15 U.S.C. 7001(d); K.S.A. 16-1612 | Document hash before and after; signing refused if the file changed; certificate saved to the matter's documents; append-only audit trail. |

### Documents this should not be used for

Do not use electronic signing in Lawdesk for **wills, codicils or testamentary trusts**
(excluded by both K.S.A. 16-1603(b)(1) and 15 U.S.C. 7003(a)(1)); and treat with care, under
other law, **family-law records** (adoption, divorce: ESIGN 7003(a)(2)), **court orders, pleadings
and other official court documents** (7003(b)(1)), and documents that by other law need a
notary, witnesses or a wet signature. The software does not detect these; the sending lawyer
decides. Notarization is not supported.

## Gaps

- The signature is not drawn onto the PDF's pages; the evidence is the separate certificate tied
  to the document by its SHA-256.
- No identity verification beyond the link (no access code, SMS, or knowledge-based check).
- One signer per request; no signing order or multiple parties.
- No email sending: staff copy the link or use the *Email* button (their mail program).
- DocuSign and Dropbox Sign are stubs only.
- Certificate times are shown in America/Chicago and UTC.
- The sign-in module must honour `public: true` on the routes above.
