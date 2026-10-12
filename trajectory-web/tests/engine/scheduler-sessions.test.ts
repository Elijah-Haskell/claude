import { describe, expect, it } from "vitest";
import { convertToScheduleBlocks, scheduleTasksIntelligently } from "../../src/engine/intelligent-scheduler";
import { MIN_SESSION_MINUTES, planSessionChunks } from "../../src/engine/session-chunks";
import { classifyTaskKind, isTestedTask, isWritingTask } from "../../src/engine/task-kind";
import { DEFAULT_USER_PREFS, StudyStyle, Task } from "../../src/engine/types";
import { timeToMinutes } from "../../src/engine/utils";
import { makeClass, makeTask, minutesBetween, NOW, overlaps, schedState } from "./scheduler-fixtures";

const styles = (style: StudyStyle) => ({ ...DEFAULT_USER_PREFS, studyStyle: style });
const solve = (tasks: Task[], style: StudyStyle = "deep_blocks", classes = [makeClass()]) =>
  scheduleTasksIntelligently(tasks, schedState({ classes, userPrefs: styles(style) }), undefined, undefined, { now: NOW });

describe("planSessionChunks: deterministic chunking without stub sessions", () => {
  it("keeps small tasks whole and splits big ones evenly", () => {
    expect(planSessionChunks(45, 45)).toEqual([45]);
    expect(planSessionChunks(60, 90)).toEqual([60]);
    expect(planSessionChunks(60, 45)).toEqual([30, 30]);
    expect(planSessionChunks(100, 90)).toEqual([50, 50]);
    expect(planSessionChunks(90, 45)).toEqual([45, 45]);
    expect(planSessionChunks(180, 90)).toEqual([90, 90]);
    expect(planSessionChunks(15, 45)).toEqual([15]);
    expect(planSessionChunks(0, 45)).toEqual([]);
  });

  it("merges a would-be stub into the other sessions instead of creating a tiny one", () => {
    expect(planSessionChunks(47, 45)).toEqual([47]); // 24 + 23 would both be stubs
    expect(planSessionChunks(50, 45)).toEqual([25, 25]);
    expect(planSessionChunks(91, 90)).toEqual([46, 45]); // both halves are real sessions
  });

  it("is a pure function of its inputs and always adds up (property test over 1..600 minutes)", () => {
    for (const target of [45, 90]) {
      for (let total = 1; total <= 600; total += 1) {
        const chunks = planSessionChunks(total, target);
        expect(chunks.reduce((sum, c) => sum + c, 0)).toBe(total);
        expect(planSessionChunks(total, target)).toEqual(chunks);
        if (total >= MIN_SESSION_MINUTES) expect(Math.min(...chunks)).toBeGreaterThanOrEqual(MIN_SESSION_MINUTES);
        else expect(chunks).toEqual([total]);
        expect(Math.max(...chunks)).toBeLessThanOrEqual(Math.max(target * 1.34, MIN_SESSION_MINUTES * 2));
      }
    }
  });
});

describe("session count and buffer (bugs: 45-min task labelled '1/2'; 60 min became 60 + a 15-min stub)", () => {
  it("a 45-minute task is ONE session, labelled without a fraction", () => {
    for (const style of ["short_bursts", "deep_blocks"] as const) {
      const result = solve([makeTask({ estimatedMinutes: 45 })], style);
      expect(result.scheduledBlocks).toHaveLength(1);
      expect(result.scheduledBlocks[0]).toMatchObject({ durationMinutes: 45, sessionNumber: 1, totalSessions: 1 });
      const title = convertToScheduleBlocks(result.scheduledBlocks)[0]!.title;
      expect(title).not.toMatch(/\d+\/\d+/);
    }
  });

  it("a 60-minute task is one 60-minute session in deep-block mode, two 30s in short-burst mode - never 60 + 15", () => {
    const deep = solve([makeTask({ estimatedMinutes: 60 })], "deep_blocks").scheduledBlocks;
    expect(deep.map((b) => b.durationMinutes)).toEqual([60]);

    const bursts = solve([makeTask({ estimatedMinutes: 60 })], "short_bursts").scheduledBlocks;
    expect(bursts.map((b) => b.durationMinutes)).toEqual([30, 30]);
    expect(bursts.map((b) => `${b.sessionNumber}/${b.totalSessions}`)).toEqual(["1/2", "2/2"]);
  });

  it("the buffer is a gap between sessions, never extra study time", () => {
    const result = solve([makeTask({ estimatedMinutes: 240, dueDate: "2030-03-14" })]);
    const total = result.scheduledBlocks.reduce((sum, b) => sum + b.durationMinutes, 0);
    expect(total).toBe(240); // no +25% planning-fallacy sessions
    const sameDay = result.scheduledBlocks.filter((b) => b.date === result.scheduledBlocks[0]!.date).sort((a, b) => a.startTime.localeCompare(b.startTime));
    for (let i = 1; i < sameDay.length; i += 1) {
      expect(timeToMinutes(sameDay[i]!.startTime) - timeToMinutes(sameDay[i - 1]!.endTime)).toBeGreaterThanOrEqual(10);
    }
  });

  it("session numbers count the REAL sessions placed, in chronological order", () => {
    const result = solve([makeTask({ estimatedMinutes: 300, dueDate: "2030-03-20" })]);
    const blocks = [...result.scheduledBlocks];
    expect(blocks.map((b) => b.sessionNumber)).toEqual(blocks.map((_, i) => i + 1));
    expect(blocks.every((b) => b.totalSessions === blocks.length)).toBe(true);
    const chronological = [...blocks].sort((a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime));
    expect(chronological.map((b) => b.sessionNumber)).toEqual(blocks.map((b) => b.sessionNumber));
  });

  it("property: sum(placed) + missing == requested and no session is shorter than the minimum, for 15..600 minutes and many windows", () => {
    const windows = [
      { label: "roomy", due: "2030-03-20", classes: [makeClass()], noGo: DEFAULT_USER_PREFS.noGoZones },
      { label: "tight", due: "2030-03-14", classes: [makeClass({ days: ["Mon", "Tue", "Wed", "Thu", "Fri"], startTime: "08:00", endTime: "16:00" })], noGo: DEFAULT_USER_PREFS.noGoZones },
      { label: "fragmented", due: "2030-03-16", classes: [makeClass({ days: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"], startTime: "12:00", endTime: "13:30" })], noGo: [{ startTime: "16:15", endTime: "17:30" }, { startTime: "22:00", endTime: "07:00" }] },
    ];
    let checked = 0;
    for (const window of windows) {
      for (const style of ["short_bursts", "deep_blocks"] as const) {
        for (let estimate = 15; estimate <= 600; estimate += 15) {
          const task = makeTask({ id: `p-${checked}`, estimatedMinutes: estimate, dueDate: window.due });
          const result = scheduleTasksIntelligently(
            [task],
            schedState({ classes: window.classes, userPrefs: { ...DEFAULT_USER_PREFS, studyStyle: style, noGoZones: window.noGo } }),
            undefined,
            undefined,
            { now: NOW },
          );
          const blocks = result.scheduledBlocks.filter((b) => b.taskId === task.id);
          const placed = blocks.reduce((sum, b) => sum + b.durationMinutes, 0);
          const missing = result.shortfalls.find((s) => s.taskId === task.id)?.missingMinutes ?? 0;
          const label = `${window.label}/${style}/${estimate}`;

          expect(`${label}: ${placed + missing}`).toBe(`${label}: ${estimate}`);
          for (const block of blocks) {
            expect(`${label}: ${block.durationMinutes >= Math.min(MIN_SESSION_MINUTES, estimate)}`).toBe(`${label}: true`);
            expect(`${label}: ${block.totalSessions}`).toBe(`${label}: ${blocks.length}`);
          }
          expect(blocks.map((b) => b.sessionNumber).sort((a, b) => a - b)).toEqual(blocks.map((_, i) => i + 1));
          for (let i = 0; i < blocks.length; i += 1) {
            for (let j = i + 1; j < blocks.length; j += 1) expect(overlaps(blocks[i]!, blocks[j]!)).toBe(false);
          }
          checked += 1;
        }
      }
    }
    expect(checked).toBe(3 * 2 * 40);
  });
});

describe("labels follow the kind of work (bug: an essay due tomorrow was titled 'Practice Test')", () => {
  it("classifies tasks with an explicit, tested rule", () => {
    const kind = (name: string, explicit?: Task["kind"]) => classifyTaskKind({ name, kind: explicit });
    expect(kind("Midterm exam")).toBe("exam");
    expect(kind("Final Exam")).toBe("exam");
    expect(kind("Midterm 1")).toBe("exam");
    expect(kind("Test 2")).toBe("exam");
    expect(kind("Quiz 3")).toBe("quiz");
    expect(kind("Chemistry exam runway: Kinematics, Lab report analysis")).toBe("exam");
    expect(kind("Study for the biology final")).toBe("exam");
    expect(kind("Term paper")).toBe("assignment");
    expect(kind("Final paper")).toBe("assignment");
    expect(kind("Midterm essay")).toBe("assignment");
    expect(kind("Final project")).toBe("project");
    expect(kind("Organic chemistry lab report")).toBe("assignment");
    expect(kind("Physics problem set 4")).toBe("assignment");
    expect(kind("Read chapter 5")).toBe("other");
    expect(kind("Reading: chapter 5")).toBe("reading");
    expect(kind("Anything at all", "exam")).toBe("exam"); // an explicit kind always wins
    expect(kind("Midterm 1", "assignment")).toBe("assignment");

    expect(isTestedTask({ name: "Quiz 3" })).toBe(true);
    expect(isTestedTask({ name: "Final paper" })).toBe(false);
    expect(isWritingTask({ name: "Term paper" })).toBe(true);
    expect(isWritingTask({ name: "Midterm exam" })).toBe(false);
  });

  it("an essay/term paper due tomorrow never gets 'Practice Test' or retrieval-practice text", () => {
    for (const name of ["Term paper", "History essay draft", "Final paper"]) {
      const task = makeTask({ name, dueDate: "2030-03-14", estimatedMinutes: 90 });
      const result = solve([task]);
      const converted = convertToScheduleBlocks(result.scheduledBlocks);
      expect(converted.length).toBeGreaterThan(0);
      for (const [i, block] of converted.entries()) {
        expect(block.title).not.toMatch(/Practice Test/i);
        expect(block.title).toMatch(/^(Work on|Draft|Finalize): /);
        expect(block.whatCountsAsDone ?? "").not.toMatch(/retrieval|Do NOT re-read/i);
        expect(block.startRitual ?? "").not.toMatch(/practice test/i);
        expect(block.schedulingReason ?? "").not.toMatch(/retrieval practice/i);
        expect(result.scheduledBlocks[i]!.isRetrievalPractice).toBe(false);
      }
    }
  });

  it("a multi-session paper reads Draft -> Work on -> Finalize", () => {
    const task = makeTask({ name: "Term paper", dueDate: "2030-03-20", estimatedMinutes: 270 });
    const titles = convertToScheduleBlocks(solve([task]).scheduledBlocks).map((b) => b.title);
    expect(titles).toEqual(["Draft: Term paper (1/3)", "Work on: Term paper (2/3)", "Finalize: Term paper (3/3)"]);
  });

  it("problem sets and readings are 'Work on', never 'Finalize'/'Practice Test'", () => {
    const task = makeTask({ name: "Physics problem set 4", dueDate: "2030-03-18", estimatedMinutes: 180 });
    const titles = convertToScheduleBlocks(solve([task]).scheduledBlocks).map((b) => b.title);
    expect(titles.length).toBeGreaterThan(1);
    expect(titles.every((t) => t.startsWith("Work on: Physics problem set 4"))).toBe(true);
  });

  it("an exam due tomorrow gets a 'Practice Test' retrieval session with the right instructions", () => {
    const task = makeTask({ name: "Midterm exam", dueDate: "2030-03-14", estimatedMinutes: 90 });
    const result = solve([task]);
    const block = convertToScheduleBlocks(result.scheduledBlocks)[0]!;
    expect(result.scheduledBlocks[0]!.isRetrievalPractice).toBe(true);
    expect(block.title).toBe("Practice Test: Midterm exam");
    expect(block.whatCountsAsDone).toMatch(/Do NOT re-read/);
    expect(block.startRitual).toMatch(/practice test/i);
  });

  it("an exam far away is 'Review' until the last two sessions inside the final two days", () => {
    const task = makeTask({ name: "Midterm exam", dueDate: "2030-03-16", estimatedMinutes: 360 });
    const result = solve([task]);
    const blocks = result.scheduledBlocks;
    expect(blocks.length).toBeGreaterThanOrEqual(4);
    for (const block of blocks) {
      const daysBefore = (Date.UTC(2030, 2, 16) - Date.UTC(Number(block.date.slice(0, 4)), Number(block.date.slice(5, 7)) - 1, Number(block.date.slice(8)))) / 86400000;
      const lastTwo = block.sessionNumber >= blocks.length - 1;
      expect(block.isRetrievalPractice).toBe(daysBefore <= 2 && lastTwo);
      expect(convertToScheduleBlocks([block])[0]!.title.startsWith(block.isRetrievalPractice ? "Practice Test:" : "Review:")).toBe(true);
    }
    expect(blocks[0]!.isRetrievalPractice).toBe(false);
  });

  it("a quiz is a short review (never a 'Practice Test' block), an explicit exam kind overrides the name", () => {
    // Quizzes are now planned 1-2 days before they are taken, like every other task; a weekly 25-45 minute quiz
    // review must not turn into a retrieval-practice block just because it sits close to the quiz.
    const quiz = makeTask({ name: "Quiz 4", dueDate: "2030-03-14", estimatedMinutes: 45 });
    expect(solve([quiz]).scheduledBlocks[0]!.isRetrievalPractice).toBe(false);
    expect(convertToScheduleBlocks(solve([quiz]).scheduledBlocks)[0]!.title).toBe("Review: Quiz 4");
    const disguised = makeTask({ name: "Chapter 6", dueDate: "2030-03-14", estimatedMinutes: 45, kind: "exam" });
    expect(solve([disguised]).scheduledBlocks[0]!.isRetrievalPractice).toBe(true);
    const notAnExam = makeTask({ name: "Midterm reflection", dueDate: "2030-03-14", estimatedMinutes: 45, kind: "assignment" });
    expect(solve([notAnExam]).scheduledBlocks[0]!.isRetrievalPractice).toBe(false);
  });

  it("strategist labels keep priority over the derived verb", () => {
    const task = makeTask({
      name: "Lab report",
      dueDate: "2030-03-20",
      estimatedMinutes: 90,
      planningStrategy: {
        rationale: "Stage it.",
        priority: 3,
        sessions: [
          { label: "Outline", purpose: "draft", minutes: 45, earliestDaysBeforeDue: 6, targetDaysBeforeDue: 5 },
          { label: "Write up", purpose: "submit", minutes: 45, earliestDaysBeforeDue: 2, targetDaysBeforeDue: 1 },
        ],
      },
    });
    const titles = convertToScheduleBlocks(solve([task]).scheduledBlocks).map((b) => b.title);
    expect(titles).toEqual(["Study: Lab report — Outline", "Study: Lab report — Write up"]);
    expect(minutesBetween("10:00", "11:00")).toBe(60);
  });
});
