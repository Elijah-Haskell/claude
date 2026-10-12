/**
 * The plan review sheet (components/plan-review-sheet.tsx), as pure functions: for each thing the plan status lists
 * (lib/plan-alerts.ts planStatusFor), the buttons that fix it, what each says, and whether it works in place or
 * closes the sheet first. The status itself (headline, counts, items) is lib/plan-alerts.ts; nothing is recomputed.
 */
import type { PlanStatus, PlanStatusItem } from "./plan-alerts";

export type PlanFixAction = "editTask" | "markDone" | "markSkipped" | "catchUp" | "replan" | "viewTasks";

export interface PlanFixButton {
  action: PlanFixAction;
  label: string;
  accessibilityLabel: string;
  /** The task the fix is about (Edit task, Done, Skipped). */
  taskId?: string;
  /** Done and Skipped change the list in place; every other fix opens a sheet or a screen, so this one closes first. */
  closesSheet: boolean;
}

/** The main button over the list while the student is behind, and the line under it. */
export const CATCH_UP = {
  label: "Catch up",
  accessibilityLabel: "Catch up: preview replanning the semester around what you missed",
  hint: "Replans the semester around what you missed. You see the preview first.",
} as const;

/**
 * The fix buttons of one item. `catchUpShown`: the "Catch up" button is already over the list, so the missed
 * sessions' row does not repeat it.
 */
export function fixButtons(item: Pick<PlanStatusItem, "title" | "fix">, options: { catchUpShown: boolean }): PlanFixButton[] {
  const fix = item.fix;
  switch (fix.kind) {
    case "editTask":
      return [{ action: "editTask", label: "Edit task", accessibilityLabel: `Edit ${item.title}: move its deadline or trim its estimate`, taskId: fix.taskId, closesSheet: true }];
    case "record":
      return [
        { action: "markDone", label: "Done", accessibilityLabel: `Mark ${item.title} done`, taskId: fix.taskId, closesSheet: false },
        { action: "markSkipped", label: "Skipped", accessibilityLabel: `Mark ${item.title} skipped`, taskId: fix.taskId, closesSheet: false },
      ];
    case "catchUp":
      return options.catchUpShown ? [] : [{ action: "catchUp", label: CATCH_UP.label, accessibilityLabel: "Catch up: preview replanning the semester", closesSheet: true }];
    case "replan":
      return [{ action: "replan", label: "Replan", accessibilityLabel: "Replan the semester: preview it first", closesSheet: true }];
    case "viewTasks":
      return [{ action: "viewTasks", label: "View tasks", accessibilityLabel: "View your tasks", closesSheet: true }];
  }
}

export interface PlanReviewRow {
  key: string;
  kind: PlanStatusItem["kind"];
  title: string;
  detail: string;
  buttons: PlanFixButton[];
}

export interface PlanReview {
  /** Red when the student is behind, gold when something needs a look. */
  tone: "red" | "gold";
  headline: string;
  summary: string;
  /** "Catch up" over the list. */
  catchUp: boolean;
  rows: PlanReviewRow[];
}

/** Everything the sheet shows for a plan status, most urgent first (the status's own order). */
export function planReview(status: Pick<PlanStatus, "severity" | "headline" | "summary" | "items" | "canCatchUp">): PlanReview {
  return {
    tone: status.severity === "critical" ? "red" : "gold",
    headline: status.headline,
    summary: status.summary,
    catchUp: status.canCatchUp,
    rows: status.items.map((item) => ({ key: item.key, kind: item.kind, title: item.title, detail: item.detail, buttons: fixButtons(item, { catchUpShown: status.canCatchUp }) })),
  };
}
