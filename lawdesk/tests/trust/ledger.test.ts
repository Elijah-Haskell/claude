import { test } from "node:test";
import assert from "node:assert/strict";
import { activity, fund, setup } from "./helpers.ts";

const rejects = (fn: () => unknown, re: RegExp) => assert.throws(fn, (e: any) => re.test(e.message));

test("an account must be confirmed as a separate Kansas account", () => {
  const { t } = setup();
  rejects(() => t.createAccount({ name: "X", bankName: "B", kind: "iolta", inKansas: false }), /Kansas/);
  rejects(() => t.createAccount({ name: "X", bankName: "B", kind: "iolta", inKansas: true, accountLast4: "123456789" }), /too long|last four/);
  const a = t.createAccount({ name: "Second", bankName: "B", kind: "non_iolta", inKansas: true });
  assert.equal(a.kind, "non_iolta");
  assert.equal(a.require_cleared, 1, "cleared funds required by default");
  assert.ok(a.firm_ledger_id, "every account gets a firm bank-charge ledger");
});

test("deposits post to a ledger per client matter and are logged", () => {
  const ctx = setup();
  const { t, db, acct, m1, m2, atty } = ctx;
  const d = t.deposit(acct, m1, { amountCents: 150000, party: "Acme (demo)", date: "2026-10-02" }, atty);
  t.deposit(acct, m2, { amountCents: 2500, party: "Acme (demo)", date: "2026-10-02" }, atty);
  assert.equal(d.amount_cents, 150000);
  assert.equal(d.cleared_on, null, "a new deposit is not cleared until marked");
  assert.equal(t.ledgerBalance(d.lines[0].ledger_id), 150000);
  assert.equal(t.accountBalance(acct), 152500);
  const log = activity(db, "trust_deposit");
  assert.equal(log.length, 2);
  assert.equal(log[0].matter_id, m1);
  assert.equal(log[0].user_id, atty);
  assert.match(log[0].detail, /\$1,500\.00 from Acme/);
});

test("a client ledger can never go negative, with no override", () => {
  const ctx = setup();
  const { t, acct, m1, m3 } = ctx;
  fund(ctx, m1, 10000);
  rejects(() => t.disburse(acct, m1, { amountCents: 10001, party: "Vendor", method: "check", checkNumber: "1001", memo: "x", date: "2026-10-03" }), /below zero/);
  // Another client's money in the same account doesn't help.
  fund(ctx, m3, 500000);
  rejects(() => t.disburse(acct, m1, { amountCents: 10001, party: "Vendor", method: "eft", memo: "x", date: "2026-10-03", force: true } as any), /below zero/);
  rejects(() => t.transferBetween(acct, m1, m3, { amountCents: 10001, memo: "client instruction", date: "2026-10-03" }), /below zero/);
  // Exactly the balance is fine.
  t.disburse(acct, m1, { amountCents: 10000, party: "Vendor", method: "eft", memo: "x", date: "2026-10-03" });
  const l = t.ledgerFor(acct, m1);
  assert.equal(t.ledgerBalance(l.id), 0);
  assert.equal(t.accountBalance(acct), 500000);
});

test("a back-dated payment can't spend money that arrived later", () => {
  const ctx = setup();
  const { t, acct, m1 } = ctx;
  fund(ctx, m1, 10000, "2026-10-10");
  rejects(() => t.disburse(acct, m1, { amountCents: 5000, party: "Vendor", method: "eft", memo: "x", date: "2026-10-05" }), /below zero/);
  t.disburse(acct, m1, { amountCents: 5000, party: "Vendor", method: "eft", memo: "x", date: "2026-10-10" });
});

test("uncleared deposits can't be paid out while the account requires cleared funds", () => {
  const ctx = setup();
  const { t, acct, m1, atty } = ctx;
  const d = t.deposit(acct, m1, { amountCents: 40000, party: "Acme", date: "2026-10-02" });
  const pay = () => t.disburse(acct, m1, { amountCents: 100, party: "Vendor", method: "eft", memo: "x", date: "2026-10-03" });
  rejects(pay, /cleared/);
  const l = t.ledger(t.ledgerFor(acct, m1).id);
  assert.equal(l.balance_cents, 40000);
  assert.equal(l.cleared_cents, 0);
  assert.equal(l.available_cents, 0);
  t.setCleared(d.id, "2026-10-03", atty);
  pay();
  // Can't take the deposit back to "not cleared" once part of it is spent.
  rejects(() => t.setCleared(d.id, null), /already been paid out/);
  // The account setting turns the check off.
  t.updateAccount(acct, { requireCleared: false });
  t.deposit(acct, m1, { amountCents: 500, party: "Acme", date: "2026-10-04" });
  t.disburse(acct, m1, { amountCents: 40400, party: "Vendor", method: "eft", memo: "x", date: "2026-10-04" });
});

test("disbursements need a payee, a purpose, and a unique check number for checks", () => {
  const ctx = setup();
  const { t, acct, m1 } = ctx;
  fund(ctx, m1, 50000);
  const base = { amountCents: 100, date: "2026-10-03", memo: "Recording fee" };
  rejects(() => t.disburse(acct, m1, { ...base, method: "check", checkNumber: "1001" }), /Payee/);
  rejects(() => t.disburse(acct, m1, { ...base, party: "Clerk", method: "check" }), /Check number/);
  rejects(() => t.disburse(acct, m1, { ...base, party: "Clerk", method: "cash" }), /check, EFT or wire/);
  rejects(() => t.disburse(acct, m1, { ...base, party: "Clerk", method: "eft", memo: "" }), /what the payment is for/);
  t.disburse(acct, m1, { ...base, party: "Clerk", method: "check", checkNumber: "1001" });
  rejects(() => t.disburse(acct, m1, { ...base, party: "Clerk", method: "check", checkNumber: "1001" }), /already recorded/);
});

test("transfers between client ledgers move money without changing the bank balance", () => {
  const ctx = setup();
  const { t, acct, m1, m2, db } = ctx;
  fund(ctx, m1, 30000);
  const x = t.transferBetween(acct, m1, m2, { amountCents: 12000, memo: "Client's written instruction of 10/3", date: "2026-10-03" });
  assert.equal(x.amount_cents, 0);
  assert.equal(t.ledgerBalance(t.ledgerFor(acct, m1).id), 18000);
  assert.equal(t.ledgerBalance(t.ledgerFor(acct, m2).id), 12000);
  assert.equal(t.accountBalance(acct), 30000);
  assert.equal(activity(db, "trust_ledger_transfer").length, 2, "logged on both matters");
});

test("bank charges come only from firm funds, within the limit the lawyer sets", () => {
  const ctx = setup();
  const { t, acct, m1 } = ctx;
  fund(ctx, m1, 100000);
  rejects(() => t.bankFee(acct, { amountCents: 1500, memo: "Monthly service charge", date: "2026-10-31" }), /never be taken from client money/);
  rejects(() => t.firmDeposit(acct, { amountCents: 20001, date: "2026-10-01" }), /over the \$200\.00 limit/);
  const fd = t.firmDeposit(acct, { amountCents: 10000, date: "2026-10-01", clearedOn: "2026-10-01" });
  assert.equal(fd.lines[0].label, "Firm funds for bank charges");
  const fee = t.bankFee(acct, { amountCents: 1500, memo: "Monthly service charge", date: "2026-10-31" });
  assert.equal(fee.cleared_on, "2026-10-31", "a bank charge is on the statement by definition");
  assert.equal(t.ledgerBalance(t.ledgerFor(acct, m1).id), 100000, "client money untouched");
  assert.equal(t.ledgerBalance(t.firmLedger(acct).id), 8500);
  // Without a limit, no firm money at all.
  const other = t.createAccount({ name: "Other", bankName: "B", kind: "iolta", inKansas: true, openedOn: "2026-01-01" });
  rejects(() => t.firmDeposit(other.id, { amountCents: 100, date: "2026-10-01" }), /Set this account's limit/);
});

test("interest is refused on IOLTA and credited to the client on a non-IOLTA account", () => {
  const ctx = setup();
  const { t, acct, m3 } = ctx;
  rejects(() => t.interest(acct, m3, { amountCents: 12, date: "2026-10-31" }), /Kansas Bar Foundation/);
  const n = t.createAccount({ name: "Jones estate trust", bankName: "B", kind: "non_iolta", inKansas: true, openedOn: "2026-01-01" });
  const i = t.interest(n.id, m3, { amountCents: 12, date: "2026-10-31" });
  assert.equal(t.ledgerBalance(i.lines[0].ledger_id), 12);
});

test("disputed funds on hold can't be paid out until released", () => {
  const ctx = setup();
  const { t, acct, m1, db } = ctx;
  fund(ctx, m1, 50000);
  const lid = t.ledgerFor(acct, m1).id;
  const h = t.placeHold(lid, { amountCents: 20000, reason: "Fee disputed by client (demo)", date: "2026-10-03" });
  rejects(() => t.placeHold(lid, { amountCents: 30001, reason: "more" }), /not already held/);
  rejects(() => t.disburse(acct, m1, { amountCents: 30001, party: "V", method: "eft", memo: "x", date: "2026-10-04" }), /on hold/);
  t.disburse(acct, m1, { amountCents: 30000, party: "V", method: "eft", memo: "x", date: "2026-10-04" });
  rejects(() => t.releaseHold(h.id, { reason: "" }), /resolved/);
  t.releaseHold(h.id, { reason: "Settled by agreement", date: "2026-10-05" });
  rejects(() => t.releaseHold(h.id, { reason: "again" }), /already released/);
  assert.equal(t.availableCents(lid), 20000);
  assert.equal(activity(db, "trust_hold").length, 1);
});

test("retention: five years after the matter closes", () => {
  const ctx = setup();
  const { t, acct, m1, engine } = ctx;
  const l = t.ledgerFor(acct, m1);
  assert.equal(t.retention(l).keep_until, null);
  assert.match(t.retention(l).note, /five years after the representation ends/);
  engine.closeMatter(m1);
  const r = t.retention(l);
  assert.equal(r.keep_until, "2031-10-01");
  assert.match(r.note, /1\.15\(a\)/);
});

test("nothing can be dated before the account opened or after it closed", () => {
  const ctx = setup();
  const { t, acct, m1 } = ctx;
  rejects(() => t.deposit(acct, m1, { amountCents: 1, party: "A", date: "2025-12-31" }), /before the account was opened/);
  t.updateAccount(acct, { closedOn: "2026-10-01" });
  rejects(() => fund(ctx, m1, 1), /is closed/);
});

test("an account with money in it can't be closed", () => {
  const ctx = setup();
  const { t, acct, m1 } = ctx;
  fund(ctx, m1, 100);
  rejects(() => t.updateAccount(acct, { closedOn: "2026-10-05" }), /balance is zero/);
});
