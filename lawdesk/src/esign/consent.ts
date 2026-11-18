// The disclosure a signer reads and agrees to before signing electronically.
//
// It follows the consumer-disclosure items of the federal ESIGN Act, 15 U.S.C. 7001(c)(1)
// (paper option, right to withdraw and its consequences, scope, how to withdraw and update
// contact details, how to get a paper copy and any fee, hardware and software needed, and
// consent given in a way that shows the signer can open the electronic record), and the
// Kansas UETA rule that the Act applies only where the parties agree to deal electronically
// (K.S.A. 16-1605(b)). It is shown to every signer, consumer or not. See docs/esign.md.
// Changing the wording? Bump CONSENT_VERSION: every signature records the exact text and
// its hash.

import { createHash } from "node:crypto";

export const CONSENT_VERSION = "2026-11-18.1";

export interface ConsentInput {
  firmName: string;
  contactEmail?: string | null;
  contactPhone?: string | null;
  paperFeeCents: number;
  documentName: string;
}

export function consentText(c: ConsentInput): string {
  const firm = c.firmName || "The firm";
  const contact = [c.contactEmail, c.contactPhone].filter(Boolean).join(" or ") || "the firm at its usual address or phone number";
  const fee = c.paperFeeCents > 0 ? `a fee of $${(c.paperFeeCents / 100).toFixed(2)}` : "no charge";
  return [
    `Consent to sign electronically`,
    `${firm} asks to give you the document "${c.documentName}" and to receive your signature on it electronically, instead of on paper.`,
    `1. Paper instead. You do not have to sign electronically. You may ask for a paper copy to sign by hand, for ${fee}. Choose "I'd rather sign on paper" on this page, or contact ${contact}.`,
    `2. What this consent covers. It covers only this document, this signing, and the certificate of completion that records it.`,
    `3. Withdrawing consent. You may withdraw this consent at any time before you sign by choosing "I'd rather sign on paper" or contacting ${contact}. If you withdraw, ${firm} will deal with you on paper for this document; there is ${c.paperFeeCents > 0 ? "the paper fee above" : "no fee"} and no other consequence.`,
    `4. Keeping your contact details current. If your email address changes, tell ${firm} at ${contact}.`,
    `5. Copies. After you sign you can download the document and the certificate of completion from this page. You may also ask ${firm} for a paper copy at any time, for ${fee}.`,
    `6. What you need. A device with a current web browser; a program that can open the document (a PDF viewer, or a word processor for Word files); and the ability to download, save or print files so you can keep a copy.`,
    `7. Showing you can open it. By ticking the boxes below you confirm that you opened the document on this page and could read it, and that you agree to use electronic records and signatures for this document.`,
  ].join("\n\n");
}

export function consentHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
