// Which endpoint a message goes to: a change to something already on the calendar is an edit; a deadline that itself
// moved is news about a task and goes to the conversation (the mobile app's tests/assistant-reply.test.ts and
// tests/assistant-deadline.test.ts, the intent halves).
import { describe, expect, it } from "vitest";

import { isDeadlineChangeIntent, isEditIntent } from "../../src/lib/assistant-intent";

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

describe("deadline messages go to the conversation, session moves stay edits", () => {
  it("recognises a deadline that itself moved", () => {
    for (const text of [
      "Midterm moved to Tuesday",
      "my STAT midterm got moved to next Thursday",
      "The essay is now due Friday at 5pm",
      "professor pushed the final to Dec 14",
      "quiz 3 was postponed to Monday",
      "the lab report deadline is extended to the 20th",
    ]) {
      expect(isDeadlineChangeIntent(text), text).toBe(true);
      expect(isEditIntent(text), text).toBe(false);
    }
  });

  it("keeps requests to move a study session (or anything imperative) as edits", () => {
    for (const text of [
      "move my midterm review to Tuesday",
      "push my quiz 12 review to Sunday afternoon",
      "reschedule the exam prep for later in the week",
      "can you move the homework 3 session to Friday",
    ]) {
      expect(isDeadlineChangeIntent(text), text).toBe(false);
      expect(isEditIntent(text), text).toBe(true);
    }
  });

  it("a message with no assessment in it is never a deadline change", () => {
    expect(isDeadlineChangeIntent("I'm sick today, push everything")).toBe(false);
    expect(isDeadlineChangeIntent("Move all my reading to mornings")).toBe(false);
  });
});
