/**
 * The study tools' calls to the server, typed: the four AI procedures (study guide, practice exam, exam-prep content,
 * test review), each validated by the engine's parsers on the way back (src/lib/study-answers.ts), and the uploads
 * that go before them (a photo of a graded test, a PDF or photos of class material, a Word file's text). What the
 * mobile app does through its tRPC hooks (trpc.ai.*.useMutation) the screens do through these functions.
 * Browser helpers for the files themselves (base64 for the upload, the size and type checks) are here too.
 */
import { MAX_UPLOAD_BYTES, checkImageForUpload, decodedBytesFromBase64, formatMegabytes, type AllowedImageMime } from "../engine/study-images";
import { mutate, type ProcedureInput } from "./api";
import {
  parseExamContentAnswer,
  parsePracticeExamAnswer,
  parseStudyGuideAnswer,
  parseTestReviewAnswer,
  type ExamContentAnswer,
  type PracticeExamAnswer,
  type StudyGuideAnswer,
  type TestReviewAnswer,
} from "./study-answers";
import type { StudyErrorInfo } from "./study-errors";

export type { ExamContentAnswer, PracticeExamAnswer, StudyGuideAnswer, TestReviewAnswer } from "./study-answers";

/** The AI writes for a while (a practice exam may take 90 s on the server): longer than the client's 60 s default. */
const AI_TIMEOUT_MS = 150_000;

// ── The four AI procedures ────────────────────────────────────

export async function analyzeSyllabus(input: ProcedureInput<"ai.analyzeSyllabus">): Promise<StudyGuideAnswer> {
  const output = await mutate("ai.analyzeSyllabus", input, { timeoutMs: AI_TIMEOUT_MS });
  return parseStudyGuideAnswer(output, input);
}

export async function generatePracticeExam(input: ProcedureInput<"ai.generatePracticeExam"> & { questionCount: number }): Promise<PracticeExamAnswer> {
  const output = await mutate("ai.generatePracticeExam", input, { timeoutMs: AI_TIMEOUT_MS });
  return parsePracticeExamAnswer(output, input);
}

export async function generateExamContent(input: ProcedureInput<"ai.generateExamContent">): Promise<ExamContentAnswer> {
  const output = await mutate("ai.generateExamContent", input, { timeoutMs: AI_TIMEOUT_MS });
  return parseExamContentAnswer(output, input);
}

export async function reviewTest(input: ProcedureInput<"ai.reviewTest">): Promise<TestReviewAnswer> {
  const output = await mutate("ai.reviewTest", input, { timeoutMs: AI_TIMEOUT_MS });
  return parseTestReviewAnswer(output, input);
}

// ── Uploads ───────────────────────────────────────────────────

function urlOf(output: unknown, what: string): string {
  const url = output && typeof output === "object" ? (output as { url?: unknown }).url : undefined;
  if (typeof url !== "string" || !url) throw new Error(`We couldn't upload ${what}. Please try again.`);
  return url;
}

/** A page of a graded test (ai.uploadFile with purpose "test-review"). */
export async function uploadReviewImage(input: { base64: string; mimeType: AllowedImageMime }): Promise<{ url: string }> {
  const output = await mutate("ai.uploadFile", { base64: input.base64, mimeType: input.mimeType, purpose: "test-review" }, { timeoutMs: AI_TIMEOUT_MS });
  return { url: urlOf(output, "that photo") };
}

/** Class material for an exam prep (a PDF or a photo), the way the mobile sheet uploads it (ai.uploadSyllabus). */
export async function uploadMaterialFile(input: { base64Data: string; fileName: string; mimeType: "application/pdf" | AllowedImageMime }): Promise<{ url: string }> {
  const output = await mutate("ai.uploadSyllabus", input, { timeoutMs: AI_TIMEOUT_MS });
  return { url: urlOf(output, "that file") };
}

/** The text of a Word (.docx) file, read by the server. */
export async function extractDocxText(base64Data: string): Promise<string> {
  const output = await mutate("ai.extractDocxText", { base64Data }, { timeoutMs: AI_TIMEOUT_MS });
  const text = output && typeof output === "object" ? (output as { text?: unknown }).text : undefined;
  return typeof text === "string" ? text : "";
}

// ── Files in the browser ──────────────────────────────────────

/** The file's bytes as base64 (what the upload procedures take). */
export function readFileAsBase64(file: Blob): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(reader.error ?? new Error("Could not read the file"));
    reader.readAsDataURL(file);
  });
}

export type PickedImage = { ok: true; base64: string; mimeType: AllowedImageMime; bytes: number } | { ok: false; reason: "missing" | "unsupported" | "too_large"; message: string };

/** A picked photo, read and checked against the server's upload rules (type, 10 MB) before any upload. */
export async function readPickedImage(file: File): Promise<PickedImage> {
  let base64 = "";
  try {
    base64 = await readFileAsBase64(file);
  } catch {
    base64 = "";
  }
  const check = checkImageForUpload({ base64, mimeType: file.type, fileName: file.name });
  if (!check.ok) return check;
  return { ok: true, base64, mimeType: check.mimeType, bytes: check.bytes };
}

/** The file is over the server's cap: the notice the exam-prep sheet shows before uploading. */
export function tooLargeFileError(base64: string): StudyErrorInfo | null {
  const bytes = decodedBytesFromBase64(base64);
  if (bytes <= MAX_UPLOAD_BYTES) return null;
  return {
    kind: "too_large",
    title: "File too large",
    message: `That file is ${formatMegabytes(bytes)}, over the ${Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024))} MB limit. Choose a smaller file or paste the text.`,
    retryable: false,
  };
}
