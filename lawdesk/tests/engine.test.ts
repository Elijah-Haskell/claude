import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.ts";
import { Engine, EngineError } from "../src/engine.ts";
import { addBusinessDays, addDays, isISODate, rollForward, today } from "../src/dates.ts";

function setup(start = "2026-11-16") {
  let now = start; // a Monday
  const e = new Engine(openDb(), { today: () => now });
  const setToday = (d: string) => (now = d);
  const atty = e.addUser("Attorney A", "attorney");
  const para = e.addUser("Paralegal P", "paralegal");
  e.addDateField("closing_date", "Closing date");
  const area = e.addPracticeArea("Business formation", ["Intake", "Drafting", "Signing", "Closed out"]);
  const client = e.addContact("Acme Widgets LLC", "company");
  return { e, setToday, atty, para, area, client };
}

const formation = (practiceAreaId: number) => ({
  name: "LLC formation",
  practiceAreaId,
  items: [
    { key: "intake", title: "Intake call", role: "attorney", offsetDays: 2, businessDays: true },
    { key: "conflicts", title: "Run conflict check", role: "paralegal", offsetDays: 1 },
    { key: "draft", title: "Draft articles of organization", role: "paralegal", anchor: "after_deps", offsetDays: 3, dependsOn: ["intake", "conflicts"] },
    { key: "review", title: "Attorney review", role: "attorney", anchor: "after_deps", offsetDays: 1, businessDays: true, dependsOn: ["draft"] },
    { key: "sign", title: "Signing meeting", role: "attorney", anchor: "field:closing_date", offsetDays: 0 },
    { key: "prep", title: "Send signing packet", role: "paralegal", anchor: "field:closing_date", offsetDays: -3, businessDays: true },
  ],
});

test("dates: business days skip weekends and listed holidays", () => {
  assert.equal(addBusinessDays("2026-11-20", 1), "2026-11-23"); // Fri -> Mon
  assert.equal(addBusinessDays("2026-11-23", -1), "2026-11-20"); // Mon -> Fri
  assert.equal(addBusinessDays("2026-11-25", 1, new Set(["2026-11-26"])), "2026-11-27");
  assert.equal(rollForward("2026-11-21"), "2026-11-23");
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(addDays("2028-02-28", 1), "2028-02-29");
  assert.ok(isISODate("2026-02-28"));
  assert.ok(!isISODate("2026-02-30"));
  assert.ok(!isISODate("11/18/2026"));
});

test("dates: today() uses the firm's time zone, not UTC", () => {
  // 03:00 UTC on Nov 18 is still the evening of Nov 17 in Kansas.
  assert.equal(today("America/Chicago", new Date("2026-11-18T03:00:00Z")), "2026-11-17");
  assert.equal(today("America/Chicago", new Date("2026-11-18T07:00:00Z")), "2026-11-18");
});

test("applying a checklist creates tasks, assigns by role and dates them", () => {
  const { e, atty, para, area, client } = setup();
  const list = e.createList(formation(area.id));
  const m = e.createMatter({ name: "Acme formation", clientId: client, practiceAreaId: area.id, roles: { attorney: atty, paralegal: para } });
  e.applyList(m, list);
  const tasks = Object.fromEntries(e.getMatter(m).tasks.map((t) => [t.title, t]));

  assert.equal(tasks["Intake call"].assignee_id, atty);
  assert.equal(tasks["Intake call"].due_date, "2026-11-18"); // 2 business days after Monday
  assert.equal(tasks["Run conflict check"].assignee_id, para);
  assert.equal(tasks["Run conflict check"].due_date, "2026-11-17");
  assert.equal(tasks["Draft articles of organization"].status, "waiting");
  assert.equal(tasks["Draft articles of organization"].due_date, null);
  assert.deepEqual(tasks["Draft articles of organization"].waiting_on.map((w: any) => w.title).sort(), ["Intake call", "Run conflict check"]);
  assert.equal(tasks["Signing meeting"].due_date, null); // no closing date yet
});

test("finishing the last dependency opens the next task and dates it from that day", () => {
  const { e, setToday, atty, para, area } = setup();
  const list = e.createList(formation(area.id));
  const m = e.createMatter({ name: "M", practiceAreaId: area.id, roles: { attorney: atty, paralegal: para } });
  e.applyList(m, list);
  const byTitle = () => Object.fromEntries(e.getMatter(m).tasks.map((t) => [t.title, t]));

  e.completeTask(byTitle()["Intake call"].id, atty);
  assert.equal(byTitle()["Draft articles of organization"].status, "waiting");

  setToday("2026-11-19");
  e.completeTask(byTitle()["Run conflict check"].id, para);
  const draft = byTitle()["Draft articles of organization"];
  assert.equal(draft.status, "open");
  assert.equal(draft.due_date, "2026-11-22"); // 3 calendar days after the 19th

  setToday("2026-11-20"); // Friday
  e.completeTask(draft.id, para);
  assert.equal(byTitle()["Attorney review"].due_date, "2026-11-23"); // next business day is Monday
});

test("a waiting task cannot be marked done, but skipping its blocker frees it", () => {
  const { e, atty, para, area } = setup();
  const list = e.createList(formation(area.id));
  const m = e.createMatter({ name: "M", practiceAreaId: area.id, roles: { attorney: atty, paralegal: para } });
  e.applyList(m, list);
  const t = (title: string) => e.getMatter(m).tasks.find((x) => x.title === title)!;
  assert.throws(() => e.completeTask(t("Draft articles of organization").id), (err: any) => err instanceof EngineError && err.status === 409);
  e.skipTask(t("Intake call").id);
  e.completeTask(t("Run conflict check").id);
  assert.equal(t("Draft articles of organization").status, "open");
});

test("reopening a finished task puts the tasks after it back to waiting", () => {
  const { e, atty, para, area } = setup();
  const list = e.createList(formation(area.id));
  const m = e.createMatter({ name: "M", practiceAreaId: area.id, roles: { attorney: atty, paralegal: para } });
  e.applyList(m, list);
  const t = (title: string) => e.getMatter(m).tasks.find((x) => x.title === title)!;
  e.completeTask(t("Intake call").id);
  e.completeTask(t("Run conflict check").id);
  assert.equal(t("Draft articles of organization").status, "open");
  e.reopenTask(t("Intake call").id);
  assert.equal(t("Intake call").status, "open");
  assert.equal(t("Draft articles of organization").status, "waiting");
  assert.equal(t("Draft articles of organization").due_date, null);
});

test("changing a matter date moves every task hung off it", () => {
  const { e, atty, para, area } = setup();
  const list = e.createList(formation(area.id));
  const m = e.createMatter({ name: "M", practiceAreaId: area.id, roles: { attorney: atty, paralegal: para } });
  e.applyList(m, list);
  const t = (title: string) => e.getMatter(m).tasks.find((x) => x.title === title)!;
  e.setMatterDate(m, "closing_date", "2026-12-04"); // Friday
  assert.equal(t("Signing meeting").due_date, "2026-12-04");
  assert.equal(t("Send signing packet").due_date, "2026-12-01"); // 3 business days before
  e.setMatterDate(m, "closing_date", "2026-12-14"); // Monday
  assert.equal(t("Signing meeting").due_date, "2026-12-14");
  assert.equal(t("Send signing packet").due_date, "2026-12-09");
});

test("a due date typed by hand is kept when the rule's inputs change, and clearing it hands it back", () => {
  const { e, atty, para, area } = setup();
  const list = e.createList(formation(area.id));
  const m = e.createMatter({ name: "M", practiceAreaId: area.id, roles: { attorney: atty, paralegal: para } });
  e.applyList(m, list);
  const t = (title: string) => e.getMatter(m).tasks.find((x) => x.title === title)!;
  e.setMatterDate(m, "closing_date", "2026-12-04");
  e.updateTask(t("Signing meeting").id, { dueDate: "2026-12-03" });
  e.setMatterDate(m, "closing_date", "2026-12-10");
  assert.equal(t("Signing meeting").due_date, "2026-12-03");
  e.updateTask(t("Signing meeting").id, { dueDate: null });
  assert.equal(t("Signing meeting").due_date, "2026-12-10");
});

test("firm holidays push business-day due dates", () => {
  const { e, atty, para, area } = setup("2026-11-24"); // Tuesday
  const list = e.createList(formation(area.id));
  const m = e.createMatter({ name: "M", practiceAreaId: area.id, roles: { attorney: atty, paralegal: para } });
  e.applyList(m, list);
  const t = (title: string) => e.getMatter(m).tasks.find((x) => x.title === title)!;
  assert.equal(t("Intake call").due_date, "2026-11-26");
  e.addHoliday("2026-11-26", "Office closed");
  assert.equal(t("Intake call").due_date, "2026-11-27");
});

test("stage automations add checklists, and a finished checklist can move the stage", () => {
  const { e, atty, para, area } = setup();
  const [intake, drafting, signing] = area.stageIds;
  const intakeList = e.createList({
    name: "Intake",
    items: [
      { key: "call", title: "Intake call", role: "attorney" },
      { key: "engage", title: "Send engagement letter", role: "attorney", dependsOn: ["call"] },
    ],
  });
  const draftList = e.createList({ name: "Drafting", items: [{ key: "d", title: "Draft documents", role: "paralegal" }] });
  e.addAutomation("Intake checklist", "stage_entered", intake, "apply_list", intakeList);
  e.addAutomation("Intake done -> drafting", "list_completed", intakeList, "set_stage", drafting);
  e.addAutomation("Drafting checklist", "stage_entered", drafting, "apply_list", draftList);

  const m = e.createMatter({ name: "M", practiceAreaId: area.id, roles: { attorney: atty, paralegal: para } });
  let d = e.getMatter(m);
  assert.equal(d.matter.stage_id, intake);
  assert.deepEqual(d.tasks.map((t) => t.title), ["Intake call", "Send engagement letter"]);

  e.completeTask(d.tasks[0].id);
  e.completeTask(d.tasks[1].id);
  d = e.getMatter(m);
  assert.equal(d.matter.stage_id, drafting);
  assert.ok(d.tasks.some((t) => t.title === "Draft documents" && t.assignee_id === para));
  assert.ok(signing);
});

test("automations that trigger each other stop instead of looping forever", () => {
  const { e, area } = setup();
  const [a, b] = area.stageIds;
  const empty1 = e.createList({ name: "L1", items: [{ key: "x", title: "x" }] });
  e.addAutomation("a->L1", "stage_entered", a, "apply_list", empty1);
  e.addAutomation("L1 done -> b", "list_completed", empty1, "set_stage", b);
  e.addAutomation("b->L1", "stage_entered", b, "apply_list", empty1);
  e.addAutomation("L1 done -> a", "list_completed", empty1, "set_stage", a);
  const m = e.createMatter({ name: "M", practiceAreaId: area.id });
  // Finishing tasks repeatedly flips the stage, but each step is bounded.
  for (let i = 0; i < 3; i++) {
    const open = e.getMatter(m).tasks.filter((t) => t.status === "open");
    for (const t of open) e.completeTask(t.id);
  }
  assert.ok(e.getMatter(m).tasks.length >= 3);
});

test("checklist validation rejects loops, unknown keys and bad anchors", () => {
  const { e } = setup();
  assert.throws(
    () => e.createList({ name: "Bad", items: [{ key: "a", title: "A", dependsOn: ["b"] }, { key: "b", title: "B", dependsOn: ["a"] }] }),
    /loop/,
  );
  assert.throws(() => e.createList({ name: "Bad", items: [{ key: "a", title: "A", dependsOn: ["zzz"] }] }), /unknown task/);
  assert.throws(() => e.createList({ name: "Bad", items: [{ key: "a", title: "A", anchor: "field:nope" }] }), /Unknown date field/);
  assert.throws(() => e.createList({ name: "Bad", items: [{ key: "A B", title: "A" }] }), /lower-case/);
  assert.throws(() => e.createList({ name: "Bad", items: [{ key: "a", title: "A", anchor: "after_deps" }] }), /depends on none/);
});

test("editing a checklist can update open tasks already on matters, but not hand-edited ones", () => {
  const { e, atty, para, area } = setup();
  const input = formation(area.id);
  const list = e.createList(input);
  const m1 = e.createMatter({ name: "M1", practiceAreaId: area.id, roles: { attorney: atty, paralegal: para } });
  const m2 = e.createMatter({ name: "M2", practiceAreaId: area.id, roles: { attorney: atty, paralegal: para } });
  e.applyList(m1, list);
  e.applyList(m2, list);
  const t = (m: number, title: string) => e.getMatter(m).tasks.find((x) => x.title === title);
  e.updateTask(t(m2, "Run conflict check")!.id, { title: "Run conflict check (also check the parent company)" });
  e.completeTask(t(m1, "Intake call")!.id);

  const edited = structuredClone(input);
  edited.items[1].title = "Run conflict check and record result";
  edited.items[1].offsetDays = 5;
  edited.items[0].title = "Intake call with client";
  const { changedTasks } = e.updateList(list, edited, { propagate: true });

  assert.ok(t(m1, "Run conflict check and record result"));
  assert.equal(t(m1, "Run conflict check and record result")!.due_date, "2026-11-21");
  assert.ok(t(m1, "Intake call"), "finished tasks keep their old title");
  assert.ok(t(m2, "Run conflict check (also check the parent company)"), "hand-edited title kept");
  assert.equal(t(m2, "Run conflict check (also check the parent company)")!.due_date, "2026-11-21", "but its date rule still updates");
  assert.ok(t(m2, "Intake call with client"));
  assert.equal(changedTasks, 3); // conflicts on M1 and M2, intake on M2
});

test("changing who fills a role moves that role's open tasks", () => {
  const { e, atty, para, area } = setup();
  const para2 = e.addUser("Paralegal Q", "paralegal");
  const list = e.createList(formation(area.id));
  const m = e.createMatter({ name: "M", practiceAreaId: area.id, roles: { attorney: atty, paralegal: para } });
  e.applyList(m, list);
  e.setMatterRole(m, "paralegal", para2);
  const paraTasks = e.getMatter(m).tasks.filter((t) => t.role === "paralegal");
  assert.ok(paraTasks.length > 0);
  assert.ok(paraTasks.every((t) => t.assignee_id === para2));
});

test("My tasks sorts work into overdue, today, upcoming, no date and waiting", () => {
  const { e, setToday, atty, para, area } = setup();
  const list = e.createList(formation(area.id));
  const m = e.createMatter({ name: "M", practiceAreaId: area.id, roles: { attorney: atty, paralegal: para } });
  e.applyList(m, list);
  e.addTask({ matterId: m, title: "Call opposing counsel", assigneeId: para });
  setToday("2026-11-17");
  const mine = e.myTasks(para);
  assert.deepEqual(mine.dueToday.map((t) => t.title), ["Run conflict check"]);
  assert.deepEqual(mine.noDate.map((t) => t.title).sort(), ["Call opposing counsel", "Send signing packet"]);
  assert.deepEqual(mine.waiting.map((t) => t.title), ["Draft articles of organization"]);
  setToday("2026-11-19");
  assert.deepEqual(e.myTasks(para).overdue.map((t) => t.title), ["Run conflict check"]);
  assert.deepEqual(e.myTasks(atty).overdue.map((t) => t.title), ["Intake call"]);
});

test("closing a matter needs every task finished; every change is logged", () => {
  const { e, atty, area } = setup();
  const m = e.createMatter({ name: "M", practiceAreaId: area.id, roles: { attorney: atty } });
  const t = e.addTask({ matterId: m, title: "Final invoice", role: "attorney" });
  assert.throws(() => e.closeMatter(m), /unfinished/);
  e.completeTask(t, atty);
  e.closeMatter(m, atty);
  const d = e.getMatter(m);
  assert.equal(d.matter.status, "closed");
  const kinds = d.activity.map((a) => a.kind);
  for (const k of ["matter_opened", "stage_changed", "task_added", "task_done", "matter_closed"]) assert.ok(kinds.includes(k), k);
  assert.equal(d.activity.find((a) => a.kind === "task_done")!.user_name, "Attorney A");
});

test("a failed change leaves nothing half-saved", () => {
  const { e, area } = setup();
  const m = e.createMatter({ name: "M", practiceAreaId: area.id });
  const before = e.getMatter(m).tasks.length;
  assert.throws(() => e.addTask({ matterId: m, title: "X", dependsOn: [99999] }));
  assert.equal(e.getMatter(m).tasks.length, before);
  assert.throws(() => e.createMatter({ name: "Bad dates", dates: { closing_date: "not a date" } }));
  assert.equal(e.listMatters().filter((x) => x.name === "Bad dates").length, 0);
});
