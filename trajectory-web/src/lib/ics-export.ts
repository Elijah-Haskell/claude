// The plan as a calendar file (.ics) for Google Calendar, Apple Calendar or Outlook: every class meeting, study
// session and commitment on the calendar from today on, plus each open deadline as an all-day event. Pure, so it is
// unit-tested (tests/web/ics-export.test.ts).

import type { AppState, ScheduleBlock, Task } from "../engine/types";
import { addDaysToKey } from "../engine/utils";
import { showsOnWeekGrid } from "../engine/week-layout";

const PRODID = "-//Trajectory//Trajectory Web//EN";

/** iCalendar text: backslashes, commas and semicolons escaped, line breaks as "\n". */
export function escapeIcsText(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\r?\n/g, "\\n").replace(/[,;]/g, (char) => `\\${char}`);
}

/** Lines longer than 75 octets are folded (RFC 5545 §3.1). */
export function foldIcsLine(line: string): string {
  const out: string[] = [];
  let rest = line;
  while (rest.length > 73) {
    out.push(rest.slice(0, 73));
    rest = ` ${rest.slice(73)}`;
  }
  out.push(rest);
  return out.join("\r\n");
}

/** "2026-10-12" + "09:30" -> "20261012T093000" (floating local time, like the plan itself). */
export function icsLocalStamp(dateKey: string, time: string): string {
  return `${dateKey.replace(/-/g, "")}T${time.replace(":", "")}00`;
}

function utcNow(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

export interface IcsExportOptions {
  /** Blocks and deadlines from this day on (default: today). */
  from?: string;
  now?: Date;
  /** Study sessions that are done or skipped are left out unless this is true. */
  includeSettled?: boolean;
}

function blockSummary(block: ScheduleBlock): string {
  if (block.type === "study") return block.title;
  if (block.type === "class") return block.title;
  return block.title;
}

/** Every event of the plan as one VCALENDAR. */
export function buildPlanIcs(state: Pick<AppState, "scheduleBlocks" | "tasks" | "classes">, options: IcsExportOptions = {}): string {
  const now = options.now ?? new Date();
  const from = options.from ?? `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const stamp = utcNow(now);
  const lines: string[] = ["BEGIN:VCALENDAR", "VERSION:2.0", `PRODID:${PRODID}`, "CALSCALE:GREGORIAN", "METHOD:PUBLISH", "X-WR-CALNAME:Trajectory"];

  const blocks = state.scheduleBlocks
    .filter((block) => block.date >= from && showsOnWeekGrid(block))
    .filter((block) => options.includeSettled || block.completionStatus === "pending" || block.type !== "study")
    .sort((a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime));
  for (const block of blocks) {
    const task = block.taskId ? state.tasks.find((candidate) => candidate.id === block.taskId) : undefined;
    const description = [block.type === "study" ? "Study session planned by Trajectory" : block.type === "class" ? "Class" : "Commitment", task ? `For: ${task.name}` : "", block.schedulingReason ?? ""].filter(Boolean).join("\n");
    lines.push(
      "BEGIN:VEVENT",
      `UID:${block.id}@trajectory-web`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${icsLocalStamp(block.date, block.startTime)}`,
      `DTEND:${icsLocalStamp(block.date, block.endTime === "24:00" ? "23:59" : block.endTime)}`,
      `SUMMARY:${escapeIcsText(blockSummary(block))}`,
      `DESCRIPTION:${escapeIcsText(description)}`,
      `CATEGORIES:${block.type === "study" ? "Study" : block.type === "class" ? "Class" : "Commitment"}`,
      "END:VEVENT",
    );
  }

  const deadlines: Task[] = state.tasks.filter((task) => task.status !== "done" && task.status !== "skipped" && /^\d{4}-\d{2}-\d{2}$/.test(task.dueDate) && task.dueDate >= from && !task.id.startsWith("exam-runway-"));
  for (const task of deadlines) {
    const course = task.courseName && task.courseName !== "General" ? `${task.courseName} · ` : "";
    lines.push(
      "BEGIN:VEVENT",
      `UID:due-${task.id}@trajectory-web`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${task.dueDate.replace(/-/g, "")}`,
      `DTEND;VALUE=DATE:${addDaysToKey(task.dueDate, 1).replace(/-/g, "")}`,
      `SUMMARY:${escapeIcsText(`Due: ${course}${task.name}`)}`,
      `DESCRIPTION:${escapeIcsText(task.dueTime ? `Due at ${task.dueTime}` : "Deadline from your Trajectory plan")}`,
      "CATEGORIES:Deadline",
      "END:VEVENT",
    );
  }

  lines.push("END:VCALENDAR");
  return lines.map(foldIcsLine).join("\r\n") + "\r\n";
}

/** Hand the browser a file to save. */
export function downloadTextFile(name: string, text: string, type = "text/plain"): void {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
