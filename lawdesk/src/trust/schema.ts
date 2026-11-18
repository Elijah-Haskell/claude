// Client trust (IOLTA) accounting tables. See docs/trust.md for the rules this encodes and
// the sources they come from. An accountant and the responsible lawyer must review this
// module before it holds real client money.
//
// Units: money is integer cents. Dates are YYYY-MM-DD. Timestamps are ISO strings.
//
// The journal is append-only. The database itself refuses to UPDATE or DELETE a posted
// transaction, its ledger lines, a clearing record, a disputed-funds hold, or a signed
// reconciliation (triggers at the bottom). Mistakes are corrected only by a reversing
// entry that names the original and gives a reason.
//
// How money is recorded: every transaction (trust_txns) has an amount_cents that is its
// effect on the bank balance (deposit +, check -, transfer between ledgers 0) and one or
// more lines (trust_lines) saying whose ledger it moves. The lines always add up to the
// transaction's amount; the code checks that, and the three-way reconciliation checks it
// again from the two tables independently.

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS trust_accounts (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  bank_name TEXT NOT NULL,
  account_last4 TEXT,                       -- last four digits only; never the full number
  kind TEXT NOT NULL CHECK (kind IN ('iolta','non_iolta')),
  -- KRPC 1.15(a), Kansas Supreme Court Rule 240: "Funds shall be kept in a separate account
  -- maintained in the state of Kansas." The person opening the account confirms it.
  in_kansas INTEGER NOT NULL CHECK (in_kansas = 1),
  -- Firm policy, not a verified rule (docs/trust.md, gap G2): only spend deposits the bank has cleared.
  require_cleared INTEGER NOT NULL DEFAULT 1 CHECK (require_cleared IN (0,1)),
  -- KRPC 1.15(d)(1)(i): "Funds reasonably sufficient to pay bank charges may be deposited therein."
  -- The lawyer decides what is reasonably sufficient; the app refuses firm deposits above it.
  firm_funds_limit_cents INTEGER CHECK (firm_funds_limit_cents IS NULL OR firm_funds_limit_cents >= 0),
  client_name TEXT,                         -- non-IOLTA accounts are usually for one client
  opened_on TEXT NOT NULL,
  closed_on TEXT,
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL
);

-- One ledger per client matter per account, plus one "firm funds for bank charges" ledger
-- per account. The firm ledger is the only place the firm's own money may sit in trust.
CREATE TABLE IF NOT EXISTS trust_ledgers (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES trust_accounts(id),
  kind TEXT NOT NULL CHECK (kind IN ('client','firm')),
  client_id INTEGER REFERENCES contacts(id),
  matter_id INTEGER REFERENCES matters(id),
  created_at TEXT NOT NULL,
  CHECK ((kind = 'client' AND client_id IS NOT NULL AND matter_id IS NOT NULL) OR (kind = 'firm' AND client_id IS NULL AND matter_id IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS trust_ledger_matter ON trust_ledgers(account_id, matter_id) WHERE kind = 'client';
CREATE UNIQUE INDEX IF NOT EXISTS trust_ledger_firm ON trust_ledgers(account_id) WHERE kind = 'firm';

-- The journal.
--   deposit          client money in                         +  one client line
--   disbursement     paid out by check / EFT / wire           -  one client line
--   fee_transfer     earned fee to the operating account      -  one client line, tied to a finalized invoice
--   ledger_transfer  between two client ledgers               0  two lines
--   firm_deposit     firm money to cover bank charges         +  firm line
--   firm_withdrawal  firm money back out                      -  firm line
--   bank_fee         charge taken by the bank                 -  firm line (never a client line)
--   interest         interest on a non-IOLTA account          +  one client line (refused on IOLTA)
--   reversal         undoes one earlier transaction           -original, lines negated
CREATE TABLE IF NOT EXISTS trust_txns (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES trust_accounts(id),
  kind TEXT NOT NULL CHECK (kind IN ('deposit','disbursement','fee_transfer','ledger_transfer','firm_deposit','firm_withdrawal','bank_fee','interest','reversal')),
  date TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  party TEXT,                               -- payor of a deposit / payee of a payment
  method TEXT CHECK (method IS NULL OR method IN ('check','eft','wire','deposit_slip','bank')),
  check_number TEXT,
  reference TEXT,
  memo TEXT NOT NULL DEFAULT '',
  invoice_id INTEGER REFERENCES billing_invoices(id),
  billing_payment_id INTEGER REFERENCES billing_payments(id),
  reverses_id INTEGER REFERENCES trust_txns(id),
  reason TEXT,                              -- required on a reversal
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL,
  CHECK (kind <> 'reversal' OR (reverses_id IS NOT NULL AND reason IS NOT NULL AND length(trim(reason)) > 0)),
  CHECK (kind = 'reversal' OR reverses_id IS NULL),
  CHECK (kind <> 'fee_transfer' OR invoice_id IS NOT NULL),
  CHECK (kind <> 'disbursement' OR (party IS NOT NULL AND method IN ('check','eft','wire'))),
  CHECK (method IS NOT 'check' OR kind = 'reversal' OR check_number IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS trust_one_reversal ON trust_txns(reverses_id) WHERE reverses_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS trust_check_numbers ON trust_txns(account_id, check_number) WHERE check_number IS NOT NULL AND kind <> 'reversal';
CREATE INDEX IF NOT EXISTS trust_txn_acct_date ON trust_txns(account_id, date, id);

CREATE TABLE IF NOT EXISTS trust_lines (
  id INTEGER PRIMARY KEY,
  txn_id INTEGER NOT NULL REFERENCES trust_txns(id),
  ledger_id INTEGER NOT NULL REFERENCES trust_ledgers(id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents <> 0)
);
CREATE INDEX IF NOT EXISTS trust_lines_ledger ON trust_lines(ledger_id);
CREATE INDEX IF NOT EXISTS trust_lines_txn ON trust_lines(txn_id);

-- When the bank shows a transaction as paid / collected. Append-only: the latest row for a
-- transaction is its status (cleared_on NULL = marked not cleared again).
CREATE TABLE IF NOT EXISTS trust_clearings (
  id INTEGER PRIMARY KEY,
  txn_id INTEGER NOT NULL REFERENCES trust_txns(id),
  cleared_on TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS trust_clear_txn ON trust_clearings(txn_id, id);

-- KRPC 1.15(d)(1)(ii): "the disputed portion shall not be withdrawn until the dispute is
-- finally resolved." A hold keeps an amount on a ledger from being paid out.
CREATE TABLE IF NOT EXISTS trust_holds (
  id INTEGER PRIMARY KEY,
  ledger_id INTEGER NOT NULL REFERENCES trust_ledgers(id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  placed_on TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS trust_hold_releases (
  hold_id INTEGER PRIMARY KEY REFERENCES trust_holds(id),
  released_on TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL
);

-- Monthly three-way reconciliation. A draft may be re-saved; once signed it is permanent.
CREATE TABLE IF NOT EXISTS trust_reconciliations (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES trust_accounts(id),
  period TEXT NOT NULL,                     -- YYYY-MM
  period_end TEXT NOT NULL,
  statement_balance_cents INTEGER NOT NULL,
  adjusted_bank_cents INTEGER NOT NULL,
  journal_cents INTEGER NOT NULL,
  ledgers_cents INTEGER NOT NULL,
  balanced INTEGER NOT NULL CHECK (balanced IN (0,1)),
  snapshot TEXT NOT NULL,                   -- JSON: outstanding items, every ledger balance, differences
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','signed')),
  notes TEXT,
  prepared_by INTEGER REFERENCES users(id),
  prepared_at TEXT NOT NULL,
  signed_by INTEGER REFERENCES users(id),
  signed_on TEXT,
  signed_at TEXT,
  CHECK (status = 'draft' OR (balanced = 1 AND signed_by IS NOT NULL AND signed_at IS NOT NULL)),
  UNIQUE (account_id, period)
);

-- ------------------------------------------------------------------ guards
CREATE TRIGGER IF NOT EXISTS trust_accounts_no_delete BEFORE DELETE ON trust_accounts
BEGIN SELECT RAISE(ABORT, 'A trust account can never be deleted'); END;
CREATE TRIGGER IF NOT EXISTS trust_accounts_fixed BEFORE UPDATE OF kind, in_kansas, opened_on ON trust_accounts
BEGIN SELECT RAISE(ABORT, 'A trust account''s type and opening date cannot change'); END;

CREATE TRIGGER IF NOT EXISTS trust_ledgers_no_delete BEFORE DELETE ON trust_ledgers
BEGIN SELECT RAISE(ABORT, 'A trust ledger can never be deleted'); END;
CREATE TRIGGER IF NOT EXISTS trust_ledgers_no_update BEFORE UPDATE ON trust_ledgers
BEGIN SELECT RAISE(ABORT, 'A trust ledger cannot be changed'); END;

CREATE TRIGGER IF NOT EXISTS trust_txns_no_update BEFORE UPDATE ON trust_txns
BEGIN SELECT RAISE(ABORT, 'Posted trust entries cannot be changed; record a reversing entry instead'); END;
CREATE TRIGGER IF NOT EXISTS trust_txns_no_delete BEFORE DELETE ON trust_txns
BEGIN SELECT RAISE(ABORT, 'Posted trust entries cannot be deleted; record a reversing entry instead'); END;
CREATE TRIGGER IF NOT EXISTS trust_txns_after_lock BEFORE INSERT ON trust_txns
WHEN NEW.date <= COALESCE((SELECT MAX(period_end) FROM trust_reconciliations WHERE account_id = NEW.account_id AND status = 'signed'), '')
BEGIN SELECT RAISE(ABORT, 'That date is in a month whose reconciliation is signed and locked; date the entry after it'); END;

CREATE TRIGGER IF NOT EXISTS trust_lines_no_update BEFORE UPDATE ON trust_lines
BEGIN SELECT RAISE(ABORT, 'Posted trust entries cannot be changed; record a reversing entry instead'); END;
CREATE TRIGGER IF NOT EXISTS trust_lines_no_delete BEFORE DELETE ON trust_lines
BEGIN SELECT RAISE(ABORT, 'Posted trust entries cannot be deleted; record a reversing entry instead'); END;
CREATE TRIGGER IF NOT EXISTS trust_lines_same_account BEFORE INSERT ON trust_lines
WHEN (SELECT account_id FROM trust_ledgers WHERE id = NEW.ledger_id) IS NOT (SELECT account_id FROM trust_txns WHERE id = NEW.txn_id)
BEGIN SELECT RAISE(ABORT, 'A trust entry can only move money on ledgers in its own account'); END;
-- Backstop for the rule the code enforces first: no ledger may go below zero.
CREATE TRIGGER IF NOT EXISTS trust_lines_not_negative AFTER INSERT ON trust_lines
WHEN (SELECT SUM(amount_cents) FROM trust_lines WHERE ledger_id = NEW.ledger_id) < 0
BEGIN SELECT RAISE(ABORT, 'A trust ledger can never go below zero'); END;

CREATE TRIGGER IF NOT EXISTS trust_clearings_no_update BEFORE UPDATE ON trust_clearings
BEGIN SELECT RAISE(ABORT, 'Clearing records cannot be changed'); END;
CREATE TRIGGER IF NOT EXISTS trust_clearings_no_delete BEFORE DELETE ON trust_clearings
BEGIN SELECT RAISE(ABORT, 'Clearing records cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS trust_clearings_after_lock BEFORE INSERT ON trust_clearings
WHEN COALESCE(NEW.cleared_on, '9999-12-31') <= COALESCE((SELECT MAX(r.period_end) FROM trust_reconciliations r JOIN trust_txns t ON t.account_id = r.account_id WHERE t.id = NEW.txn_id AND r.status = 'signed'), '')
  OR ((SELECT cleared_on FROM trust_clearings WHERE txn_id = NEW.txn_id ORDER BY id DESC LIMIT 1) <= COALESCE((SELECT MAX(r.period_end) FROM trust_reconciliations r JOIN trust_txns t ON t.account_id = r.account_id WHERE t.id = NEW.txn_id AND r.status = 'signed'), ''))
BEGIN SELECT RAISE(ABORT, 'That clearing date is inside a signed reconciliation and cannot change'); END;

CREATE TRIGGER IF NOT EXISTS trust_holds_no_update BEFORE UPDATE ON trust_holds
BEGIN SELECT RAISE(ABORT, 'Holds cannot be changed; release the hold instead'); END;
CREATE TRIGGER IF NOT EXISTS trust_holds_no_delete BEFORE DELETE ON trust_holds
BEGIN SELECT RAISE(ABORT, 'Holds cannot be deleted; release the hold instead'); END;
CREATE TRIGGER IF NOT EXISTS trust_releases_no_update BEFORE UPDATE ON trust_hold_releases
BEGIN SELECT RAISE(ABORT, 'Hold releases cannot be changed'); END;
CREATE TRIGGER IF NOT EXISTS trust_releases_no_delete BEFORE DELETE ON trust_hold_releases
BEGIN SELECT RAISE(ABORT, 'Hold releases cannot be deleted'); END;

CREATE TRIGGER IF NOT EXISTS trust_recon_locked_upd BEFORE UPDATE ON trust_reconciliations WHEN OLD.status = 'signed'
BEGIN SELECT RAISE(ABORT, 'A signed reconciliation is locked'); END;
CREATE TRIGGER IF NOT EXISTS trust_recon_locked_del BEFORE DELETE ON trust_reconciliations WHEN OLD.status = 'signed'
BEGIN SELECT RAISE(ABORT, 'A signed reconciliation is locked'); END;
`;
