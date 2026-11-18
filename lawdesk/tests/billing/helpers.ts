import { openDb } from "../../src/db.ts";
import { Engine } from "../../src/engine.ts";
import { Billing } from "../../src/billing/billing.ts";
import { SCHEMA } from "../../src/billing/schema.ts";

/** A firm with two timekeepers, two clients and three matters, on a clock the test controls. */
export function setup(start = "2026-11-02") {
  let day = start;
  let now = new Date(start + "T15:00:00Z");
  const db = openDb();
  db.exec(SCHEMA);
  const engine = new Engine(db, { today: () => day });
  const b = new Billing(db, { today: () => day, now: () => now });
  const atty = engine.addUser("Attorney A", "attorney");
  const para = engine.addUser("Paralegal P", "paralegal");
  const acme = engine.addContact("Acme Widgets LLC", "company");
  const bob = engine.addContact("Bob Jones");
  const m1 = engine.createMatter({ name: "Acme lease", number: "2026-001", clientId: acme });
  const m2 = engine.createMatter({ name: "Acme formation", number: "2026-002", clientId: acme });
  const m3 = engine.createMatter({ name: "Jones estate", number: "2026-003", clientId: bob });
  b.updateSettings({ firmName: "Test Firm", defaultRateCents: 20000 });
  b.setUserRate(atty, 30000);
  b.setUserRate(para, 12000);
  return {
    db,
    engine,
    b,
    atty,
    para,
    acme,
    bob,
    m1,
    m2,
    m3,
    setDay: (d: string) => (day = d),
    setNow: (iso: string) => (now = new Date(iso)),
  };
}

export function activity(db: any, kind?: string) {
  return (kind
    ? db.prepare("SELECT * FROM activity WHERE kind = ? ORDER BY id").all(kind)
    : db.prepare("SELECT * FROM activity ORDER BY id").all()) as any[];
}
