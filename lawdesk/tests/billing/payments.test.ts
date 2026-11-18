import { test } from "node:test";
import assert from "node:assert/strict";
import { activity, setup } from "./helpers.ts";
import { aging } from "../../src/billing/reports.ts";

function billed(ctx: ReturnType<typeof setup>, matterId: number, cents: number) {
  const d = ctx.b.createDraft({ matterId });
  ctx.b.addLine(d.id, { kind: "flat", amountCents: cents, description: "Services" });
  return ctx.b.finalize(d.id);
}

test("partial and multiple payments reduce the balance to the cent", () => {
  const ctx = setup();
  const { b, db, atty, m1 } = ctx;
  const inv = billed(ctx, m1, 100001);
  b.payInvoice(inv.id, { amountCents: 33333, method: "check", reference: "1201" }, atty);
  assert.equal(b.balance(inv.id), 66668);
  b.payInvoice(inv.id, { amountCents: 33333 });
  b.payInvoice(inv.id, { amountCents: 33334 });
  assert.equal(b.balance(inv.id), 1);
  b.payInvoice(inv.id, { amountCents: 1 });
  assert.equal(b.balance(inv.id), 0);
  const v = b.invoice(inv.id);
  assert.equal(v.payments.length, 4);
  assert.equal(v.paid_cents, 100001);
  const log = activity(db, "payment_received");
  assert.equal(log.length, 4);
  assert.equal(log[0].matter_id, m1);
  assert.equal(log[0].user_id, atty);
  assert.match(log[0].detail, /\$333\.33 .*invoice 1/);
});

test("overpayment becomes client credit, which can be applied to the next invoice", () => {
  const ctx = setup();
  const { b, db, acme, m1, m2 } = ctx;
  const a = billed(ctx, m1, 50000);
  const p = b.payInvoice(a.id, { amountCents: 80000 });
  assert.equal(b.balance(a.id), 0);
  assert.equal(p.unapplied_cents, 30000);
  assert.equal(b.clientCredit(acme), 30000);
  assert.match(activity(db, "payment_received")[0].detail, /\$300\.00 held as client credit/);
  const c = billed(ctx, m2, 45000);
  const after = b.applyCredit(c.id, null, ctx.atty);
  assert.equal(after.balance_cents, 15000);
  assert.equal(b.clientCredit(acme), 0);
  assert.throws(() => b.applyCredit(c.id), /no credit/);
  const log = activity(db, "credit_applied");
  assert.equal(log.length, 1);
  assert.equal(log[0].matter_id, m2);
});

test("applying part of the credit, across several payments", () => {
  const ctx = setup();
  const { b, acme, m1, m2 } = ctx;
  b.recordPayment({ clientId: acme, amountCents: 1000, receivedOn: "2026-10-01" });
  b.recordPayment({ clientId: acme, amountCents: 2000, receivedOn: "2026-10-02" });
  const inv = billed(ctx, m1, 10000);
  assert.throws(() => b.applyCredit(inv.id, 3001), /only \$30\.00/);
  b.applyCredit(inv.id, 2500);
  assert.equal(b.balance(inv.id), 7500);
  assert.equal(b.clientCredit(acme), 500);
  const pays = b.listPayments({ clientId: acme });
  assert.deepEqual(pays.map((p) => p.unapplied_cents), [0, 500]); // oldest used first
  const small = billed(ctx, m2, 100);
  assert.throws(() => b.applyCredit(small.id, 200), /more than/);
});

test("recordPayment validates client, allocations and amounts", () => {
  const ctx = setup();
  const { b, acme, bob, m1, m3 } = ctx;
  const inv = billed(ctx, m1, 1000);
  const jones = billed(ctx, m3, 1000);
  assert.throws(() => b.recordPayment({ clientId: acme, amountCents: 0 }), /Payment amount/);
  assert.throws(() => b.recordPayment({ clientId: acme, amountCents: 500, allocations: [{ invoiceId: inv.id, amountCents: 600 }] }), /More is applied/);
  assert.throws(() => b.recordPayment({ clientId: acme, amountCents: 2000, allocations: [{ invoiceId: inv.id, amountCents: 1500 }] }), /more than the \$10\.00 owed/);
  assert.throws(() => b.recordPayment({ clientId: acme, amountCents: 500, allocations: [{ invoiceId: jones.id, amountCents: 500 }] }), /different client/);
  assert.throws(() => b.recordPayment({ clientId: bob, matterId: m1, amountCents: 500 }), /different client/);
  const draft = b.createDraft({ matterId: m1 });
  assert.throws(() => b.payInvoice(draft.id, { amountCents: 1 }), /draft/);
  // Failed calls leave nothing behind.
  assert.equal(b.listPayments().length, 0);
  // One payment split across two invoices of the same client.
  const inv2 = billed(ctx, ctx.m2, 2000);
  const p = b.recordPayment({ clientId: acme, amountCents: 3000, allocations: [{ invoiceId: inv.id, amountCents: 1000 }, { invoiceId: inv2.id, amountCents: 2000 }] });
  assert.equal(p.unapplied_cents, 0);
  assert.equal(b.balance(inv.id) + b.balance(inv2.id), 0);
});

test("voiding a payment makes the money owed again", () => {
  const ctx = setup();
  const { b, db, acme, m1 } = ctx;
  const inv = billed(ctx, m1, 5000);
  const p = b.payInvoice(inv.id, { amountCents: 6000 });
  assert.throws(() => b.voidPayment(p.id, ""), /reason/);
  b.voidPayment(p.id, "Check returned", ctx.atty);
  assert.equal(b.balance(inv.id), 5000);
  assert.equal(b.clientCredit(acme), 0);
  assert.throws(() => b.voidPayment(p.id, "again"), /already void/);
  const log = activity(db, "payment_voided");
  assert.equal(log.length, 1);
  assert.equal(log[0].matter_id, m1);
  assert.match(log[0].detail, /Check returned/);
});

test("write-off of a finalized balance needs a reason and is logged", () => {
  const ctx = setup();
  const { b, db, m1 } = ctx;
  const inv = billed(ctx, m1, 5000);
  b.payInvoice(inv.id, { amountCents: 2000 });
  assert.throws(() => b.writeOffBalance(inv.id, { reason: "" }), /reason/);
  assert.throws(() => b.writeOffBalance(inv.id, { amountCents: 3001, reason: "x" }), /more than/);
  b.writeOffBalance(inv.id, { amountCents: 1000, reason: "Courtesy" }, ctx.atty);
  assert.equal(b.balance(inv.id), 2000);
  b.writeOffBalance(inv.id, { reason: "Uncollectible" });
  assert.equal(b.balance(inv.id), 0);
  assert.throws(() => b.writeOffBalance(inv.id, { reason: "x" }), /Nothing is owed/);
  const log = activity(db, "invoice_written_off");
  assert.equal(log.length, 2);
  assert.equal(log[0].user_id, ctx.atty);
  assert.equal(log[0].matter_id, m1);
});

test("aging: buckets by days past due on the boundary days", () => {
  const ctx = setup();
  const { b, setDay, m1 } = ctx;
  b.updateSettings({ paymentTermsDays: 30 });
  setDay("2026-01-01");
  const inv = billed(ctx, m1, 12345); // due 2026-01-31
  assert.equal(inv.due_on, "2026-01-31");
  const bucketOn = (d: string) => {
    const r = aging(b, d);
    const row = r.rows[0];
    const filled = ["current", "d1_30", "d31_60", "d61_90", "d90_plus"].filter((k) => row[k] !== 0);
    assert.equal(filled.length, 1);
    assert.equal(row[filled[0]], 12345);
    assert.equal(r.totals.total, 12345);
    return [filled[0], row.invoices[0].days_past_due];
  };
  assert.deepEqual(bucketOn("2026-01-01"), ["current", 0]);
  assert.deepEqual(bucketOn("2026-01-31"), ["current", 0]); // due date itself
  assert.deepEqual(bucketOn("2026-02-01"), ["d1_30", 1]);
  assert.deepEqual(bucketOn("2026-03-02"), ["d1_30", 30]);
  assert.deepEqual(bucketOn("2026-03-03"), ["d31_60", 31]);
  assert.deepEqual(bucketOn("2026-04-01"), ["d31_60", 60]);
  assert.deepEqual(bucketOn("2026-04-02"), ["d61_90", 61]);
  assert.deepEqual(bucketOn("2026-05-01"), ["d61_90", 90]);
  assert.deepEqual(bucketOn("2026-05-02"), ["d90_plus", 91]);
  // Before the invoice existed it is not on the report.
  assert.equal(aging(b, "2025-12-31").rows.length, 0);
});

test("aging is as of the date: later payments, write-offs and voids do not count yet", () => {
  const ctx = setup();
  const { b, setDay, m1, m2 } = ctx;
  setDay("2026-01-01");
  const a = billed(ctx, m1, 10000);
  const c = billed(ctx, m2, 20000);
  b.payInvoice(a.id, { amountCents: 4000, receivedOn: "2026-02-15" });
  setDay("2026-03-01");
  b.writeOffBalance(a.id, { amountCents: 1000, reason: "Courtesy" });
  b.void(c.id, "Duplicate");
  assert.equal(aging(b, "2026-02-14").totals.total, 30000);
  assert.equal(aging(b, "2026-02-15").totals.total, 26000);
  assert.equal(aging(b, "2026-02-28").totals.total, 26000);
  const now = aging(b, "2026-03-01");
  assert.equal(now.totals.total, 5000);
  assert.equal(now.rows[0].invoices.length, 1);
});

test("statement of account: running balance, opening balance, voids, credits", () => {
  const ctx = setup();
  const { b, setDay, acme, m1, m2 } = ctx;
  setDay("2026-09-01");
  const a = billed(ctx, m1, 10000);
  b.payInvoice(a.id, { amountCents: 4000, receivedOn: "2026-09-10", method: "check", reference: "55" });
  setDay("2026-10-01");
  const c = billed(ctx, m2, 25000);
  setDay("2026-10-05");
  b.void(c.id, "Wrong matter");
  const d = billed(ctx, m2, 20000);
  b.payInvoice(d.id, { amountCents: 30000, receivedOn: "2026-10-20" }); // 10000 over -> credit
  b.writeOffBalance(a.id, { amountCents: 1000, reason: "Courtesy" });

  const s = b.statement(acme, null, "2026-10-31");
  assert.deepEqual(
    s.lines.map((l: any) => [l.date, l.type, l.amount_cents, l.balance_cents]),
    [
      ["2026-09-01", "invoice", 10000, 10000],
      ["2026-09-10", "payment", -4000, 6000],
      ["2026-10-01", "invoice", 25000, 31000],
      ["2026-10-05", "invoice", 20000, 51000],
      ["2026-10-05", "write_off", -1000, 50000],
      ["2026-10-05", "invoice_void", -25000, 25000],
      ["2026-10-20", "payment", -30000, -5000],
    ],
  );
  assert.equal(s.closing_balance_cents, -5000);
  // Closing balance = open invoice balances - unapplied credit
  const open = s.open_invoices.reduce((t: number, i: any) => t + i.balance_cents, 0);
  assert.equal(open, 5000);
  assert.equal(s.credit_cents, 10000);
  assert.equal(open - s.credit_cents, s.closing_balance_cents);
  assert.match(s.lines[1].description, /check 55/);

  const oct = b.statement(acme, "2026-10-01", "2026-10-31");
  assert.equal(oct.opening_balance_cents, 6000);
  assert.equal(oct.lines[0].balance_cents, 31000);
  assert.equal(oct.closing_balance_cents, -5000);

  const sep = b.statement(acme, "2026-09-01", "2026-09-30");
  assert.equal(sep.closing_balance_cents, 6000);
  assert.equal(sep.credit_cents, 0);
});

test("statement stays consistent when a written-off invoice is voided and payments move to credit", () => {
  const ctx = setup();
  const { b, acme, m1 } = ctx;
  const a = billed(ctx, m1, 10000);
  b.payInvoice(a.id, { amountCents: 3000 });
  b.writeOffBalance(a.id, { amountCents: 2000, reason: "Courtesy" });
  b.void(a.id, "Reissue");
  const s = b.statement(acme);
  assert.equal(s.closing_balance_cents, -3000);
  assert.equal(s.credit_cents, 3000);
  assert.equal(s.open_invoices.length, 0);
});
