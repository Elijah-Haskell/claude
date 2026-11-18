// Made-up billing history for the browser test, so the firm overview and the money
// reports have something to draw. Fictional demo data only; never real client data.

import type { DB } from "../../src/db.ts";
import { addDays, type ISODate } from "../../src/dates.ts";
import { Billing } from "../../src/billing/billing.ts";
import { SCHEMA as BILLING_SCHEMA } from "../../src/billing/schema.ts";
import { SCHEMA as CONFLICTS_SCHEMA } from "../../src/conflicts/schema.ts";

function monthsBack(today: ISODate, n: number, day: number): ISODate {
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7)) - 1 - n;
  const yy = y + Math.floor(m / 12);
  const mm = ((m % 12) + 12) % 12;
  return `${yy}-${String(mm + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function addReportsDemo(db: DB, today: ISODate, demo: { users: Record<string, number>; matters: Record<string, number> }) {
  db.exec(BILLING_SCHEMA);
  db.exec(CONFLICTS_SCHEMA);
  let day = today;
  const b = new Billing(db, { today: () => day, now: () => new Date(day + "T16:00:00Z") });
  const { jordan, riley, sam } = demo.users;
  const { m1, m2, m4, m6 } = demo.matters;
  b.updateSettings({ firmName: "Demo Law Office (fictional)", defaultRateCents: 25000, paymentTermsDays: 30 });
  b.setUserRate(jordan, 30000);
  b.setUserRate(riley, 27500);
  b.setUserRate(sam, 12500);

  // Eleven months of monthly invoices on two matters, mostly paid.
  for (let i = 11; i >= 1; i--) {
    for (const [matter, lawyer, base] of [[m6, jordan, 150], [m4, riley, 100]] as const) {
      const work = monthsBack(today, i, 8);
      b.addTime({ userId: lawyer, matterId: matter, date: work, minutes: base + i * 9, description: "Drafting and review" });
      b.addTime({ userId: sam, matterId: matter, date: monthsBack(today, i, 9), minutes: 60 + i * 4, description: "Document preparation" });
      b.addTime({ userId: sam, matterId: matter, date: monthsBack(today, i, 10), minutes: 25, billable: false, description: "File organisation" });
      day = monthsBack(today, i, 25);
      const inv = b.createDraft({ matterId: matter, to: day });
      if (i % 4 === 0) b.writeDownLine(inv.id, inv.lines[0].id, { amountCents: 2500, reason: "Courtesy reduction" });
      const fin = b.finalize(inv.id);
      // Older invoices paid in full about three weeks later; one paid in part; recent ones open.
      const paidOn = addDays(day, 22);
      if (paidOn < today && !(matter === m4 && i === 3)) {
        day = paidOn;
        b.payInvoice(fin.id, { amountCents: matter === m6 && i === 4 ? Math.floor(fin.total_cents / 2) : fin.total_cents, method: "check" });
      }
    }
  }
  // This month's work, not billed yet.
  day = today;
  b.addTime({ userId: jordan, matterId: m1, date: addDays(today, -3), minutes: 132, description: "Operating agreement draft" });
  b.addTime({ userId: sam, matterId: m1, date: addDays(today, -2), minutes: 48, description: "Articles of organization" });
  b.addTime({ userId: riley, matterId: m2, date: addDays(today, -1), minutes: 75, description: "Lease review" });

  db.prepare(
    "INSERT INTO conflicts_checks (matter_id, run_by, run_at, terms, results, hit_count) VALUES (?,?,?,?,?,?)",
  ).run(m2, sam, `${addDays(today, -4)}T15:00:00.000Z`, JSON.stringify([{ name: "Prairie Wind Holdings (demo)" }]), "[]", 1);
  // A closed-out matter left untouched for six weeks, so the "quiet" list has an entry.
  db.prepare("UPDATE activity SET at = ? WHERE matter_id = ?").run(`${addDays(today, -45)}T15:00:00.000Z`, m2);
}
