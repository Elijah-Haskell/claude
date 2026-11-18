// Tables for online payments. Card numbers never reach Lawdesk: the client types them on
// the processor's own hosted page. We keep only what the processor tells us back
// (session ids, amounts, outcome), never card data.
//
// Two kinds of payment link, kept strictly apart (see docs/payments.md):
//   invoice        pays a finalized invoice; the money is the firm's (operating account)
//                  and is recorded in billing as an ordinary payment
//   trust_deposit  a retainer or other unearned money; it belongs in trust. Disabled unless
//                  a separate trust-account processor account is configured. It is never
//                  recorded in billing; it waits in pay_trust_receipts for the trust ledger.

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS pay_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  provider TEXT NOT NULL DEFAULT 'test' CHECK (provider IN ('off','test','stripe')),
  test_mode INTEGER NOT NULL DEFAULT 1,
  link_days INTEGER NOT NULL DEFAULT 30 CHECK (link_days BETWEEN 1 AND 180),
  -- The firm confirms that its trust processor account charges fees and chargebacks to
  -- operating, never to trust. Trust links stay off without it.
  trust_fees_confirmed INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT,
  updated_by INTEGER REFERENCES users(id)
);
INSERT OR IGNORE INTO pay_settings (id) VALUES (1);

-- A link the firm sends to a client. Only a hash of the token is stored.
CREATE TABLE IF NOT EXISTS pay_links (
  id INTEGER PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('invoice','trust_deposit')),
  account TEXT NOT NULL CHECK (account IN ('operating','trust')),
  invoice_id INTEGER REFERENCES billing_invoices(id),
  matter_id INTEGER REFERENCES matters(id),
  client_id INTEGER NOT NULL REFERENCES contacts(id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paid','cancelled')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id),
  cancelled_at TEXT,
  CHECK ((kind = 'invoice' AND account = 'operating' AND invoice_id IS NOT NULL)
      OR (kind = 'trust_deposit' AND account = 'trust' AND invoice_id IS NULL))
);

-- One attempt to pay through a link (a processor checkout session).
CREATE TABLE IF NOT EXISTS pay_checkouts (
  id INTEGER PRIMARY KEY,
  link_id INTEGER NOT NULL REFERENCES pay_links(id),
  provider TEXT NOT NULL,
  account TEXT NOT NULL CHECK (account IN ('operating','trust')),
  session_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','pending','succeeded','failed','expired')),
  payment_ref TEXT,                    -- processor's payment id (Stripe PaymentIntent)
  created_at TEXT NOT NULL,
  completed_at TEXT,
  billing_payment_id INTEGER REFERENCES billing_payments(id),
  refunded_cents INTEGER NOT NULL DEFAULT 0,
  UNIQUE (provider, session_id)
);

-- Every processor event we accepted, so a re-delivered event is never applied twice.
CREATE TABLE IF NOT EXISTS pay_events (
  id INTEGER PRIMARY KEY,
  provider TEXT NOT NULL,
  account TEXT NOT NULL,
  event_id TEXT NOT NULL,
  type TEXT NOT NULL,
  received_at TEXT NOT NULL,
  outcome TEXT NOT NULL,
  checkout_id INTEGER REFERENCES pay_checkouts(id),
  UNIQUE (provider, account, event_id)
);

-- Things a person must look at: refunds, disputes, money for an invoice that changed.
CREATE TABLE IF NOT EXISTS pay_attention (
  id INTEGER PRIMARY KEY,
  checkout_id INTEGER REFERENCES pay_checkouts(id),
  kind TEXT NOT NULL,                 -- refund, dispute, trust_receipt, unapplied
  message TEXT NOT NULL,
  amount_cents INTEGER,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  resolved_by INTEGER REFERENCES users(id),
  resolution TEXT
);

-- Trust deposits received online, waiting to be entered in the trust ledger (trust module).
CREATE TABLE IF NOT EXISTS pay_trust_receipts (
  id INTEGER PRIMARY KEY,
  checkout_id INTEGER NOT NULL UNIQUE REFERENCES pay_checkouts(id),
  client_id INTEGER NOT NULL REFERENCES contacts(id),
  matter_id INTEGER REFERENCES matters(id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  received_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'awaiting_trust_entry' CHECK (status IN ('awaiting_trust_entry','entered')),
  trust_ref TEXT
);

-- The "test" provider's simulated hosted checkout pages (demo and tests only; no card data).
CREATE TABLE IF NOT EXISTS pay_test_sessions (
  id TEXT PRIMARY KEY,
  account TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  description TEXT NOT NULL,
  reference TEXT NOT NULL,
  success_url TEXT NOT NULL,
  cancel_url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','paid','declined')),
  payment_ref TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS pay_links_invoice ON pay_links(invoice_id);
CREATE INDEX IF NOT EXISTS pay_links_matter ON pay_links(matter_id);
CREATE INDEX IF NOT EXISTS pay_checkouts_ref ON pay_checkouts(payment_ref);
`;
