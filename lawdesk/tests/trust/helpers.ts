import { openDb } from "../../src/db.ts";
import { Engine } from "../../src/engine.ts";
import { Billing } from "../../src/billing/billing.ts";
import { SCHEMA as BILLING_SCHEMA } from "../../src/billing/schema.ts";
import { SCHEMA as TRUST_SCHEMA } from "../../src/trust/schema.ts";
import { Trust } from "../../src/trust/trust.ts";

/** A made-up firm: one attorney, two clients, three matters, an IOLTA account, a clock the test controls. */
export function setup(start = "2026-10-01") {
  let day = start;
  const db = openDb();
  db.exec(BILLING_SCHEMA);
  db.exec(TRUST_SCHEMA);
  const engine = new Engine(db, { today: () => day });
  const now = () => new Date(day + "T15:00:00Z");
  const t = new Trust(db, engine, { today: () => day, now });
  const b = new Billing(db, { today: () => day, now });
  const atty = engine.addUser("Attorney A", "attorney");
  const acme = engine.addContact("Acme Widgets LLC (demo)", "company");
  const bob = engine.addContact("Bob Jones (demo)");
  const m1 = engine.createMatter({ name: "Acme lease", number: "2026-001", clientId: acme });
  const m2 = engine.createMatter({ name: "Acme formation", number: "2026-002", clientId: acme });
  const m3 = engine.createMatter({ name: "Jones estate", number: "2026-003", clientId: bob });
  const acct = t.createAccount(
    { name: "IOLTA", bankName: "Example Bank (demo)", accountLast4: "1234", kind: "iolta", inKansas: true, firmFundsLimitCents: 20000, openedOn: "2026-01-01" },
    atty,
  );
  return { db, engine, t, b, atty, acme, bob, m1, m2, m3, acct: acct.id as number, setDay: (d: string) => (day = d) };
}

export type Ctx = ReturnType<typeof setup>;

export function finalInvoice(ctx: Ctx, matterId: number, cents: number) {
  const d = ctx.b.createDraft({ matterId });
  ctx.b.addLine(d.id, { kind: "flat", amountCents: cents, description: "Services" });
  return ctx.b.finalize(d.id);
}

/** A cleared deposit. */
export function fund(ctx: Ctx, matterId: number, cents: number, date = "2026-10-02") {
  return ctx.t.deposit(ctx.acct, matterId, { amountCents: cents, party: "Client (demo)", date, clearedOn: date }, ctx.atty);
}

export function activity(db: any, kind: string) {
  return db.prepare("SELECT * FROM activity WHERE kind = ? ORDER BY id").all(kind) as any[];
}
