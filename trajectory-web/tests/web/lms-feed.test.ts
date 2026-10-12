import { describe, expect, it } from "vitest";
import { parseIcsDate, parseIcsEvents, unfoldIcsLines } from "../../src/engine/ics";
import {
  FEED_ITEM_DISMISSED,
  feedChangeActions,
  feedIsDue,
  feedItemsFromIcs,
  importFeedItems,
  isDeadlineEvent,
  normalizeFeedUrl,
  splitCourseSuffix,
  type FeedItem,
} from "../../src/lib/lms-feed";
import type { ClassBlock, Task } from "../../src/engine/types";

const pad = (n: number) => String(n).padStart(2, "0");
const localKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const localTime = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

const NOW = new Date(2026, 8, 26, 9, 0); // 26 Sep 2026 local

/** A Canvas-style feed (CRLF, folded lines, UTC due times, all-day events, a class meeting, a past assignment). */
const CANVAS_FEED = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//Instructure//Canvas//EN",
  "X-WR-CALNAME:Sam Student Calendar (Canvas)",
  "BEGIN:VEVENT",
  "DTEND:20261003T035900Z",
  "DTSTART:20261003T035900Z",
  "SUMMARY:Problem Set 4 [CHEM 101-001]",
  "UID:event-assignment-9001",
  "URL;VALUE=URI:https://school.instructure.com/courses/1/assignments/9001",
  "DESCRIPTION:Complete problems 1-20\\, show your work.\\nSubmit as PDF.",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "DTSTART;VALUE=DATE:20261009",
  "DTEND;VALUE=DATE:20261010",
  "SUMMARY:Midterm Exam [CHEM 101-001]",
  "UID:event-assignment-9002",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "DTSTART:20261005T140000Z",
  "DTEND:20261005T150000Z",
  "SUMMARY:Office hours [CHEM 101-001]",
  "UID:event-calendar-event-77",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "DTSTART:20260910T035900Z",
  "DTEND:20260910T035900Z",
  "SUMMARY:Problem Set 1 [CHEM 101-001]",
  "UID:event-assignment-8000",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "DTSTART;TZID=America/New_York:20261014T170000",
  "DTEND;TZID=America/New_York:20261014T170000",
  "SUMMARY:Reading response 3 — a very long title that the LMS folded onto the",
  "  next line [HIST 210]",
  "UID:event-assignment-9100",
  "BEGIN:VALARM",
  "TRIGGER:-PT15M",
  "SUMMARY:ignored alarm",
  "END:VALARM",
  "END:VEVENT",
  "END:VCALENDAR",
  "",
].join("\r\n");

describe("ics parser", () => {
  it("unfolds continuation lines", () => {
    expect(unfoldIcsLines("SUMMARY:Long\r\n  title\r\nUID:x")).toEqual(["SUMMARY:Long title", "UID:x"]);
  });

  it("reads all-day, UTC, TZID and floating times", () => {
    expect(parseIcsDate("20261009", { VALUE: "DATE" })).toEqual({ date: "2026-10-09", allDay: true });
    const utc = new Date(Date.UTC(2026, 9, 3, 3, 59));
    expect(parseIcsDate("20261003T035900Z")).toEqual({ date: localKey(utc), time: localTime(utc), allDay: false });
    // 17:00 in New York on 14 Oct 2026 is 21:00 UTC (EDT)
    const ny = new Date(Date.UTC(2026, 9, 14, 21, 0));
    expect(parseIcsDate("20261014T170000", { TZID: "America/New_York" })).toEqual({ date: localKey(ny), time: localTime(ny), allDay: false });
    expect(parseIcsDate("20261014T170000")).toEqual({ date: "2026-10-14", time: "17:00", allDay: false });
    expect(parseIcsDate("garbage")).toBeNull();
  });

  it("parses events, text escapes and nested alarms", () => {
    const events = parseIcsEvents(CANVAS_FEED);
    expect(events).toHaveLength(5);
    expect(events[0]!.description).toBe("Complete problems 1-20, show your work.\nSubmit as PDF.");
    expect(events[0]!.url).toBe("https://school.instructure.com/courses/1/assignments/9001");
    expect(events[4]!.summary).toBe("Reading response 3 — a very long title that the LMS folded onto the next line [HIST 210]");
  });

  it("tolerates LF-only files and events without an end", () => {
    const events = parseIcsEvents("BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:a\nSUMMARY:Quiz 2\nDTSTART;VALUE=DATE:20261101\nEND:VEVENT\nEND:VCALENDAR");
    expect(events).toEqual([expect.objectContaining({ uid: "a", summary: "Quiz 2", start: { date: "2026-11-01", allDay: true } })]);
  });
});

describe("feed -> deadlines", () => {
  it("keeps upcoming deadlines only, with course from the [COURSE] suffix", () => {
    const { items, skipped } = feedItemsFromIcs(CANVAS_FEED, { now: NOW });
    expect(items.map((i) => i.uid)).toEqual(["event-assignment-9001", "event-assignment-9002", "event-assignment-9100"]);
    expect(skipped).toBe(2); // office hours + a past assignment
    const ps4 = items[0]!;
    expect(ps4).toMatchObject({ title: "Problem Set 4", courseName: "CHEM 101-001" });
    const due = new Date(Date.UTC(2026, 9, 3, 3, 59));
    expect([ps4.dueDate, ps4.dueTime]).toEqual([localKey(due), localTime(due)]);
    expect(items[1]).toMatchObject({ title: "Midterm Exam", dueDate: "2026-10-09", dueTime: undefined, kind: "exam" });
  });

  it("recognises deadlines vs meetings", () => {
    const base = { uid: "x", categories: [], start: { date: "2026-10-01", allDay: true } };
    expect(isDeadlineEvent({ ...base, summary: "Essay 2 due" })).toBe(true);
    expect(isDeadlineEvent({ ...base, summary: "Lecture 5" })).toBe(false);
    expect(isDeadlineEvent({ ...base, summary: "Anything", uid: "event-assignment-1" })).toBe(true);
    expect(isDeadlineEvent({ ...base, summary: "Quiz 1", status: "CANCELLED" })).toBe(false);
  });

  it("a deadline at exactly midnight belongs to the previous day", () => {
    const ics = "BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:m\nSUMMARY:Lab report\nDTSTART:20261010T000000\nEND:VEVENT\nEND:VCALENDAR";
    expect(feedItemsFromIcs(ics, { now: NOW }).items[0]).toMatchObject({ dueDate: "2026-10-09", dueTime: undefined });
  });

  it("splits the course suffix and normalises feed links", () => {
    expect(splitCourseSuffix("HW 3 [MATH 2410]")).toEqual({ title: "HW 3", course: "MATH 2410" });
    expect(splitCourseSuffix("[Only brackets]")).toEqual({ title: "[Only brackets]", course: "" });
    expect(normalizeFeedUrl(" webcal://school.instructure.com/feeds/calendars/user_abc.ics ")).toBe("https://school.instructure.com/feeds/calendars/user_abc.ics");
    expect(normalizeFeedUrl("ftp://x.y/z.ics")).toBeNull();
    expect(normalizeFeedUrl("not a url")).toBeNull();
  });

  it("upgrades a plain http:// feed link to https:// (iOS blocks http downloads)", () => {
    expect(normalizeFeedUrl("http://school.instructure.com/feeds/calendars/user_abc.ics")).toBe("https://school.instructure.com/feeds/calendars/user_abc.ics");
    expect(normalizeFeedUrl(" http://canvas.school.edu/feed.ics ")).toBe("https://canvas.school.edu/feed.ics");
  });

  it("refreshes at most every 6 hours", () => {
    expect(feedIsDue(undefined, NOW)).toBe(true);
    expect(feedIsDue(new Date(NOW.getTime() - 5 * 3_600_000).toISOString(), NOW)).toBe(false);
    expect(feedIsDue(new Date(NOW.getTime() - 6 * 3_600_000).toISOString(), NOW)).toBe(true);
  });
});

describe("importFeedItems", () => {
  const chem: ClassBlock = { id: "c-chem", name: "CHEM 101 General Chemistry", days: ["Mon"], startTime: "09:00", endTime: "10:00", color: "#4F6EF7" };
  let n = 0;
  const makeId = () => `new-${++n}`;
  const item = (over: Partial<FeedItem> = {}): FeedItem => ({ uid: "u1", title: "Problem Set 4", courseName: "CHEM 101-001", dueDate: "2026-10-02", dueTime: "23:59", kind: "assignment", ...over });
  const task = (over: Partial<Task> = {}): Task => ({ id: "t1", name: "Problem Set 4", courseId: "c-chem", courseName: chem.name, dueDate: "2026-10-02", estimatedMinutes: 90, difficulty: 3, requiresOnCampus: false, status: "pending", createdAt: "2026-09-01T00:00:00.000Z", ...over });

  it("adds new deadlines linked to the matching class, and a second import changes nothing (dedupe by UID)", () => {
    const first = importFeedItems({ tasks: [], classes: [chem] }, [item()], {}, { now: NOW, makeId });
    expect(first.add).toHaveLength(1);
    expect(first.add[0]).toMatchObject({ name: "Problem Set 4", courseId: "c-chem", courseName: chem.name, dueDate: "2026-10-02", dueTime: "23:59", status: "pending", dateConfidence: "explicit" });
    const again = importFeedItems({ tasks: first.add, classes: [chem] }, [item()], first.links, { now: NOW, makeId });
    expect(again).toMatchObject({ add: [], update: [], unchanged: 1 });
  });

  it("a professor moving the due date moves the task", () => {
    const links = { u1: "t1" };
    const moved = importFeedItems({ tasks: [task({ dueTime: "23:59" })], classes: [chem] }, [item({ dueDate: "2026-10-06" })], links, { now: NOW, makeId });
    expect(moved.add).toEqual([]);
    expect(moved.update).toEqual([expect.objectContaining({ id: "t1", dueDate: "2026-10-06", dueTime: "23:59" })]);
  });

  it("links to the same assignment already imported from the syllabus instead of duplicating it", () => {
    const fromSyllabus = task({ id: "syl-1", dueDate: "2026-10-01" });
    const result = importFeedItems({ tasks: [fromSyllabus], classes: [chem] }, [item()], {}, { now: NOW, makeId });
    expect(result.add).toEqual([]);
    expect(result.links.u1).toBe("syl-1");
    expect(result.update[0]).toMatchObject({ id: "syl-1", dueDate: "2026-10-02" });
  });

  it("never brings back a task the student deleted, and leaves finished work alone", () => {
    const deleted = importFeedItems({ tasks: [], classes: [chem] }, [item()], { u1: "gone" }, { now: NOW, makeId });
    expect(deleted.add).toEqual([]);
    expect(deleted.links.u1).toBe(FEED_ITEM_DISMISSED);
    const done = importFeedItems({ tasks: [task({ status: "done" })], classes: [chem] }, [item({ dueDate: "2026-10-07" })], { u1: "t1" }, { now: NOW, makeId });
    expect(done.update).toEqual([]);
  });

  it("an unknown course still imports (labelled with the feed's course name)", () => {
    const result = importFeedItems({ tasks: [], classes: [chem] }, [item({ uid: "u9", title: "Essay 1", courseName: "HIST 210" })], {}, { now: NOW, makeId });
    expect(result.add[0]).toMatchObject({ courseId: "", courseName: "HIST 210" });
  });
});

describe("feedChangeActions (applying a refresh computed from an older snapshot)", () => {
  const task = (over: Partial<Task> = {}): Task => ({ id: "t1", name: "Problem Set 4", courseId: "c", courseName: "CHEM 101", dueDate: "2026-10-02", estimatedMinutes: 90, difficulty: 3, requiresOnCampus: false, status: "pending", createdAt: "2026-09-01T00:00:00.000Z", ...over });

  it("moves the due date on the CURRENT task, keeping what the student changed during the download", () => {
    const snapshot = task();
    const update = { ...snapshot, dueDate: "2026-10-06", dueTime: "23:59", dateConfidence: "explicit" as const, dateEvidence: "From your feed" };
    const current = task({ estimatedMinutes: 150, difficulty: 5, notes: "ask TA" } as Partial<Task>);
    const actions = feedChangeActions({ add: [], update: [update] }, [current]);
    expect(actions).toEqual([
      { type: "UPDATE_TASK", payload: { ...current, dueDate: "2026-10-06", dueTime: "23:59", dateConfidence: "explicit", dateEvidence: "From your feed" } },
    ]);
  });

  it("never reopens a task finished during the download, nor revives a deleted one, nor adds a task twice", () => {
    const update = { ...task(), dueDate: "2026-10-06" };
    expect(feedChangeActions({ add: [], update: [update] }, [task({ status: "done" })])).toEqual([]);
    expect(feedChangeActions({ add: [], update: [update] }, [])).toEqual([]);
    const added = task({ id: "new-1" });
    expect(feedChangeActions({ add: [added], update: [] }, [added])).toEqual([]);
    expect(feedChangeActions({ add: [added], update: [] }, [])).toEqual([{ type: "ADD_TASK", payload: added }]);
  });
});
