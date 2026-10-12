import { describe, expect, it } from "vitest";

import { hasNewerReadableImport, importAddedLine, importRowFlag, importRowLine, importSheetView } from "../../src/engine/imports-view";
import type { SyllabusImport } from "../../src/engine/types";

// Local time, so the day and the clock read the same in any time zone.
const at = (year: number, month: number, day: number, hour: number, minute = 0) => new Date(year, month - 1, day, hour, minute).toISOString();
const ids = (n: number) => Array.from({ length: n }, (_, index) => `t${index}`);
const NOW = new Date(2026, 9, 7, 9, 0);

const entry = (over: Partial<SyllabusImport> = {}): SyllabusImport => ({
  id: "i1",
  importedAt: at(2026, 8, 22, 14),
  courseName: "Principles of Finance",
  linkedClassId: "finc",
  linkedClassName: "Principles of Finance",
  itemCount: 44,
  skippedCount: 0,
  isNewClass: true,
  rawText: "Week 1: time value of money",
  createdTaskIds: ids(44),
  ...over,
});
const meets = { days: ["Mon", "Wed", "Fri"] as ("Mon" | "Wed" | "Fri")[], startTime: "10:00", endTime: "10:50" };

describe("an import's row", () => {
  it("says when it was added and how many tasks it added", () => {
    expect(importRowLine(entry())).toBe("Added Aug 22 · 44 tasks");
    expect(importRowLine(entry({ itemCount: 1 }))).toBe("Added Aug 22 · 1 task");
    expect(importRowLine(entry({ itemCount: 0 }))).toBe("Added Aug 22 · 0 tasks");
  });

  it("leaves out a date it cannot read instead of printing it", () => {
    expect(importRowLine(entry({ importedAt: "not a date", itemCount: 6 }))).toBe("6 tasks");
  });
});

describe("the line over the sheet's title", () => {
  it("says the day and the time, and the year only when it is not this one", () => {
    expect(importAddedLine(entry(), NOW)).toBe("Syllabus · added Aug 22, 2:00 PM");
    expect(importAddedLine(entry({ importedAt: at(2026, 8, 22, 0, 5) }), NOW)).toBe("Syllabus · added Aug 22, 12:05 AM");
    expect(importAddedLine(entry({ importedAt: at(2026, 8, 22, 12, 30) }), NOW)).toBe("Syllabus · added Aug 22, 12:30 PM");
    expect(importAddedLine(entry({ importedAt: at(2025, 1, 9, 9, 7) }), NOW)).toBe("Syllabus · added Jan 9 2025, 9:07 AM");
    expect(importAddedLine(entry({ importedAt: "" }), NOW)).toBe("Syllabus");
  });
});

describe("what the sheet says an import added", () => {
  it("counts the tasks, and under them what was skipped or left out", () => {
    const view = importSheetView(entry({ skippedCount: 2, excludedCount: 3 }), meets, NOW);
    expect(view.addedLine).toBe("Syllabus · added Aug 22, 2:00 PM");
    expect(view.added).toBe("44 tasks added");
    expect(view.addedDetails).toEqual(["2 duplicates skipped · 3 left out (no date, already past or unchecked)"]);
    expect(importSheetView(entry({ itemCount: 1, skippedCount: 1 }), meets, NOW)).toMatchObject({ added: "1 task added", addedDetails: ["1 duplicate skipped"] });
    expect(importSheetView(entry({ excludedCount: 1 }), meets, NOW).addedDetails).toEqual(["1 left out (no date, already past or unchecked)"]);
    // Nothing skipped, nothing left out: no line at all.
    expect(importSheetView(entry({ excludedCount: 0 }), meets, NOW).addedDetails).toEqual([]);
  });

  it("says that default study sessions were used, only when they were", () => {
    const sentence = "Default study sessions were used (the AI strategist was unavailable).";
    expect(importSheetView(entry({ strategyUnavailable: true }), meets, NOW).addedDetails).toEqual([sentence]);
    expect(importSheetView(entry({ skippedCount: 2, strategyUnavailable: true }), meets, NOW).addedDetails).toEqual(["2 duplicates skipped", sentence]);
    expect(importSheetView(entry(), meets, NOW).addedDetails).not.toContain(sentence);
  });

  it("says whether it made the class or added to one, and when that class meets", () => {
    expect(importSheetView(entry(), meets, NOW)).toMatchObject({ classLine: "Made a new class", classDetails: ["Mon Wed Fri · 10:00 – 10:50 AM"] });
    expect(importSheetView(entry({ isNewClass: false }), meets, NOW).classLine).toBe("Added to a class you already had");
    expect(importSheetView(entry(), { days: [], startTime: "", endTime: "", isAsynchronous: true }, NOW).classDetails).toEqual(["No set class time"]);
    // The class was deleted since: said as that, and there is nothing to open.
    const gone = importSheetView(entry(), undefined, NOW);
    expect(gone.classDetails).toEqual(["That class is no longer in your plan"]);
    expect(gone.openClass).toBeNull();
  });

  it("names what the syllabus called the class, only when that differs", () => {
    expect(importSheetView(entry({ courseName: "FINC 3100" }), meets, NOW).classDetails).toEqual(["Mon Wed Fri · 10:00 – 10:50 AM", "Extracted as: FINC 3100"]);
    expect(importSheetView(entry({ courseName: "   " }), meets, NOW).classDetails).toEqual(["Mon Wed Fri · 10:00 – 10:50 AM"]);
  });
});

describe("whether Ask AI can read it", () => {
  it("can when the syllabus's text was kept", () => {
    const view = importSheetView(entry(), meets, NOW);
    expect(view).toMatchObject({ aiReadable: true, aiLine: "Ask AI can read it", aiDetail: "" });
    expect(view.addAgain).toEqual({ detail: "When the syllabus has changed", missing: false });
  });

  it("cannot when it was not: the sheet says so and offers to add it again", () => {
    for (const rawText of [undefined, "", "   "]) {
      const view = importSheetView(entry({ rawText }), meets, NOW);
      expect(view).toMatchObject({ aiReadable: false, aiLine: "Ask AI can't read this one", aiDetail: "Its text was not kept. Add it again to fix that." });
      expect(view.addAgain).toEqual({ detail: "So Ask AI can read it", missing: true });
    }
  });
});

describe("opening the class", () => {
  it("asks for class days when the import made a class that still has none", () => {
    expect(importSheetView(entry(), { days: [], startTime: "", endTime: "" }, NOW).openClass).toEqual({ detail: "It has no class days yet", missing: true });
  });

  it("asks for nothing when the class has days, has no set time, or was there before the import", () => {
    expect(importSheetView(entry(), meets, NOW).openClass).toEqual({ detail: "", missing: false });
    expect(importSheetView(entry(), { days: [], startTime: "", endTime: "", isAsynchronous: true }, NOW).openClass).toEqual({ detail: "", missing: false });
    expect(importSheetView(entry({ isNewClass: false }), { days: [], startTime: "", endTime: "" }, NOW).openClass).toEqual({ detail: "", missing: false });
  });
});

describe("undoing an import", () => {
  it("says under the button what leaves the plan, and asks with the same facts", () => {
    const view = importSheetView(entry(), meets, NOW);
    expect(view.undo?.caption).toBe("Undo takes its 44 tasks, the class it made and their study sessions out of your plan. It asks first.");
    expect(view.undo?.question).toBe("Undo this import? This removes the 44 tasks, the class it made and their study sessions. Anything the import changed goes back to how it was.");
    expect(view.undoUnavailable).toBe("");
  });

  it("counts what the import made, not what it listed, and names the class only when it made one", () => {
    const view = importSheetView(entry({ itemCount: 44, createdTaskIds: ids(1), isNewClass: false }), meets, NOW);
    expect(view.undo?.caption).toBe("Undo takes its 1 task and its study sessions out of your plan. It asks first.");
    expect(view.undo?.question).toBe("Undo this import? This removes the 1 task and its study sessions. Anything the import changed goes back to how it was.");
    // An import that made no task: never "the 0 tasks". With a class it made, the class is what goes.
    const classOnly = importSheetView(entry({ createdTaskIds: [] }), meets, NOW);
    expect(classOnly.undo?.caption).toBe("Undo takes the class it made out of your plan. It asks first.");
    expect(classOnly.undo?.question).toBe("Undo this import? This removes the class it made. Anything the import changed goes back to how it was.");
    const nothingMade = importSheetView(entry({ createdTaskIds: [], isNewClass: false }), meets, NOW);
    expect(nothingMade.undo?.caption).toBe("Undo puts back what this import changed. It asks first.");
    expect(nothingMade.undo?.question).toBe("Undo this import? Anything it changed goes back to how it was.");
  });

  it("an older copy without its text needs nothing once a newer copy of the same class is readable", () => {
    const old = entry({ id: "old", rawText: undefined });
    const fresh = entry({ id: "new", importedAt: at(2026, 9, 5, 9), rawText: "Week 1: ..." });
    const other = entry({ id: "other", linkedClassId: "calc", importedAt: at(2026, 9, 6, 9), rawText: "Week 1: ..." });

    // Alone, the old copy is flagged, in the sheet and on its row.
    const alone = importSheetView(old, meets, NOW);
    expect(alone).toMatchObject({ aiReadable: false, aiSuperseded: false, aiLine: "Ask AI can't read this one", addAgain: { detail: "So Ask AI can read it", missing: true } });
    expect(importRowFlag(alone)).toBe("Ask AI can't read it");

    // A newer readable import of the SAME class takes over; one of another class does not.
    expect(hasNewerReadableImport(old, [old, other])).toBe(false);
    expect(hasNewerReadableImport(old, [old, fresh, other])).toBe(true);
    expect(hasNewerReadableImport(fresh, [old, fresh])).toBe(false);
    expect(hasNewerReadableImport(old, [old, { ...fresh, rawText: "  " }])).toBe(false);
    const superseded = importSheetView(old, meets, NOW, { newerReadable: true });
    expect(superseded).toMatchObject({ aiReadable: false, aiSuperseded: true, aiLine: "Ask AI reads the newer copy", addAgain: { detail: "When the syllabus has changed", missing: false } });
    expect(importRowFlag(superseded)).toBe("");
  });

  it("a row says what its import still needs, and nothing when it needs nothing", () => {
    const readable = entry({ rawText: "Week 1: ..." });
    expect(importRowFlag(importSheetView(readable, meets, NOW))).toBe("");
    // A class the import made that has no days to meet on yet.
    const noDays = { days: [] as "Mon"[], startTime: "", endTime: "" };
    expect(importRowFlag(importSheetView(readable, noDays, NOW))).toBe("Its class has no days yet");
    expect(importRowFlag(importSheetView(entry({ rawText: undefined }), noDays, NOW))).toBe("Ask AI can't read it · Its class has no days yet");
    // The class is gone: nothing to set days on.
    expect(importRowFlag(importSheetView(readable, undefined, NOW))).toBe("");
  });

  it("reads an import written by an older build that has no extracted course name", () => {
    const legacy = { ...entry(), courseName: undefined } as unknown as SyllabusImport;
    expect(() => importSheetView(legacy, meets, NOW)).not.toThrow();
    expect(importSheetView(legacy, meets, NOW).classDetails.join(" ")).not.toContain("Extracted as");
  });

  it("is not offered for an import that kept no record of what it made, and the sheet says why", () => {
    const view = importSheetView(entry({ createdTaskIds: undefined }), meets, NOW);
    expect(view.undo).toBeNull();
    expect(view.undoUnavailable).toBe("This import kept no record of what it added, so it cannot be undone.");
  });
});

describe("removing an import from the list", () => {
  it("says the tasks stay, how to take them out instead, and that its text goes too", () => {
    expect(importSheetView(entry(), meets, NOW).removeQuestion).toBe(
      'Remove "Principles of Finance" from this list? Its tasks stay in your plan. To take them out, use "Undo this import" instead. Its text goes too, so Ask AI and study guides can no longer use it.',
    );
  });

  it("does not point to an undo that is not there, or to text that was never kept", () => {
    expect(importSheetView(entry({ createdTaskIds: undefined, rawText: undefined }), meets, NOW).removeQuestion).toBe('Remove "Principles of Finance" from this list? Its tasks stay in your plan.');
    expect(importSheetView(entry({ rawText: undefined }), meets, NOW).removeQuestion).toBe('Remove "Principles of Finance" from this list? Its tasks stay in your plan. To take them out, use "Undo this import" instead.');
  });
});
