// The optional AI reader: the student's own Gemini API key, kept in this browser, calls Google's generateContent
// endpoint straight from the page (never through a Trajectory server). The request is the same shape the mobile
// app's server sends (server/_core/llm.ts there): responseMimeType + responseJsonSchema for structured output, a
// Gemini 3 thinking level with headroom on top of the answer cap, no temperature on Gemini 3. Two jobs use it:
// reading a pasted syllabus into the shape the import pipeline expects (src/engine/syllabus-extraction-utils.ts),
// and writing an exam prep's study material (src/engine/study-prompts.ts). Both answers are validated by the
// engine's own parsers before anything is used.

import { EXAM_CONTENT_RESPONSE_FORMAT, parseExamContentResponse, type ExamContentOutput } from "../engine/study-parsers";
import { examContentSystemPrompt, examContentUserText, STUDY_MAX_TOKENS } from "../engine/study-prompts";
import { EXAM_MATERIAL_CHAR_LIMIT } from "../engine/study-text";
import { buildSyllabusExtractionPrompt, parseSyllabusExtractionResponse, SYLLABUS_EXTRACTION_RESPONSE_FORMAT, wrapSyllabusText, type SyllabusExtraction } from "../engine/syllabus-extraction-utils";
import { AiError, DEFAULT_AI_MODEL } from "./ai-types";

export { AiError, DEFAULT_AI_MODEL } from "./ai-types";

const GEMINI_API = "https://generativelanguage.googleapis.com";
/** Sized for ~80 items with evidence quotes, as the mobile app's server measured (SYLLABUS_EXTRACTION_MAX_TOKENS). */
const SYLLABUS_MAX_TOKENS = 24_576;

// ── Thinking (Gemini 3) ───────────────────────────────────────

export type ThinkingLevel = "minimal" | "low" | "medium" | "high";

/**
 * Output tokens reserved for thinking ON TOP of the answer cap: on Gemini 3, maxOutputTokens counts the thought
 * tokens too, so without headroom a long think would cut a long JSON answer short (thinking guide, 2026-10-02).
 */
const THINKING_HEADROOM_TOKENS: Record<ThinkingLevel, number> = { minimal: 1024, low: 4096, medium: 8192, high: 16384 };
/** Every Gemini 3 model documented so far allows 65,536 output tokens, thinking included. */
const GEMINI_3_OUTPUT_LIMIT = 65_536;
/** "minimal" is an error on 3.8 / 3.7 Flash and not supported on 3.1 Pro: they get "low". */
const NO_MINIMAL_THINKING = /^gemini-3\.[78]-flash|^gemini-3\.1-pro/;

export const isGemini3Model = (model: string): boolean => model.trim().replace(/^models\//, "").startsWith("gemini-3");

/** The fast tier's plan ("low", as the mobile server's extraction and study calls use): null before Gemini 3. */
export function geminiThinkingPlan(model: string, answerCap: number, wanted: ThinkingLevel = "low"): { level: ThinkingLevel; maxOutputTokens: number } | null {
  const id = model.trim().replace(/^models\//, "");
  if (!isGemini3Model(id)) return null;
  const level = wanted === "minimal" && NO_MINIMAL_THINKING.test(id) ? "low" : wanted;
  return { level, maxOutputTokens: Math.min(answerCap + THINKING_HEADROOM_TOKENS[level], GEMINI_3_OUTPUT_LIMIT) };
}

// ── Schema ────────────────────────────────────────────────────

/** The JSON Schema keywords Gemini's responseJsonSchema supports (generateContent reference, checked 2026-10-02). */
const GEMINI_SCHEMA_KEYWORDS = new Set(["$id", "$defs", "$ref", "$anchor", "type", "format", "title", "description", "enum", "items", "prefixItems", "minItems", "maxItems", "minimum", "maximum", "anyOf", "oneOf", "properties", "additionalProperties", "required", "propertyOrdering"]);

/**
 * The engine's strict JSON Schemas (written for OpenAI-style structured output) as Gemini accepts them: keywords
 * outside Gemini's documented subset are dropped, `const` becomes a one-value enum, and an enum that lists null
 * (Gemini enums are for strings and numbers) is rewritten as anyOf [the enum, null], which means the same thing.
 */
export function toGeminiJsonSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toGeminiJsonSchema);
  if (!schema || typeof schema !== "object") return schema;
  const out: Record<string, unknown> = {};
  let enumAllowsNull = false;
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (key === "const") {
      if ((typeof value === "string" || typeof value === "number") && !("enum" in out)) out.enum = [value];
      continue;
    }
    if (!GEMINI_SCHEMA_KEYWORDS.has(key)) continue;
    if (key === "properties" || key === "$defs") {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        out[key] = Object.fromEntries(Object.entries(value).map(([name, sub]) => [name, toGeminiJsonSchema(sub)]));
      }
    } else if (key === "items" || key === "prefixItems" || key === "anyOf" || key === "oneOf" || key === "additionalProperties") {
      out[key] = typeof value === "boolean" ? value : toGeminiJsonSchema(value);
    } else if (key === "enum") {
      if (!Array.isArray(value)) continue;
      enumAllowsNull = value.includes(null);
      const values = value.filter((v) => typeof v === "string" || typeof v === "number");
      if (values.length > 0) out.enum = values;
    } else {
      out[key] = value;
    }
  }
  if (!enumAllowsNull) return out;
  const { type, ...rest } = out;
  const types = (Array.isArray(type) ? type : type === undefined ? [] : [type]).filter((t) => t !== "null");
  const branch = types.length === 0 ? rest : { ...rest, type: types.length === 1 ? types[0] : types };
  return { anyOf: [branch, { type: "null" }] };
}

// ── The call ──────────────────────────────────────────────────

/** Finish reasons that mean Gemini refused or withheld the answer (generateContent reference, FinishReason). */
const BLOCKED_FINISH = new Set(["SAFETY", "RECITATION", "LANGUAGE", "OTHER", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "IMAGE_SAFETY", "IMAGE_PROHIBITED_CONTENT", "IMAGE_RECITATION", "IMAGE_OTHER", "ESCALATION", "PUP_LIMITED_DISABLED"]);

interface GeminiResponse {
  candidates?: { content?: { parts?: { text?: unknown; thought?: unknown }[] }; finishReason?: unknown }[];
  promptFeedback?: { blockReason?: unknown };
}

export interface JsonRequest {
  apiKey: string;
  model?: string;
  system: string;
  user: string;
  /** A plain JSON Schema (OpenAI-style strict schema is fine: it is converted). */
  schema: unknown;
  /** The answer's own token cap; thinking headroom is added on Gemini 3. */
  maxTokens: number;
  thinking?: ThinkingLevel;
  signal?: AbortSignal;
}

async function httpFailure(response: Response): Promise<AiError> {
  let detail = "";
  try {
    const body = (await response.json()) as { error?: { message?: unknown } };
    if (typeof body.error?.message === "string") detail = body.error.message;
  } catch {
    // no JSON body
  }
  if (response.status === 400 && /api key/i.test(detail)) return new AiError("auth", "Google did not accept that API key. Check it in Settings.");
  if (response.status === 401 || response.status === 403) return new AiError("auth", "That API key is not allowed to use this model. Check the key and the model in Settings.");
  if (response.status === 404) return new AiError("other", `Google has no model called "${detail || "that"}". Check the model id in Settings.`);
  if (response.status === 429) return new AiError("rate", "Google is rate-limiting this key right now. Wait a moment and try again.");
  if (response.status >= 500) return new AiError("network", "Gemini is having trouble right now. Try again in a moment.");
  return new AiError("other", `Gemini answered with an error (${response.status})${detail ? `: ${detail}` : ""}`);
}

/** One structured answer from Gemini, as text (the caller's parser decides what it means). */
export async function requestJson(request: JsonRequest): Promise<string> {
  const model = (request.model?.trim() || DEFAULT_AI_MODEL).replace(/^models\//, "");
  const thinking = geminiThinkingPlan(model, request.maxTokens, request.thinking ?? "low");
  const generationConfig: Record<string, unknown> = {
    maxOutputTokens: thinking ? thinking.maxOutputTokens : request.maxTokens,
    responseMimeType: "application/json",
    responseJsonSchema: toGeminiJsonSchema(request.schema),
  };
  // thinkingLevel only, never with thinkingBudget: the two together are a 400. The wire value is the enum name.
  if (thinking) generationConfig.thinkingConfig = { thinkingLevel: thinking.level.toUpperCase() };
  const body = {
    systemInstruction: { parts: [{ text: request.system }] },
    contents: [{ role: "user", parts: [{ text: request.user }] }],
    generationConfig,
  };

  let response: Response;
  try {
    response = await fetch(`${GEMINI_API}/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": request.apiKey },
      body: JSON.stringify(body),
      signal: request.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw new AiError("other", "Cancelled.");
    throw new AiError("network", "Could not reach Google. Check your connection and try again.");
  }
  if (!response.ok) throw await httpFailure(response);

  let data: GeminiResponse;
  try {
    data = (await response.json()) as GeminiResponse;
  } catch {
    throw new AiError("unusable", "Gemini's answer could not be read. Try again.");
  }
  const candidate = Array.isArray(data.candidates) ? data.candidates[0] : undefined;
  const blockReason = data.promptFeedback?.blockReason;
  if (!candidate && typeof blockReason === "string" && blockReason) throw new AiError("refusal", `Gemini declined to read this (${blockReason}). Use the built-in reader instead.`);
  const finish = typeof candidate?.finishReason === "string" ? candidate.finishReason : "";
  if (BLOCKED_FINISH.has(finish)) throw new AiError("refusal", `Gemini declined to answer (${finish}). Use the built-in reader instead.`);
  // The answer: the text parts that are not the model's thoughts. A MAX_TOKENS cut-off is returned as is: the
  // syllabus parser salvages a cut-off JSON list.
  return (candidate?.content?.parts ?? [])
    .filter((part) => typeof part.text === "string" && part.thought !== true)
    .map((part) => part.text as string)
    .join("");
}

// ── Syllabus ──────────────────────────────────────────────────

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

/** The syllabus as structured data, read by Gemini (contract v2: it reports, the engine resolves the dates). */
export async function readSyllabusWithGemini(input: SyllabusReadInput): Promise<SyllabusExtraction> {
  const text = input.text.slice(0, 200_000);
  const answer = await requestJson({
    apiKey: input.apiKey,
    model: input.model,
    system: buildSyllabusExtractionPrompt({ today: input.today, semesterStart: input.semesterStart, semesterEnd: input.semesterEnd }),
    user: wrapSyllabusText(text, input.courseHint?.trim() || undefined),
    schema: SYLLABUS_EXTRACTION_RESPONSE_FORMAT.json_schema.schema,
    maxTokens: SYLLABUS_MAX_TOKENS,
    signal: input.signal,
  });
  const parsed = parseSyllabusExtractionResponse(answer);
  if (!parsed) throw new AiError("unusable", "Gemini's answer could not be read as a syllabus. Try again, or use the built-in reader.");
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

/** An exam prep's study material (deep dives, concepts, definitions, flashcards, practice questions), written by Gemini. */
export async function writeExamMaterialWithGemini(input: ExamMaterialInput): Promise<ExamContentOutput & { inputTruncated?: boolean }> {
  const raw = input.rawInput?.trim() ?? "";
  const truncated = raw.length > EXAM_MATERIAL_CHAR_LIMIT;
  const answer = await requestJson({
    apiKey: input.apiKey,
    model: input.model,
    system: examContentSystemPrompt(),
    user: examContentUserText({ topics: input.topics, rawInput: truncated ? raw.slice(0, EXAM_MATERIAL_CHAR_LIMIT) : raw || undefined, className: input.className, daysUntil: input.daysUntil }),
    schema: EXAM_CONTENT_RESPONSE_FORMAT.json_schema.schema,
    maxTokens: STUDY_MAX_TOKENS.examContent,
    signal: input.signal,
  });
  const parsed = parseExamContentResponse(answer, { sourceText: raw || undefined });
  if (!parsed.ok) throw new AiError("unusable", `Gemini's study material could not be read: ${parsed.reason}`);
  return { ...parsed.value, inputTruncated: truncated || undefined };
}
