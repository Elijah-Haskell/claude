import { describe, expect, it } from "vitest";

import { SYLLABUS_EXTRACTION_RESPONSE_FORMAT } from "../../src/engine/syllabus-extraction-utils";
import { EXAM_CONTENT_RESPONSE_FORMAT } from "../../src/engine/study-parsers";
import { geminiThinkingPlan, toGeminiJsonSchema } from "../../src/lib/gemini";

const walk = (node: unknown, seen: (key: string, value: unknown) => void) => {
  if (Array.isArray(node)) node.forEach((item) => walk(item, seen));
  else if (node && typeof node === "object") for (const [key, value] of Object.entries(node)) { seen(key, value); walk(value, seen); }
};

describe("Gemini request shape", () => {
  it("keeps the engine's schema inside Gemini's supported keywords", () => {
    const schema = toGeminiJsonSchema(SYLLABUS_EXTRACTION_RESPONSE_FORMAT.json_schema.schema) as Record<string, unknown>;
    const keys = new Set<string>();
    walk(schema, (key) => keys.add(key));
    expect(keys.has("const")).toBe(false);
    expect(keys.has("strict")).toBe(false);
    expect(schema.type).toBe("object");
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties as Record<string, unknown>)).toEqual(["course", "items"]);
    // No enum lists null any more: those became anyOf [enum, null].
    walk(schema, (key, value) => {
      if (key === "enum") expect((value as unknown[]).includes(null)).toBe(false);
    });
  });

  it("rewrites a nullable enum as anyOf and drops a const into a one-value enum", () => {
    expect(toGeminiJsonSchema({ type: ["string", "null"], enum: ["a", "b", null], description: "x" })).toEqual({ anyOf: [{ type: "string", enum: ["a", "b"], description: "x" }, { type: "null" }] });
    expect(toGeminiJsonSchema({ const: "only", unsupported: true })).toEqual({ enum: ["only"] });
  });

  it("converts the exam material schema too", () => {
    const schema = toGeminiJsonSchema(EXAM_CONTENT_RESPONSE_FORMAT.json_schema.schema) as Record<string, unknown>;
    expect(Object.keys(schema.properties as Record<string, unknown>)).toContain("flashcards");
  });

  it("adds thinking headroom on Gemini 3 and none before it", () => {
    expect(geminiThinkingPlan("gemini-3.8-flash", 24_576)).toEqual({ level: "low", maxOutputTokens: 24_576 + 4096 });
    expect(geminiThinkingPlan("gemini-3.8-flash", 1000, "minimal")).toEqual({ level: "low", maxOutputTokens: 1000 + 4096 });
    expect(geminiThinkingPlan("gemini-3.1-pro-preview", 60_000, "high")?.maxOutputTokens).toBe(65_536);
    expect(geminiThinkingPlan("gemini-2.5-flash", 1000)).toBeNull();
  });
});
