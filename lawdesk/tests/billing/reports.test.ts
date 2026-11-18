import { test } from "node:test";
import assert from "node:assert/strict";
import { setup } from "./helpers.ts";
import { billedVsCollected, unbilledTime, wip } from "../../src/billing/reports.ts";

test("unbilled time by matter and user, including work sitting on drafts", () => {
  const { b, atty, para, m1, m2 } = setup();
  b.addTime({ userId: atty, matterId: m1, date: "2026-10-01", minutes: 7 }); // 12 min billed, $60
  b.addTime({ userId: atty, matterId: m1, date: "2026-10-02", minutes: 7 }); // per-entry rounding: another 12
  b.addTime({ userId: para, matterId: m1, date: "2026-10-03", minutes: 60 }); // $120
  b.addTime({ userId: atty, matterId: m2, date: "2026-10-04", minutes: 30, billable: false });
  b.addTime({ userId: atty, matterId: m2, date: "2026-11-01", minutes: 60 });
  const r = unbilledTime(b, { to: "2026-10-31" });
  assert.deepEqual(
    r.rows.map((g) => [g.matter_id, g.user_id, g.entries, g.minutes, g.billed_minutes, g.value_cents]),
    [
      [m1, atty, 2, 14, 24, 12000],
      [m1, para, 1, 60, 60, 12000],
    ],
  );
  assert.equal(r.totals.value_cents, 24000);
  // On a draft: still unbilled, shown as on draft.
  b.createDraft({ matterId: m1 });
  const r2 = unbilledTime(b, { matterId: m1 });
  assert.equal(r2.rows[0].on_draft_minutes, 14);
  // Finalized: gone.
  b.finalize(b.listInvoices({ matterId: m1 })[0].id);
  assert.equal(unbilledTime(b, { matterId: m1 }).rows.length, 0);
  assert.equal(unbilledTime(b, { userId: atty }).totals.minutes, 60);
});

test("WIP per matter: hourly time, expenses and an unbilled flat fee", () => {
  const { b, atty, m1, m2, m3 } = setup();
  b.addTime({ userId: atty, matterId: m1, minutes: 60 });
  b.addExpense({ matterId: m1, costCents: 1000, markupBp: 1000 });
  b.setMatterBilling(m2, { method: "flat", flatFeeCents: 90000 });
  b.addTime({ userId: atty, matterId: m2, minutes: 120 });
  b.setMatterBilling(m3, { method: "contingency" });
  b.addTime({ userId: atty, matterId: m3, minutes: 60 });
  const r = wip(b);
  const by = Object.fromEntries(r.rows.map((x) => [x.matter_id, x]));
  assert.deepEqual([by[m1].time_cents, by[m1].expense_cents, by[m1].flat_fee_cents, by[m1].total_cents], [30000, 1100, 0, 31100]);
  assert.deepEqual([by[m2].time_cents, by[m2].flat_fee_cents, by[m2].minutes], [0, 90000, 120]);
  assert.deepEqual([by[m3].time_cents, by[m3].minutes, by[m3].billing_method], [0, 60, "contingency"]);
  assert.equal(r.totals.total_cents, 31100 + 90000);
  const d = b.createDraft({ matterId: m2 });
  assert.deepEqual(wip(b, { matterId: m2 }).rows[0].draft_invoice_ids, [d.id]);
  assert.equal(wip(b, { matterId: m2 }).rows[0].flat_fee_cents, 90000); // still WIP while on a draft
  b.finalize(d.id);
  assert.equal(wip(b, { matterId: m2 }).rows.length, 0);
});

test("billed vs collected: realization and collection rates", () => {
  const ctx = setup();
  const { b, atty, m1, m2, setDay } = ctx;
  setDay("2026-10-15");
  b.addTime({ userId: atty, matterId: m1, minutes: 60 }); // standard $300
  b.addTime({ userId: atty, matterId: m1, minutes: 60 }); // standard $300
  const d = b.createDraft({ matterId: m1 });
  b.writeDownLine(d.id, d.lines[1].id, { amountCents: 10000, reason: "Training time" });
  b.updateDraft(d.id, { discountKind: "fixed", discountValue: 5000 });
  const inv = b.finalize(d.id); // billed 600 - 100 - 50 = 450
  assert.equal(inv.total_cents, 45000);
  b.payInvoice(inv.id, { amountCents: 30000, receivedOn: "2026-10-20" });
  b.payInvoice(inv.id, { amountCents: 5000, receivedOn: "2026-11-03" }); // collected later, still counts toward October's billings
  // A voided invoice in the period is ignored.
  b.addTime({ userId: atty, matterId: m2, minutes: 60 });
  b.void(b.finalize(b.createDraft({ matterId: m2 }).id).id, "Mistake");

  const oct = billedVsCollected(b, "2026-10-01", "2026-10-31");
  assert.equal(oct.invoices, 1);
  assert.equal(oct.standard_cents, 60000);
  assert.equal(oct.written_down_cents, 10000);
  assert.equal(oct.discount_cents, 5000);
  assert.equal(oct.billed_cents, 45000);
  assert.equal(oct.realization_rate, 0.75);
  assert.equal(oct.collected_cents, 35000);
  assert.equal(oct.collection_rate, 0.7778);
  assert.equal(oct.cash_received_cents, 30000);
  const nov = billedVsCollected(b, "2026-11-01", "2026-11-30");
  assert.equal(nov.invoices, 0);
  assert.equal(nov.realization_rate, null);
  assert.equal(nov.cash_received_cents, 5000);
  assert.throws(() => billedVsCollected(b, "2026-11-30", "2026-11-01"), /after its end/);
});
