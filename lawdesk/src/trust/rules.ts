// The Kansas rules this module relies on, with the operative text as read from the source.
// Shown in the app ("Rules this follows") and in docs/trust.md. Every quotation here was
// read from the page named in SOURCES on 2026-11-18. Nothing here is from memory: anything
// that could not be read from a primary source is listed in GAPS instead.

export const SOURCES = {
  rule115: {
    title: "Kansas Supreme Court Rule 240, Kansas Rule of Professional Conduct 1.15: Safekeeping Property",
    url: "https://16jd.kscourts.gov/Rules-Orders/Rules/1-15-Client-Lawyer-Relationship-Safekeeping-Proper",
    alsoAt: "https://11jd.kscourts.gov/KSCourts/media/KsCourts/Rules/RULE-1-15.pdf?ext=.pdf",
  },
  rule236: {
    title: "Kansas Supreme Court Rule 236: Compliance Examination by the Disciplinary Administrator",
    url: "https://12jd.kscourts.gov/Rules-Orders/Rules/Rule-236",
  },
  overdraft: {
    title: "Bank-Attorney Trust Account Overdraft Agreement (Kansas Disciplinary Administrator form)",
    url: "https://11jd.kscourts.gov/KSCourts/media/KsCourts/Attorney%20Discipline/Bank-Attorney-Trust-Account-Overdraft-Agreement.pdf",
  },
  handbook: {
    title: "Kansas Lawyer Trust Account Handbook (rev. April 2025), Office of the Disciplinary Administrator",
    url: "https://kscourts.gov/KSCourts/media/KsCourts/Attorney%20Discipline/Trust-Account-Handbook-Rev-04-2025.pdf",
    read: false,
  },
} as const;

export interface RuleRef {
  id: string;
  cite: string;
  quote: string;
  /** What the app does because of it. */
  applied: string;
}

export const RULES: RuleRef[] = [
  {
    id: "separate-kansas",
    cite: "KRPC 1.15(a) (Kan. Sup. Ct. R. 240)",
    quote: "Funds shall be kept in a separate account maintained in the state of Kansas.",
    applied: "A trust account can only be set up after confirming it is a separate account at a bank in Kansas.",
  },
  {
    id: "retention",
    cite: "KRPC 1.15(a) (Kan. Sup. Ct. R. 240)",
    quote:
      "Complete records of such account funds and other property shall be kept by the lawyer … shall be preserved for a period of five years after termination of the representation.",
    applied:
      "Trust records can never be deleted in Lawdesk. Each ledger shows its keep-until date: five years after the matter was closed (the app treats closing the matter as the end of the representation).",
  },
  {
    id: "all-client-funds",
    cite: "KRPC 1.15(d)(1)",
    quote: "All funds of clients paid to a lawyer or law firm, including advances for costs and expenses, shall be deposited …",
    applied: "Every deposit is recorded to a named client and matter.",
  },
  {
    id: "bank-charges",
    cite: "KRPC 1.15(d)(1)(i)",
    quote: "Funds reasonably sufficient to pay bank charges may be deposited therein.",
    applied:
      "The only firm money allowed in trust is a separate “firm funds for bank charges” ledger, capped at a limit the lawyer sets. Bank charges are taken only from that ledger, never from a client.",
  },
  {
    id: "lawyer-portion",
    cite: "KRPC 1.15(d)(1)(ii)",
    quote: "the portion belonging to the lawyer or law firm may be withdrawn when due … the disputed portion shall not be withdrawn until the dispute is finally resolved.",
    applied:
      "Earned fees leave trust only against a finalized invoice, for no more than is owed on it. Disputed amounts can be put on hold, and held money cannot be paid out until the hold is released.",
  },
  {
    id: "records",
    cite: "KRPC 1.15(d)(2)(iii)",
    quote: "Maintain complete records of all funds, securities, and other properties of a client … render appropriate accountings to the client regarding them.",
    applied: "Append-only journal, a ledger for every client matter, and a printable client ledger statement.",
  },
  {
    id: "notify",
    cite: "KRPC 1.15(b), (d)(2)(i)",
    quote: "Upon receiving funds or other property in which a client or third person has an interest, … a lawyer shall promptly notify the client or third person.",
    applied: "Lawdesk does not send this notice; the deposit screen reminds the user to notify the client. (Gap G7.)",
  },
  {
    id: "iolta-interest",
    cite: "KRPC 1.15(d)(3)(iii)(aa)",
    quote: "to remit at least quarterly, to the Kansas Bar Foundation, Inc., interest or dividends …",
    applied:
      "On an IOLTA account, interest is never credited to a client or the firm in Lawdesk: the bank sends it to the Kansas Bar Foundation. Interest can only be recorded on a non-IOLTA account, to a client ledger.",
  },
  {
    id: "overdraft",
    cite: "KRPC 1.15(f); Bank-Attorney Trust Account Overdraft Agreement",
    quote: "within (five) 5 banking days of presentation for payments against insufficient funds",
    applied: "Information only: the bank reports trust overdrafts to the Disciplinary Administrator. Lawdesk refuses any entry that would take a ledger below zero.",
  },
  {
    id: "examination",
    cite: "Kan. Sup. Ct. R. 236",
    quote: "records and accounts are being maintained in accordance with applicable rules",
    applied: "Every report prints from the same permanent journal, so the records can be produced for a compliance examination.",
  },
];

export interface Gap {
  id: string;
  what: string;
  whatTheAppDoes: string;
}

export const GAPS: Gap[] = [
  {
    id: "G1",
    what:
      "The Kansas Lawyer Trust Account Handbook (rev. April 2025) could not be loaded from this build environment, so none of its guidance has been read or encoded. That includes any requirement on how often to reconcile, what a three-way reconciliation must show, journal and ledger formats, and how to handle bank fees, interest and returned items.",
    whatTheAppDoes:
      "Reconciliation is monthly and three-way because the firm asked for it. Compare every screen and report against the handbook before use.",
  },
  {
    id: "G2",
    what: "Whether Kansas forbids disbursing against deposits that have not yet cleared was not verified.",
    whatTheAppDoes:
      "Each deposit shows Cleared / Not cleared. Each account has a setting, on by default, that refuses to pay out money that has not cleared. That is a firm policy, not a verified rule.",
  },
  {
    id: "G3",
    what: "How much firm money is “reasonably sufficient to pay bank charges” is not stated in the rule text read.",
    whatTheAppDoes: "The lawyer enters the limit for each account; no firm money can be deposited until it is set.",
  },
  {
    id: "G4",
    what: "What to do when a deposited check is returned after the money was paid out was not verified.",
    whatTheAppDoes:
      "Lawdesk refuses any entry that would take a ledger below zero, with no override. The bank and books will then disagree, and the reconciliation shows the difference until the lawyer resolves it.",
  },
  {
    id: "G5",
    what: "Rules on cash withdrawals, ATM or debit cards, and who may sign trust checks were not verified.",
    whatTheAppDoes: "Payments can only be recorded as a numbered check, an EFT or a wire, always to a named payee.",
  },
  {
    id: "G6",
    what: "How to handle unclaimed or long-inactive trust balances (unclaimed property law) was not verified.",
    whatTheAppDoes: "The inactive balances report lists them; what to do with them is the lawyer's decision.",
  },
  {
    id: "G7",
    what: "Lawdesk does not send the client notice of receipt required by KRPC 1.15(b) and (d)(2)(i).",
    whatTheAppDoes: "The deposit form reminds the user. The firm must send and keep the notice.",
  },
  {
    id: "G8",
    what: "The comments to Rule 1.15 (for example on interest earned on client funds and the kinds of trust account allowed) were read only in summary, not word for word.",
    whatTheAppDoes: "No requirement is encoded from the comments.",
  },
];

/** KRPC 1.15(a): five years after the representation ends. */
export const RETENTION_YEARS = 5;
