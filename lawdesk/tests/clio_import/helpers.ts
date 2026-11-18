import { readFileSync } from "node:fs";
import { openDb } from "../../src/db.ts";
import { Engine } from "../../src/engine.ts";
import { SCHEMA as BILLING } from "../../src/billing/schema.ts";
import { SCHEMA as CALENDAR } from "../../src/calendar/schema.ts";
import { SCHEMA as CLIO } from "../../src/clio_import/schema.ts";
import { ClioImporter } from "../../src/clio_import/importer.ts";

export function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
}

/** A firm with two attorneys (all names are made up). */
export function setup(today = "2026-03-15") {
  const db = openDb();
  db.exec(BILLING);
  db.exec(CALENDAR);
  db.exec(CLIO);
  const engine = new Engine(db, { today: () => today });
  const jordan = engine.addUser("Jordan Reyes", "attorney", "jordan@example.com");
  const riley = engine.addUser("Riley Chen", "attorney", "riley@example.com");
  const imp = new ClioImporter(db, engine, { now: () => new Date(`${today}T18:00:00Z`) });
  const q = (sql: string, ...p: any[]) => db.prepare(sql).all(...p) as any[];
  const one = (sql: string, ...p: any[]) => db.prepare(sql).get(...p) as any;
  return { db, engine, imp, jordan, riley, q, one };
}

/** Load contacts and matters from the fixture files. */
export function withMatters(today?: string) {
  const s = setup(today);
  s.imp.importCsv("contacts", fixture("contacts_migration.csv"));
  s.imp.importCsv("matters", fixture("matters_migration.csv"));
  return s;
}
