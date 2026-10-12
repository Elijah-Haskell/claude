/**
 * What a syllabus reading answers, read into the engine's SyllabusExtraction so the class and the dates steps can
 * be built from it (src/screens/syllabus.tsx finishRead).
 *
 * The server (server/syllabus-extract.ts runSyllabusExtraction) answers the extraction's fields at the top level:
 * `course`, `items` (each with its resolved date beside the reported one), `warnings`, `truncated`, `count`,
 * `courseName`, `term` and `rawText`. The API client types the same answer loosely as `{ count, extraction? }`
 * (src/lib/api.ts SyllabusExtractionResult), and the browser test's mock answers that shape. Both are read here:
 * the extraction is normalised by the engine's own normaliser, so a field that is missing or oddly typed gets its
 * default instead of breaking the import, and the dates are resolved again on this side with the same rules the
 * server used (a full date resolves to itself).
 */
import { normalizeExtraction, type SyllabusExtraction } from "../engine/syllabus-extraction-utils";

/** A reading, ready for the class step. */
export interface SyllabusReading {
  extraction: SyllabusExtraction;
  /** The document's text (pasted, or transcribed by the server), kept on the import for Ask AI. */
  rawText: string;
  /** How many items the server found (dated or not). */
  count: number;
  /** The course's name as the server settled it (the document's, else the hint the student gave). */
  courseName: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "") : [];
}

/** The reading in a server answer, or null when the answer carries no extraction at all. */
export function readingOfResult(result: unknown): SyllabusReading | null {
  if (!isRecord(result)) return null;
  const source = isRecord(result.extraction) ? result.extraction : result;
  const truncated = source.truncated === true || result.truncated === true;
  const normalized = normalizeExtraction(source, truncated);
  if (!normalized) return null;
  // The server's warnings first (what the document lacks), then what normalising found; each sentence once.
  const warnings: string[] = [];
  for (const warning of [...stringList(result.warnings), ...stringList(source.warnings), ...normalized.warnings]) {
    if (!warnings.includes(warning)) warnings.push(warning);
  }
  const extraction: SyllabusExtraction = { ...normalized, warnings };
  const count = typeof result.count === "number" && Number.isFinite(result.count) ? result.count : extraction.items.length;
  const courseName = typeof result.courseName === "string" && result.courseName.trim() ? result.courseName.trim() : extraction.course.name;
  return {
    extraction,
    rawText: typeof result.rawText === "string" ? result.rawText : "",
    count,
    courseName,
  };
}
