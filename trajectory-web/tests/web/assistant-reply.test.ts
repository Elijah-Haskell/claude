import { describe, expect, it } from "vitest";

import { isEditIntent } from "../../src/lib/assistant-intent";
import { displayableReply, looksLikeJsonReply, normalizeClock, salvageJsonReply, sanitizeEditBlocks } from "../../src/lib/assistant-reply";

const CUT_OFF = `{
  "type": "schedule",
  "reply": "That makes total sense. I've adjusted your settings so the auto-scheduler only looks at a 4-day window.",
  "tasks": [],
  "events": [
    {
      "title": "Review: Quiz`;

describe("salvageJsonReply / displayableReply (bug 2026-09-24: a cut-off JSON answer was shown as the assistant's words)", () => {
  it("pulls the reply out of a JSON answer that was cut off after it", () => {
    expect(salvageJsonReply(CUT_OFF)).toBe("That makes total sense. I've adjusted your settings so the auto-scheduler only looks at a 4-day window.");
  });

  it("marks a reply that was itself cut off, and resolves JSON escapes", () => {
    expect(salvageJsonReply('{"type":"chat","reply":"Line one\\nsaid \\"hi\\" and then')).toBe("Line one\nsaid \"hi\" and then…");
  });

  it("returns null when there is no reply to salvage", () => {
    expect(salvageJsonReply("")).toBeNull();
    expect(salvageJsonReply('{"type":"chat","tasks":[]}')).toBeNull();
    expect(salvageJsonReply('{"reply": ""}')).toBeNull();
  });

  it("looksLikeJsonReply only fires on JSON-shaped text (with or without a code fence)", () => {
    expect(looksLikeJsonReply(CUT_OFF)).toBe(true);
    expect(looksLikeJsonReply('```json\n{"reply": "x"}')).toBe(true);
    expect(looksLikeJsonReply("Sure! Your quiz is on Monday.")).toBe(false);
    expect(looksLikeJsonReply("{ curly braces } in prose are fine")).toBe(false);
  });

  it("displayableReply never shows raw JSON", () => {
    expect(displayableReply(CUT_OFF)).not.toMatch(/"type"/);
    expect(displayableReply('{"type":"chat","tasks":[]}')).toMatch(/say that again/);
    expect(displayableReply("plain words")).toBe("plain words");
  });
});

describe("sanitizeEditBlocks", () => {
  const known = new Set(["study-q9-1-2026-09-24", "class-1"]);

  it("keeps well-formed edits of listed blocks and normalises the clock", () => {
    expect(sanitizeEditBlocks([{ id: "study-q9-1-2026-09-24", date: "2026-09-27", startTime: "9:00", endTime: "9:45" }], known)).toEqual([
      { id: "study-q9-1-2026-09-24", date: "2026-09-27", startTime: "09:00", endTime: "09:45" },
    ]);
  });

  it("drops unknown ids, malformed dates/times, inverted times, empty edits, duplicates and non-objects", () => {
    expect(sanitizeEditBlocks([
      { id: "ghost", startTime: "10:00" },
      { id: "class-1", date: "Sunday" },
      { id: "class-1", startTime: "25:00" },
      { id: "class-1", startTime: "11:00", endTime: "10:00" },
      { id: "class-1" },
      "class-1",
      null,
      { id: "class-1", title: "  Renamed  " },
      { id: "class-1", title: "again" },
    ], known)).toEqual([{ id: "class-1", title: "Renamed" }]);
    expect(sanitizeEditBlocks("nope", known)).toEqual([]);
    expect(sanitizeEditBlocks(undefined, known)).toEqual([]);
  });

  it("normalizeClock", () => {
    expect(normalizeClock("7:05")).toBe("07:05");
    expect(normalizeClock("23:59")).toBe("23:59");
    expect(normalizeClock("24:00")).toBeUndefined();
    expect(normalizeClock("9am")).toBeUndefined();
    expect(normalizeClock(9)).toBeUndefined();
  });
});

describe("isEditIntent", () => {
  it("recognises requests and complaints about existing calendar blocks", () => {
    for (const text of [
      "You said you moved quiz 9 and homework 3 but they didn't get moved",
      "Move my Wednesday study block to 7pm",
      "push my quiz 12 review to Sunday afternoon",
      "can you change the homework 3 session to Friday",
      "reschedule the exam prep for later in the week",
      "put the review session on Sunday instead",
      "that's wrong, it should be 3pm",
      "nothing changed on my calendar",
    ]) expect(isEditIntent(text), text).toBe(true);
  });

  it("leaves new work, questions and preferences to the conversation", () => {
    for (const text of [
      "Chem problem set due next Thursday, 2 hours",
      "3 or 4 at most",
      "what's due this week?",
      "I have work every weekday 9-5",
      "Midterm on April 15, need 3 study sessions",
      "how should I study for the final?",
    ]) expect(isEditIntent(text), text).toBe(false);
  });
});
