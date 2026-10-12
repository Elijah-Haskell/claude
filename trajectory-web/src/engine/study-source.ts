/**
 * What "Study materials" are built from: an already-imported syllabus (SyllabusImport history) or text
 * the student pastes. There is no second upload pipeline; the ONE syllabus import is
 * app/syllabus-upload.tsx. SyllabusImport is being extended by another workstream, so everything here
 * reads it defensively (unknown shapes, missing fields, non-string text).
 */
import type { SyllabusStudyGuide, SyllabusTopic } from "./types";
import { STUDY_TEXT_LIMIT, prepareStudyText, truncationNotice, type PreparedText } from "./study-text";

export type StudySourceKind = "syllabus_text" | "deadlines_only" | "none";

export interface StudySource {
  id: string;
  /** Best display name for the course. */
  title: string;
  importedAt: string;
  kind: StudySourceKind;
  /** Characters of full syllabus text stored with the import (0 when none). */
  chars: number;
  itemCount: number;
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

interface ImportItemLike {
  name: string;
  type: string;
  dueDate: string;
}

function itemsOf(imp: Record<string, unknown>): ImportItemLike[] {
  if (!Array.isArray(imp.extractedItems)) return [];
  const out: ImportItemLike[] = [];
  for (const candidate of imp.extractedItems) {
    if (!candidate || typeof candidate !== "object") continue;
    const item = candidate as Record<string, unknown>;
    const name = str(item.name);
    if (!name) continue;
    out.push({ name, type: str(item.type) || "assignment", dueDate: str(item.dueDate) });
  }
  return out;
}

function classify(imp: Record<string, unknown>): { kind: StudySourceKind; chars: number; itemCount: number } {
  const raw = str(imp.rawText);
  const items = itemsOf(imp);
  if (raw.length >= 40) return { kind: "syllabus_text", chars: raw.length, itemCount: items.length };
  if (items.length > 0) return { kind: "deadlines_only", chars: 0, itemCount: items.length };
  return { kind: "none", chars: 0, itemCount: 0 };
}

function titleOf(imp: Record<string, unknown>): string {
  return str(imp.linkedClassName) || str(imp.courseName) || "Imported syllabus";
}

/** Imported syllabi the student can build study materials from, newest first. Bad entries are skipped. */
export function listStudySources(imports: unknown): StudySource[] {
  if (!Array.isArray(imports)) return [];
  const sources: StudySource[] = [];
  for (const candidate of imports) {
    if (!candidate || typeof candidate !== "object") continue;
    const imp = candidate as Record<string, unknown>;
    const id = str(imp.id);
    if (!id) continue;
    const { kind, chars, itemCount } = classify(imp);
    sources.push({ id, title: titleOf(imp), importedAt: str(imp.importedAt), kind, chars, itemCount });
  }
  return sources.sort((a, b) => b.importedAt.localeCompare(a.importedAt));
}

export interface BuiltSource {
  kind: StudySourceKind | "pasted_text";
  /** Text to send to the AI (already cut to the limit). */
  text: string;
  prep: PreparedText;
  /** Shown when only part of the text is used; null when everything is. */
  truncationNotice: string | null;
  /** Shown when the source is thinner than a full syllabus (deadline list only). */
  caveat: string | null;
  title: string;
}

/** The AI input for one imported syllabus, or null when the import holds nothing to build from. */
export function buildImportSource(imports: unknown, importId: string): BuiltSource | null {
  if (!Array.isArray(imports)) return null;
  const found = imports.find((c) => c && typeof c === "object" && str((c as Record<string, unknown>).id) === importId) as
    | Record<string, unknown>
    | undefined;
  if (!found) return null;
  const { kind } = classify(found);
  const title = titleOf(found);
  if (kind === "none") return null;

  if (kind === "syllabus_text") {
    const prep = prepareStudyText(str(found.rawText));
    return { kind, text: prep.text, prep, truncationNotice: truncationNotice(prep, "syllabus"), caveat: null, title };
  }

  const items = itemsOf(found);
  const description = str(found.courseDescription);
  const lines = [
    `Course: ${str(found.courseName) || title}`,
    description && description !== str(found.courseName) ? `Description: ${description}` : "",
    "Assignments, exams and quizzes listed in the syllabus:",
    ...items.map((item) => `- ${item.name} (${item.type})${item.dueDate ? `, due ${item.dueDate}` : ""}`),
  ].filter(Boolean);
  const prep = prepareStudyText(lines.join("\n"));
  return {
    kind,
    text: prep.text,
    prep,
    truncationNotice: truncationNotice(prep, "syllabus"),
    caveat: "The full syllabus text wasn't saved with this import, so this guide is built from its deadline list only. Topics may be thin. Paste the syllabus text for a fuller guide.",
    title,
  };
}

/** Pasted text as an AI input; null when it is too short to be a syllabus. */
export function buildPastedSource(pasted: string): BuiltSource | null {
  const prep = prepareStudyText(pasted);
  if (prep.text.length < 40) return null;
  return { kind: "pasted_text", text: prep.text, prep, truncationNotice: truncationNotice(prep, "text"), caveat: null, title: "Pasted text" };
}

/** The text a practice exam is generated from: the guide itself (its topics), never a claim about the raw syllabus. */
export function guideTextForExam(guide: Pick<SyllabusStudyGuide, "courseTitle" | "overview" | "topics">): string {
  const topics: SyllabusTopic[] = Array.isArray(guide.topics) ? guide.topics : [];
  const text = `Course: ${guide.courseTitle}\n\nOverview: ${guide.overview}\n\nTopics:\n${topics
    .map((t) => `${t.title}${t.week ? ` (${t.week})` : ""}: ${t.description}\nKey terms: ${(t.keyTerms ?? []).join(", ")}`)
    .join("\n\n")}`;
  return prepareStudyText(text, STUDY_TEXT_LIMIT).text;
}

/** Fields recorded on a guide about what it was built from (spread into the SyllabusStudyGuide). */
export function guideProvenance(source: BuiltSource, importId?: string): Pick<
  SyllabusStudyGuide,
  "sourceImportId" | "sourceKind" | "sourceTruncated" | "sourceChars" | "sourceUsedChars"
> {
  return {
    sourceImportId: importId,
    sourceKind: source.kind === "none" ? undefined : source.kind,
    sourceTruncated: source.prep.truncated || undefined,
    sourceChars: source.prep.originalChars,
    sourceUsedChars: source.prep.usedChars,
  };
}

/** One-line description of what a saved guide was built from, for the guide screen. */
export function describeGuideSource(guide: Pick<SyllabusStudyGuide, "sourceKind" | "sourceTruncated" | "syllabusFileName">): string | null {
  if (guide.sourceKind === "deadlines_only") return "Built from your syllabus deadline list only (the full text wasn't available).";
  if (guide.sourceKind === "pasted_text") return "Built from text you pasted.";
  if (guide.sourceKind === "syllabus_text") return "Built from your imported syllabus.";
  if (guide.syllabusFileName) return `Built from ${guide.syllabusFileName}.`;
  return null;
}
