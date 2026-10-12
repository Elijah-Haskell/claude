import { describe, expect, it } from "vitest";
import { describeIntakeFailure, PASTE_PICTURE_NOTE } from "../../src/engine/syllabus-messages";

const trpcError = (code: string, message: string) => Object.assign(new Error(message), { data: { code } });

describe("describeIntakeFailure", () => {
  it("never shows raw parser or server text to a student", () => {
    for (const raw of ["JSON Parse error: Unexpected character: <", "Invalid URL: /api/trpc/ai.uploadAudio", "AI returned invalid JSON", "Unable to transform response from server"]) {
      const failure = describeIntakeFailure(new Error(raw), "extract");
      expect(failure.message).not.toContain("JSON");
      expect(failure.message).not.toContain("/api");
      expect(failure.message).not.toContain("transform");
      expect(failure.offerPaste).toBe(true);
      expect(failure.canRetry).toBe(true);
    }
  });

  it("offers 'paste the text instead' when the file could not be read", () => {
    const failure = describeIntakeFailure(new Error("We couldn't read a usable schedule from this file. Please try the file again or paste its text."), "extract");
    expect(failure.title).toBe("Could not read this file");
    expect(failure.offerPaste).toBe(true);
  });

  it("a busy provider and a dropped connection are retryable and say which", () => {
    const busy = describeIntakeFailure(trpcError("SERVICE_UNAVAILABLE", "AI is busy right now"), "extract");
    expect(busy).toMatchObject({ title: "The AI is busy", canRetry: true, offerPaste: true });
    const offline = describeIntakeFailure(new Error("Network request failed"), "upload");
    expect(offline).toMatchObject({ title: "Connection problem", canRetry: true });
  });

  it("the daily allowance is not retryable and does not push pasting (pasting also uses the AI)", () => {
    const failure = describeIntakeFailure(trpcError("TOO_MANY_REQUESTS", "You've used today's AI allowance"), "extract");
    expect(failure).toMatchObject({ canRetry: false, offerPaste: false });
  });

  it("wherever pasting is suggested, it warns that tables saved as pictures will not paste", () => {
    for (const stage of ["read-file", "upload", "extract"] as const) {
      const failure = describeIntakeFailure(new Error("x"), stage);
      expect(failure.offerPaste).toBe(true);
      expect(failure.message).toContain(PASTE_PICTURE_NOTE);
    }
    expect(PASTE_PICTURE_NOTE).toMatch(/pictures/);
    expect(PASTE_PICTURE_NOTE).toMatch(/upload the PDF or a photo/);
    // and not where pasting is not offered
    expect(describeIntakeFailure(Object.assign(new Error("x"), { data: { code: "TOO_MANY_REQUESTS" } }), "extract").message).not.toContain("pictures");
  });

  it("stage-specific fallbacks", () => {
    expect(describeIntakeFailure(new Error("x"), "read-file").title).toBe("Could not open the file");
    expect(describeIntakeFailure(new Error("x"), "upload").title).toBe("Upload failed");
    expect(describeIntakeFailure("weird", "extract").title).toBe("Could not read the syllabus");
  });
});
