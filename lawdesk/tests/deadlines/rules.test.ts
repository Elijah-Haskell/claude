// Rules library and routes. Worked examples use the rule's period from its source text and the
// K.S.A. 60-206 counting rules; each expected date is derived by hand in the comment.
import { test } from "node:test";
import assert from "node:assert/strict";
import { RULES, EVENT_TYPES, deadlinesFor, ruleById, applyRule } from "../../src/deadlines/rules.ts";
import { DeadlineError } from "../../src/deadlines/compute.ts";
import { routes } from "../../src/deadlines/routes.ts";
import { EngineError } from "../../src/engine.ts";

const byId = (list: ReturnType<typeof deadlinesFor>, id: string) => list.find((d) => d.rule.id === id)!.result;

test("every rule is complete and cites a primary source", () => {
  const ids = new Set<string>();
  for (const r of RULES) {
    assert.ok(!ids.has(r.id), `duplicate ${r.id}`);
    ids.add(r.id);
    assert.ok(r.name && r.citation && r.quote, r.id);
    assert.ok(r.trigger in EVENT_TYPES, r.id);
    assert.ok(Number.isInteger(r.days) && r.days > 0, r.id);
    assert.ok(["after", "before"].includes(r.direction), r.id);
    assert.ok(["yes", "no", "uncertain"].includes(r.serviceAdjustment), r.id);
    assert.match(r.url, /^https:\/\/([a-z0-9]+\.)?(ksrevisor\.gov|kscourts\.gov)\//, r.id);
  }
});

test("answer to petition: 21 days, no mail days (process is not 60-205 service)", () => {
  // Served Mon 2026-11-02; + 21 = Mon Nov 23. Even with serviceMethod "mail" nothing is added.
  const [d] = deadlinesFor("served_summons_and_petition", "2026-11-02", { serviceMethod: "mail" });
  assert.equal(d.rule.id, "answer-petition");
  assert.equal(d.result.date, "2026-11-23");
  assert.match(d.result.steps[0], /60-212\(a\)\(1\)\(A\)\(i\)/);
});

test("discovery served by mail: 30 days + 3 (60-233, 60-234, 60-236)", () => {
  // Mailed Thu 2026-10-01: + 30 = Sat Oct 31 -> Mon Nov 2; + 3 = Thu Nov 5.
  for (const ev of ["served_interrogatories", "served_production_request", "served_admission_requests"] as const) {
    const [d] = deadlinesFor(ev, "2026-10-01", { serviceMethod: "mail" });
    assert.equal(d.result.date, "2026-11-05", ev);
    // By hand delivery: Mon Nov 2.
    assert.equal(deadlinesFor(ev, "2026-10-01", { serviceMethod: "hand" })[0].result.date, "2026-11-02", ev);
  }
});

test("entry of judgment: new trial and alter/amend at 28 days, notice of appeal at 30", () => {
  // Judgment entered Fri 2026-12-11.
  // + 28 = Fri 2027-01-08 (Dec 11 + 20 = Dec 31; + 8 = Jan 8), a business day.
  // + 30 = Sun 2027-01-10 -> Mon Jan 11.
  const list = deadlinesFor("entry_of_judgment", "2026-12-11", { serviceMethod: "mail" });
  assert.equal(list.length, 3);
  assert.equal(byId(list, "new-trial-motion").date, "2027-01-08");
  assert.equal(byId(list, "alter-amend-motion").date, "2027-01-08");
  assert.equal(byId(list, "notice-of-appeal").date, "2027-01-11"); // mail days never added: runs from entry of judgment
});

test("Rule 133 motion response: 7 days, mail days not added because unverified, with a warning", () => {
  // Served by mail Mon 2026-11-16: + 7 = Mon Nov 23. No 3 days added ("uncertain").
  const [d] = deadlinesFor("served_motion", "2026-11-16", { serviceMethod: "mail" });
  assert.equal(d.result.date, "2026-11-23");
  assert.ok(d.result.warnings.some((w) => /was not verified/.test(w)));
});

test("Rule 141 summary judgment response 21 days and reply 14 days", () => {
  // Response: served Wed 2026-11-04 + 21 = Wed Nov 25 (day before Thanksgiving).
  assert.equal(deadlinesFor("served_summary_judgment_motion", "2026-11-04")[0].result.date, "2026-11-25");
  // Reply: response served Thu 2026-11-12 + 14 = Thu Nov 26 (Thanksgiving) -> Fri Nov 27.
  assert.equal(deadlinesFor("served_summary_judgment_response", "2026-11-12")[0].result.date, "2026-11-27");
});

test("hearing date: motion and notice 7 days before, opposing affidavit 1 day before (backward)", () => {
  // Hearing Mon 2026-12-07: 7 days back = Mon Nov 30. 1 day back = Sun Dec 6 -> Sat -> Fri Dec 4.
  const list = deadlinesFor("hearing_date", "2026-12-07");
  assert.equal(byId(list, "motion-hearing-notice").date, "2026-11-30");
  assert.equal(byId(list, "opposing-affidavit-before-hearing").date, "2026-12-04");
});

test("cross-appeal: 21 days after the notice of appeal is served and filed", () => {
  // Served and filed Mon 2026-11-30: + 21 = Mon Dec 21.
  assert.equal(deadlinesFor("served_notice_of_appeal", "2026-11-30")[0].result.date, "2026-12-21");
});

test("answer to counterclaim served by mail ending near Christmas", () => {
  // Mailed Wed 2026-11-25: + 21 = Wed Dec 16; + 3 = Sat Dec 19 (deadline shown) / Mon Dec 21 if extended.
  const r = applyRule(ruleById("answer-counterclaim")!, "2026-11-25", { serviceMethod: "mail" }).result;
  assert.equal(r.date, "2026-12-19");
  assert.equal(r.laterDateIfExtended, "2026-12-21");
});

test("unknown event type is refused", () => {
  assert.throws(() => deadlinesFor("served_with_a_pie", "2026-11-02"), DeadlineError);
});

function route(method: string, path: string) {
  const r = routes.find((x) => x.method === method && x.path === path);
  assert.ok(r, `${method} ${path}`);
  return r!;
}
const ctx = (body: any = {}, params: Record<string, string> = {}) =>
  ({ db: null as any, engine: null as any, params, query: new URLSearchParams(), body, userId: null }) as any;

test("GET /deadlines/rules lists rules with the disclaimer", async () => {
  const out: any = await route("GET", "/deadlines/rules").handler(ctx());
  assert.equal(out.rules.length, RULES.length);
  assert.match(out.disclaimer, /VERIFY/);
});

test("POST /deadlines/compute: raw computation and rules-library form", async () => {
  const h = route("POST", "/deadlines/compute").handler;
  const a: any = await h(ctx({ trigger: "2026-10-01", days: 30 }));
  assert.equal(a.date, "2026-11-02");
  assert.match(a.disclaimer, /VERIFY/);
  const b: any = await h(ctx({ eventType: "hearing_date", trigger: "2026-12-07" }));
  assert.equal(b.deadlines.length, 2);
  assert.throws(() => h(ctx({ trigger: "nope", days: 3 })), (e: any) => e instanceof EngineError && e.status === 400);
  assert.throws(() => h(ctx({ eventType: "x", trigger: "2026-12-07" })), (e: any) => e instanceof EngineError && e.status === 400);
});

test("GET /deadlines/holidays/:year", async () => {
  const h = route("GET", "/deadlines/holidays/:year").handler;
  const out: any = await h(ctx({}, { year: "2026" }));
  assert.equal(out.holidays.length, 11);
  assert.throws(() => h(ctx({}, { year: "1999" })), (e: any) => e instanceof EngineError && e.status === 400);
});
