/**
 * What the student types into "Create exam prep" (pure): topic lines, the exam date advice, and the
 * honest local fallback outline built ONLY from the student's own notes when the AI has not (yet)
 * produced study content. Nothing here invents study material.
 */
import type { ExamStudyGuide, ExamTopic } from "./types";
import { examTiming } from "./exam-runway";

export const MAX_EXAM_TOPICS = 40;
const MAX_TOPIC_CHARS = 120;

/** One topic per line; strips bullets/numbering, trims, drops blanks and case-insensitive duplicates, caps count and length. */
export function parseTopicLines(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    const cleaned = line
      .replace(/^\s*(?:[-*•–—]|\d{1,2}[.)])\s+/, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, MAX_TOPIC_CHARS)
      .trim();
    const key = cleaned.toLowerCase();
    if (!cleaned || seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
    if (out.length >= MAX_EXAM_TOPICS) break;
  }
  return out;
}

export interface ExamDateAdvice {
  level: "ok" | "info" | "blocked";
  message: string;
}

/** Feedback about a chosen exam date, shown before the exam is created. */
export function examDateAdvice(examDate: string, todayKey: string): ExamDateAdvice {
  const timing = examTiming(examDate, todayKey);
  if (timing.status === "invalid") return { level: "blocked", message: "Pick a valid exam date." };
  if (timing.status === "past") return { level: "blocked", message: "That date has already passed. Pick today or a later day." };
  if (timing.status === "today") {
    return { level: "info", message: "The exam is today. You can still use the study guide and quiz, but Trajectory can't plan study time ahead of it." };
  }
  if (timing.daysLeft > 14) {
    return { level: "info", message: "Study sessions are planned starting two weeks before the exam." };
  }
  return { level: "ok", message: "" };
}

/**
 * Definitions and flashcards taken directly from "term: definition" / "term - definition" / "term = definition"
 * lines in the student's own notes. No template questions, nothing invented. Marked aiGenerated: false.
 */
export function buildNotesOutline(rawInput: string, topics: Pick<ExamTopic, "title">[]): ExamStudyGuide {
  const importantDefinitions: ExamStudyGuide["importantDefinitions"] = [];
  const flashcards: ExamStudyGuide["flashcards"] = [];
  const seen = new Set<string>();

  for (const line of rawInput.replace(/\r\n?/g, "\n").split("\n")) {
    const parts = line.split(/\s*:\s+|\s+-\s+|\s+=\s+/).map((p) => p.trim());
    if (parts.length < 2) continue;
    const term = parts[0]!;
    const definition = parts.slice(1).join(": ");
    if (term.length < 2 || term.length > 80 || definition.length < 8 || definition.length > 600) continue;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    importantDefinitions.push({ term, definition });
    flashcards.push({ front: `What is "${term}"?`, back: definition });
    if (importantDefinitions.length >= 40) break;
  }

  return {
    keyConcepts: topics.map((t) => t.title),
    importantDefinitions,
    practiceQuestions: [],
    flashcards,
    aiGenerated: false,
  };
}
