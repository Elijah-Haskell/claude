import { test } from "node:test";
import assert from "node:assert/strict";
import { activity, setup } from "./helpers.ts";
import { renderInvoiceHtml } from "../../src/billing/render.ts";

test("draft picks up unbilled billable time and expenses in the date range, priced to the cent", () => {
  const { b, atty, para, m1, m2 } = setup();
  b.addTime({ userId: atty, matterId: m1, date: "2026-10-01", minutes: 7, description: "Call" }); // 0.2 h x $300 = $60
  b.addTime({ userId: para, matterId: m1, date: "2026-10-15", minutes: 61, description: "Draft" }); // 1.1 h x $120 = $132
  b.addTime({ userId: atty, matterId: m1, date: "2026-10-20", minutes: 30, billable: false }); // not billable
  b.addTime({ userId: atty, matterId: m1, date: "2026-11-01", minutes: 60 }); // outside range
  b.addTime({ userId: atty, matterId: m2, date: "2026-10-10", minutes: 60 }); // other matter
  b.addTime({ userId: atty, matterId: m1, date: "2026-10-21", minutes: 6, rateCents: 25025 }); // 2502.5c -> 2503c
  b.addTime({ userId: atty, matterId: m1, date: "2026-10-22", minutes: 45, flatCents: 50000, description: "Lease review (flat)" });
  b.addExpense({ matterId: m1, date: "2026-10-05", costCents: 1999, markupBp: 1500, description: "Courier" });

  const inv = b.createDraft({ matterId: m1, from: "2026-10-01", to: "2026-10-31" });
  assert.equal(inv.status, "draft");
  assert.equal(inv.number, null);
  const amounts = inv.lines.map((l: any) => [l.kind, l.minutes, l.amount_cents]);
  assert.deepEqual(amounts, [
    ["time", 12, 6000],
    ["time", 66, 13200],
    ["time", 6, 2503],
    ["time", 48, 50000],
    ["expense", null, 2299],
  ]);
  assert.equal(inv.totals.subtotal_cents, 6000 + 13200 + 2503 + 50000 + 2299);
  assert.equal(inv.totals.tax_cents, 0); // tax off by default
  assert.equal(inv.totals.total_cents, inv.totals.subtotal_cents);

  // A second draft for the same range finds nothing left; the out-of-range entry remains unbilled.
  const again = b.createDraft({ matterId: m1, from: "2026-10-01", to: "2026-10-31" });
  assert.equal(again.lines.length, 0);
  assert.equal(b.listTime({ matterId: m1, status: "unbilled" }).filter((t) => t.invoice_id == null).length, 2);
});

test("draft needs a client and a sensible range", () => {
  const { b, engine } = setup();
  const orphan = engine.createMatter({ name: "No client" });
  assert.throws(() => b.createDraft({ matterId: orphan }), /no client/);
  const m = engine.createMatter({ name: "x", clientId: engine.addContact("C") });
  assert.throws(() => b.createDraft({ matterId: m, from: "2026-10-31", to: "2026-10-01" }), /after its end/);
});

test("editing draft lines: re-price, manual flat line, remove releases the entry", () => {
  const { b, atty, m1 } = setup();
  const e = b.addTime({ userId: atty, matterId: m1, minutes: 30 });
  const inv = b.createDraft({ matterId: m1 });
  const line = inv.lines[0];
  assert.equal(line.amount_cents, 15000);
  const edited = b.updateLine(inv.id, line.id, { minutes: 20, description: "Edited" }); // 20 -> 24 min = 0.4 h
  assert.equal(edited.minutes, 24);
  assert.equal(edited.amount_cents, 12000);
  assert.equal(edited.standard_cents, 15000); // realization baseline is unchanged
  const flat = b.addLine(inv.id, { kind: "flat", description: "Filing package", amountCents: 75000 });
  assert.equal(flat.amount_cents, 75000);
  const manualTime = b.addLine(inv.id, { kind: "time", minutes: 10, rateCents: 10000, description: "Misc" });
  assert.equal(manualTime.amount_cents, 2000); // 0.2 h
  assert.equal(b.invoice(inv.id).totals.total_cents, 12000 + 75000 + 2000);
  b.removeLine(inv.id, line.id);
  assert.equal(b.timeEntry(e.id).invoice_id, null);
  assert.throws(() => b.addLine(inv.id, { kind: "bogus" as any }), /kind/);
});

test("discounts: percent (rounded half-up once) and fixed (capped at subtotal)", () => {
  const { b, m1 } = setup();
  const inv = b.createDraft({ matterId: m1 });
  b.addLine(inv.id, { kind: "flat", amountCents: 10005 });
  let v = b.updateDraft(inv.id, { discountKind: "percent", discountValue: 1000 }); // 10% of 100.05 = 10.005 -> 10.01
  assert.equal(v.totals.discount_cents, 1001);
  assert.equal(v.totals.total_cents, 9004);
  v = b.updateDraft(inv.id, { discountKind: "fixed", discountValue: 2500 });
  assert.equal(v.totals.discount_cents, 2500);
  assert.equal(v.totals.total_cents, 7505);
  v = b.updateDraft(inv.id, { discountValue: 999999 });
  assert.equal(v.totals.discount_cents, 10005);
  assert.equal(v.totals.total_cents, 0);
  assert.throws(() => b.updateDraft(inv.id, { discountKind: "percent", discountValue: 10001 }), /10000/);
  v = b.updateDraft(inv.id, { discountKind: "none" });
  assert.equal(v.totals.discount_cents, 0);
});

test("write-downs and write-offs per line need a reason and are logged", () => {
  const { b, db, atty, m1 } = setup();
  b.addTime({ userId: atty, matterId: m1, minutes: 60, description: "Research" });
  b.addTime({ userId: atty, matterId: m1, minutes: 30, description: "Duplicate call" });
  const inv = b.createDraft({ matterId: m1 });
  const [a, c] = inv.lines;
  assert.throws(() => b.writeDownLine(inv.id, a.id, { amountCents: 5000 }), /reason/);
  assert.throws(() => b.writeDownLine(inv.id, a.id, { amountCents: 30001, reason: "x" }), /Write-down/);
  b.writeDownLine(inv.id, a.id, { amountCents: 5000, reason: "Over budget" }, atty);
  b.writeDownLine(inv.id, c.id, { all: true, reason: "Duplicate" }, atty);
  const v = b.invoice(inv.id);
  assert.equal(v.lines[0].net_cents, 25000);
  assert.equal(v.lines[1].net_cents, 0);
  assert.equal(v.totals.total_cents, 25000);
  const down = activity(db, "line_written_down");
  const off = activity(db, "line_written_off");
  assert.equal(down.length, 1);
  assert.equal(off.length, 1);
  assert.equal(down[0].matter_id, m1);
  assert.equal(down[0].user_id, atty);
  assert.match(down[0].detail, /\$50\.00.*Over budget/);
  // A re-price below the write-down is refused
  assert.throws(() => b.updateLine(inv.id, a.id, { amountCents: 100 }), /write-down/);
});

test("sales tax is off by default and applies per line type when configured", () => {
  const { b, atty, m1 } = setup();
  b.updateSettings({ taxExpenseBp: 650 }); // a made-up rate for the test, not a statement of any tax law
  b.addTime({ userId: atty, matterId: m1, minutes: 60 });
  b.addExpense({ matterId: m1, costCents: 1001 });
  const inv = b.createDraft({ matterId: m1 });
  assert.equal(inv.lines[0].tax_bp, 0);
  assert.equal(inv.lines[1].tax_bp, 650);
  assert.equal(inv.totals.tax_cents, 65); // 6.5% of 10.01 = 65.065c -> 65c
  assert.equal(inv.totals.total_cents, 30000 + 1001 + 65);
  b.updateLine(inv.id, inv.lines[0].id, { taxBp: 100 });
  assert.equal(b.invoice(inv.id).totals.tax_cents, 65 + 300);
});

test("finalize: sequential numbers, dates, frozen totals and locked lines", () => {
  const { b, db, atty, m1, m2, setDay } = setup();
  b.updateSettings({ firstInvoiceNumber: 1001, paymentTermsDays: 15 });
  b.addTime({ userId: atty, matterId: m1, minutes: 60 });
  b.addTime({ userId: atty, matterId: m2, minutes: 60 });
  const d1 = b.createDraft({ matterId: m1 });
  const d2 = b.createDraft({ matterId: m2 });
  const empty = b.createDraft({ matterId: m1 });
  assert.throws(() => b.finalize(empty.id), /at least one line/);
  setDay("2026-11-05");
  const f2 = b.finalize(d2.id, atty);
  const f1 = b.finalize(d1.id, atty);
  assert.equal(f2.number, 1001); // numbered in finalize order, not draft order
  assert.equal(f1.number, 1002);
  assert.equal(f1.issued_on, "2026-11-05");
  assert.equal(f1.due_on, "2026-11-20");
  assert.equal(f1.total_cents, 30000);
  assert.throws(() => b.finalize(d1.id), /finalized/);
  assert.throws(() => b.updateLine(d1.id, f1.lines[0].id, { amountCents: 1 }), /cannot be edited/);
  assert.throws(() => b.writeDownLine(d1.id, f1.lines[0].id, { all: true, reason: "x" }), /cannot be edited/);
  assert.throws(() => b.deleteDraft(d1.id), /cannot be edited/);
  assert.throws(() => b.updateSettings({ firstInvoiceNumber: 5 }), /numbering has started/);
  // The database itself refuses to touch a finalized invoice.
  assert.throws(() => db.prepare("DELETE FROM billing_invoices WHERE id = ?").run(d1.id), /never be deleted/);
  assert.throws(() => db.prepare("UPDATE billing_invoice_lines SET amount_cents = 1 WHERE invoice_id = ?").run(d1.id), /cannot be edited/);
  assert.throws(() => db.prepare("UPDATE billing_invoices SET total_cents = 1 WHERE id = ?").run(d1.id), /cannot be edited/);
  assert.throws(() => db.prepare("UPDATE billing_invoices SET number = 7 WHERE id = ?").run(d1.id), /cannot change/);
  assert.throws(() => db.prepare("UPDATE billing_invoices SET status = 'draft' WHERE id = ?").run(d1.id), /draft -> final -> void/);
  const log = activity(db, "invoice_finalized");
  assert.equal(log.length, 2);
  assert.equal(log[1].matter_id, m1);
  assert.equal(log[1].user_id, atty);
  assert.match(log[1].detail, /invoice 1002 for \$300\.00/);
});

test("explicit invoice and due dates are kept; due before issue is refused", () => {
  const { b, m1 } = setup();
  const d = b.createDraft({ matterId: m1 });
  b.addLine(d.id, { kind: "flat", amountCents: 100 });
  assert.throws(() => b.updateDraft(d.id, { issuedOn: "2026-11-10", dueOn: "2026-11-09" }), /before the invoice date/);
  b.updateDraft(d.id, { issuedOn: "2026-10-31", dueOn: "2026-11-30" });
  const f = b.finalize(d.id);
  assert.equal(f.issued_on, "2026-10-31");
  assert.equal(f.due_on, "2026-11-30");
});

test("numbering has no gaps through voids and deleted drafts", () => {
  const { b, atty, m1, m2, m3 } = setup();
  const make = (m: number) => {
    b.addTime({ userId: atty, matterId: m, minutes: 6 });
    return b.createDraft({ matterId: m });
  };
  const a = b.finalize(make(m1).id);
  const throwaway = make(m2);
  b.deleteDraft(throwaway.id); // never numbered
  const c = b.finalize(make(m2).id);
  b.void(a.id, "Wrong client address");
  const d = b.finalize(make(m3).id);
  // Re-bill the voided work: entries came back to unbilled.
  const e = b.finalize(b.createDraft({ matterId: m1 }).id);
  assert.equal(e.lines.length, 1);
  const numbers = b.listInvoices().filter((i) => i.number != null).map((i) => i.number);
  assert.deepEqual(numbers, [1, 2, 3, 4]);
  assert.deepEqual([a.number, c.number, d.number, e.number], [1, 2, 3, 4]);
  assert.equal(b.invoice(a.id).status, "void");
  assert.equal(b.invoice(a.id).number, 1);
});

test("void needs a reason, keeps the invoice, releases entries and moves payments to credit", () => {
  const { b, db, atty, acme, m1, setDay } = setup();
  b.addTime({ userId: atty, matterId: m1, minutes: 60 });
  b.addExpense({ matterId: m1, costCents: 500 });
  const inv = b.finalize(b.createDraft({ matterId: m1 }).id);
  b.payInvoice(inv.id, { amountCents: 10000 });
  assert.throws(() => b.void(inv.id, "  "), /reason/);
  setDay("2026-11-10");
  const v = b.void(inv.id, "Billed to wrong matter", atty);
  assert.equal(v.status, "void");
  assert.equal(v.void_reason, "Billed to wrong matter");
  assert.equal(v.voided_on, "2026-11-10");
  assert.equal(v.balance_cents, 0);
  assert.equal(b.clientCredit(acme), 10000);
  assert.equal(b.listTime({ matterId: m1 })[0].invoice_id, null);
  assert.equal(b.listExpenses({ matterId: m1 })[0].invoice_id, null);
  assert.throws(() => b.void(inv.id, "again"), /already void/);
  assert.throws(() => b.payInvoice(inv.id, { amountCents: 1 }), /void/);
  const draft = b.createDraft({ matterId: m1 });
  assert.throws(() => b.void(draft.id, "x"), /delete it instead/);
  const log = activity(db, "invoice_voided");
  assert.equal(log.length, 1);
  assert.equal(log[0].user_id, atty);
  assert.equal(log[0].matter_id, m1);
  assert.match(log[0].detail, /Billed to wrong matter.*\$100\.00 in payments moved to client credit/);
});

test("flat-fee matters bill the fee once and list time at no charge", () => {
  const { b, atty, m2 } = setup();
  b.setMatterBilling(m2, { method: "flat", flatFeeCents: 150000 });
  assert.throws(() => b.setMatterBilling(m2, { method: "flat", flatFeeCents: null }), /fee amount/);
  b.addTime({ userId: atty, matterId: m2, minutes: 120, description: "Draft operating agreement" });
  b.addExpense({ matterId: m2, costCents: 16000, description: "Filing fee" });
  const inv = b.createDraft({ matterId: m2 });
  assert.deepEqual(
    inv.lines.map((l: any) => [l.kind, l.amount_cents, l.no_charge_note]),
    [
      ["flat", 150000, null],
      ["time", 0, "Included in flat fee"],
      ["expense", 16000, null],
    ],
  );
  const f = b.finalize(inv.id);
  b.addTime({ userId: atty, matterId: m2, minutes: 30 });
  const next = b.createDraft({ matterId: m2 });
  assert.equal(next.lines.filter((l: any) => l.kind === "flat").length, 0); // already billed
  b.deleteDraft(next.id);
  b.void(f.id, "Reissue");
  const reissue = b.createDraft({ matterId: m2 });
  assert.equal(reissue.lines.filter((l: any) => l.matter_flat_fee === 1).length, 1); // void frees it up again
});

test("contingency matters are non-hourly: time is no-charge, expenses bill", () => {
  const { b, atty, m3 } = setup();
  b.setMatterBilling(m3, { method: "contingency" });
  b.addTime({ userId: atty, matterId: m3, minutes: 90 });
  b.addExpense({ matterId: m3, costCents: 4200 });
  const inv = b.createDraft({ matterId: m3 });
  assert.deepEqual(
    inv.lines.map((l: any) => [l.kind, l.amount_cents, l.no_charge_note]),
    [
      ["time", 0, "Contingency matter: no hourly charge"],
      ["expense", 4200, null],
    ],
  );
});

test("printable invoice is self-contained and escapes text", () => {
  const { b, atty, m1, engine } = setup();
  b.updateSettings({ firmName: "Smith & Jones <LLP>", firmAddress: "1 Main St\nTopeka, KS" });
  b.addTime({ userId: atty, matterId: m1, minutes: 30, description: `<script>alert("x")</script> & 'quotes'` });
  const inv = b.createDraft({ matterId: m1 });
  b.writeDownLine(inv.id, inv.lines[0].id, { amountCents: 100, reason: "<b>courtesy</b>" });
  b.updateDraft(inv.id, { notes: "Thanks <3", discountKind: "percent", discountValue: 500 });
  let html = renderInvoiceHtml(b.invoice(inv.id), b.settings());
  assert.match(html, /DRAFT/);
  b.finalize(inv.id);
  html = renderInvoiceHtml(b.invoice(inv.id), b.settings());
  assert.ok(!html.includes("<script>"));
  assert.ok(html.includes("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;quotes&#39;"));
  assert.ok(html.includes("Smith &amp; Jones &lt;LLP&gt;"));
  assert.ok(html.includes("&lt;b&gt;courtesy&lt;/b&gt;"));
  assert.ok(html.includes("Thanks &lt;3"));
  assert.ok(html.includes("1 Main St<br>Topeka, KS"));
  assert.ok(html.includes("Invoice 1"));
  assert.ok(html.includes("Amount due"));
  assert.ok(html.includes("Discount (5%)"));
  // No external assets of any kind.
  assert.ok(!/\b(src|href)\s*=/.test(html));
  assert.ok(!/url\(|@import|https?:/.test(html));
  b.void(inv.id, "test <void>");
  html = renderInvoiceHtml(b.invoice(inv.id), b.settings());
  assert.ok(html.includes(">VOID<"));
  assert.ok(html.includes("test &lt;void&gt;"));
  void engine;
});
