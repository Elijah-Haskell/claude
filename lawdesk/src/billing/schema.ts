// Billing tables: time, expenses, rates, invoices, payments (operating money only;
// trust accounting is a separate module).
//
// Units, everywhere in this module:
//   money     integer cents
//   rates     integer cents per hour
//   percent   integer basis points (1% = 100 bp), used for markups, discounts and tax rates
//   time      integer minutes as worked; billed in whole increments of `increment_minutes`
//             (default 6 = 0.1 h), rounding each entry UP to the next increment.
//
// The database itself refuses to change or delete a finalized/void invoice or its
// lines (see the triggers at the bottom), so no code path can quietly rewrite history.

export const SCHEMA = `
-- One row of firm-wide billing settings.
CREATE TABLE IF NOT EXISTS billing_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  firm_name TEXT NOT NULL DEFAULT '',
  firm_address TEXT NOT NULL DEFAULT '',
  default_rate_cents INTEGER NOT NULL DEFAULT 0 CHECK (default_rate_cents >= 0),
  increment_minutes INTEGER NOT NULL DEFAULT 6 CHECK (increment_minutes BETWEEN 1 AND 60),
  payment_terms_days INTEGER NOT NULL DEFAULT 30 CHECK (payment_terms_days >= 0),
  first_invoice_number INTEGER NOT NULL DEFAULT 1 CHECK (first_invoice_number >= 1),
  -- Sales tax is off unless the firm sets a rate. The firm decides what is taxable.
  tax_time_bp INTEGER NOT NULL DEFAULT 0 CHECK (tax_time_bp BETWEEN 0 AND 10000),
  tax_expense_bp INTEGER NOT NULL DEFAULT 0 CHECK (tax_expense_bp BETWEEN 0 AND 10000),
  tax_flat_bp INTEGER NOT NULL DEFAULT 0 CHECK (tax_flat_bp BETWEEN 0 AND 10000)
);
INSERT OR IGNORE INTO billing_settings (id) VALUES (1);

-- Standard hourly rate per timekeeper (overrides the firm default).
CREATE TABLE IF NOT EXISTS billing_user_rates (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  rate_cents INTEGER NOT NULL CHECK (rate_cents >= 0)
);

-- How a matter is billed.
--   hourly       time billed at the resolved rate
--   flat         one flat fee (flat_fee_cents) billed once; time is recorded but not charged
--   contingency  flagged non-hourly: time is recorded but not charged; expenses still bill
CREATE TABLE IF NOT EXISTS billing_matters (
  matter_id INTEGER PRIMARY KEY REFERENCES matters(id) ON DELETE CASCADE,
  method TEXT NOT NULL DEFAULT 'hourly' CHECK (method IN ('hourly','flat','contingency')),
  rate_cents INTEGER CHECK (rate_cents IS NULL OR rate_cents >= 0),   -- matter-wide rate override
  flat_fee_cents INTEGER CHECK (flat_fee_cents IS NULL OR flat_fee_cents >= 0)
);

-- Rate for one timekeeper on one matter (the most specific override).
CREATE TABLE IF NOT EXISTS billing_matter_user_rates (
  matter_id INTEGER NOT NULL REFERENCES matters(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rate_cents INTEGER NOT NULL CHECK (rate_cents >= 0),
  PRIMARY KEY (matter_id, user_id)
);

CREATE TABLE IF NOT EXISTS billing_time_entries (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  matter_id INTEGER NOT NULL REFERENCES matters(id),
  date TEXT NOT NULL,
  minutes INTEGER NOT NULL DEFAULT 0 CHECK (minutes >= 0),     -- as worked, before increment rounding
  description TEXT NOT NULL DEFAULT '',
  billable INTEGER NOT NULL DEFAULT 1,
  rate_cents INTEGER NOT NULL CHECK (rate_cents >= 0),          -- resolved when entered; editable until billed
  flat_cents INTEGER CHECK (flat_cents IS NULL OR flat_cents >= 0), -- flat-fee item: charge this instead of rate x time
  activity_code TEXT,                                           -- free text; no code list is assumed
  task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  timer_started_at TEXT,                                        -- ISO timestamp while a timer is running
  invoice_id INTEGER REFERENCES billing_invoices(id),           -- set while on a draft or finalized invoice
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS billing_expenses (
  id INTEGER PRIMARY KEY,
  matter_id INTEGER NOT NULL REFERENCES matters(id),
  user_id INTEGER REFERENCES users(id),
  date TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  cost_cents INTEGER NOT NULL CHECK (cost_cents >= 0),
  markup_bp INTEGER NOT NULL DEFAULT 0 CHECK (markup_bp >= 0),
  billable INTEGER NOT NULL DEFAULT 1,
  expense_code TEXT,                                            -- free text
  receipt_note TEXT,
  invoice_id INTEGER REFERENCES billing_invoices(id),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS billing_invoices (
  id INTEGER PRIMARY KEY,
  number INTEGER UNIQUE,                    -- assigned at finalize, sequential, never reused
  matter_id INTEGER NOT NULL REFERENCES matters(id),
  client_id INTEGER NOT NULL REFERENCES contacts(id),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','final','void')),
  period_from TEXT,
  period_to TEXT,
  issued_on TEXT,
  due_on TEXT,
  discount_kind TEXT NOT NULL DEFAULT 'none' CHECK (discount_kind IN ('none','percent','fixed')),
  discount_value INTEGER NOT NULL DEFAULT 0 CHECK (discount_value >= 0),  -- bp for percent, cents for fixed
  notes TEXT,
  -- Snapshot of the totals, written at finalize.
  subtotal_cents INTEGER,
  discount_cents INTEGER,
  tax_cents INTEGER,
  total_cents INTEGER,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL,
  finalized_by INTEGER REFERENCES users(id),
  finalized_at TEXT,
  voided_by INTEGER REFERENCES users(id),
  voided_on TEXT,
  void_reason TEXT
);

CREATE TABLE IF NOT EXISTS billing_invoice_lines (
  id INTEGER PRIMARY KEY,
  invoice_id INTEGER NOT NULL REFERENCES billing_invoices(id),
  kind TEXT NOT NULL CHECK (kind IN ('time','expense','flat')),
  position INTEGER NOT NULL DEFAULT 0,
  date TEXT,
  user_id INTEGER REFERENCES users(id),
  description TEXT NOT NULL DEFAULT '',
  minutes INTEGER,                           -- billed minutes (after increment rounding), time lines only
  rate_cents INTEGER,
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),   -- before write-down
  standard_cents INTEGER NOT NULL DEFAULT 0, -- value when drafted, before any edits: realization baseline
  writedown_cents INTEGER NOT NULL DEFAULT 0 CHECK (writedown_cents >= 0),
  writedown_reason TEXT,
  tax_bp INTEGER NOT NULL DEFAULT 0 CHECK (tax_bp BETWEEN 0 AND 10000),
  no_charge_note TEXT,                       -- e.g. "Included in flat fee"
  matter_flat_fee INTEGER NOT NULL DEFAULT 0,-- 1 on the line that bills the matter's flat fee
  source_time_id INTEGER REFERENCES billing_time_entries(id),
  source_expense_id INTEGER REFERENCES billing_expenses(id),
  CHECK (writedown_cents <= amount_cents)
);

-- Money received from a client. Whatever is not allocated to invoices is the client's credit.
CREATE TABLE IF NOT EXISTS billing_payments (
  id INTEGER PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES contacts(id),
  matter_id INTEGER REFERENCES matters(id),
  received_on TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  method TEXT,
  reference TEXT,
  note TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL,
  voided_on TEXT,
  voided_by INTEGER REFERENCES users(id),
  void_reason TEXT
);

-- Part of a payment applied to an invoice. Released (not deleted) when the invoice or payment is voided.
CREATE TABLE IF NOT EXISTS billing_allocations (
  id INTEGER PRIMARY KEY,
  payment_id INTEGER NOT NULL REFERENCES billing_payments(id),
  invoice_id INTEGER NOT NULL REFERENCES billing_invoices(id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  applied_on TEXT NOT NULL,
  released_on TEXT
);

-- Balance written off on a finalized invoice (e.g. uncollectible).
CREATE TABLE IF NOT EXISTS billing_writeoffs (
  id INTEGER PRIMARY KEY,
  invoice_id INTEGER NOT NULL REFERENCES billing_invoices(id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  reason TEXT NOT NULL,
  written_on TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS billing_time_matter ON billing_time_entries(matter_id, date);
CREATE INDEX IF NOT EXISTS billing_time_user ON billing_time_entries(user_id, date);
CREATE INDEX IF NOT EXISTS billing_time_invoice ON billing_time_entries(invoice_id);
CREATE INDEX IF NOT EXISTS billing_exp_matter ON billing_expenses(matter_id, date);
CREATE INDEX IF NOT EXISTS billing_exp_invoice ON billing_expenses(invoice_id);
CREATE INDEX IF NOT EXISTS billing_inv_matter ON billing_invoices(matter_id);
CREATE INDEX IF NOT EXISTS billing_inv_client ON billing_invoices(client_id);
CREATE INDEX IF NOT EXISTS billing_lines_inv ON billing_invoice_lines(invoice_id, position);
CREATE INDEX IF NOT EXISTS billing_alloc_inv ON billing_allocations(invoice_id);
CREATE INDEX IF NOT EXISTS billing_alloc_pay ON billing_allocations(payment_id);
CREATE INDEX IF NOT EXISTS billing_pay_client ON billing_payments(client_id);

-- Guards: a finalized or void invoice is permanent.
CREATE TRIGGER IF NOT EXISTS billing_invoice_no_delete
BEFORE DELETE ON billing_invoices WHEN OLD.status <> 'draft'
BEGIN SELECT RAISE(ABORT, 'A finalized invoice can never be deleted; void it instead'); END;

CREATE TRIGGER IF NOT EXISTS billing_invoice_number_fixed
BEFORE UPDATE OF number ON billing_invoices WHEN OLD.number IS NOT NULL AND NEW.number IS NOT OLD.number
BEGIN SELECT RAISE(ABORT, 'An invoice number cannot change once assigned'); END;

CREATE TRIGGER IF NOT EXISTS billing_invoice_status_flow
BEFORE UPDATE OF status ON billing_invoices
WHEN NOT ((OLD.status = 'draft' AND NEW.status IN ('draft','final'))
       OR (OLD.status = 'final' AND NEW.status IN ('final','void'))
       OR (OLD.status = 'void' AND NEW.status = 'void'))
BEGIN SELECT RAISE(ABORT, 'Invoices go draft -> final -> void only'); END;

CREATE TRIGGER IF NOT EXISTS billing_invoice_locked_fields
BEFORE UPDATE OF matter_id, client_id, period_from, period_to, issued_on, due_on, discount_kind, discount_value,
  subtotal_cents, discount_cents, tax_cents, total_cents ON billing_invoices
WHEN OLD.status <> 'draft'
BEGIN SELECT RAISE(ABORT, 'A finalized invoice cannot be edited'); END;

CREATE TRIGGER IF NOT EXISTS billing_lines_locked_ins
BEFORE INSERT ON billing_invoice_lines
WHEN (SELECT status FROM billing_invoices WHERE id = NEW.invoice_id) <> 'draft'
BEGIN SELECT RAISE(ABORT, 'A finalized invoice cannot be edited'); END;

CREATE TRIGGER IF NOT EXISTS billing_lines_locked_upd
BEFORE UPDATE ON billing_invoice_lines
WHEN (SELECT status FROM billing_invoices WHERE id = OLD.invoice_id) <> 'draft'
BEGIN SELECT RAISE(ABORT, 'A finalized invoice cannot be edited'); END;

CREATE TRIGGER IF NOT EXISTS billing_lines_locked_del
BEFORE DELETE ON billing_invoice_lines
WHEN (SELECT status FROM billing_invoices WHERE id = OLD.invoice_id) <> 'draft'
BEGIN SELECT RAISE(ABORT, 'A finalized invoice cannot be edited'); END;
`;
