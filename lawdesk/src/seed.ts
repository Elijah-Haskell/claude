// DEMO DATA ONLY. Every person, company and matter here is made up. Each client contact is
// marked in its notes (DEMO_NOTE); the app shows a dismissible "Demo data" banner when it
// sees that marker, so the names themselves read naturally. Phone numbers use the 555-01xx
// range reserved for fiction and email addresses use example.com / example.net.
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
import { Calendar } from "./calendar/calendar.ts";
import { SCHEMA as CALENDAR_SCHEMA } from "./calendar/schema.ts";
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
  // The demo also fills the calendar and the firm name, so make sure those tables exist
  // even when the server hasn't opened this database yet.
  db.exec(CALENDAR_SCHEMA);
  db.exec(BILLING_SCHEMA);
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

  db.exec("BEGIN");
  try {
    // ---------------------------------------------------------------- people
    const jordan = e.addUser("Jordan Reyes", "attorney", "jordan@example.com");
    const riley = e.addUser("Riley Chen", "attorney", "riley@example.com");
    const avery = e.addUser("Avery Lindqvist", "attorney", "avery@example.com");
    const sam = e.addUser("Sam Patel", "paralegal", "sam@example.com");
    const dana = e.addUser("Dana Whitfield", "paralegal", "dana@example.com");
    const casey = e.addUser("Casey Morgan", "assistant", "casey@example.com");
    const priya = e.addUser("Priya Nair", "assistant", "priya@example.com");
    db.prepare("UPDATE billing_settings SET firm_name = ? WHERE id = 1 AND firm_name = ''").run("Reyes & Chen, LLC");

    let phone = 100;
    const client = (name: string, kind: "person" | "company", email: string) => {
      const id = e.addContact(name, kind, email, `(785) 555-0${phone++}`);
      db.prepare("UPDATE contacts SET notes = ? WHERE id = ?").run(DEMO_NOTE, id);
      return id;
    };
    const sunflower = client("Sunflower Coffee Roasters LLC", "company", "owners@sunflower-coffee.example.com");
    const prairieWind = client("Prairie Wind Solar Inc.", "company", "legal@prairiewind.example.com");
    const flintHills = client("Flint Hills Dental Group PA", "company", "office@flinthillsdental.example.com");
    const bluestem = client("Bluestem Holdings LLC", "company", "deals@bluestem.example.net");
    const taylor = client("Taylor Brooks", "person", "taylor.brooks@example.com");
    const meadowlark = client("Meadowlark Farms Co.", "company", "accounts@meadowlark.example.net");
    const wheatland = client("Wheatland Analytics Inc.", "company", "contracts@wheatland.example.com");
    const cottonwood = client("Cottonwood Animal Hospital PA", "company", "dr.vasquez@cottonwoodvet.example.com");
    const kawValley = client("Kaw Valley Outfitters LLC", "company", "hello@kawvalley.example.com");
    const harper = client("Margaret and Thomas Harper", "person", "harpers@example.net");
    const okafor = client("David Okafor", "person", "d.okafor@example.com");
    const vasquez = client("Elena Vasquez", "person", "elena.vasquez@example.net");

    // ------------------------------------------------------- set-up
    e.addDateField("closing_date", "Closing date");
    e.addDateField("signing_date", "Signing meeting");
    e.addDateField("filing_date", "Filing date");
    e.addDateField("mediation_date", "Mediation");
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
    const estate = e.addPracticeArea("Estate planning", ["Intake", "Design meeting", "Drafting", "Signing", "Funding & wrap-up"]);
    const [eIntake, eDesign, eDrafting, , eFunding] = estate.stageIds;
    const litigation = e.addPracticeArea("Civil litigation", ["Intake", "Pleadings", "Discovery", "Mediation", "Resolution"]);
    const [lIntake, lPleadings, lDiscovery] = litigation.stageIds;

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

    const estatePlan = e.createList({
      name: "Estate plan package",
      description: "Will, revocable trust and powers of attorney, from questionnaire to signed originals.",
      practiceAreaId: estate.id,
      items: [
        { key: "questionnaire", title: "Send estate planning questionnaire", role: "assistant", offsetDays: 1, businessDays: true },
        { key: "assets", title: "Collect asset and beneficiary information", role: "paralegal", anchor: "after_deps", offsetDays: 5, dependsOn: ["questionnaire"] },
        { key: "design", title: "Design meeting with client", role: "attorney", anchor: "after_deps", offsetDays: 3, businessDays: true, dependsOn: ["assets"] },
        { key: "draft_docs", title: "Draft will, trust and powers of attorney", role: "attorney", anchor: "after_deps", offsetDays: 5, businessDays: true, dependsOn: ["design"], priority: "high" },
        { key: "review_draft", title: "Send drafts to client for review", role: "paralegal", anchor: "after_deps", offsetDays: 1, businessDays: true, dependsOn: ["draft_docs"] },
        { key: "signing", title: "Signing ceremony", role: "attorney", anchor: "field:signing_date", offsetDays: 0, dependsOn: ["review_draft"] },
        { key: "funding", title: "Send trust funding instructions", role: "paralegal", anchor: "after_deps", offsetDays: 3, businessDays: true, dependsOn: ["signing"] },
        { key: "originals", title: "Scan and store signed originals", role: "assistant", anchor: "after_deps", offsetDays: 2, businessDays: true, dependsOn: ["signing"] },
      ],
    });
    const kickoff = e.createList({
      name: "Litigation kickoff",
      description: "First steps once a lawsuit is filed or served. Court deadlines are entered from the deadlines tool, not from this list.",
      practiceAreaId: litigation.id,
      items: [
        { key: "hold", title: "Send litigation hold letter to client", role: "attorney", offsetDays: 1, businessDays: true, priority: "high" },
        { key: "deadlines", title: "Enter court deadlines on the calendar and double-check them", role: "paralegal", offsetDays: 1, businessDays: true, priority: "high" },
        { key: "parties", title: "Run conflict check on opposing parties and counsel", role: "paralegal", offsetDays: 1, businessDays: true },
        { key: "docs", title: "Collect client documents and correspondence", role: "paralegal", offsetDays: 3, businessDays: true },
        { key: "strategy", title: "Case strategy memo", role: "attorney", anchor: "after_deps", offsetDays: 5, businessDays: true, dependsOn: ["docs"] },
        { key: "client_update", title: "Send case-plan letter to client", role: "assistant", anchor: "after_deps", offsetDays: 2, businessDays: true, dependsOn: ["strategy"] },
      ],
    });
    const discovery = e.createList({
      name: "Discovery",
      practiceAreaId: litigation.id,
      items: [
        { key: "requests", title: "Draft written discovery requests", role: "attorney", offsetDays: 5, businessDays: true },
        { key: "review_prod", title: "Review the other side's document production", role: "paralegal", anchor: "after_deps", offsetDays: 6, dependsOn: ["requests"] },
        { key: "privilege", title: "Prepare privilege log", role: "paralegal", anchor: "after_deps", offsetDays: 5, businessDays: true, dependsOn: ["review_prod"] },
        { key: "med_statement", title: "Draft mediation statement", role: "attorney", anchor: "field:mediation_date", offsetDays: -5, businessDays: true, priority: "high" },
        { key: "med_prep", title: "Prepare client for mediation", role: "attorney", anchor: "field:mediation_date", offsetDays: -2, businessDays: true, dependsOn: ["med_statement"] },
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
    e.addAutomation("New estate planning matters start intake", "stage_entered", eIntake, "apply_list", intake);
    e.addAutomation("Design meeting stage adds the estate plan package", "stage_entered", eDesign, "apply_list", estatePlan);
    e.addAutomation("Estate plan done → Funding & wrap-up", "list_completed", estatePlan, "set_stage", eFunding);
    e.addAutomation("New litigation matters start intake", "stage_entered", lIntake, "apply_list", intake);
    e.addAutomation("Pleadings stage adds litigation kickoff", "stage_entered", lPleadings, "apply_list", kickoff);
    e.addAutomation("Discovery stage adds the discovery checklist", "stage_entered", lDiscovery, "apply_list", discovery);

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
    const teamRiley = { attorney: riley, paralegal: dana, assistant: casey };
    const teamAvery = { attorney: avery, paralegal: dana, assistant: priya };
    /** Finish every open task on a matter (waiting ones open up as their blockers finish). */
    const finishAll = (matter: number, by: number) => {
      for (let guard = 0; guard < 50; guard++) {
        const open = db.prepare("SELECT id FROM tasks WHERE matter_id = ? AND status = 'open' ORDER BY id").all(matter) as { id: number }[];
        if (!open.length) return;
        for (const t of open) e.completeTask(t.id, by);
      }
    };

    // A finished contract matter, closed out.
    day(-62);
    const m6 = e.createMatter(
      { name: "Equipment lease review", number: "D-1001", clientId: meadowlark, practiceAreaId: contracts.id, roles: usual, description: "Five-year lease of two irrigation pivots and a grain dryer; client wanted early-buyout terms." },
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
        description: "Purchase of a six-unit retail strip. Seller financing on 20% of the price; buyer wants a new survey only if the lender asks.",
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
        description: "New LLC for a two-owner coffee roaster. Owners want a buy-sell clause and unequal capital accounts.",
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
        description: "Panel supply agreement on the manufacturer's paper. Main issues: indemnity cap, warranty period and price escalation.",
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
        description: "Renewal of the clinic's main office lease. Landlord proposes a 4% annual escalator; client wants a renewal option.",
      },
      riley,
    );
    day(-1);
    done(m3, sam, "conflicts");


    // ----------------------------------------------------- more of the firm's matters

    // A contract that closed out last quarter.
    day(-95);
    const m13 = e.createMatter(
      { name: "Equipment financing review", number: "D-1013", clientId: wheatland, practiceAreaId: contracts.id, roles: teamAvery, description: "Review of a server-equipment financing agreement." },
      avery,
    );
    day(-90);
    finishAll(m13, dana);
    e.setStage(m13, cReview, avery);
    day(-72);
    finishAll(m13, avery); // finishing contract review moves it to Signed
    day(-70);
    e.closeMatter(m13, avery);

    // An estate plan that finished in October.
    day(-80);
    const m16 = e.createMatter(
      { name: "Vasquez revocable trust", number: "D-1016", clientId: vasquez, practiceAreaId: estate.id, roles: teamAvery, description: "Revocable living trust with pour-over will; two adult children as successor trustees.", dates: { signing_date: addDays(realToday, -52) } },
      avery,
    );
    day(-76);
    finishAll(m16, priya);
    e.setStage(m16, eDesign, avery);
    day(-48);
    finishAll(m16, avery);
    day(-44);
    e.closeMatter(m16, avery);

    // A lawsuit in discovery, mediation set.
    day(-40);
    const m17 = e.createMatter(
      {
        name: "Granger v. Flint Hills Dental Group",
        number: "D-1017",
        clientId: flintHills,
        practiceAreaId: litigation.id,
        roles: usual,
        description: "Defense of a former patient's negligence claim. Insurer has appointed us; adjuster wants monthly updates.",
      },
      jordan,
    );
    day(-39);
    done(m17, sam, "conflicts");
    done(m17, jordan, "engagement");
    done(m17, casey, "send_engagement");
    day(-36);
    done(m17, casey, "signed", "file_setup");
    e.setStage(m17, lPleadings, jordan);
    day(-35);
    done(m17, jordan, "hold");
    done(m17, sam, "deadlines", "parties");
    day(-31);
    done(m17, sam, "docs");
    day(-26);
    done(m17, jordan, "strategy");
    day(-24);
    done(m17, casey, "client_update");
    day(-20);
    e.setStage(m17, lDiscovery, jordan);
    e.setMatterDate(m17, "mediation_date", workday(16), jordan);
    day(-14);
    done(m17, jordan, "requests");
    day(-7);
    done(m17, sam, "review_prod");

    // A collection suit just filed.
    day(-12);
    const m18 = e.createMatter(
      {
        name: "Collection: Osage Ridge Builders invoices",
        number: "D-1018",
        clientId: prairieWind,
        practiceAreaId: litigation.id,
        roles: teamAvery,
        description: "Suit on four unpaid invoices for a commercial rooftop install. Defendant disputes the change order.",
      },
      avery,
    );
    day(-11);
    done(m18, dana, "conflicts");
    done(m18, avery, "engagement");
    done(m18, priya, "send_engagement");
    day(-9);
    done(m18, priya, "signed", "file_setup");
    e.setStage(m18, lPleadings, avery);
    day(-8);
    e.skipTask(task(m18, "hold"), avery);
    done(m18, dana, "deadlines", "parties");
    day(-4);
    done(m18, dana, "docs");

    // A distribution agreement negotiated and signed.
    day(-30);
    const m10 = e.createMatter(
      { name: "Distribution agreement: Midwest territory", number: "D-1010", clientId: prairieWind, practiceAreaId: contracts.id, roles: usual, description: "Exclusive distributor for Kansas, Missouri and Nebraska. Minimum purchase commitments were the sticking point." },
      jordan,
    );
    day(-29);
    done(m10, sam, "conflicts");
    done(m10, jordan, "engagement");
    done(m10, casey, "send_engagement");
    day(-26);
    done(m10, casey, "signed", "file_setup");
    e.setStage(m10, cReview, jordan);
    day(-25);
    done(m10, casey, "receive");
    day(-23);
    done(m10, jordan, "first_read");
    day(-20);
    done(m10, jordan, "redline");
    done(m10, sam, "client_memo");
    day(-15);
    done(m10, jordan, "counterparty");
    day(-6);
    done(m10, casey, "execution");
    day(-3);
    done(m10, sam, "key_dates");
    e.addTask({ matterId: m10, title: "Send executed copy and closing letter to client", assigneeId: casey, dueDate: addDays(realToday, 2) }, jordan);

    // A SaaS agreement under review.
    day(-10);
    const m7 = e.createMatter(
      { name: "SaaS subscription agreement", number: "D-1007", clientId: wheatland, practiceAreaId: contracts.id, roles: teamAvery, description: "Enterprise subscription for a data warehouse vendor. Client needs a data-processing addendum and an uptime credit." },
      avery,
    );
    day(-9);
    done(m7, dana, "conflicts");
    done(m7, avery, "engagement");
    done(m7, priya, "send_engagement");
    day(-6);
    done(m7, priya, "signed", "file_setup");
    e.setStage(m7, cReview, avery);
    day(-5);
    done(m7, priya, "receive");
    day(-2);
    done(m7, avery, "first_read");

    // A professional association formation, filing step running late.
    day(-16);
    const m8 = e.createMatter(
      { name: "Cottonwood Animal Hospital formation", number: "D-1008", clientId: cottonwood, practiceAreaId: formation.id, roles: teamRiley, description: "Professional association for a three-veterinarian practice buying out the founding owner." },
      riley,
    );
    day(-15);
    done(m8, dana, "conflicts");
    done(m8, riley, "engagement");
    done(m8, casey, "send_engagement");
    day(-11);
    done(m8, casey, "signed", "file_setup");
    e.setStage(m8, fFormation, riley);
    e.setMatterDate(m8, "signing_date", workday(6), riley);
    day(-10);
    done(m8, dana, "name_check");
    day(-8);
    done(m8, casey, "questionnaire");
    day(-5);
    done(m8, dana, "draft_articles");
    day(-4);
    done(m8, riley, "review_articles");

    // A seller-side lot sale in title review.
    day(-9);
    const m11 = e.createMatter(
      {
        name: "Lot 14 Tallgrass Commons sale",
        number: "D-1011",
        clientId: bluestem,
        practiceAreaId: realEstate.id,
        roles: { attorney: riley, paralegal: sam, assistant: casey },
        description: "Sale of a pad site to a regional bank. Buyer's lender requires an updated ALTA survey.",
        dates: { closing_date: workday(26) },
      },
      riley,
    );
    day(-8);
    done(m11, sam, "conflicts");
    done(m11, riley, "engagement");
    done(m11, casey, "send_engagement");
    day(-6);
    done(m11, casey, "signed", "file_setup");
    e.setStage(m11, rTitle, riley);
    day(-4);
    done(m11, sam, "title_order", "survey");

    // A warehouse purchase closing next week.
    day(-35);
    const m12 = e.createMatter(
      {
        name: "Warehouse purchase: 1200 Industrial Ave",
        number: "D-1012",
        clientId: meadowlark,
        practiceAreaId: realEstate.id,
        roles: usual,
        description: "Purchase of a 40,000 sq ft grain-storage warehouse with rail spur. 1031 exchange funds held by the client's intermediary.",
        dates: { closing_date: workday(5) },
      },
      jordan,
    );
    day(-34);
    done(m12, sam, "conflicts");
    done(m12, jordan, "engagement");
    done(m12, casey, "send_engagement");
    day(-31);
    done(m12, casey, "signed", "file_setup");
    e.setStage(m12, rTitle, jordan);
    day(-30);
    done(m12, sam, "title_order", "survey");
    day(-26);
    done(m12, jordan, "title_review");
    day(-24);
    done(m12, jordan, "objections");
    day(-3);
    done(m12, sam, "deed");

    // Estate plans.
    day(-21);
    const m14 = e.createMatter(
      { name: "Harper estate plan", number: "D-1014", clientId: harper, practiceAreaId: estate.id, roles: { attorney: jordan, paralegal: dana, assistant: priya }, description: "Joint revocable trust, pour-over wills and health care powers for a married couple with a family farm." },
      jordan,
    );
    day(-20);
    done(m14, dana, "conflicts");
    done(m14, jordan, "engagement");
    done(m14, priya, "send_engagement");
    day(-16);
    done(m14, priya, "signed", "file_setup");
    e.setStage(m14, eDesign, jordan);
    e.setMatterDate(m14, "signing_date", workday(8), jordan);
    day(-15);
    done(m14, priya, "questionnaire");
    day(-9);
    done(m14, dana, "assets");
    day(-6);
    done(m14, jordan, "design");
    e.setStage(m14, eDrafting, jordan);
    day(-1);
    done(m14, jordan, "draft_docs");

    day(-6);
    const m15 = e.createMatter(
      { name: "Okafor will and powers of attorney", number: "D-1015", clientId: okafor, practiceAreaId: estate.id, roles: teamAvery, description: "Simple will with a testamentary trust for a minor child; durable and health care powers of attorney." },
      avery,
    );
    day(-5);
    done(m15, dana, "conflicts");
    day(-4);
    done(m15, avery, "engagement");
    done(m15, priya, "send_engagement");

    // A new formation in intake.
    day(-3);
    const m9 = e.createMatter(
      { name: "Kaw Valley Outfitters LLC formation", number: "D-1009", clientId: kawValley, practiceAreaId: formation.id, roles: { attorney: avery, paralegal: sam, assistant: priya }, description: "Two-member LLC for a canoe and kayak outfitter; members want an operating agreement with a vesting schedule." },
      avery,
    );
    day(-2);
    done(m9, sam, "conflicts");

    // Opened today.
    day(0);
    const m5 = e.createMatter(
      {
        name: "Brooks Consulting LLC formation",
        number: "D-1006",
        clientId: taylor,
        practiceAreaId: formation.id,
        roles: usual,
        description: "Single-member LLC for an independent HR consultant.",
      },
      jordan,
    );
    e.addTask({ title: "Renew the firm's online research subscription", assigneeId: casey, priority: "low" }, casey);
    e.addTask({ title: "Review the month's open matters with Riley", assigneeId: jordan, dueDate: addDays(realToday, 3) }, jordan);
    e.addTask({ title: "Order updated ALTA survey from the surveyor", matterId: m11, assigneeId: sam, dueDate: addDays(realToday, 4) }, riley);
    e.addTask({ title: "Monthly status report to the insurer", matterId: m17, assigneeId: jordan, dueDate: addDays(realToday, 6), priority: "high" }, jordan);
    e.addTask({ title: "Update the firm's engagement letter template", assigneeId: riley, dueDate: addDays(realToday, 10), priority: "low" }, riley);

    // ------------------------------------------------------------- calendar
    const cal = new Calendar(db, { now: () => new Date(`${now}T15:00:00Z`) });
    const at = (n: number, time: string) => `${workday(n)}T${time}`;
    const ev = (title: string, kind: string, start: string, end: string | null, extra: Record<string, unknown> = {}) =>
      cal.createEvent({ title, kind: kind as any, start, end, timeZone: "America/Chicago", ...extra } as any, jordan);
    const nextMonday = (() => {
      let d = addDays(realToday, 1);
      while (new Date(d + "T12:00:00Z").getUTCDay() !== 1) d = addDays(d, 1);
      return d;
    })();
    ev("Weekly case review", "meeting", `${nextMonday}T09:00`, `${nextMonday}T10:00`, { rrule: "FREQ=WEEKLY;BYDAY=MO", attendees: [jordan, riley, avery, sam, dana], location: "Conference room" });
    ev("Call with Prairie Wind about distributor minimums", "meeting", `${realToday}T15:30`, `${realToday}T16:00`, { matterId: m10, attendees: [jordan] });
    ev("Client call: Wheatland Analytics DPA questions", "meeting", at(1, "11:00"), at(1, "11:30"), { matterId: m7, attendees: [avery, jordan] });
    ev("Closing: Warehouse purchase", "meeting", at(5, "10:00"), at(5, "11:30"), { matterId: m12, attendees: [jordan, casey], location: "Title company conference room" });
    ev("Status conference: Granger v. Flint Hills Dental", "hearing", at(7, "13:30"), at(7, "14:00"), { matterId: m17, attendees: [jordan, sam], location: "District Court, Courtroom 3" });
    ev("Harper signing ceremony", "meeting", at(8, "10:00"), at(8, "11:30"), { matterId: m14, attendees: [jordan, priya], location: "Our office" });
    ev("Sunflower Coffee operating agreement signing", "meeting", at(9, "14:00"), at(9, "15:00"), { matterId: m1, attendees: [jordan, sam] });
    ev("Mediation: Granger v. Flint Hills Dental", "hearing", at(16, "09:00"), at(16, "16:00"), { matterId: m17, attendees: [jordan], location: "Mediator's office" });
    ev("Lunch and learn: e-signature tools", "other", at(3, "12:00"), at(3, "13:00"), { attendees: [jordan, riley, avery, sam, dana, casey, priya] });
    stampActivity();
    db.exec("COMMIT");
    return {
      users: { jordan, riley, avery, sam, dana, casey, priya },
      matters: { m1, m2, m3, m4, m5, m6, m7, m8, m9, m10, m11, m12, m13, m14, m15, m16, m17, m18 },
      lists: { intake, llc, review, closing, estatePlan, kickoff, discovery },
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
