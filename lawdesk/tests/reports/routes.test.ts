import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createServer } from "../../src/server.ts";
import { fixture, TODAY } from "./fixture.ts";

async function withServer(fn: (base: string) => Promise<void>) {
  const f = fixture();
  const server = createServer(f.db, { today: () => TODAY, log: () => {} });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api`);
  } finally {
    server.close();
  }
  return f;
}

test("catalogue, dashboard and one report over HTTP", async () => {
  await withServer(async (base) => {
    const cat = await (await fetch(base + "/reports")).json();
    assert.deepEqual(cat.reports.map((r: any) => r.key), ["tasks", "matters", "productivity", "revenue", "aging", "time-by-matter", "clients", "activity"]);
    assert.equal(cat.billing, true);
    assert.ok(cat.reports.find((r: any) => r.key === "activity").options[0].choices.some((c: any) => c.value === "stage_changed"));
    assert.equal(cat.people.length, 3);
    const d = await (await fetch(base + "/reports/dashboard")).json();
    assert.equal(d.tiles.outstanding_cents, 69000);
    const r = await (await fetch(base + "/reports/productivity?from=2026-07-01&to=2026-11-18")).json();
    assert.equal(r.totals.worked, 482);
    const all = await (await fetch(base + "/reports/matters?all=1&status=all")).json();
    assert.equal(all.rows.length, 3);
  });
});

test("CSV download headers and body", async () => {
  await withServer(async (base) => {
    const res = await fetch(base + "/reports/aging/csv?to=2026-11-18");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/csv; charset=utf-8");
    assert.equal(res.headers.get("content-disposition"), 'attachment; filename="lawdesk-aging-as-of-2026-11-18.csv"');
    const bytes = new Uint8Array(await res.arrayBuffer());
    assert.deepEqual([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf], "UTF-8 BOM");
    const text = new TextDecoder().decode(bytes.slice(3));
    assert.equal(text.split("\r\n")[1], "Acme Widgets LLC,0.00,0.00,0.00,310.00,0.00,310.00,0.00");
    assert.equal(text.split("\r\n")[3], "All clients,0.00,380.00,0.00,310.00,0.00,690.00,100.00");
  });
});

test("bad input is a 4xx with a plain message", async () => {
  await withServer(async (base) => {
    let res = await fetch(base + "/reports/tasks?from=yesterday");
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /date like/);
    res = await fetch(base + "/reports/nope");
    assert.equal(res.status, 404);
    res = await fetch(base + "/reports/aging?view=sideways");
    assert.equal(res.status, 400);
    res = await fetch(base + "/reports/tasks?userId=abc");
    assert.equal(res.status, 400);
  });
});
