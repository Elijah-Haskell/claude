/**
 * The first plan's overlay (components/build-week-overlay.tsx), as pure functions. While the planner runs it says one
 * thing, because one thing is known: the plan is being made. Once it is made, every word comes from the plan that
 * was built (the Week tab counts it): how many blocks, how many things still need a look, four numbers and up to two
 * lines about the week.
 */

export interface BuildWeekResult {
  totalBlocks: number;
  studyBlocks: number;
  studyHours: number;
  classBlocks: number;
  freeBlocks: number;
  tasksScheduled: number;
  peakStudyDay: string;
  /** How many things the plan status lists (lib/plan-alerts.ts planStatusFor): never hidden, never repeated in full. */
  toReview?: number;
}

/** The whole wait: no steps and no progress, because the planner reports none. */
export const BUILD_WAIT_LINE = "Planning your semester";

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export interface BuildWeekDone {
  /** Nothing was there to plan: the title and the line under it say so, and there are no numbers to show. */
  nothingPlanned: boolean;
  title: string;
  subtitle: string;
  /** Green = ready, gold = ready with things to review, quiet = nothing to plan yet. */
  tone: "green" | "gold" | "quiet";
  /** The four numbers of the week on screen (empty when nothing was planned). */
  stats: { key: "studyTime" | "classes" | "studySessions" | "assignments"; value: string; label: string }[];
  /** Up to two lines: the assignments placed this week (and the busiest study day), and the personal events kept. */
  lines: { key: "assignments" | "personal"; strong: string; rest: string }[];
  button: string;
}

export function buildWeekDone(result: BuildWeekResult): BuildWeekDone {
  const nothingPlanned = result.totalBlocks === 0;
  const toReview = result.toReview ?? 0;
  const lines: BuildWeekDone["lines"] = [];
  if (result.tasksScheduled > 0) {
    lines.push({ key: "assignments", strong: count(result.tasksScheduled, "assignment"), rest: ` scheduled this week${result.peakStudyDay ? ` · Busiest study day: ${result.peakStudyDay}` : ""}` });
  }
  if (result.freeBlocks > 0) lines.push({ key: "personal", strong: count(result.freeBlocks, "personal event"), rest: " kept on your calendar" });
  return {
    nothingPlanned,
    title: nothingPlanned ? "Nothing to plan yet" : "Your plan is ready",
    subtitle: nothingPlanned
      ? "Add classes, commitments or a syllabus and Trajectory will fill this in."
      : `${count(result.totalBlocks, "block")} this week${toReview > 0 ? ` · ${toReview} to review` : ""}`,
    tone: toReview > 0 ? "gold" : nothingPlanned ? "quiet" : "green",
    stats: nothingPlanned
      ? []
      : [
          { key: "studyTime", value: `${result.studyHours.toFixed(1)}h`, label: "Study time" },
          { key: "classes", value: String(result.classBlocks), label: "Classes" },
          { key: "studySessions", value: String(result.studyBlocks), label: "Study sessions" },
          { key: "assignments", value: String(result.tasksScheduled), label: "Assignments" },
        ],
    lines,
    button: "View my week",
  };
}
