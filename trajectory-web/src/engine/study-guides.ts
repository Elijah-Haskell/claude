/**
 * Syllabus study guides (pure). Shared by Exam Prep's "Study guides" tab (components/study/study-guides-panel.tsx),
 * which is now the one place study material is built, and by the older Study Materials screen (app/syllabus.tsx).
 */
import type { ExamStudyGuide, SyllabusStudyGuide, SyllabusTopic } from "./types";
import { guideProvenance, type BuiltSource, type StudySource, type StudySourceKind } from "./study-source";
import { formatCount } from "./study-text";

export const STUDY_SOURCE_KIND_LABEL: Record<StudySourceKind, string> = {
  syllabus_text: "Full syllabus text",
  deadlines_only: "Deadline list only",
  none: "Nothing to build from",
};

/** "Full syllabus text · 12,000 characters · 8 deadlines · imported 9/1/2030" for a source row. */
export function describeStudySourceRow(source: StudySource): string {
  const imported = source.importedAt ? new Date(source.importedAt) : null;
  return [
    STUDY_SOURCE_KIND_LABEL[source.kind],
    source.kind === "syllabus_text" ? `${formatCount(source.chars)} characters` : "",
    source.itemCount > 0 ? `${source.itemCount} deadline${source.itemCount === 1 ? "" : "s"}` : "",
    imported && !Number.isNaN(imported.getTime()) ? `imported ${imported.toLocaleDateString()}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * The course name for a new guide: what the student typed, else (for an imported syllabus) the import's
 * course title. Pasted text without a typed name has none.
 */
export function guideCourseName(typed: string, source: Pick<BuiltSource, "title">, importId?: string): string | undefined {
  return typed.trim() || (importId ? source.title : undefined) || undefined;
}

/** What ai.analyzeSyllabus returns (the fields a guide keeps). */
export interface SyllabusAnalysis {
  courseTitle: string;
  examDate?: string | null;
  overview: string;
  topics: SyllabusTopic[];
  studyTips: string[];
}

/** A saved SyllabusStudyGuide from the AI analysis plus a record of what it was built from. */
export function studyGuideFromAnalysis(
  analysis: SyllabusAnalysis,
  input: { id: string; now: Date; typedCourseName: string; source: BuiltSource; importId?: string },
): SyllabusStudyGuide {
  return {
    id: input.id,
    courseTitle: analysis.courseTitle,
    courseName: guideCourseName(input.typedCourseName, input.source, input.importId),
    examDate: analysis.examDate || undefined,
    overview: analysis.overview,
    topics: analysis.topics,
    studyTips: analysis.studyTips,
    createdAt: input.now.toISOString(),
    ...guideProvenance(input.source, input.importId),
  };
}

/** Saved guides newest first (bad entries skipped). */
export function sortGuidesNewestFirst(guides: readonly SyllabusStudyGuide[] | undefined | null): SyllabusStudyGuide[] {
  return (Array.isArray(guides) ? guides : [])
    .filter((g) => g && typeof g.id === "string")
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

/** Plain-text excerpt of an exam's AI study guide for the AI content report. */
export function examStudyGuideExcerpt(guide: Pick<ExamStudyGuide, "bigPictureSummary" | "topicExpansions" | "keyConcepts" | "importantDefinitions">): string {
  return [
    guide.bigPictureSummary ?? "",
    ...(guide.topicExpansions ?? []).slice(0, 6).map((t) => `${t.title}: ${t.explanation}`),
    (guide.keyConcepts ?? []).length > 0 ? `Key concepts: ${(guide.keyConcepts ?? []).slice(0, 12).join(", ")}` : "",
    ...(guide.importantDefinitions ?? []).slice(0, 6).map((d) => `${d.term}: ${d.definition}`),
  ]
    .filter(Boolean)
    .join("\n");
}

/** Plain-text excerpt of question/answer pairs for the AI content report. */
export function questionsExcerpt(questions: readonly { question: string; answer: string }[], max = 6): string {
  return questions
    .slice(0, max)
    .map((q, i) => `Q${i + 1}: ${q.question}\nA: ${q.answer}`)
    .join("\n");
}

/** Plain-text excerpt of a guide for the AI content report. */
export function studyGuideExcerpt(guide: Pick<SyllabusStudyGuide, "courseTitle" | "overview" | "topics" | "studyTips">): string {
  const topics = Array.isArray(guide.topics) ? guide.topics : [];
  return [
    guide.courseTitle,
    guide.overview,
    ...topics.slice(0, 8).map((t) => `${t.title}: ${t.description}`),
    ...(Array.isArray(guide.studyTips) ? guide.studyTips.slice(0, 3) : []),
  ]
    .filter(Boolean)
    .join("\n");
}
