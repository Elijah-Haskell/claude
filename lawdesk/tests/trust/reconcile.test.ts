import { test } from "node:test";
import assert from "node:assert/strict";
import { activity, fund, setup, type Ctx } from "./helpers.ts";

const rejects = (fn: () => unknown, re: RegExp) => assert.throws(fn, (e: any) => re.test(e.message));

/** October: $1,000 in (cleared), check 1001 for $250 (outstanding), $75 deposit (in transit). */
function october(ctx: Ctx) {
  const { t, acct, m1, m3 } = ctx;
  fund(ctx, m1, 100000, "2026-10-02");
  const chk = t.disburse(acct, m1, { amountCents: 25000, party: "County clerk", method: "check", checkNumber: "1001", memo: "Filing fee", date: "2026-10-20" });
  const dep = t.deposit(acct, m3, { amountCents: 7500, party: "Bob Jones", date: "2026-10-31" });
  return { chk, dep };
}

test("three-way reconciliation balances to the cent with outstanding items", () => {
  const ctx = setup();
  october(ctx);
  // The bank shows only the cleared $1,000.
  const r = ctx.t.reconcile(ctx.acct, "2026-10", 100000);
  assert.equal(r.period_end, "2026-10-31");
  assert.equal(r.deposits_in_transit_cents, 7500);
  assert.equal(r.outstanding_payments_cents, 25000);
  assert.equal(r.adjusted_bank_cents, 82500);
  assert.equal(r.journal_cents, 82500);
  assert.equal(r.ledgers_cents, 82500);
  assert.equal(r.balanced, true);
  assert.deepEqual(r.problems, []);
  assert.equal(r.outstanding.length, 2);
});

test("a mismatch shows the difference and can't be signed", () => {
  const ctx = setup();
  october(ctx);
  const r = ctx.t.reconcile(ctx.acct, "2026-10", 99999);
  assert.equal(r.balanced, false);
  assert.equal(r.bank_vs_journal_cents, -1);
  assert.match(r.problems[0], /\$0\.01 less than the trust journal/);
  ctx.t.saveReconciliation(ctx.acct, { period: "2026-10", statementBalanceCents: 99999 }, ctx.atty);
  rejects(() => ctx.t.signReconciliation(ctx.acct, "2026-10", ctx.atty), /does not balance/);
  // Fix the figure, re-save, sign.
  ctx.t.saveReconciliation(ctx.acct, { period: "2026-10", statementBalanceCents: 100000 }, ctx.atty);
  const s = ctx.t.signReconciliation(ctx.acct, "2026-10", ctx.atty);
  assert.equal(s.status, "signed");
  assert.equal(s.signed_by_name, "Attorney A");
  assert.equal(s.signed_on, "2026-10-01");
  assert.equal(activity(ctx.db, "trust_reconciliation_signed").length, 1);
});

test("signing needs a named person, and months are signed in order", () => {
  const ctx = setup();
  october(ctx);
  ctx.t.deposit(ctx.acct, ctx.m1, { amountCents: 100, party: "A", date: "2026-11-02", clearedOn: "2026-11-02" });
  ctx.t.saveReconciliation(ctx.acct, { period: "2026-11", statementBalanceCents: 100100 + 7500 - 25000 + 25000 - 7500 }, ctx.atty);
  rejects(() => ctx.t.signReconciliation(ctx.acct, "2026-11", null), /who is signing/);
  rejects(() => ctx.t.signReconciliation(ctx.acct, "2026-11", ctx.atty), /Sign the 2026-10 reconciliation first/);
});

test("a signed month is locked: no new entries, clearings or edits inside it", () => {
  const ctx = setup();
  const { t, db, acct, m1, atty } = ctx;
  const { chk } = october(ctx);
  t.saveReconciliation(acct, { period: "2026-10", statementBalanceCents: 100000 }, atty);
  const signed = t.signReconciliation(acct, "2026-10", atty);
  rejects(() => fund(ctx, m1, 100, "2026-10-15"), /signed/);
  rejects(() => t.setCleared(chk.id, "2026-10-25"), /signed/);
  rejects(() => t.saveReconciliation(acct, { period: "2026-10", statementBalanceCents: 1 }), /already signed/);
  // The database refuses too, even bypassing the code.
  rejects(() => db.prepare("UPDATE trust_reconciliations SET statement_balance_cents = 1 WHERE id = ?").run(signed.id), /locked/);
  rejects(() => db.prepare("DELETE FROM trust_reconciliations WHERE id = ?").run(signed.id), /locked/);
  rejects(
    () => db.prepare("INSERT INTO trust_txns (account_id, kind, date, amount_cents, created_at) VALUES (?, 'interest', '2026-10-30', 1, 'x')").run(acct),
    /signed and locked/,
  );
  // The outstanding check clears next month: allowed, dated after the lock.
  t.setCleared(chk.id, "2026-11-03", atty);
  const nov = t.reconcile(acct, "2026-11", 100000 - 25000 + 7500);
  assert.equal(nov.balanced, false, "the $75 deposit has still not cleared");
  t.setCleared(t.journal(acct).find((r) => r.amount_cents === 7500)!.id, "2026-11-02");
  assert.equal(t.reconcile(acct, "2026-11", 82500).balanced, true);
});

test("a negative ledger (only possible by tampering) makes the reconciliation fail", () => {
  const ctx = setup();
  const { t, db, acct, m1, m3 } = ctx;
  fund(ctx, m1, 1000);
  fund(ctx, m3, 1000);
  // Simulate corruption: drop the guard and move money in the lines table only.
  db.exec("DROP TRIGGER trust_lines_not_negative");
  const l1 = t.ledgerFor(acct, m1).id;
  const l3 = t.ledgerFor(acct, m3).id;
  const tx1 = db.prepare("SELECT txn_id FROM trust_lines WHERE ledger_id = ?").get(l1) as any;
  db.prepare("INSERT INTO trust_lines (txn_id, ledger_id, amount_cents) VALUES (?,?,?)").run(tx1.txn_id, l1, -1500);
  db.prepare("INSERT INTO trust_lines (txn_id, ledger_id, amount_cents) VALUES (?,?,?)").run(tx1.txn_id, l3, 1500);
  const r = t.reconcile(acct, "2026-10", 2000);
  assert.equal(r.bank_vs_journal_cents, 0);
  assert.equal(r.journal_vs_ledgers_cents, 0);
  assert.equal(r.balanced, false);
  assert.match(r.problems.join(" "), /below zero/);
});

test("journal and ledgers that disagree are reported (independent totals)", () => {
  const ctx = setup();
  const { t, db, acct, m1 } = ctx;
  fund(ctx, m1, 1000);
  db.exec("DROP TRIGGER trust_lines_no_delete");
  db.exec("DELETE FROM trust_lines");
  const r = t.reconcile(acct, "2026-10", 1000);
  assert.equal(r.journal_vs_ledgers_cents, 1000);
  assert.match(r.problems.join(" "), /client ledgers differ by \$10\.00/);
});

test("reconciliation history lists drafts and signed months", () => {
  const ctx = setup();
  october(ctx);
  ctx.t.saveReconciliation(ctx.acct, { period: "2026-10", statementBalanceCents: 100000, notes: "Statement received 11/3" }, ctx.atty);
  ctx.t.signReconciliation(ctx.acct, "2026-10", ctx.atty);
  ctx.t.saveReconciliation(ctx.acct, { period: "2026-11", statementBalanceCents: 5 }, ctx.atty);
  const h = ctx.t.listReconciliations(ctx.acct);
  assert.deepEqual(h.map((r) => [r.period, r.status, r.balanced]), [["2026-11", "draft", 0], ["2026-10", "signed", 1]]);
  assert.equal(ctx.t.reconciliation(ctx.acct, "2026-10").snapshot.journal_cents, 82500);
});

test("bad month and statement inputs are refused", () => {
  const ctx = setup();
  rejects(() => ctx.t.reconcile(ctx.acct, "2026-13", 0), /Month/);
  rejects(() => ctx.t.reconcile(ctx.acct, "2026-10", 1.5), /cents/);
});
