import { test } from "node:test";
import assert from "node:assert/strict";
import { activity, finalInvoice, fund, setup } from "./helpers.ts";

const rejects = (fn: () => unknown, re: RegExp) => assert.throws(fn, (e: any) => re.test(e.message));

test("the database refuses to change or delete posted entries", () => {
  const ctx = setup();
  const { db, t, acct, m1 } = ctx;
  const d = fund(ctx, m1, 5000);
  for (const sql of [
    "UPDATE trust_txns SET amount_cents = 1",
    "UPDATE trust_txns SET memo = 'edited'",
    "DELETE FROM trust_txns",
    "UPDATE trust_lines SET amount_cents = 1",
    "DELETE FROM trust_lines",
    "UPDATE trust_clearings SET cleared_on = NULL",
    "DELETE FROM trust_clearings",
    "DELETE FROM trust_ledgers",
    "UPDATE trust_ledgers SET matter_id = NULL",
    "DELETE FROM trust_accounts",
    "UPDATE trust_accounts SET kind = 'non_iolta'",
  ]) {
    rejects(() => db.exec(sql), /cannot|never/);
  }
  const h = t.placeHold(t.ledgerFor(acct, m1).id, { amountCents: 1, reason: "r" });
  rejects(() => db.exec("UPDATE trust_holds SET amount_cents = 2"), /cannot/);
  rejects(() => db.exec("DELETE FROM trust_holds"), /cannot/);
  t.releaseHold(h.id, { reason: "done" });
  rejects(() => db.exec("DELETE FROM trust_hold_releases"), /cannot/);
  assert.equal(t.txn(d.id).amount_cents, 5000);
});

test("the database refuses a line that takes a ledger negative or crosses accounts", () => {
  const ctx = setup();
  const { db, t, acct, m1 } = ctx;
  const d = fund(ctx, m1, 5000);
  const lid = t.ledgerFor(acct, m1).id;
  rejects(() => db.prepare("INSERT INTO trust_lines (txn_id, ledger_id, amount_cents) VALUES (?,?,?)").run(d.id, lid, -5001), /below zero/);
  const other = t.createAccount({ name: "Other", bankName: "B", kind: "iolta", inKansas: true, openedOn: "2026-01-01" });
  rejects(() => db.prepare("INSERT INTO trust_lines (txn_id, ledger_id, amount_cents) VALUES (?,?,?)").run(d.id, other.firm_ledger_id, 1), /own account/);
});

test("a reversal is an equal and opposite entry; the original stays", () => {
  const ctx = setup();
  const { t, db, acct, m1, atty } = ctx;
  fund(ctx, m1, 50000);
  const chk = t.disburse(acct, m1, { amountCents: 12000, party: "Wrong payee", method: "check", checkNumber: "1005", memo: "Appraisal", date: "2026-10-03" }, atty);
  rejects(() => t.reverse(chk.id, { reason: " " }), /Reason/);
  const r = t.reverse(chk.id, { reason: "Check voided: wrong payee", date: "2026-10-04" }, atty);
  assert.equal(r.kind, "reversal");
  assert.equal(r.amount_cents, 12000);
  assert.equal(r.reverses_id, chk.id);
  assert.equal(t.txn(chk.id).reversed_by.id, r.id);
  assert.equal(t.ledgerBalance(t.ledgerFor(acct, m1).id), 50000);
  assert.equal(t.journal(acct).length, 3, "deposit, check, reversal all remain");
  rejects(() => t.reverse(chk.id, { reason: "again" }), /already been reversed/);
  rejects(() => t.reverse(r.id, { reason: "undo the undo" }), /can't itself be reversed/);
  rejects(() => t.reverse(chk.id + 99, { reason: "x" }), /not found/);
  assert.match(activity(db, "trust_reversal")[0].detail, /wrong payee/);
  // The check number stays used.
  rejects(() => t.disburse(acct, m1, { amountCents: 1, party: "P", method: "check", checkNumber: "1005", memo: "x", date: "2026-10-05" }), /already recorded/);
});

test("reversing a deposit that has been spent is refused", () => {
  const ctx = setup();
  const { t, acct, m1 } = ctx;
  const d = fund(ctx, m1, 10000);
  t.disburse(acct, m1, { amountCents: 6000, party: "V", method: "eft", memo: "x", date: "2026-10-03" });
  rejects(() => t.reverse(d.id, { reason: "Returned check", date: "2026-10-05" }), /below zero/);
});

test("a reversal can't be dated before the entry or inside a locked month", () => {
  const ctx = setup();
  const { t, acct, m1, atty } = ctx;
  const d = fund(ctx, m1, 10000, "2026-10-02");
  rejects(() => t.reverse(d.id, { reason: "x", date: "2026-10-01" }), /before the entry/);
  t.saveReconciliation(acct, { period: "2026-10", statementBalanceCents: 10000 }, atty);
  t.signReconciliation(acct, "2026-10", atty);
  rejects(() => t.reverse(d.id, { reason: "x", date: "2026-10-30" }), /signed/);
  t.reverse(d.id, { reason: "Deposited to wrong account", date: "2026-11-02" });
});

test("earned fees move only against a finalized invoice and record a payment on it", () => {
  const ctx = setup();
  const { t, b, db, acct, m1, m3, atty } = ctx;
  fund(ctx, m1, 100000);
  const draft = b.createDraft({ matterId: m1 });
  b.addLine(draft.id, { kind: "flat", amountCents: 40000, description: "Services" });
  rejects(() => t.transferFee(acct, draft.id, { amountCents: 100 }), /finalized invoice/);
  const inv = b.finalize(draft.id);
  rejects(() => t.transferFee(acct, inv.id, { amountCents: 40001 }), /more than the \$400\.00/);
  const fee = t.transferFee(acct, inv.id, { amountCents: 30000, date: "2026-10-05" }, atty);
  assert.equal(fee.kind, "fee_transfer");
  assert.equal(fee.invoice.number, inv.number);
  assert.equal(b.balance(inv.id), 10000);
  const pay = b.payment(fee.billing_payment_id);
  assert.equal(pay.amount_cents, 30000);
  assert.equal(pay.method, "Trust transfer");
  assert.equal(pay.allocations[0].invoice_id, inv.id);
  assert.equal(t.ledgerBalance(t.ledgerFor(acct, m1).id), 70000);
  assert.equal(activity(db, "trust_fee_transfer").length, 1);
  // Another client's invoice can't be paid from this client's ledger: the ledger is the invoice's own matter.
  const bobInv = finalInvoice(ctx, m3, 5000);
  rejects(() => t.transferFee(acct, bobInv.id, { amountCents: 5000, date: "2026-10-05" }), /below zero/);
  assert.equal(b.balance(bobInv.id), 5000, "billing untouched when trust refuses");
});

test("reversing an earned-fee transfer voids the invoice payment", () => {
  const ctx = setup();
  const { t, b, acct, m1, atty } = ctx;
  fund(ctx, m1, 50000);
  const inv = finalInvoice(ctx, m1, 20000);
  const fee = t.transferFee(acct, inv.id, { amountCents: 20000, date: "2026-10-05" }, atty);
  assert.equal(b.balance(inv.id), 0);
  t.reverse(fee.id, { reason: "Moved before the client approved the bill", date: "2026-10-06" }, atty);
  assert.equal(b.balance(inv.id), 20000);
  assert.ok(b.payment(fee.billing_payment_id).voided_on);
  assert.equal(t.ledgerBalance(t.ledgerFor(acct, m1).id), 50000);
});

test("fee transfers respect cleared funds and disputed holds", () => {
  const ctx = setup();
  const { t, acct, m1 } = ctx;
  t.deposit(acct, m1, { amountCents: 50000, party: "A", date: "2026-10-02" });
  const inv = finalInvoice(ctx, m1, 20000);
  rejects(() => t.transferFee(acct, inv.id, { amountCents: 20000, date: "2026-10-05" }), /cleared/);
  t.setCleared(t.journal(acct)[0].id, "2026-10-03");
  t.placeHold(t.ledgerFor(acct, m1).id, { amountCents: 40000, reason: "Fee disputed" });
  rejects(() => t.transferFee(acct, inv.id, { amountCents: 20000, date: "2026-10-05" }), /on hold/);
});

test("journal running balance and ledger statement", () => {
  const ctx = setup();
  const { t, acct, m1, m2 } = ctx;
  fund(ctx, m1, 10000, "2026-10-02");
  fund(ctx, m2, 5000, "2026-10-03");
  t.disburse(acct, m1, { amountCents: 2500, party: "V", method: "wire", memo: "x", date: "2026-10-04" });
  const j = t.journal(acct);
  assert.deepEqual(j.map((r) => r.balance_cents), [10000, 15000, 12500]);
  assert.deepEqual(t.journal(acct, "2026-10-03", "2026-10-03").map((r) => r.balance_cents), [15000]);
  const l = t.ledger(t.ledgerFor(acct, m1).id);
  assert.deepEqual(l.entries.map((r: any) => r.balance_cents), [10000, 7500]);
  assert.match(l.label, /Acme Widgets LLC \(demo\) — 2026-001 Acme lease/);
});

test("client balances and inactive balances", () => {
  const ctx = setup("2026-01-05");
  const { t, acct, m1, m2, m3, setDay } = ctx;
  fund(ctx, m1, 10000, "2026-01-05");
  fund(ctx, m2, 0 + 300, "2026-01-05");
  t.transferBetween(acct, m2, m3, { amountCents: 300, memo: "instruction", date: "2026-01-06" });
  setDay("2026-09-01");
  fund(ctx, m3, 100, "2026-09-01");
  const bal = t.clientBalances(acct);
  assert.deepEqual(bal.filter((r) => r.kind === "client").map((r) => [r.matter_number, r.balance_cents]), [["2026-001", 10000], ["2026-003", 400]]);
  assert.deepEqual(t.clientBalances(acct, "2026-01-05").filter((r) => r.kind === "client").map((r) => r.balance_cents), [10000, 300]);
  const idle = t.inactiveBalances(acct, 6);
  assert.deepEqual(idle.map((r) => r.matter_number), ["2026-001"]);
  assert.throws(() => t.inactiveBalances(acct, 0));
});
