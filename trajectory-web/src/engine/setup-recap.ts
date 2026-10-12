/**
 * What Today shows once a syllabus has been planned, as pure functions (app/(tabs)/index.tsx):
 *  - the green card ("Your semester is planned · 33 deadlines across 11 weeks. Here is today."), on the day of the
 *    import only, with what was left out and the way to undo it;
 *  - "Make it fit your life": the three things that make a plan fit a real week (work and activities, the iPhone's
 *    calendars, a course site's feed), each ticked once it is set up, until all are done or the student hides it.
 * The import writes the recap (app/syllabus-upload.tsx); both keys are erased with the rest at sign-out.
 */
import { daysBetweenKeys, weekStartKeyOf } from "./utils";

export const SETUP_RECAP_KEY = "@trajectory/setupRecap";
export const SETUP_LIST_HIDDEN_KEY = "@trajectory/setupListHidden";

export interface SetupRecap {
  importId: string;
  /** The day the import was planned ("YYYY-MM-DD"): the card is shown on that day only. */
  day: string;
  courseLabel: string;
  /** The first syllabus this student has planned. */
  first: boolean;
  /** Dated items that went into the plan (added, or replaced on request). */
  deadlines: number;
  /** Weeks from the week of `day` through the week of the last of those deadlines (0 with no deadlines). */
  weeks: number;
  /** Study minutes the planner could place for them; null when that could not be worked out. */
  plannedMinutes: number | null;
  /** Items left out because the syllabus gave them no date. */
  needDate: number;
  /** Items that matched something already in the plan and were kept as they were. */
  kept: number;
  /** Items already in the plan that the student chose to replace. */
  replaced: number;
  /** The days, times or room of a class the student already had were changed by this import. */
  classUpdated: boolean;
  /** The AI that suggests how to split the study time could not be reached: the usual session plans were used. */
  defaultSessions: boolean;
  /** Up to two remarks from that AI about the plan ("Exam 2 and the project fall in the same week"). */
  notes: string[];
}

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

export function buildSetupRecap(input: {
  importId: string;
  day: string;
  courseLabel: string;
  first: boolean;
  /** Due dates of the items that went into the plan. */
  dueDates: readonly string[];
  plannedMinutes: number | null;
  needDate: number;
  kept?: number;
  replaced?: number;
  classUpdated?: boolean;
  defaultSessions?: boolean;
  notes?: readonly string[];
}): SetupRecap {
  const dated = input.dueDates.filter((key) => DATE_KEY.test(key));
  const last = dated.reduce((latest, key) => (key > latest ? key : latest), "");
  const weeks = last && last >= input.day ? Math.floor(daysBetweenKeys(weekStartKeyOf(input.day), weekStartKeyOf(last)) / 7) + 1 : dated.length > 0 ? 1 : 0;
  return {
    importId: input.importId,
    day: input.day,
    courseLabel: input.courseLabel,
    first: input.first,
    deadlines: dated.length,
    weeks,
    plannedMinutes: input.plannedMinutes === null ? null : Math.max(0, Math.round(input.plannedMinutes)),
    needDate: Math.max(0, input.needDate),
    kept: Math.max(0, input.kept ?? 0),
    replaced: Math.max(0, input.replaced ?? 0),
    classUpdated: input.classUpdated === true,
    defaultSessions: input.defaultSessions === true,
    notes: (input.notes ?? []).map((note) => note.trim()).filter(Boolean).slice(0, 2),
  };
}

/** What is stored, read back. Anything that is not a recap reads as none. */
export function parseSetupRecap(raw: string | null | undefined): SetupRecap | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<SetupRecap> | null;
    if (!value || typeof value.importId !== "string" || !value.importId || typeof value.day !== "string" || !DATE_KEY.test(value.day)) return null;
    const number = (n: unknown) => (typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.round(n) : 0);
    return {
      importId: value.importId,
      day: value.day,
      courseLabel: typeof value.courseLabel === "string" ? value.courseLabel : "",
      first: value.first === true,
      deadlines: number(value.deadlines),
      weeks: number(value.weeks),
      plannedMinutes: value.plannedMinutes === null || value.plannedMinutes === undefined ? null : number(value.plannedMinutes),
      needDate: number(value.needDate),
      kept: number(value.kept),
      replaced: number(value.replaced),
      classUpdated: value.classUpdated === true,
      defaultSessions: value.defaultSessions === true,
      notes: Array.isArray(value.notes) ? value.notes.filter((note): note is string => typeof note === "string" && note.trim() !== "").slice(0, 2) : [],
    };
  } catch {
    return null;
  }
}

/** The card is for the day of the import, and only while that import is still in the plan (it can be undone). */
export function recapIsCurrent(recap: SetupRecap | null, input: { today: string; importIds: readonly string[] }): recap is SetupRecap {
  return recap !== null && recap.day === input.today && input.importIds.includes(recap.importId);
}

/** "Your semester is planned" only when study time really was placed; otherwise the plain "Added to your plan". */
export function recapTitle(recap: SetupRecap): string {
  return recap.first && recap.deadlines > 0 && recap.plannedMinutes !== 0 ? "Your semester is planned" : "Added to your plan";
}

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "33 deadlines across 11 weeks. Here is today." For a later class the line starts with its name. */
export function recapLine(recap: SetupRecap): string {
  const lead = recap.first || !recap.courseLabel ? "" : `${recap.courseLabel}: `;
  if (recap.deadlines === 0) return `${lead}${lead ? "e" : "E"}verything in it was already in your plan.`;
  const spread = `${count(recap.deadlines, "deadline")} across ${count(Math.max(1, recap.weeks), "week")}.`;
  if (recap.plannedMinutes === 0) return `${lead}${spread} No study time could be placed yet.`;
  return recap.first ? `${spread} Here is today.` : `${lead}${spread}`;
}

/** The quiet second line, when items were left out for want of a date; "" otherwise. */
export function recapLeftOutLine(recap: SetupRecap): string {
  if (recap.needDate === 0) return "";
  const one = recap.needDate === 1;
  return `${count(recap.needDate, "item")} had no date and ${one ? "was" : "were"} left out. Add ${one ? "it" : "them"} with the + button when you know the date.`;
}

/**
 * The quiet lines under the main one, each only when it applies: what was left out, what was already there, a
 * class whose times changed, and the session plans falling back to the usual ones. The AI's own remarks are kept
 * folded under recapNotesLabel: they can run long, and the card's job is the one line above them.
 */
export function recapDetailLines(recap: SetupRecap): string[] {
  const lines: string[] = [];
  const leftOut = recapLeftOutLine(recap);
  if (leftOut) lines.push(leftOut);
  if (recap.deadlines > 0 && (recap.kept > 0 || recap.replaced > 0)) {
    const parts = [];
    if (recap.kept > 0) parts.push(`${recap.kept} ${recap.kept === 1 ? "was" : "were"} already in your plan and ${recap.kept === 1 ? "was" : "were"} kept`);
    if (recap.replaced > 0) parts.push(`${recap.replaced} ${recap.replaced === 1 ? "was" : "were"} replaced`);
    lines.push(`${parts.join(", ")}.`);
  }
  if (recap.classUpdated) lines.push("The class's days and times were updated.");
  if (recap.defaultSessions) lines.push("The AI that suggests how to split study time wasn't available, so the usual session plans were used. Your plan is complete either way.");
  return lines;
}

/** "2 notes from the AI planner": the link that unfolds recap.notes; "" when there are none. */
export function recapNotesLabel(recap: SetupRecap): string {
  return recap.notes.length === 0 ? "" : `${count(recap.notes.length, "note")} from the AI planner`;
}

// ── Make it fit your life ─────────────────────────────────────────────────────

export type SetupItemKey = "commitments" | "calendars" | "feeds";

export interface SetupItem {
  key: SetupItemKey;
  icon: "work" | "cal" | "link";
  title: string;
  sub: string;
  done: boolean;
}

/**
 * The rows, in the mockup's order. The iPhone's calendars are only offered where they can be read (not in the
 * browser preview). A row that is set up stays in the list, ticked, with what was set up as its second line.
 */
export function setupChecklist(input: { recurringEvents: number; calendarsSupported: boolean; calendarsOn: boolean; feeds: number }): SetupItem[] {
  const items: SetupItem[] = [
    {
      key: "commitments",
      icon: "work",
      title: "Add work and activities",
      sub: input.recurringEvents > 0 ? `${input.recurringEvents} every week. Nothing is planned over them` : "So nothing is planned over a shift",
      done: input.recurringEvents > 0,
    },
  ];
  if (input.calendarsSupported) {
    items.push({
      key: "calendars",
      icon: "cal",
      title: "Use my iPhone calendars",
      sub: input.calendarsOn ? "On. Study time avoids your events" : "Plan around what is already on your phone",
      done: input.calendarsOn,
    });
  }
  items.push({
    key: "feeds",
    icon: "link",
    title: "Link Canvas or Blackboard",
    sub: input.feeds > 0 ? `${count(input.feeds, "feed")} linked. Due dates stay up to date` : "Keeps due dates up to date",
    done: input.feeds > 0,
  });
  return items;
}

/** "1 of 3" */
export function setupProgress(items: readonly SetupItem[]): string {
  return `${items.filter((item) => item.done).length} of ${items.length}`;
}

/**
 * Whether Today shows the list: the student has a plan to fit (a class or a task), has not hidden it, and has
 * something left to set up.
 */
export function showsSetupList(input: { items: readonly SetupItem[]; hidden: boolean; hasPlan: boolean }): boolean {
  return input.hasPlan && !input.hidden && input.items.some((item) => !item.done);
}
