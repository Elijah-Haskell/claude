import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../../src/db.ts";
import { seed } from "../../src/seed.ts";
import { STATUS_KEYS } from "../../src/intake/schema.ts";

test("the demo seed has a made-up lead in every stage, a form and booking hours", () => {
  const db = openDb();
  seed(db, "2026-11-17");
  for (const s of STATUS_KEYS) {
    const n = (db.prepare("SELECT COUNT(*) AS n FROM intake_leads WHERE status = ?").get(s) as any).n;
    assert.ok(n >= 1, `a lead in ${s}`);
  }
  const names = db.prepare("SELECT name FROM intake_leads").all() as any[];
  assert.ok(names.every((r) => /\(demo\)/.test(r.name)), "every lead is marked demo");
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM intake_forms").get() as any).n, 1);
  assert.ok((db.prepare("SELECT COUNT(*) AS n FROM intake_availability").get() as any).n >= 5);
  const hired = db.prepare("SELECT * FROM intake_leads WHERE status = 'hired'").get() as any;
  assert.ok(hired.matter_id, "the hired lead points at its matter");
  assert.ok((db.prepare("SELECT COUNT(*) AS n FROM intake_consultations").get() as any).n >= 1, "a consultation is booked");
  assert.ok((db.prepare("SELECT COUNT(*) AS n FROM intake_engagements WHERE status = 'sent'").get() as any).n >= 1, "an engagement letter went out");
});
