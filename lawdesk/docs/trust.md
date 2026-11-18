# Client trust (IOLTA) accounting

> **Must be reviewed before real use.** This module has not been reviewed by an accountant, by the
> firm's responsible lawyer, or by the Kansas Disciplinary Administrator. The lawyer and an accountant
> must check it against the rules and the Disciplinary Administrator's Trust Account Handbook, and
> test it with made-up data, before any real client money is recorded in it. A trust accounting
> error can lead to discipline. Nothing here is legal advice.

Code: `src/trust/` (schema, logic, rules, printable reports, routes). Screens: `public/js/views/trust.js`,
styles in `public/css/trust.css`. Tests: `tests/trust/`.

## Sources

Read on 2026-11-18:

| Source | URL | Status |
| --- | --- | --- |
| Kansas Supreme Court Rule 240, KRPC 1.15 Safekeeping Property | https://16jd.kscourts.gov/Rules-Orders/Rules/1-15-Client-Lawyer-Relationship-Safekeeping-Proper (same rule as PDF: https://11jd.kscourts.gov/KSCourts/media/KsCourts/Rules/RULE-1-15.pdf?ext=.pdf) | Read. Quotations below are from this page. |
| Kansas Supreme Court Rule 236, Compliance Examination by the Disciplinary Administrator | https://12jd.kscourts.gov/Rules-Orders/Rules/Rule-236 | Read (summary and short quotations). |
| Bank-Attorney Trust Account Overdraft Agreement (Disciplinary Administrator form) | https://11jd.kscourts.gov/KSCourts/media/KsCourts/Attorney%20Discipline/Bank-Attorney-Trust-Account-Overdraft-Agreement.pdf | Read. |
| Kansas Lawyer Trust Account Handbook, rev. April 2025 | https://kscourts.gov/KSCourts/media/KsCourts/Attorney%20Discipline/Trust-Account-Handbook-Rev-04-2025.pdf | **Not read.** The file could not be loaded from the build environment (blocked by the network proxy; the fetch tool also failed on it and on the September 2023 copy listed at https://registration-kard.kscourts.gov/PortalFile/Resources). Nothing in this module comes from it. |

Note on numbering: the court's site publishes KRPC 1.15 as **Supreme Court Rule 240** ("Rule 240 1.15:
Safekeeping Property"), not Rule 226. Citations here use "KRPC 1.15 (Kan. Sup. Ct. R. 240)".

The rule text was read through a tool that returns quotations in short pieces. Where a sentence was
read in pieces, the quotation marks the join with "…". None of the quotations is from memory.

## Rules encoded, with the text relied on

| Rule | Text read | What Lawdesk does | Where |
| --- | --- | --- | --- |
| KRPC 1.15(a) | "Funds shall be kept in a separate account maintained in the state of Kansas." | An account can't be created without confirming it is a separate trust account at a bank in Kansas; the database column requires it. | `createAccount`, `trust_accounts.in_kansas` |
| KRPC 1.15(a), retention | "Complete records of such account funds and other property shall be kept by the lawyer … shall be preserved for a period of five years after termination of the representation." | Nothing in trust can be deleted (database triggers). Each ledger shows "keep until" = matter closing date + 5 years; open matters say "five years after the representation ends". Shown on ledger statements, balance reports and the Reports screen. Assumption: closing the matter in Lawdesk marks the end of the representation. | `retention()`, `RETENTION_YEARS` |
| KRPC 1.15(d)(1) | "All funds of clients paid to a lawyer or law firm, including advances for costs and expenses, shall be deposited …" | Every deposit is to a named client matter's ledger. | `deposit` |
| KRPC 1.15(d)(1)(i) | "Funds reasonably sufficient to pay bank charges may be deposited therein." | The only firm money allowed is on a separate "firm funds for bank charges" ledger, capped at a limit the lawyer sets per account (none allowed until set). Bank charges are taken only from that ledger and are refused if it can't cover them; they are never charged to a client. | `firmDeposit`, `bankFee` |
| KRPC 1.15(d)(1)(ii) | "the portion belonging to the lawyer or law firm may be withdrawn when due" … "the disputed portion shall not be withdrawn until the dispute is finally resolved." | Earned fees leave trust only against a **finalized** invoice for the same client and matter, for no more than its unpaid balance; the transfer records a payment on the invoice in billing in the same database transaction. Disputed amounts can be put on hold; held money can't be paid out, transferred or moved to operating until the hold is released with a reason. | `transferFee`, `placeHold`, `releaseHold` |
| KRPC 1.15(d)(2)(iii) | "Maintain complete records of all funds, securities, and other properties of a client" … "render appropriate accountings to the client regarding them." | Append-only journal, a ledger per client matter, printable client ledger statement. | `journal`, `ledger`, `render.ts` |
| KRPC 1.15(b), (d)(2)(i) | "Upon receiving funds or other property in which a client or third person has an interest," … "a lawyer shall promptly notify the client or third person." / "Promptly notify a client of the receipt of the client's funds, securities, or other properties." | Not automated. The deposit form reminds the user to notify the client (gap G7). | deposit form |
| KRPC 1.15(d)(3)(iii)(aa) | "to remit at least quarterly, to the Kansas Bar Foundation, Inc., interest or dividends" | Interest can't be recorded on an IOLTA account (the bank remits it to the Kansas Bar Foundation). On a non-IOLTA account interest is credited to a client ledger. | `interest` |
| KRPC 1.15(d)(3)(iv)(aa) | "shall file a Notice of Declination with the Clerk of the Appellate Courts" | Information only; Lawdesk does not track declinations. | — |
| KRPC 1.15(f); overdraft agreement | Banks report "within (five) 5 banking days of presentation for payments against insufficient funds" | Information only. Lawdesk refuses any entry that would take a ledger below zero. | — |
| Rule 236 | Examinations check that "records and accounts are being maintained in accordance with applicable rules" | All reports come from the same permanent journal and can be printed for an examiner. | reports |

## Rules the firm asked for (not taken from a source read)

These are built because the firm asked for them; they are sound practice but were **not** verified as
Kansas requirements:

- **No negative client ledger, ever, with no override.** Checked over the whole running balance (so a
  back-dated payment can't spend money that arrived later) and again by a database trigger.
- **Monthly three-way reconciliation**: statement ending balance adjusted for deposits in transit and
  outstanding checks, vs. the journal balance, vs. the sum of the client ledgers (computed separately
  from the line table). Must agree to the cent with no negative ledger before it can be signed. Signing
  needs a named user; months are signed in order; once signed the row is locked by trigger and no entry
  or clearing date can fall inside that month.
- **Cleared funds.** Every deposit is Cleared or Not cleared. Each account has a setting (on by default)
  that refuses to pay out money whose deposit hasn't cleared (gap G2).
- **Corrections only by reversal.** A reversal names the original entry, needs a reason, is dated on or
  after it, can be made only once, and can't itself be reversed. Reversing an earned-fee transfer voids the
  billing payment it created.
- **Payments only by numbered check, EFT or wire, to a named payee, with a purpose**; check numbers are
  unique per account (gap G5).

## Gaps: not verified, decide before real use

- **G1.** The Trust Account Handbook could not be read. Any handbook requirement on reconciliation
  frequency, the content of a three-way reconciliation, journal and ledger formats, bank fees, interest,
  returned items, or electronic transfers is **not** encoded. Compare every screen and report with it.
- **G2.** Whether Kansas forbids disbursing against uncleared deposits was not verified (the setting is firm policy).
- **G3.** What is "reasonably sufficient" for bank charges: the lawyer sets the limit.
- **G4.** Returned (bounced) deposits after the money was paid out: Lawdesk refuses the entry that would make
  the ledger negative; the books and bank will then disagree until the lawyer resolves it.
- **G5.** Cash withdrawals, debit cards and signatories: not verified; not offered.
- **G6.** Unclaimed or long-inactive balances: the inactive-balances report lists them; the law on what to
  do with them was not verified.
- **G7.** Client notice of receipt is not sent by Lawdesk.
- **G8.** The comments to Rule 1.15 were read only in summary; nothing is encoded from them.
- Trust screens are visible to every user until sign-in exists; they should be limited to attorneys and admins.
- The KRPC 1.15(e) annual certification and IOLTA declination are outside this module.

## Data model

`trust_accounts` → `trust_ledgers` (one per client matter per account, plus one firm bank-charge ledger) →
`trust_txns` (the journal; `amount_cents` is the bank effect) with `trust_lines` (whose ledger moves;
they always sum to the transaction). `trust_clearings` (append-only; latest row is the status),
`trust_holds` / `trust_hold_releases`, `trust_reconciliations` (draft or signed with a JSON snapshot).
Triggers forbid UPDATE/DELETE of accounts' fixed fields, ledgers, entries, lines, clearings, holds,
releases and signed reconciliations, any entry dated inside a signed month, and any line that leaves a
ledger below zero. Every change is written to the activity log through `engine.log`.

## API (under `/api`)

`GET/POST /trust/accounts`, `GET/PATCH /trust/accounts/:id`, `GET /trust/accounts/:id/journal|ledgers|balances|inactive|reconciliations`,
`POST /trust/accounts/:id/deposits|disbursements|fee-transfers|ledger-transfers|firm-deposits|firm-withdrawals|bank-fees|interest`,
`POST /trust/entries/:id/reverse`, `PUT /trust/entries/:id/cleared`, `GET /trust/ledgers/:id`,
`POST /trust/ledgers/:id/holds`, `POST /trust/holds/:id/release`,
`GET|PUT /trust/accounts/:id/reconcile/:yyyy-mm`, `POST …/sign`, `GET /trust/rules`.
Printable HTML: `…/print` on ledgers, journal, balances, inactive, reconciliations (history and one month), and `/trust/rules/print`.
