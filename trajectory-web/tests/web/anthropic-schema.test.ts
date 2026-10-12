import { describe, expect, it } from "vitest";

import { SYLLABUS_EXTRACTION_RESPONSE_FORMAT } from "../../src/engine/syllabus-extraction-utils";
import { EXAM_CONTENT_RESPONSE_FORMAT } from "../../src/engine/study-parsers";
import { toOutputSchema } from "../../src/lib/anthropic";

const walk = (node: unknown, seen: (key: string) => void) => {
  if (Array.isArray(node)) node.forEach((item) => walk(item, seen));
  else if (node && typeof node === "object") for (const [key, value] of Object.entries(node)) { seen(key); walk(value, seen); }
};

describe("output schema for Claude", () => {
  it("drops the numeric bounds the structured-output contract does not take and keeps the shape", () => {
    const schema = toOutputSchema(SYLLABUS_EXTRACTION_RESPONSE_FORMAT.json_schema.schema);
    const keys = new Set<string>();
    walk(schema, (key) => keys.add(key));
    expect(keys.has("minimum")).toBe(false);
    expect(keys.has("maximum")).toBe(false);
    expect(schema.type).toBe("object");
    expect((schema.properties as Record<string, unknown>).items).toBeDefined();
    expect((schema.properties as Record<string, unknown>).course).toBeDefined();
    expect(schema.additionalProperties).toBe(false);
  });

  it("works on the exam material schema too", () => {
    const schema = toOutputSchema(EXAM_CONTENT_RESPONSE_FORMAT.json_schema.schema);
    expect(Object.keys(schema.properties as Record<string, unknown>)).toContain("flashcards");
  });
});
