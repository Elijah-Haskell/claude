// Shared set-up for intake tests: an in-memory database with every module's tables,
// a fixed "today" and a clock the test can move.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/db.ts";
import { Engine } from "../../src/engine.ts";
import { matchPath, type Route } from "../../src/http.ts";
import { modules } from "../../src/modules.ts";
import { Documents } from "../../src/documents/documents.ts";
import { setDocuments } from "../../src/documents/routes.ts";
import { Intake } from "../../src/intake/leads.ts";
import { routes } from "../../src/intake/routes.ts";

export const TODAY = "2026-11-18"; // a Wednesday
export const NOW = Date.parse("2026-11-18T15:00:00Z"); // 9:00 AM in Kansas

export function setup() {
  const db = openDb();
  for (const m of modules) if (m.schema) db.exec(m.schema);
  const engine = new Engine(db, { today: () => TODAY });
  const docs = new Documents(db, { dir: mkdtempSync(join(tmpdir(), "lawdesk-intake-")), today: () => TODAY, fts: false });
  setDocuments(db, docs);
  const clock = { now: NOW };
  const it = new Intake(db, engine, { now: () => clock.now, documents: docs });
  const jordan = engine.addUser("Jordan Ellis", "attorney", "jordan@example.test");
  const sam = engine.addUser("Sam Ortiz", "paralegal");
  const area = engine.addPracticeArea("Business formation", ["Intake", "Drafting", "Done"]);
  return { db, engine, docs, it, clock, jordan, sam, area };
}

/** Call the intake routes the way the server does (public routes get an ip). */
export function caller(env: ReturnType<typeof setup>, userId: number | null = null) {
  return async function call(method: Route["method"], url: string, body: any = {}, ip = "203.0.113.9") {
    const u = new URL(url, "http://x");
    for (const r of routes) {
      if (r.method !== method) continue;
      const params = matchPath(r.path, u.pathname);
      if (!params) continue;
      try {
        return { status: 200, data: (await r.handler({ db: env.db, engine: env.engine, params, query: u.searchParams, body, userId, ip } as any)) as any };
      } catch (e: any) {
        return { status: e.status ?? 500, data: { error: e.message } };
      }
    }
    return { status: 404, data: { error: "no route" } };
  };
}
