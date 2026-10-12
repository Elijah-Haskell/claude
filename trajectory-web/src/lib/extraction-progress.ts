import type { JobPollProgress } from "../engine/poll-job";

/**
 * Honest expectation-setting while the model reads a syllabus (picture pages are the slow part). When the
 * server reports where the job is (`progress`), that wins over the time-based guess.
 */
export function extractionProgressCopy(
  elapsedMs: number,
  isPastedText: boolean,
  progress?: JobPollProgress | null,
  reconnecting = false,
): string {
  if (reconnecting) return "The connection dropped. Your syllabus is still being read on the server; reconnecting…";
  const found = progress?.itemsFound;
  if (progress?.stage === "reading-more" && found) return `Found ${found} deliverable${found === 1 ? "" : "s"} so far. Reading the rest of the schedule.`;
  if (progress?.stage === "second-look") return "The first read was not usable, so a second, slower model is taking a look.";
  if (progress?.stage === "finishing" && found) return `Found ${found} deliverable${found === 1 ? "" : "s"}. Saving the syllabus text for the AI chat.`;
  if (isPastedText) return "Finding class times, term dates, exams and deadlines.";
  if (elapsedMs < 45_000) return "Finding class times, term dates, exams and deadlines. Schedules saved as pictures take longer to read: usually 1–3 minutes.";
  if (elapsedMs < 150_000) return "Still reading. Pages that are pictures (like a semester schedule table) take longest. You can switch to another app: the server keeps reading and the result is picked up when you come back.";
  return "Taking longer than usual. The server keeps working in the background; if this fails you can retry or paste the text.";
}

export function formatElapsed(ms: number): string {
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}m ${String(s).padStart(2, "0")}s` : `${s}s`;
}
