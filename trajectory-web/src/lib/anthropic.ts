// The optional AI reader: the student's own Anthropic API key, kept in this browser, calls Claude straight from the
// page (the official SDK with dangerouslyAllowBrowser, since the key is the student's and never leaves their
// machine for anything but Anthropic). Two jobs use it: reading a pasted syllabus into the structured shape the
// import pipeline expects (src/engine/syllabus-extraction-utils.ts), and writing an exam prep's study material
// (src/engine/study-prompts.ts). Both answers are validated by the engine's own parsers before anything is used.

import Anthropic from "@anthropic-ai/sdk";

import { EXAM_CONTENT_RESPONSE_FORMAT, parseExamContentResponse, type ExamContentOutput } from "../engine/study-parsers";
import { examContentSystemPrompt, examContentUserText, STUDY_MAX_TOKENS } from "../engine/study-prompts";
import { EXAM_MATERIAL_CHAR_LIMIT } from "../engine/study-text";
import { buildSyllabusExtractionPrompt, parseSyllabusExtractionResponse, SYLLABUS_EXTRACTION_RESPONSE_FORMAT, wrapSyllabusText, type SyllabusExtraction } from "../engine/syllabus-extraction-utils";
import { AiError, DEFAULT_AI_MODEL } from "./ai-types";

export { AiError, DEFAULT_AI_MODEL } from "./ai-types";

/** Sized for ~80 items with evidence quotes, as the mobile app's server measured. */
const SYLLABUS_MAX_TOKENS = 24_576;

/**
 * Anthropic's structured outputs take a plain JSON Schema object: the engine's response format carries OpenAI-style
 * wrapping and numeric bounds, so the schema is lifted out and the bounds dropped (the parsers clamp the values).
 */
export function toOutputSchema(schema: unknown): Record<string, unknown> {
  const strip = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(strip);
    if (!node || typeof node !== "object") return node;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === "minimum" || key === "maximum" || key === "multipleOf" || key === "minLength" || key === "maxLength" || key === "minItems" || key === "maxItems" || key === "pattern" || key === "format") continue;
      out[key] = strip(value);
    }
    return out;
  };
  return strip(schema) as Record<string, unknown>;
}

function describeFailure(error: unknown): AiError {
  if (error instanceof AiError) return error;
  if (error instanceof Anthropic.AuthenticationError) return new AiError("auth", "Anthropic did not accept that API key. Check it in Settings.");
  if (error instanceof Anthropic.PermissionDeniedError) return new AiError("auth", "That API key is not allowed to use this model. Check the key and the model in Settings.");
  if (error instanceof Anthropic.RateLimitError) return new AiError("rate", "Anthropic is rate-limiting this key right now. Wait a moment and try again.");
  if (error instanceof Anthropic.APIConnectionError) return new AiError("network", "Could not reach Anthropic. Check your connection and try again.");
  if (error instanceof Anthropic.APIError) return new AiError("other", `Anthropic answered with an error (${error.status ?? "unknown"}): ${error.message}`);
  if (error instanceof DOMException && error.name === "AbortError") return new AiError("other", "Cancelled.");
  return new AiError("other", error instanceof Error && error.message ? error.message : "Something went wrong while asking the AI.");
}

export interface JsonRequest {
  apiKey: string;
  model?: string;
  system: string;
  user: string;
  /** A plain JSON Schema (see toOutputSchema). */
  schema: Record<string, unknown>;
  maxTokens: number;
  effort?: "low" | "medium" | "high";
  signal?: AbortSignal;
}

/** One structured answer from Claude, as text (the caller's parser decides what it means). */
export async function requestJson(request: JsonRequest): Promise<string> {
  const client = new Anthropic({ apiKey: request.apiKey, dangerouslyAllowBrowser: true, maxRetries: 2, timeout: 10 * 60_000 });
  try {
    // Streaming keeps a long answer from tripping the request timeout; the whole message is read at the end.
    const stream = client.beta.messages.stream(
      {
        model: request.model?.trim() || DEFAULT_AI_MODEL,
        max_tokens: request.maxTokens,
        // A safety decline is re-run on a fallback model inside the same call, so a syllabus is never left unread.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        system: request.system,
        messages: [{ role: "user", content: request.user }],
        output_config: { effort: request.effort ?? "medium", format: { type: "json_schema", schema: request.schema } },
      },
      { signal: request.signal },
    );
    const message = await stream.finalMessage();
    if (message.stop_reason === "refusal") throw new AiError("refusal", "The AI declined to read this document. Use the built-in reader instead.");
    return message.content
      .filter((block): block is Extract<(typeof message.content)[number], { type: "text" }> => block.type === "text")
      .map((block) => block.text)
      .join("");
  } catch (error) {
    throw describeFailure(error);
  }
}

export interface SyllabusReadInput {
  apiKey: string;
  model?: string;
  text: string;
  courseHint?: string;
  today: string;
  semesterStart?: string;
  semesterEnd?: string;
  signal?: AbortSignal;
}

/** The syllabus as structured data, read by Claude (contract v2: it reports, the engine resolves the dates). */
export async function readSyllabusWithClaude(input: SyllabusReadInput): Promise<SyllabusExtraction> {
  const text = input.text.slice(0, 200_000);
  const answer = await requestJson({
    apiKey: input.apiKey,
    model: input.model,
    system: buildSyllabusExtractionPrompt({ today: input.today, semesterStart: input.semesterStart, semesterEnd: input.semesterEnd }),
    user: wrapSyllabusText(text, input.courseHint?.trim() || undefined),
    schema: toOutputSchema(SYLLABUS_EXTRACTION_RESPONSE_FORMAT.json_schema.schema),
    maxTokens: SYLLABUS_MAX_TOKENS,
    effort: "medium",
    signal: input.signal,
  });
  const parsed = parseSyllabusExtractionResponse(answer);
  if (!parsed) throw new AiError("unusable", "The AI's answer could not be read as a syllabus. Try again, or use the built-in reader.");
  return parsed;
}

// ── Exam prep material ────────────────────────────────────────

export interface ExamMaterialInput {
  apiKey: string;
  model?: string;
  topics: string[];
  rawInput?: string;
  className?: string;
  daysUntil?: number | null;
  signal?: AbortSignal;
}

/** An exam prep's study material (deep dives, concepts, definitions, flashcards, practice questions), written by Claude. */
export async function writeExamMaterialWithClaude(input: ExamMaterialInput): Promise<ExamContentOutput & { inputTruncated?: boolean }> {
  const raw = input.rawInput?.trim() ?? "";
  const truncated = raw.length > EXAM_MATERIAL_CHAR_LIMIT;
  const answer = await requestJson({
    apiKey: input.apiKey,
    model: input.model,
    system: examContentSystemPrompt(),
    user: examContentUserText({ topics: input.topics, rawInput: truncated ? raw.slice(0, EXAM_MATERIAL_CHAR_LIMIT) : raw || undefined, className: input.className, daysUntil: input.daysUntil }),
    schema: toOutputSchema(EXAM_CONTENT_RESPONSE_FORMAT.json_schema.schema),
    maxTokens: Math.max(STUDY_MAX_TOKENS.examContent, 8000),
    effort: "medium",
    signal: input.signal,
  });
  const parsed = parseExamContentResponse(answer, { sourceText: raw || undefined });
  if (!parsed.ok) throw new AiError("unusable", `The AI's study material could not be read: ${parsed.reason}`);
  return { ...parsed.value, inputTruncated: truncated || undefined };
}
