/**
 * The live import, shared by the app and the server (pure, no platform imports).
 *
 * Reading a syllabus takes 25 to 60 seconds. While the model is still writing its answer, the server reads the
 * deliverables that are already complete out of it and reports them with the job's progress (JobProgress in
 * server/extraction-jobs.ts, returned by ai.syllabusExtractionStatus), so the waiting screen fills in as the dates
 * arrive instead of showing a stage alone. The contract the screen can rely on is in docs/live-import.md.
 */
import type { SyllabusItemType } from "../engine/syllabus-extraction-utils";

/** One deliverable as it stood when it was read: a preview, not the result. */
export interface LiveItem {
  name: string;
  type: SyllabusItemType;
  /** "YYYY-MM-DD" as the app would plan it, or null when it has no date yet. */
  date: string | null;
}

/** The longest name a live item carries. */
export const LIVE_ITEM_NAME_MAX = 200;

/** The most items a live list carries. The reading's result is not cut to this. */
export const LIVE_ITEMS_MAX = 400;
