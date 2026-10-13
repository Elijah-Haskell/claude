// The Calendars screen (src/screens/calendars.tsx): what it says is src/lib/calendars-view.ts, the iPhone app's
// lib/calendars-view.ts word for word (the iPhone groups included, which the browser never shows), plus what the
// browser adds. Dates are built in the PROCESS time zone, and the calendar file uses floating local times, so every
// assertion holds in any TZ.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  allDayDetail,
  APPLE_CALENDAR_EXPLAINER,
  APPLE_CALENDAR_NOT_CREATED,
  APPLE_STOP_ANSWERS,
  APPLE_STOP_QUESTION,
  appleCalendarStatus,
  CALENDAR_FILE_DETAIL,
  CALENDAR_FILE_SAVED,
  CALENDAR_LINK_DETAIL,
  calendarRows,
  CALENDARS_NOT_READ,
  calendarsSections,
  GOOGLE_DISCONNECT_QUESTION,
  googleConnectionRow,
  googleNote,
  googleSyncBlocked,
  googleSyncResult,
  ICS_BROWSER_BLOCKED,
  ICS_FACTS,
  ICS_MAX_EVENTS,
  ICS_NOTHING_FOUND,
  ICS_STEPS,
  icsFailure,
  icsFetchUrl,
  icsImportFailure,
  icsLinkProblem,
  icsNothingNew,
  icsResultLine,
  IPHONE_CALENDARS_CLAIM,
  IPHONE_ONLY_NOTE,
  iphoneCalendarsStatus,
  lastSyncLabel,
  NO_CALENDAR_TICKED,
  NO_CALENDARS_YET,
  planIcsImport,
} from "../../src/lib/calendars-view";
import { groupByAccount, type DeviceCalendar } from "../../src/lib/device-calendars";

const read = (file: string) => readFileSync(resolve(__dirname, "..", "..", file), "utf8");
const NOW = new Date(2030, 2, 13, 12, 0, 0);
const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();

describe("what the page shows", () => {
  it("on the iPhone: both iPhone groups, no note; Google only for a connection made before", () => {
    expect(calendarsSections({ deviceSupported: true, appleSupported: true, googleShown: false })).toEqual({ iphone: true, apple: true, google: false, note: null });
    expect(calendarsSections({ deviceSupported: true, appleSupported: true, googleShown: true }).google).toBe(true);
  });

  it("in the browser: neither iPhone group, and one note so the page is not nearly empty", () => {
    const browser = calendarsSections({ deviceSupported: false, appleSupported: false, googleShown: false });
    expect(browser).toEqual({ iphone: false, apple: false, google: false, note: IPHONE_ONLY_NOTE });
    expect(IPHONE_ONLY_NOTE).toBe("Your iPhone's calendars are read in the iPhone app.");
  });
});

describe("plan around your iPhone calendars", () => {
  const on = { enabled: true, calendars: 3, ticked: 2, upcoming: 38, now: NOW };

  it("keeps the claim under the group word for word", () => {
    expect(IPHONE_CALENDARS_CLAIM).toBe("Study sessions avoid the events in the calendars you pick (iCloud, Google, Outlook). Your events stay on this iPhone.");
  });

  it("off: the switch alone, nothing under it", () => {
    expect(iphoneCalendarsStatus({ ...on, enabled: false })).toEqual({ text: "", tone: "quiet" });
  });

  it("on: when the calendars were last read and how many events lie ahead", () => {
    expect(iphoneCalendarsStatus({ ...on, lastReadAt: minutesAgo(2) })).toEqual({ text: "Updated 2 min ago · 38 events in the next 16 weeks", tone: "quiet" });
    expect(iphoneCalendarsStatus({ ...on, upcoming: 1, lastReadAt: minutesAgo(0) }).text).toBe("Updated just now · 1 event in the next 16 weeks");
  });

  it("on, not read yet: says it is reading, with no count it does not have", () => {
    const reading = iphoneCalendarsStatus({ ...on, calendars: null, ticked: 0 });
    expect(reading.tone).toBe("quiet");
    expect(reading.text).toMatch(/^Reading your calendars/);
    expect(reading.text).not.toMatch(/\d/);
  });

  it("says in gold the one thing that is missing: no calendar on the iPhone, or none ticked", () => {
    expect(iphoneCalendarsStatus({ ...on, calendars: 0, ticked: 0, lastReadAt: minutesAgo(2) })).toEqual({ text: NO_CALENDARS_YET, tone: "gold" });
    expect(NO_CALENDARS_YET).toMatch(/^No calendars on this iPhone yet\./);
    expect(iphoneCalendarsStatus({ ...on, ticked: 0, lastReadAt: minutesAgo(2) })).toEqual({ text: NO_CALENDAR_TICKED, tone: "gold" });
    expect(NO_CALENDAR_TICKED).toMatch(/^No calendar ticked/);
  });

  it("a failure that is not iOS refusing access is said in red, under the switch", () => {
    expect(iphoneCalendarsStatus({ ...on, enabled: false, failed: true })).toEqual({ text: CALENDARS_NOT_READ, tone: "red" });
    // Once it is on, the failure of an earlier try is no longer what is true.
    expect(iphoneCalendarsStatus({ ...on, failed: true, lastReadAt: minutesAgo(5) }).tone).toBe("quiet");
  });

  const calendars: DeviceCalendar[] = [
    { id: "p", title: "Personal", color: "#3B82F6", account: "iCloud" },
    { id: "f", title: "Family", color: "#EC4899", account: "iCloud" },
    { id: "s", title: "School", account: "student@gmail.com" },
  ];

  it("lists the calendars by account, the ticked ones marked, each row saying its calendar and account", () => {
    const rows = calendarRows(groupByAccount(calendars), ["p", "s"]);
    expect(rows.map((row) => (row.kind === "account" ? `# ${row.account}` : `${row.checked ? "[x]" : "[ ]"} ${row.title}`))).toEqual([
      "# iCloud",
      "[x] Personal",
      "[ ] Family",
      "# student@gmail.com",
      "[x] School",
    ]);
    const school = rows[4]!;
    expect(school.kind === "calendar" && school.accessibilityLabel).toBe("School, student@gmail.com");
    expect(new Set(rows.map((row) => row.key)).size).toBe(rows.length);
    expect(calendarRows([], ["p"])).toEqual([]);
  });

  it("says what the all-day switch does, either way", () => {
    expect(allDayDetail(true)).toBe("Every all-day event in the ticked calendars blocks its whole day.");
    expect(allDayDetail(false)).toBe("Most all-day events (holidays, due dates) do not fill your day.");
  });
});

describe("your plan in Apple Calendar", () => {
  it("off: the explainer, word for word", () => {
    expect(APPLE_CALENDAR_EXPLAINER).toBe("Study sessions go to a separate \"Trajectory\" calendar that is rewritten whenever your plan changes.");
    expect(appleCalendarStatus(null)).toEqual({ text: APPLE_CALENDAR_EXPLAINER, tone: "quiet" });
    expect(appleCalendarStatus({ enabled: false })).toEqual({ text: APPLE_CALENDAR_EXPLAINER, tone: "quiet" });
  });

  it("on: setting up, then up to date with the count, or the error in red", () => {
    expect(appleCalendarStatus({ enabled: true })).toEqual({ text: "Setting up the Trajectory calendar...", tone: "quiet" });
    expect(appleCalendarStatus({ enabled: true, lastSyncAt: minutesAgo(1), lastSyncCount: 21 })).toEqual({ text: "Up to date · 21 events in the next 8 weeks", tone: "quiet" });
    expect(appleCalendarStatus({ enabled: true, lastSyncAt: minutesAgo(1), lastSyncCount: 1 }).text).toBe("Up to date · 1 event in the next 8 weeks");
    expect(appleCalendarStatus({ enabled: true, lastSyncAt: minutesAgo(1) }).text).toBe("Up to date · 0 events in the next 8 weeks");
    expect(appleCalendarStatus({ enabled: true, lastSyncAt: minutesAgo(1), lastSyncCount: 21, lastError: "Calendar access is off for Trajectory in iOS Settings." })).toEqual({
      text: "Calendar access is off for Trajectory in iOS Settings.",
      tone: "red",
    });
  });

  it("a calendar that could not be created is said in red, under the switch", () => {
    expect(appleCalendarStatus({ enabled: false }, { failed: true })).toEqual({ text: APPLE_CALENDAR_NOT_CREATED, tone: "red" });
    expect(appleCalendarStatus({ enabled: true, lastSyncAt: minutesAgo(1), lastSyncCount: 2 }, { failed: true }).tone).toBe("quiet");
  });

  it("turning it off asks first, with the three answers it always had", () => {
    expect(APPLE_STOP_QUESTION).toMatch(/^Stop adding your plan to Apple Calendar\?/);
    expect(APPLE_STOP_ANSWERS.map((answer) => answer.label)).toEqual(["Cancel", "Keep calendar", "Remove calendar"]);
    expect(APPLE_STOP_ANSWERS.filter((answer) => answer.destructive).map((answer) => answer.answer)).toEqual(["remove"]);
  });
});

describe("import from a calendar link", () => {
  const event = (lines: string[]) => ["BEGIN:VEVENT", ...lines, "END:VEVENT"].join("\r\n");
  const calendar = (events: string[]) => ["BEGIN:VCALENDAR", "VERSION:2.0", ...events, "END:VCALENDAR"].join("\r\n");
  let next = 0;
  const makeId = () => `id-${++next}`;

  it("keeps the row's line (said for a browser), the steps and the facts", () => {
    expect(CALENDAR_LINK_DETAIL).toBe("Paste a secret iCal (ICS) link once. Runs in this browser.");
    expect(ICS_STEPS).toHaveLength(6);
    expect(ICS_STEPS[4]).toContain("Secret address in iCal format");
    expect(ICS_FACTS).toHaveLength(4);
    expect(ICS_FACTS[2]).toBe("Past events, and ones already in your plan, are skipped");
    expect(ICS_FACTS[3]).toBe(`Up to ${ICS_MAX_EVENTS} events are imported at once`);
  });

  it("the button is off until there is a link that can be tried, with the reason in words", () => {
    expect(icsLinkProblem("")).toBe("Paste the calendar link to import it");
    expect(icsLinkProblem("   \n")).toBe("Paste the calendar link to import it");
    expect(icsLinkProblem("calendar.google.com/ical/basic.ics")).toMatch(/has to start with https:\/\//);
    expect(icsLinkProblem("ftp://school.example/feed.ics")).toMatch(/has to start with https:\/\//);
    // "webcal://" is what Apple and some schools hand out: the same file, fetched over https.
    expect(icsLinkProblem("webcal://calendar.google.com/ical/basic.ics")).toBeNull();
    expect(icsFetchUrl(" webcal://calendar.google.com/ical/basic.ics\n")).toBe("https://calendar.google.com/ical/basic.ics");
    expect(icsFetchUrl("https://school.example/feed.ics")).toBe("https://school.example/feed.ics");
    expect(icsLinkProblem("https://calendar.google.com/ical/a b.ics")).toMatch(/no spaces/);
    expect(icsLinkProblem("  https://calendar.google.com/calendar/ical/abc/basic.ics\n")).toBeNull();
    expect(icsLinkProblem("http://school.example/feed.ics")).toBeNull();
  });

  it("an event on set weekdays becomes work or an activity; every other event a task due on its date", () => {
    next = 0;
    const text = calendar([
      event(["UID:1", "SUMMARY:Barista shift", "DTSTART:20300311T170000", "DTEND:20300311T210000", "RRULE:FREQ=WEEKLY;BYDAY=MO,WE"]),
      event(["UID:2", "SUMMARY:Dentist", "DTSTART:20300320T093000", "DTEND:20300320T101500"]),
      event(["UID:3", "SUMMARY:Cancelled meeting", "DTSTART:20300321T090000", "STATUS:CANCELLED"]),
      // Repeats, but on no set weekday: one task on its first date, not a weekly commitment.
      event(["UID:4", "SUMMARY:Daily reading", "DTSTART:20300314T080000", "RRULE:FREQ=DAILY"]),
      // ... and none at all when that first date is behind us: a task cannot be due in the past.
      event(["UID:5", "SUMMARY:Morning run", "DTSTART:20300301T070000", "RRULE:FREQ=DAILY"]),
    ]);
    const plan = planIcsImport(text, { now: NOW, makeId });

    expect(plan.found).toBe(4);
    expect(plan.leftOut).toBe(0);
    expect(plan.past).toBe(1);
    expect(plan.names).toEqual(["Barista shift (every week)", "Dentist", "Daily reading"]);
    expect(plan.items.map((item) => item.kind)).toEqual(["recurring", "task", "task"]);
    const [shift, dentist] = plan.items;
    expect(shift).toMatchObject({ kind: "recurring", event: { id: "id-1", title: "Barista shift", days: ["Mon", "Wed"], startTime: "17:00", endTime: "21:00", locked: false } });
    expect(shift?.kind === "recurring" ? shift.event.color : "").toMatch(/^#[0-9A-F]{6}$/i);
    expect(dentist).toEqual({
      kind: "task",
      task: { id: "id-2", name: "Dentist", courseId: "", courseName: "Imported", dueDate: "2030-03-20", estimatedMinutes: 60, difficulty: 2, requiresOnCampus: false, status: "pending", createdAt: NOW.toISOString() },
    });
  });

  it("brings in the first 50 and says how many were left out", () => {
    const many = calendar(Array.from({ length: ICS_MAX_EVENTS + 3 }, (_, index) => event([`UID:${index}`, `SUMMARY:Event ${index + 1}`, "DTSTART:20300401T100000"])));
    const plan = planIcsImport(many, { now: NOW, makeId });
    expect(plan.items).toHaveLength(ICS_MAX_EVENTS);
    expect(plan.names[ICS_MAX_EVENTS - 1]).toBe("Event 50");
    expect(plan.found).toBe(53);
    expect(plan.leftOut).toBe(3);
    expect(icsResultLine(plan)).toBe("50 events imported. 3 more events were left out: 50 come in at once.");
    expect(icsResultLine({ names: ["a"], leftOut: 0 })).toBe("1 event imported");
    expect(icsResultLine({ names: ["a", "b"], leftOut: 1 })).toBe("2 events imported. 1 more event was left out: 50 come in at once.");
  });

  it("a file with no event in it imports nothing, and the sheet says so instead of 'complete'", () => {
    expect(planIcsImport("<html>Sign in</html>", { now: NOW, makeId }).items).toEqual([]);
    expect(planIcsImport(calendar([]), { now: NOW, makeId })).toMatchObject({ items: [], names: [], found: 0, leftOut: 0, past: 0, already: 0 });
    expect(ICS_NOTHING_FOUND).toMatch(/^No events found\./);
  });

  it("leaves out what is over: a calendar link carries years of history", () => {
    // NOW is 13 March 2030.
    const text = calendar([
      event(["UID:1", "SUMMARY:Last year's exam", "DTSTART:20290510T090000"]),
      event(["UID:2", "SUMMARY:Yesterday", "DTSTART:20300312T090000"]),
      event(["UID:3", "SUMMARY:Today", "DTSTART:20300313T090000"]),
      event(["UID:4", "SUMMARY:Next week", "DTSTART:20300320T090000"]),
      // A class that stopped repeating last December, and one that still runs (no end date, and an end in May).
      event(["UID:5", "SUMMARY:Fall seminar", "DTSTART:20290903T100000", "RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20291210T000000Z"]),
      event(["UID:6", "SUMMARY:Choir", "DTSTART:20290903T180000", "RRULE:FREQ=WEEKLY;BYDAY=TU"]),
      event(["UID:7", "SUMMARY:Spring lab", "DTSTART:20300114T140000", "RRULE:FREQ=WEEKLY;BYDAY=TH;UNTIL=20300509T000000Z"]),
    ]);
    const plan = planIcsImport(text, { now: NOW, makeId });
    expect(plan.names).toEqual(["Today", "Next week", "Choir (every week)", "Spring lab (every week)"]);
    expect(plan).toMatchObject({ found: 7, past: 3, already: 0, leftOut: 0 });
    expect(icsResultLine(plan)).toBe("4 events imported. 3 past events were left out.");
  });

  it("adds nothing twice: not on a second import, and not when the file lists an event twice", () => {
    const text = calendar([
      event(["UID:1", "SUMMARY:Barista shift", "DTSTART:20300311T170000", "DTEND:20300311T210000", "RRULE:FREQ=WEEKLY;BYDAY=MO,WE"]),
      event(["UID:2", "SUMMARY:Dentist", "DTSTART:20300320T093000"]),
      event(["UID:2b", "SUMMARY:dentist ", "DTSTART:20300320T140000"]),
      event(["UID:3", "SUMMARY:Dentist", "DTSTART:20300327T093000"]),
    ]);
    const first = planIcsImport(text, { now: NOW, makeId });
    // The same name on the same date is one task; on another date it is another.
    expect(first.names).toEqual(["Barista shift (every week)", "Dentist", "Dentist"]);
    expect(first).toMatchObject({ found: 4, already: 1, past: 0 });

    // The plan after that import: importing the same link again adds nothing.
    const existing = {
      tasks: first.items.flatMap((item) => (item.kind === "task" ? [item.task] : [])),
      recurringEvents: first.items.flatMap((item) => (item.kind === "recurring" ? [item.event] : [])),
    };
    const second = planIcsImport(text, { now: NOW, makeId, existing });
    expect(second.items).toEqual([]);
    expect(second).toMatchObject({ found: 4, already: 4 });
    expect(icsNothingNew(second)).toBe("Nothing new to import. The link has 4 events: 4 are already in your plan.");
    expect(icsNothingNew({ found: 3, past: 2, already: 1 })).toBe("Nothing new to import. The link has 3 events: 2 are over and 1 is already in your plan.");
    expect(icsNothingNew({ found: 1, past: 1, already: 0 })).toBe("Nothing new to import. The link has 1 event: 1 is over.");

    // A task stored with a time on its date is still the same task.
    const timed = planIcsImport(text, { now: NOW, makeId, existing: { tasks: [{ name: "Dentist", dueDate: "2030-03-20T09:30:00" }], recurringEvents: [] } });
    expect(timed.names).toEqual(["Barista shift (every week)", "Dentist"]);
    expect(icsResultLine(timed)).toBe("2 events imported. 2 events already in your plan were skipped.");
  });

  it("the limit counts what could come in, after the past and the duplicates are set aside", () => {
    const old = Array.from({ length: 30 }, (_, index) => event([`UID:old-${index}`, `SUMMARY:Old ${index + 1}`, "DTSTART:20290401T100000"]));
    const ahead = Array.from({ length: ICS_MAX_EVENTS + 2 }, (_, index) => event([`UID:new-${index}`, `SUMMARY:Ahead ${index + 1}`, "DTSTART:20300401T100000"]));
    const plan = planIcsImport(calendar([...old, ...ahead]), { now: NOW, makeId });
    expect(plan.items).toHaveLength(ICS_MAX_EVENTS);
    expect(plan.names[0]).toBe("Ahead 1");
    expect(plan).toMatchObject({ found: 82, past: 30, leftOut: 2 });
    expect(icsResultLine(plan)).toBe("50 events imported. 30 past events were left out. 2 more events were left out: 50 come in at once.");
  });

  it("says that the import failed, with the reason when there is one", () => {
    expect(icsFailure(new Error("HTTP 404"))).toBe("Import failed. Your calendar could not be read (HTTP 404). Check the link and try again.");
    expect(icsFailure("nope")).toBe("Import failed. Your calendar could not be read. Check the link and try again.");
  });

  it("in a browser, a link the service keeps from web pages is said as that, not as 'Failed to fetch'", () => {
    // fetch() rejects with a TypeError before any answer when the server sends no CORS headers (Google Calendar's
    // secret address does not): there is no HTTP status to show, and the link itself is fine.
    expect(icsImportFailure(new TypeError("Failed to fetch"))).toBe(ICS_BROWSER_BLOCKED);
    expect(ICS_BROWSER_BLOCKED).toMatch(/^Import failed\./);
    expect(ICS_BROWSER_BLOCKED).toMatch(/does not let web browsers read the link/);
    expect(ICS_BROWSER_BLOCKED).not.toMatch(/Failed to fetch/);
    // Everything else keeps the iPhone's sentence, reason included.
    expect(icsImportFailure(new Error("HTTP 404"))).toBe(icsFailure(new Error("HTTP 404")));
    expect(icsImportFailure("nope")).toBe(icsFailure("nope"));
  });
});

describe("a Google Calendar connection made before", () => {
  it("says when it last synced", () => {
    expect(lastSyncLabel(null, NOW)).toBe("Never");
    expect(lastSyncLabel("not a date", NOW)).toBe("Never");
    expect(lastSyncLabel(minutesAgo(0), NOW)).toBe("Just now");
    expect(lastSyncLabel(minutesAgo(12), NOW)).toBe("12m ago");
    expect(lastSyncLabel(minutesAgo(3 * 60 + 5), NOW)).toBe("3h ago");
    expect(lastSyncLabel(minutesAgo(3 * 24 * 60), NOW)).toBe(new Date(NOW.getTime() - 3 * 24 * 60 * 60_000).toLocaleDateString());
  });

  it("its row says the state, and for a connection when it last synced and that it is live", () => {
    const base = { loading: false, connected: true, channelActive: false, lastSync: minutesAgo(12), now: NOW };
    expect(googleConnectionRow({ ...base, loading: true })).toEqual({ label: "Checking...", detail: "" });
    expect(googleConnectionRow({ ...base, connected: false })).toEqual({ label: "Not connected", detail: "" });
    expect(googleConnectionRow(base)).toEqual({ label: "Connected", detail: "Last synced: 12m ago" });
    expect(googleConnectionRow({ ...base, channelActive: true })).toEqual({ label: "Connected", detail: "Last synced: 12m ago · Live" });
  });

  it("keeps the note word for word", () => {
    expect(googleNote({ connected: true, events: 14 })).toBe("14 Google events block time in your plan. Trajectory only reads them, and disconnecting removes them from Trajectory and from our server.");
    expect(googleNote({ connected: true, events: 1 })).toBe("1 Google event blocks time in your plan. Trajectory only reads them, and disconnecting removes them from Trajectory and from our server.");
    expect(googleNote({ connected: false, events: 0 })).toBe("Your Google events block time in the plan. Trajectory only reads them, never changes them.");
  });

  it("'Sync now' says its result on the page: how many came in, or that it did not go through", () => {
    expect(googleSyncResult(7)).toEqual({ text: "Sync complete. 7 events synced from Google Calendar.", tone: "quiet" });
    expect(googleSyncResult(1).text).toBe("Sync complete. 1 event synced from Google Calendar.");
    expect(googleSyncResult(0).text).toBe("Sync complete. 0 events synced from Google Calendar.");
    expect(googleSyncResult(null).tone).toBe("red");
    expect(googleSyncResult(null).text).not.toMatch(/complete/i);
  });

  it("while 'Sync now' is off the page says why, unless the row already does", () => {
    expect(googleSyncBlocked({ loading: true, connected: false })).toBe("");
    expect(googleSyncBlocked({ loading: false, connected: true })).toBe("");
    expect(googleSyncBlocked({ loading: false, connected: false })).toMatch(/could not be confirmed/);
  });

  it("disconnecting asks first and says what goes", () => {
    expect(GOOGLE_DISCONNECT_QUESTION).toBe("Disconnect Google Calendar? This removes all synced events from Trajectory. Your Google Calendar is not affected.");
  });
});

describe("what the browser adds", () => {
  it("the plan as a calendar file: the row's words are Settings' words, and the page says when the file was handed over", () => {
    const settings = read("src/screens/settings.tsx");
    expect(settings).toContain(`detail="${CALENDAR_FILE_DETAIL}"`);
    expect(CALENDAR_FILE_SAVED).toMatch(/^Your plan was saved as a calendar file\./);
  });
});

describe("the Calendars screen, as built", () => {
  const screen = read("src/screens/calendars.tsx");

  it("is titled as the iPhone's and has every part a browser can have, in the same places", () => {
    expect(screen).toContain('<ScreenHeader eyebrow="Your time" title="Calendars" />');
    for (const piece of [
      '<SectionLabel title="Google Calendar" />',
      'label="Calendar file"',
      'label="Import from a calendar link"',
      'label="Sync now"',
      'label="Connect Google Calendar"',
      'label="Import events"',
      'label="Done"',
      "Import another calendar",
      "View Google&apos;s guide",
      "{sections.note ? <Note>{sections.note}</Note> : null}",
      "deviceSupported: false",
      "appleSupported: false",
    ]) expect(screen, piece).toContain(piece);
    // The iPhone's own groups are not drawn in a browser.
    expect(screen).not.toMatch(/Plan around your iPhone calendars|Your plan in Apple Calendar/);
  });

  it("no longer links to the course feeds: Settings does", () => {
    expect(screen).not.toMatch(/course-feeds|Course feeds/);
  });

  it("asks in place before Google is disconnected, and speaks to the server through lib/api.ts", () => {
    // The only way to disconnect goes through the question.
    expect(screen.match(/\bdisconnect\(\)/g)).toHaveLength(1);
    expect(screen).toMatch(/onClick=\{\(\) => setConfirmingDisconnect\(true\)\}[^>]*aria-label="Disconnect Google Calendar"/);
    expect(screen).toMatch(/onClick=\{\(\) => void disconnect\(\)\}[^>]*aria-label="Yes, disconnect Google Calendar"/);
    expect(screen).toContain('from "../lib/gcal-sync"');
    expect(screen).not.toMatch(/\bfetch\(`\$\{API_BASE/);
    expect(screen).toContain('dispatch({ type: "CLEAR_GOOGLE_CALENDAR" })');
    expect(screen).toContain("dispatch(gcalEventsAction(events))");
  });

  it("shows the import in a sheet and its problems in the sheet, with the browser's own failure sentence", () => {
    expect(screen).toContain("<CalendarLinkSheet open={linkOpen} onClose={() => setLinkOpen(false)} />");
    expect(screen).toContain("setProblem({ text: plan.found > 0 ? icsNothingNew(plan) : ICS_NOTHING_FOUND, tone: \"gold\" });");
    expect(screen).toContain("setProblem({ text: icsImportFailure(err), tone: \"red\" });");
    expect(screen).toContain("disabled={loading || blocked !== null}");
    expect(screen).toContain('dispatch({ type: "ADD_RECURRING_EVENT", payload: item.event })');
    expect(screen).toContain('dispatch({ type: "ADD_TASK", payload: item.task })');
  });

  it("has no alerts (nothing here needs iOS Settings) and goes back, never onto a second copy of the tabs", () => {
    expect(screen).not.toMatch(/Alert\.alert|window\.alert|window\.confirm|showAlert\(/);
    expect(screen).toContain('goBack("settings")');
    expect(screen).not.toMatch(/<Redirect/);
  });
});
