/**
 * The imported syllabi (app/syllabus-history.tsx), as pure functions: what an import's row says, what its sheet says
 * it added, and the words of its two questions ("Undo this import", "Remove from this list, keep the tasks").
 * Nothing here says more than the import's own record holds: an import that kept no record of what it made cannot
 * be undone and says so, and one whose text was not kept says Ask AI cannot read it.
 */
import { classScheduleLine, syllabusReadableByAi } from "./classes-view";
import type { ClassBlock, SyllabusImport } from "./types";

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "Aug 22", or "" for a date that cannot be read. */
function dayOf(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** "2:00 PM" (written out here: the system's own time format puts a narrow space before AM / PM on some iPhones). */
function clockOf(date: Date): string {
  const hour = date.getHours();
  return `${hour % 12 || 12}:${String(date.getMinutes()).padStart(2, "0")} ${hour >= 12 ? "PM" : "AM"}`;
}

/** "Added Aug 22 · 44 tasks": the quiet line of an import's row. */
export function importRowLine(entry: Pick<SyllabusImport, "importedAt" | "itemCount">): string {
  const day = dayOf(entry.importedAt);
  const tasks = count(entry.itemCount, "task");
  return day ? `Added ${day} · ${tasks}` : tasks;
}

/**
 * True when a later import of the same class kept its text: Ask AI reads that one, so an older copy without its text
 * needs nothing done about it.
 */
export function hasNewerReadableImport(entry: Pick<SyllabusImport, "id" | "linkedClassId" | "importedAt">, imports: readonly Pick<SyllabusImport, "id" | "linkedClassId" | "importedAt" | "rawText">[]): boolean {
  return imports.some((other) => other.id !== entry.id && other.linkedClassId === entry.linkedClassId && other.importedAt > entry.importedAt && syllabusReadableByAi(other));
}

/**
 * What an import's row flags on the list, in gold: "Ask AI can't read it", "Its class has no days yet", both, or ""
 * when it needs nothing.
 */
export function importRowFlag(view: Pick<ImportSheetView, "aiReadable" | "aiSuperseded" | "openClass">): string {
  const flags = [!view.aiReadable && !view.aiSuperseded ? "Ask AI can't read it" : "", view.openClass?.missing ? "Its class has no days yet" : ""].filter(Boolean);
  return flags.join(" · ");
}

/** "Syllabus · added Aug 22, 2:00 PM": the line over the sheet's title. The year is said when it is not this one. */
export function importAddedLine(entry: Pick<SyllabusImport, "importedAt">, now: Date = new Date()): string {
  const date = new Date(entry.importedAt);
  if (Number.isNaN(date.getTime())) return "Syllabus";
  const year = date.getFullYear() === now.getFullYear() ? "" : ` ${date.getFullYear()}`;
  return `Syllabus · added ${dayOf(entry.importedAt)}${year}, ${clockOf(date)}`;
}

type ImportEntry = Pick<
  SyllabusImport,
  "importedAt" | "courseName" | "linkedClassName" | "itemCount" | "skippedCount" | "isNewClass" | "rawText" | "createdTaskIds" | "excludedCount" | "strategyUnavailable"
>;
type LinkedClass = Pick<ClassBlock, "days" | "startTime" | "endTime" | "isAsynchronous">;

export interface ImportSheetView {
  /** "Syllabus · added Aug 22, 2:00 PM" */
  addedLine: string;
  /** "44 tasks added" */
  added: string;
  /** Under it, one line each: what was skipped or left out, and that default study sessions were used. */
  addedDetails: string[];
  /** "Made a new class", or "Added to a class you already had". */
  classLine: string;
  /** Under it: when the class meets (or that it is gone), and the name the syllabus gave it when that differs. */
  classDetails: string[];
  /** Can Ask AI read this syllabus? When it cannot, the row is gold and "Add it again" is the fix. */
  aiReadable: boolean;
  aiLine: string;
  aiDetail: string;
  /** Its text was not kept, but a later import of the same class is the one Ask AI reads: nothing to fix. */
  aiSuperseded: boolean;
  /** "Open the class": null once the class is no longer in the plan. `missing` = it has no class days yet. */
  openClass: { detail: string; missing: boolean } | null;
  /** "Add it again": `missing` = adding it again is what makes it readable by Ask AI. */
  addAgain: { detail: string; missing: boolean };
  /** "Undo this import": the line under the button and the question it turns into. Null when it cannot be undone. */
  undo: { caption: string; question: string } | null;
  /** Why there is no undo, when there is none. */
  undoUnavailable: string;
  /** "Remove from this list, keep the tasks": the question it turns into. */
  removeQuestion: string;
}

/** Everything the sheet of one import says. `linkedClass` is the class it belongs to, when that is still in the plan. */
export function importSheetView(entry: ImportEntry, linkedClass: LinkedClass | undefined, now: Date = new Date(), opts: { newerReadable?: boolean } = {}): ImportSheetView {
  const skipped = entry.skippedCount > 0 ? `${count(entry.skippedCount, "duplicate")} skipped` : "";
  const excluded = (entry.excludedCount ?? 0) > 0 ? `${entry.excludedCount} left out (no date, already past or unchecked)` : "";
  const counts = [skipped, excluded].filter(Boolean).join(" · ");
  const strategy = entry.strategyUnavailable ? "Default study sessions were used (the AI strategist was unavailable)." : "";

  const extractedName = typeof entry.courseName === "string" ? entry.courseName.trim() : "";
  const extracted = extractedName && extractedName !== entry.linkedClassName ? `Extracted as: ${extractedName}` : "";
  const meets = linkedClass ? classScheduleLine(linkedClass) : "That class is no longer in your plan";

  const aiReadable = syllabusReadableByAi(entry);
  // A class the import made that still has no days to meet on (and is not one without a set time) needs them.
  const needsDays = Boolean(linkedClass) && entry.isNewClass && !linkedClass?.isAsynchronous && !linkedClass?.days?.length;

  // Imports made before undo existed carry no record of what they created, so they cannot be undone exactly.
  const canUndo = entry.createdTaskIds !== undefined;
  const created = entry.createdTaskIds?.length ?? 0;
  const createdTasks = count(created, "task");
  // What undo takes away, as the import made it: tasks (with their sessions), the class, both, or neither.
  // "1 task and its study sessions", "44 tasks and their study sessions"; with the class, there are always several.
  const whose = created === 1 && !entry.isNewClass ? "its" : "their";
  const made = [created > 0 ? createdTasks : "", entry.isNewClass ? "the class it made" : ""].filter(Boolean).join(", ");
  const withSessions = created > 0 ? ` and ${whose} study sessions` : "";
  const aiSuperseded = !aiReadable && Boolean(opts.newerReadable);

  return {
    addedLine: importAddedLine(entry, now),
    added: `${count(entry.itemCount, "task")} added`,
    addedDetails: [counts, strategy].filter(Boolean),
    classLine: entry.isNewClass ? "Made a new class" : "Added to a class you already had",
    classDetails: [meets, extracted].filter(Boolean),
    aiReadable,
    aiSuperseded,
    aiLine: aiReadable ? "Ask AI can read it" : aiSuperseded ? "Ask AI reads the newer copy" : "Ask AI can't read this one",
    aiDetail: aiReadable ? "" : aiSuperseded ? "This copy's text was not kept; the one you added later is the one it reads." : "Its text was not kept. Add it again to fix that.",
    openClass: linkedClass ? { detail: needsDays ? "It has no class days yet" : "", missing: needsDays } : null,
    addAgain: { detail: aiReadable || aiSuperseded ? "When the syllabus has changed" : "So Ask AI can read it", missing: !aiReadable && !aiSuperseded },
    undo: canUndo
      ? {
          // The same facts as the question it turns into: an import that made its class takes the class out too.
          caption: made ? `Undo takes ${created > 0 ? "its " : ""}${made}${withSessions} out of your plan. It asks first.` : "Undo puts back what this import changed. It asks first.",
          question: made ? `Undo this import? This removes ${created > 0 ? "the " : ""}${made}${withSessions}. Anything the import changed goes back to how it was.` : "Undo this import? Anything it changed goes back to how it was.",
        }
      : null,
    undoUnavailable: canUndo ? "" : "This import kept no record of what it added, so it cannot be undone.",
    removeQuestion: [
      `Remove "${entry.linkedClassName}" from this list? Its tasks stay in your plan.`,
      canUndo ? 'To take them out, use "Undo this import" instead.' : "",
      aiReadable ? "Its text goes too, so Ask AI and study guides can no longer use it." : "",
    ]
      .filter(Boolean)
      .join(" "),
  };
}
