import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  followAfterScroll,
  LIVE_ANNOUNCE_EVERY_MS,
  LIVE_FOLLOW_SLOP,
  LIVE_FULL_NOTE,
  LIVE_LEAVE_NOTE,
  LIVE_NO_DATE,
  LIVE_STAGGER_MAX,
  LIVE_STAGGER_MS,
  LIVE_STAGGER_SLOW_MS,
  liveCountLabel,
  liveCountSpoken,
  liveCourseName,
  liveDateLabel,
  liveEmptyLine,
  liveIsTest,
  liveItemsOf,
  liveKindLabel,
  liveListIsFull,
  liveModeAfter,
  liveRowName,
  liveRowSpoken,
  liveStatus,
  liveWeekday,
  mergeLiveItems,
  revealDelay,
  revealPlan,
  revealStep,
  scrollsToNewest,
  shouldAnnounceCount,
  showsLiveList,
  type LiveItem,
  type LiveMode,
} from "../../src/lib/live-list";
import { DEFAULT_POLL_OPTIONS, LIVE_READING_POLL_OPTIONS, pollJob, pollSchedule, type JobPollProgress, type JobPollStatus } from "../../src/engine/poll-job";
import { readingExpectation } from "../../src/engine/syllabus-review";
import { LIVE_ITEMS_MAX } from "../../src/shared/live-import";

// The live import's screen half (lib/live-list.ts, components/syllabus/live-list.tsx): while a syllabus is read, the
// waiting screen fills in with the deadlines the server has found so far. The server's side is docs/live-import.md
// and tests/syllabus-live-import.test.ts.

const quiz = (n: number, date: string | null = `2026-09-${String(n).padStart(2, "0")}`): LiveItem => ({ name: `Quiz ${n}`, type: "quiz", date });
const quizzes = (n: number): LiveItem[] => Array.from({ length: n }, (_, index) => quiz(index + 1));
const progress = (items: LiveItem[] | undefined, extra: Partial<JobPollProgress> = {}): JobPollProgress => ({ stage: "reading", ...(items ? { items, itemsFound: items.length, courseName: null } : {}), ...extra });

describe("is there a list at all", () => {
  it("a server that sends `items` is live from its first report, even when the list is still empty", () => {
    expect(liveModeAfter("unknown", progress([]))).toBe("live");
    expect(liveModeAfter("unknown", progress(quizzes(3)))).toBe("live");
  });

  it("a report without `items` is a server from before the live import", () => {
    expect(liveModeAfter("unknown", { stage: "reading" })).toBe("legacy");
    expect(liveModeAfter("unknown", { stage: "reading-more", itemsFound: 12 })).toBe("legacy");
    expect(liveModeAfter("legacy", { stage: "finishing", itemsFound: 12 })).toBe("legacy");
  });

  it("an answer with no progress at all says nothing either way (a queued job, a finished one)", () => {
    for (const mode of ["unknown", "live", "legacy"] as LiveMode[]) {
      expect(liveModeAfter(mode, null)).toBe(mode);
      expect(liveModeAfter(mode, undefined)).toBe(mode);
    }
  });

  it("a reading that has shown its list keeps it, whatever a later answer leaves out", () => {
    expect(liveModeAfter("live", { stage: "finishing" })).toBe("live");
  });

  it("a file or photos start on the list's screen; an old server and pasted text never show it", () => {
    expect(showsLiveList({ isJob: true, mode: "unknown" })).toBe(true); // "nothing found yet" is true on any server
    expect(showsLiveList({ isJob: true, mode: "live" })).toBe(true);
    expect(showsLiveList({ isJob: true, mode: "legacy" })).toBe(false);
    for (const mode of ["unknown", "live", "legacy"] as LiveMode[]) expect(showsLiveList({ isJob: false, mode })).toBe(false);
  });
});

describe("the rows are the server's rows", () => {
  it("no progress, or a progress without `items`, is no list (not an empty one)", () => {
    expect(liveItemsOf(null)).toBeNull();
    expect(liveItemsOf(undefined)).toBeNull();
    expect(liveItemsOf({ stage: "reading", itemsFound: 4 })).toBeNull();
    expect(liveItemsOf(progress([]))).toEqual([]);
  });

  it("keeps every row in the server's order, and never more than the server's own limit", () => {
    const rows = quizzes(5);
    expect(liveItemsOf(progress(rows))).toEqual(rows);
    expect(liveItemsOf(progress(quizzes(LIVE_ITEMS_MAX + 30)))).toHaveLength(LIVE_ITEMS_MAX);
  });

  it("tidies a row it cannot read instead of dropping it, so the rows after it keep their place", () => {
    const odd = [quiz(1), { name: "  Lab  ", type: "lab", date: "soon" }, null, quiz(4)] as unknown as LiveItem[];
    expect(liveItemsOf(progress(odd))).toEqual([quiz(1), { name: "Lab", type: "other", date: null }, { name: "", type: "other", date: null }, quiz(4)]);
  });

  it("the list on screen never gets shorter", () => {
    const shown = quizzes(6);
    expect(mergeLiveItems(shown, quizzes(4))).toEqual(shown); // a second model that has found less so far
    expect(mergeLiveItems(shown, null)).toEqual(shown); // a dropped check, or a report without a list
    expect(mergeLiveItems(shown, [])).toEqual(shown);
    expect(mergeLiveItems(null, null)).toBeNull();
    expect(mergeLiveItems(null, [])).toEqual([]);
  });

  it("a longer list replaces the one shown, and a row the server corrected is corrected in place", () => {
    const shown = quizzes(3);
    const longer = [quiz(1), { name: "Quiz 2 (moved)", type: "quiz", date: "2026-09-20" } as LiveItem, quiz(3), quiz(4)];
    expect(mergeLiveItems(shown, longer)).toEqual(longer);
    const sameLength = [quiz(1), quiz(2, null), quiz(3)];
    expect(mergeLiveItems(shown, sameLength)).toEqual(sameLength);
  });

  it("a row that has not changed stays the same object, so only the new rows are drawn", () => {
    const shown = quizzes(2);
    const merged = mergeLiveItems(shown, quizzes(4))!; // the server sends the whole list again, as new objects
    expect(merged).toHaveLength(4);
    expect(merged[0]).toBe(shown[0]);
    expect(merged[1]).toBe(shown[1]);
    const corrected = mergeLiveItems(shown, [quizzes(1)[0]!, quiz(2, null)])!;
    expect(corrected[0]).toBe(shown[0]);
    expect(corrected[1]).not.toBe(shown[1]);
  });

  it("an answer that changes nothing hands back the very same list, and never changes one it was given", () => {
    const shown = Object.freeze(quizzes(3)) as readonly LiveItem[];
    expect(mergeLiveItems(shown, quizzes(3))).toBe(shown);
    expect(mergeLiveItems(shown, null)).toBe(shown);
    expect(mergeLiveItems(shown, quizzes(2))).toBe(shown);
    const incoming = Object.freeze(quizzes(5)) as readonly LiveItem[];
    expect(mergeLiveItems(shown, incoming)).toEqual(incoming); // frozen lists: a write would throw
  });

  it("the course's name appears when the model has written it, and then stays", () => {
    expect(liveCourseName(null, progress([], { courseName: null }))).toBeNull();
    expect(liveCourseName(null, progress(quizzes(1), { courseName: "  Principles of Finance " }))).toBe("Principles of Finance");
    expect(liveCourseName("Principles of Finance", progress(quizzes(2), { courseName: null }))).toBe("Principles of Finance");
    expect(liveCourseName("Principles of Finance", null)).toBe("Principles of Finance");
    expect(liveCourseName("Finance", progress(quizzes(2), { courseName: "Principles of Finance" }))).toBe("Principles of Finance");
  });
});

describe("how a row reads", () => {
  it("names its kind", () => {
    expect((["exam", "quiz", "assignment", "project", "reading", "other"] as const).map(liveKindLabel)).toEqual(["Exam", "Quiz", "Assignment", "Project", "Reading", "Other"]);
  });

  it("flags exams and quizzes only", () => {
    expect(liveIsTest({ name: "Exam 1", type: "exam", date: null })).toBe(true);
    expect(liveIsTest(quiz(1))).toBe(true);
    expect(liveIsTest({ name: "HW 1", type: "assignment", date: null })).toBe(false);
  });

  it("shows a date as the day it is, and says so plainly when there is none", () => {
    expect(liveDateLabel("2026-09-02")).toBe("Sep 2");
    expect(liveDateLabel("2026-09-02", "2026-08-20")).toBe("Sep 2");
    expect(liveDateLabel("2027-01-11", "2026-12-01")).toBe("Jan 11, 2027");
    expect(liveDateLabel(null)).toBe(LIVE_NO_DATE);
    expect(liveDateLabel("not a date")).toBe(LIVE_NO_DATE);
    expect(LIVE_NO_DATE).toBe("No date yet");
    expect(liveWeekday("2026-09-02")).toBe("Wed");
    expect(liveWeekday(null)).toBe("");
  });

  it("an item the model left unnamed shows as its kind, never a made-up name", () => {
    expect(liveRowName({ name: "", type: "quiz", date: null })).toBe("Quiz");
    expect(liveRowName(quiz(3))).toBe("Quiz 3");
  });

  it("is read aloud as its name, its kind and its date", () => {
    expect(liveRowSpoken(quiz(2))).toBe("Quiz 2, quiz, Wednesday, September 2");
    expect(liveRowSpoken({ name: "Term paper", type: "project", date: null })).toBe("Term paper, project, no date yet");
    expect(liveRowSpoken({ name: "", type: "exam", date: "2026-12-15" })).toBe("Exam, Tuesday, December 15"); // not "Exam, exam"
  });
});

describe("the words around the list", () => {
  it("labels the list as found so far, never as final: the result can have fewer rows, and the list stops at the server's limit", () => {
    expect(liveCountLabel({ count: 0 })).toBe("Nothing found yet");
    expect(liveCountLabel({ count: 1 })).toBe("1 found so far");
    expect(liveCountLabel({ count: 43 })).toBe("43 found so far");
    expect(liveCountLabel({ count: LIVE_ITEMS_MAX })).toBe(`${LIVE_ITEMS_MAX} found so far`);
    expect(liveCountSpoken(12)).toBe("12 found so far.");
    // The label takes no stage at all, so no stage can make it read as final (the last one, "finishing", least of all).
    expect(liveCountLabel.length).toBe(1);
    expect(liveCountLabel({ count: 43, stage: "finishing" } as Parameters<typeof liveCountLabel>[0])).toBe("43 found so far");
  });

  it("a reading that is picked up again does not say nothing was found before the server has answered", () => {
    expect(liveCountLabel({ count: 0, asking: true })).toBe("Checking what was found");
    expect(liveEmptyLine(null, { asking: true })).toMatch(/Asking the server what it has found so far/);
    expect(liveCountLabel({ count: 30, asking: true })).toBe("30 found so far"); // once rows are there, they count
  });

  it("before the server's first answer the frame promises no rows: an older server sends none", () => {
    expect(liveEmptyLine(null, { answered: false })).toBe("The reading is starting.");
    expect(liveEmptyLine("reading", { answered: false })).toBe("The reading is starting.");
    expect(liveEmptyLine("reading", { answered: true })).toBe("Each deadline appears here as it is read.");
    expect(liveCountLabel({ count: 0 })).toBe("Nothing found yet"); // true on any server
  });

  it("says so when the list has reached the most rows the server sends", () => {
    expect(liveListIsFull(LIVE_ITEMS_MAX - 1)).toBe(false);
    expect(liveListIsFull(LIVE_ITEMS_MAX)).toBe(true);
    expect(LIVE_FULL_NOTE).toContain(String(LIVE_ITEMS_MAX));
    expect(LIVE_FULL_NOTE).toMatch(/next step/);
  });

  it("names the stage the server reports, with the clock's line where a stage has no more to say", () => {
    const expectation = readingExpectation({ kind: "file", elapsedMs: 12_000 });
    expect(liveStatus({ stage: "reading", expectation })).toEqual({ title: "Finding deadlines", sub: "Usually 1 to 3 minutes" });
    expect(liveStatus({ stage: null, expectation })).toEqual({ title: "Finding deadlines", sub: "Usually 1 to 3 minutes" });
    expect(liveStatus({ stage: "reading-more", expectation }).title).toBe("Reading the rest");
    expect(liveStatus({ stage: "second-look", expectation })).toEqual({ title: "Taking a slower second look", sub: "The first read wasn't usable." });
    expect(liveStatus({ stage: "finishing", expectation })).toEqual({ title: "Finishing up", sub: "Saving the text. You check the dates next." });
  });

  it("every stage's line fits one line of the status block, so the block does not change height under the list", () => {
    // About 46 characters of 13pt text fit the block on a 375pt iPhone.
    for (const stage of ["reading", "reading-more", "second-look", "finishing"] as const) {
      for (const reconnecting of [false, true]) {
        for (const elapsedMs of [5_000, 400_000]) {
          const { sub } = liveStatus({ stage, reconnecting, expectation: readingExpectation({ kind: "file", elapsedMs, reconnecting }) });
          expect((sub ?? "").length, `${stage}: ${sub}`).toBeLessThanOrEqual(46);
        }
      }
    }
  });

  it("says the app can be left in one line", () => {
    expect(LIVE_LEAVE_NOTE).toBe("You can leave the app. It keeps reading.");
  });

  it("a dropped connection says so and keeps the stage's name", () => {
    expect(liveStatus({ stage: "reading", reconnecting: true, expectation: "Usually 1 to 3 minutes" })).toEqual({ title: "Finding deadlines", sub: "The connection dropped. Reconnecting…" });
    expect(liveStatus({ stage: "finishing", reconnecting: true }).title).toBe("Finishing up");
  });

  it("does not promise rows one by one from a second look, which reports all at once", () => {
    expect(liveEmptyLine("reading")).toBe("Each deadline appears here as it is read.");
    expect(liveEmptyLine(null)).toBe("Each deadline appears here as it is read.");
    expect(liveEmptyLine("second-look")).toBe("This read reports its dates together, when it is done.");
  });

  it("claims no percentage and no count the server did not send", () => {
    const words = [liveStatus({ stage: "reading" }), liveStatus({ stage: "reading-more" }), liveStatus({ stage: "second-look" }), liveStatus({ stage: "finishing" })].map((status) => `${status.title} ${status.sub ?? ""}`).join(" ");
    expect(words).not.toMatch(/%|\d/);
  });
});

describe("rows flowing in", () => {
  it("the rows of one answer land one after another", () => {
    expect(revealPlan(0, 1)).toEqual({ jumpTo: 0, staggered: 1 });
    expect(revealPlan(4, 10)).toEqual({ jumpTo: 4, staggered: 6 });
    expect(revealPlan(10, 10)).toEqual({ jumpTo: 10, staggered: 0 });
  });

  it("a long list that arrives at once is simply there, except its last few rows: forty rows are not replayed", () => {
    expect(revealPlan(0, 40)).toEqual({ jumpTo: 40 - LIVE_STAGGER_MAX, staggered: LIVE_STAGGER_MAX });
    expect(revealPlan(12, 400)).toEqual({ jumpTo: 400 - LIVE_STAGGER_MAX, staggered: LIVE_STAGGER_MAX });
  });

  it("with Reduce Motion, or on coming back to a reading, everything is simply there", () => {
    expect(revealPlan(0, 40, { instant: true })).toEqual({ jumpTo: 40, staggered: 0 });
    expect(revealPlan(7, 9, { instant: true })).toEqual({ jumpTo: 9, staggered: 0 });
  });

  it("never plans to show fewer rows than are on screen", () => {
    for (const [shown, total] of [[0, 0], [3, 3], [9, 4], [5, 30]] as const) {
      const plan = revealPlan(shown, total);
      expect(plan.jumpTo).toBeGreaterThanOrEqual(Math.min(shown, total));
      expect(plan.jumpTo + plan.staggered).toBe(total);
    }
  });

  it("spreads the rows that are waiting over the second until the next answer, and hurries when many wait", () => {
    expect(revealDelay(1)).toBe(LIVE_STAGGER_SLOW_MS);
    expect(revealDelay(2)).toBe(450);
    expect(revealDelay(3)).toBe(300);
    expect(revealDelay(6)).toBe(150);
    expect(revealDelay(8)).toBe(LIVE_STAGGER_MS);
    expect(revealDelay(400)).toBe(LIVE_STAGGER_MS);
    expect(revealDelay(0)).toBe(LIVE_STAGGER_SLOW_MS); // never a pause the list could hang on
    for (let waiting = 1; waiting < 12; waiting++) expect(revealDelay(waiting + 1)).toBeLessThanOrEqual(revealDelay(waiting));
  });

  /** Plays the list's steps from `shown` until it has caught up with `total`, as the screen does. */
  const play = (shown: number, total: number, options: { instant?: boolean } = {}) => {
    const steps: NonNullable<ReturnType<typeof revealStep>>[] = [];
    for (let step = revealStep(shown, total, options); step; step = revealStep(step.shown, total, options)) {
      steps.push(step);
      if (steps.length > 1000) throw new Error("the reveal does not end");
    }
    return steps;
  };

  it("one step is one row landing, the row after the last one shown, and then the list has caught up", () => {
    expect(revealStep(3, 3)).toBeNull();
    expect(revealStep(9, 3)).toBeNull(); // a shorter list than the screen has: nothing to do, nothing taken away
    expect(revealStep(3, 5)).toEqual({ shown: 4, fresh: 3, delayMs: revealDelay(2), jump: false });
    const steps = play(10, 14);
    expect(steps.map((step) => step.shown)).toEqual([11, 12, 13, 14]);
    expect(steps.map((step) => step.fresh)).toEqual([10, 11, 12, 13]); // each row eases in once, in order
    expect(steps.every((step) => !step.jump)).toBe(true);
  });

  it("a long list first appears up to its last few rows without moving, then those land one by one", () => {
    const steps = play(0, 40);
    expect(steps[0]).toEqual({ shown: 40 - LIVE_STAGGER_MAX, fresh: -1, delayMs: 0, jump: true });
    expect(steps.slice(1).map((step) => step.fresh)).toEqual(Array.from({ length: LIVE_STAGGER_MAX }, (_, index) => 40 - LIVE_STAGGER_MAX + index));
    expect(steps.filter((step) => step.jump)).toHaveLength(1);
    expect(steps.at(-1)!.shown).toBe(40);
  });

  it("with Reduce Motion, or coming back to a reading, it is one step and no row eases in", () => {
    expect(play(0, 40, { instant: true })).toEqual([{ shown: 40, fresh: -1, delayMs: 0, jump: true }]);
    expect(play(38, 43, { instant: true })).toEqual([{ shown: 43, fresh: -1, delayMs: 0, jump: true }]);
  });

  it("keeps up with a real reading (two rows a second) and a fast one (five a second) without falling behind", () => {
    for (const perAnswer of [2, 5]) {
      // An answer a second for twenty seconds; between answers the list takes its steps as their pauses allow.
      let shown = 0;
      let total = 0;
      let behindAtMost = 0;
      for (let second = 0; second < 20; second++) {
        total += perAnswer;
        let budget = 1_000;
        for (let step = revealStep(shown, total); step && step.delayMs <= budget; step = revealStep(shown, total)) {
          budget -= step.delayMs;
          shown = step.shown;
        }
        behindAtMost = Math.max(behindAtMost, total - shown);
      }
      expect(behindAtMost, `${perAnswer} rows an answer`).toBeLessThanOrEqual(perAnswer + 1);
    }
  });
});

describe("following the newest row", () => {
  const at = (input: Partial<Parameters<typeof followAfterScroll>[0]>) => followAfterScroll({ following: true, offsetY: 500, lastOffsetY: 500, distanceFromEnd: 300, ...input });

  it("keeps following while the list scrolls itself down to a new row", () => {
    expect(at({ offsetY: 540, lastOffsetY: 500, distanceFromEnd: 60 })).toBe(true);
  });

  it("stops when the student scrolls up, and stays stopped while they read", () => {
    expect(at({ offsetY: 420, lastOffsetY: 500, distanceFromEnd: 380 })).toBe(false);
    expect(at({ following: false, offsetY: 421, lastOffsetY: 420, distanceFromEnd: 379 })).toBe(false);
  });

  it("follows again once they are back at the end", () => {
    expect(at({ following: false, offsetY: 790, lastOffsetY: 700, distanceFromEnd: LIVE_FOLLOW_SLOP })).toBe(true);
    expect(at({ following: false, offsetY: 800, lastOffsetY: 790, distanceFromEnd: -6 })).toBe(true); // the bounce past the end
  });

  it("a jitter of a point or two is not the student scrolling up", () => {
    expect(at({ offsetY: 498, lastOffsetY: 500, distanceFromEnd: 302 })).toBe(true);
  });

  it("a finger on the list stops it following at any speed, even three points at a time", () => {
    expect(at({ offsetY: 497, lastOffsetY: 500, distanceFromEnd: 303, byHand: true })).toBe(false);
    expect(at({ offsetY: 500, lastOffsetY: 500, distanceFromEnd: 60, byHand: true })).toBe(false);
    // Still at the end under the finger: it keeps following.
    expect(at({ offsetY: 499, lastOffsetY: 500, distanceFromEnd: LIVE_FOLLOW_SLOP - 2, byHand: true })).toBe(true);
  });

  it("does not scroll by itself under a finger or under VoiceOver", () => {
    expect(scrollsToNewest({ following: true, dragging: false, screenReader: false })).toBe(true);
    expect(scrollsToNewest({ following: false, dragging: false, screenReader: false })).toBe(false);
    expect(scrollsToNewest({ following: true, dragging: true, screenReader: false })).toBe(false);
    expect(scrollsToNewest({ following: true, dragging: false, screenReader: true })).toBe(false);
  });
});

describe("what VoiceOver hears", () => {
  it("the first row, then the count now and then, not every row", () => {
    expect(shouldAnnounceCount({ count: 0, lastCount: 0, sinceLastMs: 99_999 })).toBe(false);
    expect(shouldAnnounceCount({ count: 1, lastCount: 0, sinceLastMs: 0 })).toBe(true);
    expect(shouldAnnounceCount({ count: 2, lastCount: 1, sinceLastMs: 900 })).toBe(false);
    expect(shouldAnnounceCount({ count: 9, lastCount: 1, sinceLastMs: LIVE_ANNOUNCE_EVERY_MS })).toBe(true);
    expect(shouldAnnounceCount({ count: 9, lastCount: 9, sinceLastMs: 60_000 })).toBe(false); // nothing new to say
  });

  it("once more when the reading is finishing, when its last rows have all landed", () => {
    expect(shouldAnnounceCount({ count: 43, lastCount: 38, sinceLastMs: 1_000, finishing: true, settled: true })).toBe(true);
    expect(shouldAnnounceCount({ count: 43, lastCount: 43, sinceLastMs: 1_000, finishing: true, settled: true })).toBe(false);
  });

  it("the last rows and the finishing stage arrive together: the rows landing one by one are not each spoken", () => {
    // 38 rows were spoken a second ago; the answer brings 43 and "finishing"; the rows land at 39, 40, 41, 42, 43.
    const said: number[] = [];
    let last = { count: 38, at: 0 };
    [39, 40, 41, 42, 43].forEach((count, index) => {
      const now = 1_000 + index * 130;
      if (!shouldAnnounceCount({ count, lastCount: last.count, sinceLastMs: now - last.at, finishing: true, settled: count === 43 })) return;
      said.push(count);
      last = { count, at: now };
    });
    expect(said).toEqual([43]);
  });
});

describe("how often a reading is asked about", () => {
  const schedule = pollSchedule({ ...DEFAULT_POLL_OPTIONS, ...LIVE_READING_POLL_OPTIONS });

  it("first after a second, then once a second for the first minute and a half", () => {
    expect(schedule.slice(0, 90)).toEqual(Array(90).fill(1_000));
    // Never faster than once a second: the server brings its list up to date twice a second at most.
    expect(Math.min(...schedule.slice(0, -1))).toBe(1_000);
  });

  it("then slows down again, so a reading that hangs is not asked at full speed until the deadline", () => {
    expect(schedule[90]).toBe(1_000);
    expect(schedule[91]).toBe(1_250);
    expect(schedule[95]).toBeGreaterThan(schedule[92]!);
    expect(Math.max(...schedule)).toBe(DEFAULT_POLL_OPTIONS.maxIntervalMs);
    expect(schedule.reduce((sum, wait) => sum + wait, 0)).toBe(DEFAULT_POLL_OPTIONS.deadlineMs);
    // Under 200 checks for a reading that runs to the deadline (a job cannot run past ten minutes on the server).
    expect(schedule.length).toBeLessThan(200);
  });

  it("leaves every other poll as it was", () => {
    expect(DEFAULT_POLL_OPTIONS.steadyMs).toBe(0);
    expect(pollSchedule(DEFAULT_POLL_OPTIONS).slice(0, 4)).toEqual([2_000, 2_500, 3_125, 3_906]);
    expect(pollSchedule({ initialDelayMs: 1000, intervalMs: 1000, backoff: 2, maxIntervalMs: 4000, deadlineMs: 10_000 })).toEqual([1000, 1000, 2000, 4000, 2000]);
  });

  it("failed checks are retried exactly as before, on the faster schedule", async () => {
    const answers: (JobPollStatus<string> | Error)[] = [
      { status: "running", elapsedMs: 1_000, progress: progress(quizzes(2)) },
      new TypeError("Network request failed"),
      new TypeError("Network request failed"),
      { status: "running", elapsedMs: 4_000, progress: progress(quizzes(9)) },
      { status: "done", elapsedMs: 5_000, result: "read" },
    ];
    const waits: number[] = [];
    const ticks: number[] = [];
    let failed = 0;
    const result = await pollJob<string>(
      async () => {
        const next = answers.shift()!;
        if (next instanceof Error) throw next;
        return next;
      },
      {
        ...LIVE_READING_POLL_OPTIONS,
        sleep: async (ms) => void waits.push(ms),
        onTick: (status) => ticks.push(status.status === "running" ? status.progress?.items?.length ?? -1 : -2),
        onCheckError: () => void failed++,
      },
    );
    expect(result).toBe("read");
    expect(waits).toEqual([1_000, 1_000, 1_000, 1_000, 1_000]);
    expect(ticks).toEqual([2, 9, -2]); // the list is there again after the gap, longer
    expect(failed).toBe(2);
  });
});

describe("the screen keeps the rules", () => {
  const root = resolve(__dirname, "../..");
  const read = (file: string) => readFileSync(join(root, file), "utf8").replace(/\r\n/g, "\n");
  const list = read("src/components/syllabus/live-list.tsx");
  const step = read("src/components/syllabus/reading-step.tsx");
  const screen = read("src/screens/syllabus.tsx");

  it("draws every row from the server's list: no placeholder rows, no skeletons", () => {
    expect(list).toContain("items.slice(0, shown).map(");
    expect(list.match(/<LiveRow\b/g)).toHaveLength(1);
    expect(list).not.toMatch(/skeleton|placeholder|shimmer|Array\.from|Array\(/i);
  });

  it("rows cannot be clicked or edited here: the only button is the way back to the newest row", () => {
    const buttons = list.match(/<button\b/g) ?? [];
    expect(buttons).toHaveLength(1);
    expect(list).toContain('aria-label="Jump to the newest"');
    expect(list).not.toMatch(/<input|<textarea|onDoubleClick|contentEditable/);
  });

  it("each row is one thing for a screen reader, and the count is announced through the rule, not for every row", () => {
    expect(list).toContain("aria-label={liveRowSpoken(item)}");
    expect(list).toContain("shouldAnnounceCount(");
    expect(list).toContain("settled: shown >= total");
    // One polite live region carries the count; the rows themselves are not a live region.
    expect(list.match(/aria-live="polite"/g)).toHaveLength(1);
  });

  it("the time so far can be heard on the list's screen too", () => {
    const live = step.slice(step.indexOf("function LiveReadingStep"), step.indexOf("export function ReadingStep"));
    expect(live).toContain("seconds so far");
  });

  it("nothing moves with Reduce Motion on", () => {
    expect(list).toContain("useReduceMotion()");
    expect(list).toContain("instant: reduceMotion ||");
    expect(list).toContain("animate={!reduceMotion && index === reveal.fresh}");
    expect(list).toContain("still={reduceMotion}");
    // The list is placed at its newest row, not scrolled there.
    expect(list).toContain('const glide = why === "rows" && !placeNext.current && !reduceMotion;');
    expect(list).toContain('behavior: glide ? "smooth" : "auto"');
    expect(list).toContain('behavior: reduceMotion ? "auto" : "smooth"'); // the "Newest" button
  });

  it("a list that arrives long is placed at its end, not scrolled there row by row", () => {
    expect(list).toContain("if (step.jump) placeNext.current = true;");
  });

  it("a reading picked up at launch is not opened a second time over an import screen that is already open", () => {
    const resume = read("src/components/headless/resume-pending-extraction.tsx");
    expect(resume).toContain('if (active && pending && routeRef.current !== "syllabus") navigate("syllabus");');
  });

  it("no type under 12px", () => {
    for (const text of [list, step]) {
      const sizes = [...text.matchAll(/fontSize:\s*(\d+(?:\.\d+)?)/g)].map((match) => Number(match[1]));
      expect(sizes.length).toBeGreaterThan(0);
      expect(Math.min(...sizes)).toBeGreaterThanOrEqual(12);
    }
  });

  it("the clock and Cancel stay in view: on the list's screen only the list scrolls", () => {
    const live = step.slice(step.indexOf("function LiveReadingStep"), step.indexOf("export function ReadingStep"));
    expect(live).toContain("<LiveList ");
    expect(live).toContain("formatClock(elapsedMs)");
    expect(live).toContain('label="Cancel"');
    expect(live).toContain("<FlowFooter hint={leaveNote ? LIVE_LEAVE_NOTE : null}>");
  });

  it("the list stays on its newest row when rows arrive and when its frame changes size, while it is following", () => {
    expect(list).toContain('keepUp("rows");');
    expect(list).toContain('keepUp("frame");');
    expect(list).toContain("if (scrollsToNewest({ following: follow.current, dragging: dragging.current, screenReader })) ");
    expect(list).toContain("byHand: dragging.current");
  });

  it("the time bar still shows time passing, not how much has been read", () => {
    const live = step.slice(step.indexOf("function LiveReadingStep"), step.indexOf("export function ReadingStep"));
    expect(live).toContain("<TimeBar fraction={readingTimeFraction(elapsedMs)} />");
    expect(live).not.toMatch(/items\.length\s*\//);
  });

  it("without a list the screen is the one it was", () => {
    expect(step).toContain("return live ? <LiveReadingStep {...rest} live={live} /> : <PlainReadingStep {...rest} rows={rows} />;");
    const plain = step.slice(step.indexOf("function PlainReadingStep"));
    expect(plain).not.toContain("LiveList");
    expect(plain).toContain("rows.map((row, index)");
  });

  it("asks once a second for a reading, and feeds the list from the server's answers", () => {
    expect(screen).toContain("...LIVE_READING_POLL_OPTIONS,");
    expect(screen).toContain("setLiveItems((shown) => mergeLiveItems(shown, liveItemsOf(now)));");
    expect(screen).toContain("showsLiveList({ isJob: isExtracting && !sendingFile, mode: liveMode })");
  });

  it("a dropped check leaves the rows alone", () => {
    const onError = screen.slice(screen.indexOf("onCheckError: () => {"), screen.indexOf("isCancelled: () => stale()"));
    expect(onError).toContain("setReconnecting(true)");
    expect(onError).not.toMatch(/setLive/);
  });

  it("never carries a live row into the review or the plan: those are built from the result alone", () => {
    // The list is named twice: where it is kept, and where it is handed to the waiting screen's `live` prop.
    expect(screen.match(/\bliveItems\b/g)).toHaveLength(2);
    expect(screen).toContain("live={liveList ? { items: liveItems ?? [],");
    expect(screen).toContain('answered: liveMode === "live"');
    expect(screen).toContain("setDrafts(buildDraftItems(items, { today, idPrefix: runId }));");
    // The same for the course's name as the model had written it: the class is named from the result.
    expect(screen.match(/\bliveCourse\b/g)).toHaveLength(2);
    expect(screen).toContain("courseName: liveCourse,");
    expect(screen).toContain("const detectedName = extraction.course.name || courseName || courseHint.trim();");
    // A new read starts from "the server has not answered yet", whatever the last one found.
    expect(screen).toContain('setLiveMode("unknown");');
    // It is dropped when the wait ends, and when the student cancels.
    expect(screen.match(/setLiveItems\(null\);/g)).toHaveLength(3); // a new read, the wait's end, Cancel
  });

  it("every reading, pasted text included, runs as a job the browser can come back to", () => {
    expect(screen).toContain('mutate("ai.startSyllabusExtraction", request)');
    expect(screen).toContain('query("ai.syllabusExtractionStatus", { jobId: id })');
    expect(screen).not.toContain('"ai.extractSyllabus"');
  });
});
