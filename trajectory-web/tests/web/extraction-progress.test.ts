import { describe, expect, it } from "vitest";

import { extractionProgressCopy, formatElapsed } from "../../src/lib/extraction-progress";

describe("extraction progress copy", () => {
  it("sets an honest expectation for picture pages and escalates over time", () => {
    expect(extractionProgressCopy(0, false)).toMatch(/1–3 minutes/);
    expect(extractionProgressCopy(60_000, false)).toMatch(/Still reading/);
    expect(extractionProgressCopy(200_000, false)).toMatch(/longer than usual/);
  });

  it("does not warn about slowness for pasted text", () => {
    expect(extractionProgressCopy(0, true)).not.toMatch(/minutes/);
  });

  it("uses what the server reports over the time-based guess", () => {
    expect(extractionProgressCopy(90_000, false, { stage: "reading-more", itemsFound: 38 })).toMatch(/Found 38 deliverables so far/);
    expect(extractionProgressCopy(90_000, false, { stage: "finishing", itemsFound: 43 })).toMatch(/Found 43 deliverables/);
    expect(extractionProgressCopy(90_000, false, { stage: "second-look" })).toMatch(/second, slower model/);
    expect(extractionProgressCopy(90_000, false, null, true)).toMatch(/reconnecting/);
    expect(extractionProgressCopy(90_000, false, { stage: "reading" })).toMatch(/Still reading/);
  });

  it("formats elapsed time", () => {
    expect(formatElapsed(4_000)).toBe("4s");
    expect(formatElapsed(65_000)).toBe("1m 05s");
    expect(formatElapsed(180_400)).toBe("3m 00s");
  });
});
