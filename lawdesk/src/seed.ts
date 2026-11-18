// DEMO DATA ONLY. Every person, company and matter here is made up.
//
//   npm run seed            fill an empty database (LAWDESK_DB, default lawdesk.db)
//   npm run seed -- --reset delete that database file first
//
// The demo plays the last few weeks forward day by day through the engine, so the
// matters end up at different stages with real history: checklists added by
// automations, tasks finished on earlier days, some overdue, some waiting.
// The checklists are ordinary office workflow steps; they make no statement of law.

import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb, type DB } from "./db.ts";
import { Engine } from "./engine.ts";
import { addDays, rollForward, today as todayIn, type ISODate } from "./dates.ts";
import { Billing } from "./billing/billing.ts";
import { SCHEMA as BILLING_SCHEMA } from "./billing/schema.ts";

export const DEMO_NOTE = "Fictional demo data. Not a real client.";

/** Firm closed days for a year: the usual office holidays (the firm can edit these). */
function closedDays(year: number): [ISODate, string][] {
  const d = (m: number, day: number) => `${year}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const weekday = (m: number, day: number) => new Date(Date.UTC(year, m - 1, day)).getUTCDay();
  const nth = (m: number, dow: number, n: number) => {
    let day = 1;
    while (weekday(m, day) !== dow) day++;
    return day + 7 * (n - 1);
  };
  const lastMonday = (m: number) => {
    let day = new Date(Date.UTC(year, m, 0)).getUTCDate();
    while (weekday(m, day) !== 1) day--;
    return day;
  };
  const thanksgiving = nth(11, 4, 4);
  return [
    [d(1, 1), "New Year's Day"],
    [d(5, lastMonday(5)), "Memorial Day"],
    [d(7, 4), "Independence Day"],
    [d(9, nth(9, 1, 1)), "Labor Day"],
    [d(11, thanksgiving), "Thanksgiving"],
    [d(11, thanksgiving + 1), "Day after Thanksgiving"],
    [d(12, 24), "Christmas Eve"],
    [d(12, 25), "Christmas Day"],
  ];
}

export function seed(db: DB, realToday: ISODate = todayIn()) {
  let now = realToday;
  const e = new Engine(db, { today: () => now });
  let lastActivity = 0;
  let minute = 0;
  /** Move the clock to `offset` days from today and back-date the log entries written meanwhile. */
  const day = (offset: number) => {
    stampActivity();
    now = addDays(realToday, offset);
    minute = 0;
  };
  const stampActivity = () => {
    const rows = db.prepare("SELECT id FROM activity WHERE id > ? ORDER BY id").all(lastActivity) as { id: number }[];
    for (const r of rows) {
      minute += 7;
      const at = new Date(`${now}T15:00:00Z`);
      at.setUTCMinutes(at.getUTCMinutes() + minute);
      db.prepare("UPDATE activity SET at = ? WHERE id = ?").run(at.toISOString(), r.id);
      lastActivity = r.id;
    }
  };

  db.exec(BILLING_SCHEMA);
  db.exec("BEGIN");
  try {
    // ---------------------------------------------------------------- people
    const jordan = e.addUser("Jordan Reyes", "attorney", "jordan@example.com");
    const riley = e.addUser("Riley Chen", "attorney", "riley@example.com");
    const sam = e.addUser("Sam Patel", "paralegal", "sam@example.com");
    const casey = e.addUser("Casey Morgan", "assistant", "casey@example.com");

    const client = (name: string, kind: "person" | "company") => {
      const id = e.addContact(name, kind, null, null);
      db.prepare("UPDATE contacts SET notes = ? WHERE id = ?").run(DEMO_NOTE, id);
      return id;
    };
    const sunflower = client("Sunflower Coffee Roasters LLC (demo)", "company");
    const prairieWind = client("Prairie Wind Solar Inc. (demo)", "company");
    const flintHills = client("Flint Hills Dental Group PA (demo)", "company");
    const bluestem = client("Bluestem Holdings LLC (demo)", "company");
    const taylor = client("Taylor Brooks (demo)", "person");
    const meadowlark = client("Meadowlark Farms Co. (demo)", "company");

    // ------------------------------------------------------- set-up
    e.addDateField("closing_date", "Closing date");
    e.addDateField("signing_date", "Signing meeting");
    e.addDateField("filing_date", "Filing date");
    const year = Number(realToday.slice(0, 4));
    const closed = new Set<string>();
    for (const y of [year, year + 1]) for (const [d, name] of closedDays(y)) (e.addHoliday(d, name), closed.add(d));
    /** A business day about n days from today, for demo closing and signing dates. */
    const workday = (n: number) => rollForward(addDays(realToday, n), closed);

    const formation = e.addPracticeArea("Business formation", ["Intake", "Formation", "Post-formation", "Wrap-up"]);
    const contracts = e.addPracticeArea("Contracts", ["Intake", "Review", "Negotiation", "Signed"]);
    const realEstate = e.addPracticeArea("Real estate closings", ["Intake", "Title & survey", "Pre-closing", "Post-closing", "Wrap-up"]);
    const [fIntake, fFormation, fPost] = formation.stageIds;
    const [cIntake, cReview, , cSigned] = contracts.stageIds;
    const [rIntake, rTitle, , rPost] = realEstate.stageIds;

    // ------------------------------------------------------- checklists
    const intake = e.createList({
      name: "New client intake",
      description: "Every new matter starts here.",
      items: [
        { key: "conflicts", title: "Run conflict check", role: "paralegal", offsetDays: 1, businessDays: true, priority: "high" },
        { key: "engagement", title: "Draft engagement letter", role: "attorney", anchor: "after_deps", offsetDays: 1, businessDays: true, dependsOn: ["conflicts"] },
        { key: "send_engagement", title: "Send engagement letter for signature", role: "assistant", anchor: "after_deps", offsetDays: 1, businessDays: true, dependsOn: ["engagement"] },
        { key: "signed", title: "Signed engagement letter and retainer received", role: "assistant", anchor: "after_deps", offsetDays: 7, dependsOn: ["send_engagement"] },
        { key: "file_setup", title: "Open client file and billing record", role: "assistant", anchor: "after_deps", offsetDays: 1, businessDays: true, dependsOn: ["signed"] },
      ],
    });
    const llc = e.createList({
      name: "LLC formation",
      practiceAreaId: formation.id,
      items: [
        { key: "name_check", title: "Check name availability with the Secretary of State", role: "paralegal", offsetDays: 1, businessDays: true },
        { key: "questionnaire", title: "Collect formation questionnaire from client", role: "assistant", offsetDays: 3, businessDays: true },
        { key: "draft_articles", title: "Draft articles of organization", role: "paralegal", anchor: "after_deps", offsetDays: 2, businessDays: true, dependsOn: ["name_check", "questionnaire"] },
        { key: "review_articles", title: "Attorney review of articles", role: "attorney", anchor: "after_deps", offsetDays: 1, businessDays: true, dependsOn: ["draft_articles"], priority: "high" },
        { key: "file_articles", title: "File articles of organization", role: "paralegal", anchor: "after_deps", offsetDays: 1, businessDays: true, dependsOn: ["review_articles"] },
        { key: "ein", title: "Apply for EIN", role: "paralegal", anchor: "after_deps", offsetDays: 2, businessDays: true, dependsOn: ["file_articles"] },
        { key: "operating_agreement", title: "Draft operating agreement", role: "attorney", anchor: "after_deps", offsetDays: 5, businessDays: true, dependsOn: ["questionnaire"] },
        { key: "signing", title: "Operating agreement signing meeting", role: "attorney", anchor: "field:signing_date", offsetDays: 0, dependsOn: ["operating_agreement"] },
        { key: "binder", title: "Send formation binder to client", role: "assistant", anchor: "after_deps", offsetDays: 3, businessDays: true, dependsOn: ["ein", "signing"] },
      ],
    });
    const review = e.createList({
      name: "Contract review",
      practiceAreaId: contracts.id,
      items: [
        { key: "receive", title: "Get the draft and deal terms from client", role: "assistant", offsetDays: 2, businessDays: true },
        { key: "first_read", title: "First read and issues list", role: "attorney", anchor: "after_deps", offsetDays: 2, businessDays: true, dependsOn: ["receive"], priority: "high" },
        { key: "redline", title: "Prepare redline", role: "attorney", anchor: "after_deps", offsetDays: 3, businessDays: true, dependsOn: ["first_read"] },
        { key: "client_memo", title: "Send redline and issues memo to client", role: "paralegal", anchor: "after_deps", offsetDays: 1, businessDays: true, dependsOn: ["redline"] },
        { key: "counterparty", title: "Send comments to the other side", role: "attorney", anchor: "after_deps", offsetDays: 2, businessDays: true, dependsOn: ["client_memo"] },
        { key: "execution", title: "Collect signatures", role: "assistant", anchor: "after_deps", offsetDays: 5, dependsOn: ["counterparty"] },
        { key: "key_dates", title: "Calendar renewal and notice dates from the signed contract", role: "paralegal", anchor: "after_deps", offsetDays: 2, businessDays: true, dependsOn: ["execution"] },
      ],
    });
    const closing = e.createList({
      name: "Commercial real estate closing",
      practiceAreaId: realEstate.id,
      items: [
        { key: "title_order", title: "Order title commitment", role: "paralegal", offsetDays: 1, businessDays: true },
        { key: "survey", title: "Order survey if the buyer wants one", role: "paralegal", offsetDays: 2, businessDays: true, priority: "low" },
        { key: "title_review", title: "Review title commitment and exceptions", role: "attorney", anchor: "after_deps", offsetDays: 3, businessDays: true, dependsOn: ["title_order"], priority: "high" },
        { key: "objections", title: "Send title objections", role: "attorney", anchor: "after_deps", offsetDays: 2, businessDays: true, dependsOn: ["title_review"] },
        { key: "deed", title: "Draft deed", role: "paralegal", anchor: "field:closing_date", offsetDays: -10, businessDays: true },
        { key: "closing_statement", title: "Review settlement statement", role: "attorney", anchor: "field:closing_date", offsetDays: -3, businessDays: true, dependsOn: ["deed"] },
        { key: "wire", title: "Confirm wire instructions by phone, using a number already on file", role: "assistant", anchor: "field:closing_date", offsetDays: -2, businessDays: true, priority: "high" },
        { key: "closing", title: "Closing", role: "attorney", anchor: "field:closing_date", offsetDays: 0, dependsOn: ["closing_statement", "wire", "objections"] },
        { key: "record", title: "Confirm deed recorded", role: "paralegal", anchor: "after_deps", offsetDays: 5, businessDays: true, dependsOn: ["closing"] },
        { key: "final_docs", title: "Send closing binder to client", role: "assistant", anchor: "after_deps", offsetDays: 5, businessDays: true, dependsOn: ["record"] },
      ],
    });

    // ------------------------------------------------------- automations
    e.addAutomation("New business formation matters start intake", "stage_entered", fIntake, "apply_list", intake);
    e.addAutomation("Formation stage adds the LLC checklist", "stage_entered", fFormation, "apply_list", llc);
    e.addAutomation("LLC checklist done → Post-formation", "list_completed", llc, "set_stage", fPost);
    e.addAutomation("New contract matters start intake", "stage_entered", cIntake, "apply_list", intake);
    e.addAutomation("Review stage adds contract review", "stage_entered", cReview, "apply_list", review);
    e.addAutomation("Contract review done → Signed", "list_completed", review, "set_stage", cSigned);
    e.addAutomation("New closing matters start intake", "stage_entered", rIntake, "apply_list", intake);
    e.addAutomation("Title & survey stage adds the closing checklist", "stage_entered", rTitle, "apply_list", closing);
    e.addAutomation("Closing checklist done → Post-closing", "list_completed", closing, "set_stage", rPost);

    // ------------------------------------------------------- history
    const task = (matter: number, key: string): number => {
      const r = db
        .prepare(
          `SELECT t.id FROM tasks t JOIN task_templates tt ON tt.id = t.template_id
           WHERE t.matter_id = ? AND tt.key = ? ORDER BY t.id DESC LIMIT 1`,
        )
        .get(matter, key) as { id: number } | undefined;
      if (!r) throw new Error(`seed: no task ${key} on matter ${matter}`);
      return r.id;
    };
    const done = (matter: number, by: number, ...keys: string[]) => keys.forEach((k) => e.completeTask(task(matter, k), by));
    const intakeKeys = ["conflicts", "engagement", "send_engagement", "signed", "file_setup"];
    const usual = { attorney: jordan, paralegal: sam, assistant: casey };

    // A finished contract matter, closed out.
    day(-62);
    const m6 = e.createMatter(
      { name: "Equipment lease review", number: "D-1001", clientId: meadowlark, practiceAreaId: contracts.id, roles: usual, description: "Demo matter. " + DEMO_NOTE },
      jordan,
    );
    day(-60);
    done(m6, sam, "conflicts");
    done(m6, jordan, "engagement");
    done(m6, casey, "send_engagement");
    day(-54);
    done(m6, casey, "signed", "file_setup");
    e.setStage(m6, cReview, jordan);
    day(-50);
    done(m6, casey, "receive");
    done(m6, jordan, "first_read");
    day(-45);
    done(m6, jordan, "redline");
    done(m6, sam, "client_memo");
    day(-40);
    done(m6, jordan, "counterparty");
    day(-33);
    done(m6, casey, "execution");
    done(m6, sam, "key_dates"); // finishes the checklist; the automation moves the matter to Signed
    e.closeMatter(m6, jordan);

    // A real estate closing two weeks out.
    day(-25);
    const m4 = e.createMatter(
      {
        name: "Riverside Plaza purchase",
        number: "D-1002",
        clientId: bluestem,
        practiceAreaId: realEstate.id,
        roles: { attorney: riley, paralegal: sam, assistant: casey },
        description: "Demo matter: purchase of a small retail strip. " + DEMO_NOTE,
        dates: { closing_date: workday(12) },
      },
      riley,
    );
    day(-24);
    done(m4, sam, "conflicts");
    done(m4, riley, "engagement");
    done(m4, casey, "send_engagement");
    day(-20);
    done(m4, casey, "signed", "file_setup");
    day(-19);
    e.setStage(m4, rTitle, riley);
    day(-18);
    done(m4, sam, "title_order");
    e.skipTask(task(m4, "survey"), riley);
    day(-14);
    done(m4, riley, "title_review");
    day(-12);
    done(m4, riley, "objections");

    // An LLC formation stuck on attorney review.
    day(-20);
    const m1 = e.createMatter(
      {
        name: "Sunflower Coffee Roasters formation",
        number: "D-1003",
        clientId: sunflower,
        practiceAreaId: formation.id,
        roles: usual,
        description: "Demo matter: new LLC for a two-owner coffee roaster. " + DEMO_NOTE,
      },
      jordan,
    );
    day(-19);
    done(m1, sam, "conflicts");
    done(m1, jordan, "engagement");
    done(m1, casey, "send_engagement");
    day(-14);
    done(m1, casey, "signed", "file_setup");
    day(-13);
    e.setStage(m1, fFormation, jordan);
    e.setMatterDate(m1, "signing_date", workday(9), jordan);
    day(-12);
    done(m1, sam, "name_check");
    day(-9);
    done(m1, casey, "questionnaire");
    day(-6);
    done(m1, sam, "draft_articles");

    // A contract review in progress.
    day(-7);
    const m2 = e.createMatter(
      {
        name: "Supply agreement review",
        number: "D-1004",
        clientId: prairieWind,
        practiceAreaId: contracts.id,
        roles: usual,
        description: "Demo matter: panel supply agreement from a manufacturer. " + DEMO_NOTE,
      },
      jordan,
    );
    day(-6);
    done(m2, sam, "conflicts");
    done(m2, jordan, "engagement");
    done(m2, casey, "send_engagement");
    day(-4);
    done(m2, casey, "signed", "file_setup");
    e.setStage(m2, cReview, jordan);
    day(-3);
    done(m2, casey, "receive");
    day(-1);
    done(m2, jordan, "first_read");
    e.addTask({ matterId: m2, title: "Call client about the indemnity cap", assigneeId: jordan, dueDate: addDays(realToday, 1), priority: "high" }, jordan);

    // A new lease matter still in intake.
    day(-2);
    const m3 = e.createMatter(
      {
        name: "Office lease renewal",
        number: "D-1005",
        clientId: flintHills,
        practiceAreaId: contracts.id,
        roles: { attorney: riley, paralegal: sam, assistant: casey },
        description: "Demo matter. " + DEMO_NOTE,
      },
      riley,
    );
    day(-1);
    done(m3, sam, "conflicts");

    // Opened today.
    day(0);
    const m5 = e.createMatter(
      {
        name: "Brooks Consulting LLC formation",
        number: "D-1006",
        clientId: taylor,
        practiceAreaId: formation.id,
        roles: usual,
        description: "Demo matter: single-member LLC for a consultant. " + DEMO_NOTE,
      },
      jordan,
    );
    e.addTask({ title: "Renew the firm's online research subscription", assigneeId: casey, priority: "low" }, casey);
    e.addTask({ title: "Review the month's open matters with Riley", assigneeId: jordan, dueDate: addDays(realToday, 3) }, jordan);

    // ------------------------------------------------------- billing
    // Made-up rates, hours and amounts. Two invoices are finalized (one partly paid,
    // one awaiting payment); the rest of the work is unbilled.
    const b = new Billing(db, { today: () => now, now: () => new Date(`${now}T16:00:00Z`) });
    b.updateSettings({
      firmName: "Reyes & Chen LLP (demo)",
      firmAddress: "100 Example Street, Suite 2\nTopeka, KS 66603\nFictional demo firm",
      defaultRateCents: 25000,
      paymentTermsDays: 30,
      firstInvoiceNumber: 1001,
    }, jordan);
    b.setUserRate(jordan, 30000);
    b.setUserRate(riley, 27500);
    b.setUserRate(sam, 13500);
    b.setUserRate(casey, 9000);
    b.setMatterBilling(m1, { method: "flat", flatFeeCents: 150000 }, jordan);
    b.setMatterBilling(m5, { method: "flat", flatFeeCents: 90000 }, jordan);
    const at = (offset: number) => addDays(realToday, offset);
    const time = (matterId: number, userId: number, offset: number, hours: number, description: string, billable = true) =>
      b.addTime({ matterId, userId, date: at(offset), minutes: Math.round(hours * 60), description, billable }, userId);
    const cost = (matterId: number, userId: number, offset: number, dollars: number, description: string, receiptNote: string | null = null) =>
      b.addExpense({ matterId, userId, date: at(offset), costCents: Math.round(dollars * 100), description, receiptNote }, userId);

    // Equipment lease review (closed): billed on invoice 1001, partly paid, now past due.
    time(m6, jordan, -60, 0.5, "Call with client about the equipment lease; reviewed the term sheet");
    time(m6, jordan, -50, 1.8, "First read of the lease; prepared issues list");
    time(m6, jordan, -45, 2.4, "Prepared redline of the lease");
    time(m6, sam, -45, 0.6, "Assembled redline and issues memo for the client");
    time(m6, jordan, -40, 0.9, "Call with lessor's counsel on our comments");
    time(m6, casey, -33, 0.3, "Coordinated signatures", false);
    cost(m6, casey, -33, 38.5, "Overnight courier of the signed lease", "Receipt in the file");
    day(-32);
    const inv1 = b.createDraft({ matterId: m6, to: at(-32) }, jordan);
    b.finalize(inv1.id, jordan);
    day(-15);
    b.payInvoice(inv1.id, { amountCents: 100000, method: "Check", reference: "4417 (demo)" }, jordan);

    // Riverside Plaza purchase: invoice 1002 for the title work, awaiting payment.
    time(m4, riley, -25, 0.7, "Intake call; reviewed the purchase contract");
    time(m4, sam, -18, 0.8, "Ordered the title commitment; opened the closing file");
    time(m4, riley, -14, 2.2, "Reviewed the title commitment and exceptions");
    time(m4, riley, -12, 1.4, "Drafted the title objection letter");
    time(m4, sam, -12, 0.5, "Sent title objections to the title company and seller's counsel");
    cost(m4, sam, -18, 350, "Title commitment fee (passed through)");
    day(-10);
    const inv2 = b.createDraft({ matterId: m4, to: at(-11) }, riley);
    b.finalize(inv2.id, riley);
    day(0);
    time(m4, riley, -6, 1.0, "Reviewed the seller's response to title objections");
    time(m4, sam, -5, 1.2, "Prepared the draft deed");
    cost(m4, sam, -5, 24, "Certified copies from the county register of deeds");

    // Sunflower Coffee formation (flat fee): time recorded, not charged; filing fee to pass on.
    time(m1, jordan, -19, 0.4, "Prepared the engagement letter");
    time(m1, sam, -12, 0.3, "Checked name availability");
    time(m1, sam, -6, 1.5, "Drafted articles of organization");
    time(m1, jordan, -2, 0.6, "Reviewed the draft articles with comments for Sam");
    cost(m1, sam, -6, 165, "State filing fee for articles of organization (demo amount)");

    // Supply agreement review (hourly): this week's work, not yet billed.
    time(m2, jordan, -6, 0.4, "Prepared the engagement letter");
    time(m2, jordan, -2, 0.5, "Reviewed the draft and deal terms from the client");
    time(m2, casey, -2, 0.2, "Set up the matter file", false);
    time(m2, jordan, -1, 2.8, "First read of the supply agreement; prepared issues list");
    time(m2, jordan, 0, 0.7, "Outlined points for the call with the client on the indemnity cap");

    // Office lease renewal and Brooks formation: a little intake time.
    time(m3, riley, -1, 0.4, "Intake call with the practice manager about the renewal");
    time(m5, jordan, 0, 0.5, "Initial consultation on forming the LLC");
    stampActivity();
    db.exec("COMMIT");
    return {
      users: { jordan, riley, sam, casey },
      matters: { m1, m2, m3, m4, m5, m6 },
      lists: { intake, llc, review, closing },
      invoices: { pastDue: inv1.id, open: inv2.id },
    };
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const path = process.env.LAWDESK_DB ?? "lawdesk.db";
  if (process.argv.includes("--reset") && path !== ":memory:") {
    for (const suffix of ["", "-journal", "-wal", "-shm"]) if (existsSync(path + suffix)) rmSync(path + suffix);
  }
  const db = openDb(path);
  const n = (db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n;
  if (n > 0) {
    console.error(`${path} already has data. Run "npm run seed -- --reset" to wipe it and load the demo.`);
    process.exit(1);
  }
  seed(db);
  console.log(`Loaded fictional demo data into ${path}. Start the app with "npm start".`);
}
