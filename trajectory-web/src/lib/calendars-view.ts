/**
 * The Calendars screen (app/google-calendar-sync.tsx on the iPhone, src/screens/calendars.tsx here), as pure
 * functions: which groups it shows, the line under each switch, the rows of the calendar checklist, the one-off
 * import from a calendar link (what stops it, what comes in, what the sheet says afterwards) and the lines of a Google
 * Calendar connection made before. Nothing here claims more than the app knows: a sync that failed says so, and an
 * import that left events out says how many.
 *
 * The iPhone groups (its calendars read, the plan mirrored to Apple Calendar) are kept word for word although the
 * browser never shows them: the module stays one with the iPhone app's, and its tests run as they are. What the
 * browser adds is at the end: the plan as a calendar file, and a link a browser is not allowed to read.
 */
import { parseIcsEvents } from "../engine/ics";
import type { DayOfWeek, RecurringEvent, Task } from "../engine/types";
import { dateKeyOf, localDateKey } from "../engine/utils";
import { deviceCalendarStatus, type CalendarGroup } from "./device-calendars";

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** A line under a switch or over a button: quiet = how things are, gold = something is missing, red = it failed. */
export interface StatusLine {
  text: string;
  tone: "quiet" | "gold" | "red";
}

/** The iPhone app's lib/apple-calendar.ts settings (the browser has no Apple Calendar mirror; the wording is kept). */
export interface AppleCalendarSettings {
  enabled: boolean;
  /** Also add each unfinished deadline (all-day, or at its due time). */
  includeDeadlines: boolean;
  calendarId?: string;
  lastSyncAt?: string;
  /** Events in the Trajectory calendar after the last sync. */
  lastSyncCount?: number;
  lastError?: string;
}

// ── What the page shows ───────────────────────────────────────────────────────

/** The one note of the browser build, where the iPhone's calendars cannot be read. */
export const IPHONE_ONLY_NOTE = "Your iPhone's calendars are read in the iPhone app.";

export interface CalendarsSections {
  /** "Plan around your iPhone calendars" */
  iphone: boolean;
  /** "Your plan in Apple Calendar" */
  apple: boolean;
  /** A Google Calendar connection made before (connecting is retired: lib/config.ts). */
  google: boolean;
  /** Said once when neither iPhone group can be shown, so the page is not nearly empty. */
  note: string | null;
}

export function calendarsSections(input: { deviceSupported: boolean; appleSupported: boolean; googleShown: boolean }): CalendarsSections {
  return {
    iphone: input.deviceSupported,
    apple: input.appleSupported,
    google: input.googleShown,
    note: input.deviceSupported || input.appleSupported ? null : IPHONE_ONLY_NOTE,
  };
}

// ── Plan around your iPhone calendars ─────────────────────────────────────────

/** Under the group, always: what the switch does and where the events stay. */
export const IPHONE_CALENDARS_CLAIM = "Study sessions avoid the events in the calendars you pick (iCloud, Google, Outlook). Your events stay on this iPhone.";

export const NO_CALENDARS_YET = "No calendars on this iPhone yet. Add an account in iOS Settings → Apps → Calendar → Calendar Accounts.";
export const NO_CALENDAR_TICKED = "No calendar ticked: tick the ones whose events count as busy.";
export const CALENDARS_NOT_READ = "Your calendars could not be read. Please try again.";

/**
 * The line under "Plan around them". Off, it says nothing (the sentence under the group says what it does); on, it
 * says when the calendars were last read and how many events lie ahead, or the one thing that is missing.
 */
export function iphoneCalendarsStatus(input: {
  enabled: boolean;
  /** How many calendars the iPhone has; null while they are being listed. */
  calendars: number | null;
  ticked: number;
  lastReadAt?: string;
  upcoming: number;
  now: Date;
  /** Turning it on failed for a reason other than iOS refusing access. */
  failed?: boolean;
}): StatusLine {
  if (input.failed && !input.enabled) return { text: CALENDARS_NOT_READ, tone: "red" };
  if (!input.enabled) return { text: "", tone: "quiet" };
  if (input.calendars === 0) return { text: NO_CALENDARS_YET, tone: "gold" };
  if (input.calendars !== null && input.ticked === 0) return { text: NO_CALENDAR_TICKED, tone: "gold" };
  return { text: deviceCalendarStatus({ lastReadAt: input.lastReadAt, upcoming: input.upcoming, now: input.now }), tone: "quiet" };
}

export type CalendarRow =
  | { kind: "account"; key: string; account: string }
  | { kind: "calendar"; key: string; id: string; title: string; color?: string; checked: boolean; accessibilityLabel: string };

/** The checklist, top to bottom: each account's name, then its calendars with the ticked ones marked. */
export function calendarRows(groups: readonly CalendarGroup[], ticked: readonly string[]): CalendarRow[] {
  const on = new Set(ticked);
  return groups.flatMap((group, index): CalendarRow[] => [
    { kind: "account", key: `account-${index}-${group.account}`, account: group.account },
    ...group.calendars.map((calendar): CalendarRow => ({
      kind: "calendar",
      key: calendar.id,
      id: calendar.id,
      title: calendar.title,
      color: calendar.color,
      checked: on.has(calendar.id),
      accessibilityLabel: `${calendar.title}, ${calendar.account}`,
    })),
  ]);
}

/** Under "All-day events are busy". */
export function allDayDetail(on: boolean): string {
  return on ? "Every all-day event in the ticked calendars blocks its whole day." : "Most all-day events (holidays, due dates) do not fill your day.";
}

// ── Your plan in Apple Calendar ───────────────────────────────────────────────

export const APPLE_CALENDAR_EXPLAINER = "Study sessions go to a separate \"Trajectory\" calendar that is rewritten whenever your plan changes.";
export const APPLE_CALENDAR_NOT_CREATED = "The Trajectory calendar could not be created. Please try again.";
export const INCLUDE_DEADLINES_DETAIL = "Due dates as their own events (at the due time, or all day).";

/** The line under "Add my plan to it". */
export function appleCalendarStatus(
  settings: Pick<AppleCalendarSettings, "enabled" | "lastError" | "lastSyncAt" | "lastSyncCount"> | null,
  options: { failed?: boolean } = {},
): StatusLine {
  if (!settings?.enabled) return options.failed ? { text: APPLE_CALENDAR_NOT_CREATED, tone: "red" } : { text: APPLE_CALENDAR_EXPLAINER, tone: "quiet" };
  if (settings.lastError) return { text: settings.lastError, tone: "red" };
  if (settings.lastSyncAt) return { text: `Up to date · ${count(settings.lastSyncCount ?? 0, "event")} in the next 8 weeks`, tone: "quiet" };
  return { text: "Setting up the Trajectory calendar...", tone: "quiet" };
}

/** Turning the export off asks first, on the page: the question and its three answers. */
export const APPLE_STOP_QUESTION = "Stop adding your plan to Apple Calendar? You can keep the Trajectory calendar as it is now, or remove it from your phone.";
export type AppleStopAnswer = "cancel" | "keep" | "remove";
export const APPLE_STOP_ANSWERS: readonly { answer: AppleStopAnswer; label: string; destructive?: boolean }[] = [
  { answer: "cancel", label: "Cancel" },
  { answer: "keep", label: "Keep calendar" },
  { answer: "remove", label: "Remove calendar", destructive: true },
];

// ── Import from a calendar link ───────────────────────────────────────────────

/** The iPhone says "Runs on this iPhone."; here the browser fetches the file. */
export const CALENDAR_LINK_DETAIL = "Paste a secret iCal (ICS) link once. Runs in this browser.";
export const ICS_GUIDE_URL = "https://support.google.com/calendar/answer/37648";
export const ICS_GUIDE_FALLBACK = "The guide could not be opened. Search for \"Google Calendar secret address\" in your browser.";
/** At most this many events come in at once. */
export const ICS_MAX_EVENTS = 50;

export const ICS_STEPS: readonly string[] = [
  "Open Google Calendar on your computer",
  "Click the gear icon, then Settings",
  "Click your calendar's name in the left sidebar",
  "Scroll down to Integrate calendar",
  "Copy the \"Secret address in iCal format\" link",
  "Paste it below and select Import events",
];

export const ICS_FACTS: readonly string[] = [
  "Events that repeat on set days of the week are added to Work and activities",
  "Every other event from today on is added to Tasks, due on its date",
  "Past events, and ones already in your plan, are skipped",
  `Up to ${ICS_MAX_EVENTS} events are imported at once`,
];

/** Why "Import events" is off, in the words shown over it; null when the link can be tried. */
export function icsLinkProblem(url: string): string | null {
  const link = url.trim();
  if (!link) return "Paste the calendar link to import it";
  if (!/^(https?|webcal):\/\/\S+$/i.test(link)) return "The link has to start with https:// or webcal:// and have no spaces";
  return null;
}

/** The address the file is fetched from: a "webcal://" link (what Apple and some schools hand out) is the same file over https. */
export function icsFetchUrl(url: string): string {
  return url.trim().replace(/^webcal:\/\//i, "https://");
}

const ICS_DAYS: Record<string, DayOfWeek> = { MO: "Mon", TU: "Tue", WE: "Wed", TH: "Thu", FR: "Fri", SA: "Sat", SU: "Sun" };
// Colours for the commitments an import adds (the student can change them afterwards).
const IMPORT_COLORS = ["#6366F1", "#3B82F6", "#8B5CF6", "#EC4899", "#F59E0B"] as const;

export type IcsImportItem = { kind: "recurring"; event: RecurringEvent } | { kind: "task"; task: Task };

export interface IcsImportPlan {
  /** What to add, in the calendar's own order. */
  items: IcsImportItem[];
  /** One line per imported event, for the list the sheet shows afterwards. */
  names: string[];
  /** Events the link had (cancelled ones left out). */
  found: number;
  /** Events that could have come in beyond the first ICS_MAX_EVENTS, which were not imported. */
  leftOut: number;
  /** Events that are over: a one-time event before today, a weekly one whose repeat ended before today. */
  past: number;
  /** Events already in the plan (the same name on the same date, or the same weekly activity), or twice in the file. */
  already: number;
}

/** What the plan already holds, so a second import of the same calendar adds nothing twice. */
export interface IcsExisting {
  tasks: readonly Pick<Task, "name" | "dueDate">[];
  recurringEvents: readonly Pick<RecurringEvent, "title" | "days" | "startTime">[];
}

const sameText = (text: string) => text.trim().toLowerCase();
const taskKey = (name: string, dueDate: string) => `${sameText(name)}|${dateKeyOf(dueDate)}`;
const weeklyKey = (title: string, days: readonly DayOfWeek[], startTime: string) => `${sameText(title)}|${[...days].sort().join(",")}|${startTime}`;

/** The last day a repeating event happens ("UNTIL=20240510T..."), as a date key; "" when the rule has no end date. */
function ruleEndKey(rrule: string): string {
  const until = /UNTIL=(\d{4})(\d{2})(\d{2})/.exec(rrule);
  return until ? `${until[1]}-${until[2]}-${until[3]}` : "";
}

/**
 * What a calendar file adds to the plan: an event that repeats on set weekdays becomes work or an activity; every
 * other event becomes a task due on its date. Left out: cancelled events, events that are over (a calendar link often
 * carries years of history, which would arrive as overdue tasks and last year's classes), and what the plan already
 * has. Of what is left, the first ICS_MAX_EVENTS come in.
 */
export function planIcsImport(icsText: string, options: { now: Date; makeId: () => string; existing?: IcsExisting }): IcsImportPlan {
  const events = parseIcsEvents(icsText).filter((event) => event.status !== "CANCELLED");
  const today = localDateKey(options.now);
  const seenTasks = new Set((options.existing?.tasks ?? []).map((task) => taskKey(task.name, task.dueDate)));
  const seenWeekly = new Set((options.existing?.recurringEvents ?? []).map((event) => weeklyKey(event.title, event.days, event.startTime)));
  const items: IcsImportItem[] = [];
  const names: string[] = [];
  let colorIndex = 0;
  let past = 0;
  let already = 0;
  let leftOut = 0;
  for (const event of events) {
    const byDay = event.rrule?.match(/BYDAY=([^;]+)/)?.[1];
    const days = byDay ? byDay.split(",").map((day) => ICS_DAYS[day.replace(/[-+\d]/g, "").toUpperCase()]).filter((day): day is DayOfWeek => Boolean(day)) : [];
    const weekly = Boolean(event.rrule) && days.length > 0;
    const startTime = event.start.time ?? "00:00";
    // Over: a weekly event whose repeat has an end date before today; any other event dated before today.
    const endKey = weekly ? ruleEndKey(event.rrule ?? "") : "";
    if (weekly ? endKey !== "" && endKey < today : event.start.date < today) {
      past++;
      continue;
    }
    const key = weekly ? weeklyKey(event.summary, days, startTime) : taskKey(event.summary, event.start.date);
    const seen = weekly ? seenWeekly : seenTasks;
    if (seen.has(key)) {
      already++;
      continue;
    }
    seen.add(key);
    if (items.length >= ICS_MAX_EVENTS) {
      leftOut++;
      continue;
    }
    if (weekly) {
      items.push({
        kind: "recurring",
        event: {
          id: options.makeId(),
          title: event.summary,
          days,
          startTime,
          endTime: event.end?.time ?? startTime,
          color: IMPORT_COLORS[colorIndex++ % IMPORT_COLORS.length]!,
          locked: false,
        },
      });
      names.push(`${event.summary} (every week)`);
    } else {
      items.push({
        kind: "task",
        task: {
          id: options.makeId(),
          name: event.summary,
          courseId: "",
          courseName: "Imported",
          dueDate: event.start.date,
          estimatedMinutes: 60,
          difficulty: 2,
          requiresOnCampus: false,
          status: "pending",
          createdAt: options.now.toISOString(),
        },
      });
      names.push(event.summary);
    }
  }
  return { items, names, found: events.length, leftOut, past, already };
}

export const ICS_NOTHING_FOUND = "No events found. Make sure the link is a valid iCal (ICS) link.";

/** The link had events, but none to add: they are over, or the plan has them already. */
export function icsNothingNew(plan: Pick<IcsImportPlan, "found" | "past" | "already">): string {
  const why = [plan.past > 0 ? `${plan.past} ${plan.past === 1 ? "is" : "are"} over` : "", plan.already > 0 ? `${plan.already} ${plan.already === 1 ? "is" : "are"} already in your plan` : ""].filter(Boolean).join(" and ");
  return `Nothing new to import. The link has ${count(plan.found, "event")}: ${why}.`;
}

/** What the sheet says when the link could not be read. */
export function icsFailure(error: unknown): string {
  const reason = error instanceof Error && error.message ? error.message : "";
  return `Import failed. Your calendar could not be read${reason ? ` (${reason})` : ""}. Check the link and try again.`;
}

/** Under "Import complete.": how many came in, and how many did not (over, already there, or beyond the limit). */
export function icsResultLine(plan: Pick<IcsImportPlan, "names" | "leftOut"> & Partial<Pick<IcsImportPlan, "past" | "already">>): string {
  const imported = `${count(plan.names.length, "event")} imported`;
  const skipped = [
    plan.already ? `${count(plan.already, "event")} already in your plan ${plan.already === 1 ? "was" : "were"} skipped.` : "",
    plan.past ? `${count(plan.past, "past event")} ${plan.past === 1 ? "was" : "were"} left out.` : "",
    plan.leftOut > 0 ? `${count(plan.leftOut, "more event")} ${plan.leftOut === 1 ? "was" : "were"} left out: ${ICS_MAX_EVENTS} come in at once.` : "",
  ].filter(Boolean);
  return skipped.length > 0 ? `${imported}. ${skipped.join(" ")}` : imported;
}

// ── Google Calendar (a connection made before) ────────────────────────────────

/** "Just now", "12m ago", "3h ago", then the date; "Never" when it has not synced. */
export function lastSyncLabel(iso: string | null, now: Date): string {
  const then = iso ? new Date(iso).getTime() : NaN;
  if (!Number.isFinite(then)) return "Never";
  const minutes = Math.floor((now.getTime() - then) / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(then).toLocaleDateString();
}

/** The connection's row: its state as the label, and when it last synced (and that it is live) under it. */
export function googleConnectionRow(input: { loading: boolean; connected: boolean; channelActive: boolean; lastSync: string | null; now: Date }): { label: string; detail: string } {
  if (input.loading) return { label: "Checking...", detail: "" };
  if (!input.connected) return { label: "Not connected", detail: "" };
  return { label: "Connected", detail: [`Last synced: ${lastSyncLabel(input.lastSync, input.now)}`, input.channelActive ? "Live" : ""].filter(Boolean).join(" · ") };
}

/** Under the connection's row: what the events do in the plan, and what disconnecting removes. */
export function googleNote(input: { connected: boolean; events: number }): string {
  return input.connected
    ? `${count(input.events, "Google event")} ${input.events === 1 ? "blocks" : "block"} time in your plan. Trajectory only reads them, and disconnecting removes them from Trajectory and from our server.`
    : "Your Google events block time in the plan. Trajectory only reads them, never changes them.";
}

/**
 * Why "Sync now" is off, in the words shown over it; "" when it can be pressed or the row already says why
 * ("Checking..."). The server answers "not connected" both when the connection is gone and when it cannot be reached.
 */
export function googleSyncBlocked(input: { loading: boolean; connected: boolean }): string {
  return input.loading || input.connected ? "" : "The connection could not be confirmed, so there is nothing to sync right now.";
}

/** After "Sync now": how many events came in, or that it did not work (null = the server did not answer). */
export function googleSyncResult(synced: number | null): StatusLine {
  return synced === null
    ? { text: "The sync did not go through. Check your connection and try again.", tone: "red" }
    : { text: `Sync complete. ${count(synced, "event")} synced from Google Calendar.`, tone: "quiet" };
}

/** Disconnecting asks first, on the page. */
export const GOOGLE_DISCONNECT_QUESTION = "Disconnect Google Calendar? This removes all synced events from Trajectory. Your Google Calendar is not affected.";
export const GOOGLE_NOT_STARTED = "Google Calendar could not be started. Please try again.";
export const GOOGLE_SIGN_IN_FAILED = "Google sign-in could not be opened. Please try again.";

/** How connecting works, shown only while connecting is offered and nothing is connected yet. */
export const GOOGLE_HOW_IT_WORKS: readonly { icon: "calSync" | "bolt" | "arrow" | "lock"; title: string; detail: string }[] = [
  { icon: "calSync", title: "Connect once", detail: "Sign in with Google. It takes about 30 seconds" },
  { icon: "bolt", title: "Stays in sync", detail: "New Google events show up the next time you open Trajectory" },
  { icon: "arrow", title: "One way", detail: "From Google to Trajectory. Your Trajectory schedule stays separate" },
  { icon: "lock", title: "Read only", detail: "Trajectory only reads your calendar, never changes it" },
];

// ── What the browser adds ─────────────────────────────────────────────────────

/** The row that saves the plan as a calendar file (the same words as the row in Settings). */
export const CALENDAR_FILE_DETAIL = "Every class, session and deadline as an .ics file for Google, Apple or Outlook";
/** Said on the page once the file was handed to the browser. */
export const CALENDAR_FILE_SAVED = "Your plan was saved as a calendar file. Open it in Google Calendar, Apple Calendar or Outlook to add it there.";

/**
 * A browser may only read a calendar link whose server allows web pages to (CORS). Google Calendar's secret address
 * does not, so the fetch fails before any answer arrives (a TypeError, not an HTTP status). Said as what it is, with
 * the way that works, instead of "(Failed to fetch)".
 */
export const ICS_BROWSER_BLOCKED = "Import failed. This calendar service does not let web browsers read the link. The iPhone app can import it; here, save the calendar as an .ics file and import that instead.";

/** What the sheet says when the link could not be read from this browser: blocked for browsers, or any other failure. */
export function icsImportFailure(error: unknown): string {
  return error instanceof TypeError ? ICS_BROWSER_BLOCKED : icsFailure(error);
}
