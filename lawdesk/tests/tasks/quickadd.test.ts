import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-ignore plain browser module
import { parseQuickAdd } from "../../public/js/quickadd.js";

const ctx = {
  today: "2026-11-18", // a Wednesday
  users: [
    { id: 1, name: "Jordan Reyes" },
    { id: 2, name: "Riley Chen" },
    { id: 3, name: "Sam Patel" },
  ],
  matters: [
    { id: 10, name: "Supply agreement review", number: "D-1004", client_name: "Prairie Wind Solar Inc." },
    { id: 11, name: "Sunflower Coffee Roasters formation", number: "D-1003", client_name: "Sunflower Coffee Roasters LLC" },
    { id: 12, name: "Office lease renewal", number: "D-1005", client_name: "Flint Hills Dental" },
  ],
};
const p = (s: string) => parseQuickAdd(s, ctx);

test("quick-add pulls out date, person, matter and priority", () => {
  const r = p("Call client re indemnity cap fri @sam #d-1004 !high");
  assert.equal(r.title, "Call client re indemnity cap");
  assert.equal(r.dueDate, "2026-11-20");
  assert.equal(r.assignee.id, 3);
  assert.equal(r.matter.id, 10);
  assert.equal(r.priority, "high");
  assert.deepEqual(r.problems, []);
});

test("quick-add dates", () => {
  const due = (s: string) => p("Do it " + s).dueDate;
  assert.equal(due("today"), "2026-11-18");
  assert.equal(due("tomorrow"), "2026-11-19");
  assert.equal(due("wed"), "2026-11-18");
  assert.equal(due("mon"), "2026-11-23");
  assert.equal(due("next fri"), "2026-11-27");
  assert.equal(due("next week"), "2026-11-23");
  assert.equal(due("eow"), "2026-11-20");
  assert.equal(due("in 3 days"), "2026-11-21");
  assert.equal(due("in 2 weeks"), "2026-12-02");
  assert.equal(due("+5bd"), "2026-11-25");
  assert.equal(due("in 3 business days"), "2026-11-23");
  assert.equal(due("12/1"), "2026-12-01");
  assert.equal(due("1/5"), "2027-01-05");
  assert.equal(due("2/30"), null);
  assert.equal(due("dec 3"), "2026-12-03");
  assert.equal(due("2027-03-01"), "2027-03-01");
  assert.equal(p("Send packet due fri").title, "Send packet");
  assert.equal(p("Send packet by 12/1").title, "Send packet");
});

test("quick-add: the last date wins and earlier ones stay in the title", () => {
  const r = p("Prep for dec 3 hearing tomorrow");
  assert.equal(r.dueDate, "2026-11-19");
  assert.equal(r.title, "Prep for dec 3 hearing");
});

test("quick-add people and matters by name parts, initials and client", () => {
  assert.equal(p("x @jr").assignee.id, 1);
  assert.equal(p("x @riley").assignee.id, 2);
  assert.equal(p("x #sunflower").matter.id, 11);
  assert.equal(p("x #flint").matter.id, 12);
  const amb = p("x #d-100");
  assert.equal(amb.matter, null);
  assert.match(amb.problems[0], /matches 3 matters/);
  assert.match(p("x @zed").problems[0], /Nobody matches/);
  assert.equal(p("Email @ the office").title, "Email @ the office");
});
