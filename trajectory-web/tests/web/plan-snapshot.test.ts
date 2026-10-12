// What a saved plan contains and how it is written and read (lib/plan-snapshot.ts). The two privacy promises are
// proven here: an event read from the iPhone's calendars and a course feed's link can never be in a snapshot.
import { gunzipSync as nodeGunzip, gzipSync as nodeGzip } from "node:zlib";
import { describe, expect, it, vi } from "vitest";

// The realistic plans below are made with the app's own reducer, which lives next to the React provider.


vi.mock("@react-native-async-storage/async-storage", () => ({
  default: { getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined },
}));
// The compression library's own text helpers must never be used: without a TextEncoder they write every emoji
// wrongly, and what the app's JavaScript engine offers instead is not what these tests run on. Here they blow up,
// so every test in this file also proves the snapshot does without them.
vi.mock("fflate", async (original) => {
  const unusable = () => {
    throw new Error("the saved plan must not turn text into bytes with the compression library");
  };
  return { ...(await original<typeof import("fflate")>()), strToU8: unusable, strFromU8: unusable };
});

import { CALENDAR_REPLAN_LABEL, reducer } from "../../src/engine/app-context";
import {
  MAX_PLAN_JSON_BYTES,
  base64ToBytes,
  bytesToBase64,
  canonicalJson,
  decodePlanSnapshot,
  encodePlanSnapshot,
  encodePlanSnapshotInSlices,
  hashText,
  isBlankPlan,
  isPristineState,
  planStateChanged,
  preparePlan,
  stateForLoadedPlan,
  utf8Bytes,
  utf8Length,
  utf8Text,
  type PlanContents,
} from "../../src/lib/plan-snapshot";
import { createInitialState, toLocalPersistedState } from "../../src/engine/state-persistence";
import type { AppState, GoogleCalendarEventLocal, ScheduleBlock } from "../../src/engine/types";
import { MAX_PLAN_SNAPSHOT_CHARS, PLAN_SNAPSHOT_VERSION, parsePlanEnvelope } from "../../src/shared/plan-sync";
import { fiveCourseState } from "../engine/fixtures/stress-semester";

type Action = Parameters<typeof reducer>[1];
const run = (state: AppState, ...actions: Action[]) => actions.reduce(reducer, state);
const NOW = new Date(2026, 8, 7, 8, 5);

/** A heavy five-course semester, planned by the real planner (a few hundred sessions). */
const semester = (): AppState => run({ ...createInitialState(), ...fiveCourseState() }, { type: "AUTO_BUILD_WEEK", payload: { now: NOW } });

const contentsOf = (state: AppState, extra: Partial<PlanContents> = {}): PlanContents => ({ state, feedLinks: {}, feedCount: 0, ...extra });

/** The plan's JSON as it sits inside a snapshot (read with Node's own zlib, not with the code under test). */
function jsonInside(snapshot: string): string {
  const envelope = JSON.parse(snapshot) as { data: string };
  return nodeGunzip(Buffer.from(envelope.data, "base64")).toString("utf8");
}

function snapshotOf(contents: PlanContents): string {
  const encoded = encodePlanSnapshot(preparePlan(contents).json);
  if (!encoded.ok) throw new Error("too large");
  return encoded.snapshot;
}

/** An envelope around any bytes, to hand the decoder things the encoder never writes. */
const envelope = (data: string, overrides: Record<string, unknown> = {}) => JSON.stringify({ format: "trajectory-plan", v: 1, encoding: "gzip-base64", data, ...overrides });
const gz = (text: string) => nodeGzip(Buffer.from(text, "utf8")).toString("base64");

describe("one text for one plan (canonicalJson, hashText)", () => {
  it("writes what JSON.stringify writes, with the keys of every object in alphabetical order", () => {
    const value = { b: 1, a: [{ z: null, y: "é", x: [1.5, -0, 1e21, true, false] }], c: { d: {}, a: [] } };
    expect(canonicalJson(value)).toBe('{"a":[{"x":[1.5,0,1e+21,true,false],"y":"é","z":null}],"b":1,"c":{"a":[],"d":{}}}');
    expect(JSON.parse(canonicalJson(value))).toEqual(JSON.parse(JSON.stringify(value)));
  });

  it("leaves out what JSON leaves out and turns the rest into null the same way", () => {
    const value = { keep: 1, gone: undefined, fn: () => 1, list: [undefined, () => 1, NaN, Infinity], when: new Date("2026-10-05T12:00:00.000Z") };
    expect(canonicalJson(value)).toBe('{"keep":1,"list":[null,null,null,null],"when":"2026-10-05T12:00:00.000Z"}');
    expect(JSON.parse(canonicalJson(value))).toEqual(JSON.parse(JSON.stringify(value)));
  });

  it("does not depend on the order the keys were added in", () => {
    const one = { name: "Quiz 4", dueDate: "2026-10-09", tags: { b: 2, a: 1 } };
    const other = { tags: { a: 1, b: 2 }, dueDate: "2026-10-09", name: "Quiz 4" };
    expect(canonicalJson(one)).toBe(canonicalJson(other));
    expect(hashText(canonicalJson(one))).toBe(hashText(canonicalJson(other)));
  });

  it("keeps emoji whole and writes half an emoji as an escape, so every text survives the trip", () => {
    const whole = "Study 📚 with Zoë, 数学, שלום";
    const cut = "Notes 📚".slice(0, -1); // text cut in the middle of an emoji: a lone surrogate
    expect(canonicalJson(whole)).toBe(JSON.stringify(whole));
    expect(canonicalJson(cut)).toBe('"Notes \\ud83d"');
    expect(JSON.parse(canonicalJson({ cut, whole }))).toEqual({ cut, whole });
  });

  it("the fingerprint is the same for the same text and different for a different one", () => {
    const a = canonicalJson({ tasks: [{ id: "t1", name: "Essay" }] });
    const b = canonicalJson({ tasks: [{ id: "t1", name: "Essay!" }] });
    expect(hashText(a)).toBe(hashText(a));
    expect(hashText(a)).not.toBe(hashText(b));
    expect(hashText("ab")).not.toBe(hashText("ba"));
    expect(hashText(a)).toMatch(/^[0-9a-z]+-[0-9a-f]{16}$/);
  });
});

describe("text as UTF-8 bytes and back, without TextEncoder or TextDecoder", () => {
  const asNode = (text: string) => Buffer.from(text, "utf8");
  const samples = [
    "",
    "plain ASCII, {\"json\":[1,2.5,null]}\n\t",
    "Zoë Müller · résumé · «El Niño» — ½",
    "数学の宿題 · שלום · Ελληνικά · हिन्दी",
    "🎓📚✔️ 𝒜𝓑 👩🏽‍🎓 🇨🇦",
    // The first and last character of every length: 1, 2, 3 and 4 bytes.
    "\u0000\u007f\u0080\u07ff\u0800\ud7ff\ue000\uffff\u{10000}\u{10ffff}",
  ];
  /** A text of `length` characters picked from every range by a fixed sequence (the same on every run). */
  function sampleText(seed: number, length: number, withHalves = false): string {
    let state = seed >>> 0 || 1;
    const next = () => {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      return (state >>>= 0);
    };
    let text = "";
    for (let i = 0; i < length; i++) {
      const pick = next() % (withHalves ? 12 : 10);
      if (pick < 4) text += String.fromCharCode(next() % 0x80);
      else if (pick < 6) text += String.fromCharCode(0x80 + (next() % 0x780));
      else if (pick < 8) text += String.fromCharCode(0x800 + (next() % 0xd000)); // up to U+D7FF
      else if (pick < 9) text += String.fromCharCode(0xe000 + (next() % 0x2000));
      else if (pick < 10) text += String.fromCodePoint(0x10000 + (next() % 0x100000));
      else text += String.fromCharCode(0xd800 + (next() % 0x800)); // half a pair, anywhere
    }
    return text;
  }

  it("writes exactly the bytes Node writes, for every kind of character", () => {
    for (const text of samples) {
      expect(Buffer.from(utf8Bytes(text)).equals(asNode(text)), JSON.stringify(text)).toBe(true);
      expect(utf8Length(text), JSON.stringify(text)).toBe(asNode(text).length);
    }
    // An emoji is four bytes, not the six that writing its two halves one by one would give.
    expect(Array.from(utf8Bytes("📚"))).toEqual([0xf0, 0x9f, 0x93, 0x9a]);
  });

  it("reads them back exactly", () => {
    for (const text of samples) expect(utf8Text(utf8Bytes(text)), JSON.stringify(text)).toBe(text);
    expect(utf8Text(asNode(samples.join("|")))).toBe(samples.join("|"));
  });

  it("also where a long text is put together piece by piece, with an emoji across every seam", () => {
    for (const lead of [8189, 8190, 8191, 8192, 8193]) {
      const text = `${"x".repeat(lead)}${"🎓é数".repeat(6000)}`;
      const bytes = utf8Bytes(text);
      expect(Buffer.from(bytes).equals(asNode(text)), String(lead)).toBe(true);
      expect(utf8Text(bytes) === text, String(lead)).toBe(true);
    }
  });

  it("agrees with Node on thousands of texts of every mix, half surrogate pairs included", () => {
    for (let seed = 1; seed <= 3000; seed++) {
      const text = sampleText(seed * 2654435761, seed % 60, seed % 3 === 0);
      const bytes = utf8Bytes(text);
      const node = asNode(text); // half a pair becomes U+FFFD there too
      if (!Buffer.from(bytes).equals(node)) throw new Error(`bytes differ for seed ${seed}`);
      if (utf8Length(text) !== node.length) throw new Error(`length differs for seed ${seed}`);
      if (utf8Text(bytes) !== node.toString("utf8")) throw new Error(`text differs for seed ${seed}`);
    }
  });

  it("bytes that are not UTF-8 never throw and never turn into a character they do not spell", () => {
    const read = (...bytes: number[]) => utf8Text(Uint8Array.from(bytes));
    expect(read(0x61, 0xff, 0x62)).toBe("a\ufffdb");
    expect(read(0x61, 0x80, 0x62)).toBe("a\ufffdb"); // a continuation byte on its own
    expect(read(0xc3)).toBe("\ufffd"); // cut short at the end
    expect(read(0xe2, 0x82)).not.toMatch(/[^\ufffd]/);
    expect(read(0xf0, 0x9f, 0x93)).not.toMatch(/[^\ufffd]/);
    expect(read(0xc3, 0x41)).toBe("\ufffdA"); // cut short in the middle: what follows is kept
    // Overlong forms of "/" and of NUL, an encoded half surrogate, and a code point beyond the last one.
    for (const bad of [[0xc0, 0xaf], [0xe0, 0x80, 0xaf], [0xf0, 0x80, 0x80, 0xaf], [0xc0, 0x80], [0xed, 0xa0, 0x80], [0xed, 0xbf, 0xbf], [0xf4, 0x90, 0x80, 0x80], [0xf8, 0x88, 0x80, 0x80, 0x80]]) {
      expect(read(...bad), bad.map((b) => b.toString(16)).join(" ")).not.toMatch(/[^\ufffd]/);
    }
    // Any bytes at all: no error, and what comes out is proper text (it survives being written and read again).
    let state = 0x9e3779b9;
    for (let round = 0; round < 2000; round++) {
      const bytes = new Uint8Array(round % 50);
      for (let i = 0; i < bytes.length; i++) {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        bytes[i] = state & 255;
      }
      const text = utf8Text(bytes);
      if (utf8Text(utf8Bytes(text)) !== text) throw new Error(`round ${round}`);
      if (/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(text)) throw new Error(`half a pair in round ${round}`);
    }
  });
});

describe("base64 without Buffer, btoa or atob", () => {
  const bytesOf = (length: number, seed: number) => Uint8Array.from({ length }, (_, i) => (i * 131 + seed * 17 + (i >> 3)) & 255);

  it("writes exactly what Node's Buffer writes, for every length", () => {
    for (let length = 0; length <= 70; length++) {
      const bytes = bytesOf(length, length);
      expect(bytesToBase64(bytes), `length ${length}`).toBe(Buffer.from(bytes).toString("base64"));
      expect(Array.from(base64ToBytes(bytesToBase64(bytes))!), `length ${length}`).toEqual(Array.from(bytes));
    }
  });

  it("round-trips a large buffer (many chunks)", () => {
    const bytes = bytesOf(200_003, 7);
    const text = bytesToBase64(bytes);
    expect(text).toBe(Buffer.from(bytes).toString("base64"));
    expect(Buffer.from(base64ToBytes(text)!).equals(Buffer.from(bytes))).toBe(true);
  });

  it("refuses anything that is not base64", () => {
    for (const bad of ["abc", "ab=c", "a===", "=abc", "ab c", "abc\n", "abcé", "ab-_", "abcd=", "abcde==="]) {
      expect(base64ToBytes(bad), JSON.stringify(bad)).toBeNull();
    }
    expect(Array.from(base64ToBytes("")!)).toEqual([]);
    expect(Array.from(base64ToBytes("TQ==")!)).toEqual([77]);
    expect(Array.from(base64ToBytes("TWE=")!)).toEqual([77, 97]);
  });
});

describe("a plan survives being saved and loaded", () => {
  const state = semester();
  const firstClass = state.classes[0]!;
  const withUnicode: AppState = {
    ...state,
    user: { id: "local", email: "", name: "Zoë Müller 🎓", currentSemester: "Fall 2026", createdAt: "2026-08-20T10:00:00.000Z" },
    tasks: state.tasks.map((task, i) => (i === 0 ? { ...task, name: "Leer capítulo 3: «El Niño» — 数学 📚 שלום" } : task)),
    syllabusImports: [{ id: "imp1", importedAt: "2026-08-21T10:00:00.000Z", courseName: firstClass.name, linkedClassId: firstClass.id, linkedClassName: firstClass.name, itemCount: 3, skippedCount: 0, isNewClass: true, rawText: "Week 1 …\nÜbung 2 — “quotes” and\ttabs\n".repeat(200) }],
  };
  const contents: PlanContents = { state: withUnicode, feedLinks: { "event-assignment-101": state.tasks[1]!.id, "event-assignment-102": "__dismissed__" }, feedCount: 1 };
  const prepared = preparePlan(contents);
  const encoded = encodePlanSnapshot(prepared.json);

  it("is the envelope the server expects, far below its size limit", () => {
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    expect(encoded.snapshot.startsWith('{"format":"trajectory-plan","v":1,"encoding":"gzip-base64","data":"')).toBe(true);
    expect(parsePlanEnvelope(encoded.snapshot)).toMatchObject({ format: "trajectory-plan", v: PLAN_SNAPSHOT_VERSION, encoding: "gzip-base64" });
    console.log(`five-course semester: ${Math.round(prepared.json.length / 1024)} KB of JSON -> ${Math.round(encoded.snapshot.length / 1024)} KB snapshot`);
    expect(prepared.json.length).toBeGreaterThan(100_000);
    expect(encoded.snapshot.length).toBeLessThan(200_000);
    expect(encoded.snapshot.length).toBeLessThan(prepared.json.length / 4);
  });

  it("holds exactly the plan's JSON, readable by any gzip (Node's own here)", () => {
    if (!encoded.ok) throw new Error("too large");
    expect(jsonInside(encoded.snapshot)).toBe(prepared.json);
    // The layout: two parts, the keys of every object in alphabetical order.
    const plan = JSON.parse(prepared.json) as Record<string, any>;
    expect(Object.keys(plan)).toEqual(["courseFeeds", "state"]);
    expect(plan.courseFeeds).toEqual({ count: 1, links: contents.feedLinks });
    expect(Object.keys(plan.state)).toEqual([
      "classes", "examPreps", "grades", "healthPrefs", "onboardingComplete", "planAlerts", "practiceExams", "recommendations",
      "recurringEvents", "scheduleBlocks", "semester", "studyGuides", "syllabusImports", "tasks", "user", "userPrefs",
    ]);
    expect(canonicalJson(plan)).toBe(prepared.json);
  });

  it("comes back as the same plan: state, feed links, unicode and all", () => {
    if (!encoded.ok) throw new Error("too large");
    const decoded = decodePlanSnapshot(encoded.snapshot);
    expect(decoded.kind).toBe("plan");
    if (decoded.kind !== "plan") return;
    const { plan } = decoded;
    expect(plan.state.tasks).toEqual(withUnicode.tasks);
    expect(plan.state.user).toEqual(withUnicode.user);
    expect(plan.state.classes).toEqual(withUnicode.classes);
    expect(plan.state.semester).toEqual(withUnicode.semester);
    expect(plan.state.syllabusImports).toEqual(withUnicode.syllabusImports);
    expect(plan.state.scheduleBlocks).toEqual(toLocalPersistedState(withUnicode).scheduleBlocks);
    expect(plan.state.onboardingComplete).toBe(true);
    expect(plan.feedLinks).toEqual(contents.feedLinks);
    expect(plan.feedCount).toBe(1);
    // Saved again from what was loaded, it is the same text with the same fingerprint (and again after that).
    const again = preparePlan(plan);
    expect(again.json).toBe(prepared.json);
    expect(again.hash).toBe(prepared.hash);
    const third = decodePlanSnapshot(snapshotOf(plan));
    expect(third.kind === "plan" && preparePlan(third.plan).hash).toBe(prepared.hash);
  });

  it("compressed a slice at a time it is the same plan, and the app gets a breath between slices", async () => {
    let pauses = 0;
    const sliced = await encodePlanSnapshotInSlices(prepared.json, async () => {
      pauses++;
    });
    expect(sliced.ok).toBe(true);
    if (!sliced.ok) return;
    expect(pauses).toBeGreaterThanOrEqual(2); // more than 128 KB of JSON: at least three slices
    expect(jsonInside(sliced.snapshot)).toBe(prepared.json);
    const decoded = decodePlanSnapshot(sliced.snapshot);
    expect(decoded.kind === "plan" && preparePlan(decoded.plan).hash).toBe(prepared.hash);
    // A plan shorter than one slice, and an empty text, are one slice with no pause.
    pauses = 0;
    const small = await encodePlanSnapshotInSlices(preparePlan(contentsOf(createInitialState())).json, async () => {
      pauses++;
    });
    expect(small.ok && decodePlanSnapshot(small.snapshot).kind).toBe("plan");
    expect(pauses).toBe(0);
  });

  it("reads a snapshot compressed by something else (Node's zlib)", () => {
    const decoded = decodePlanSnapshot(envelope(gz(prepared.json)));
    expect(decoded.kind === "plan" && preparePlan(decoded.plan).hash).toBe(prepared.hash);
  });

  it("gives the same fingerprint whatever order the app built its objects in", () => {
    const reorder = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(reorder);
      if (typeof value !== "object" || value === null) return value;
      return Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reorder(item)]));
    };
    const shuffled: PlanContents = {
      state: reorder(withUnicode) as AppState,
      feedLinks: reorder(contents.feedLinks) as PlanContents["feedLinks"],
      feedCount: 1,
    };
    expect(Object.keys(shuffled.state)[0]).not.toBe(Object.keys(withUnicode)[0]);
    expect(preparePlan(shuffled).json).toBe(prepared.json);
    expect(preparePlan(shuffled).hash).toBe(prepared.hash);
  });

  it("the fingerprint follows the plan, not the iPhone: a change to the plan changes it, the feed count does not", () => {
    expect(preparePlan({ ...contents, feedCount: 0 }).hash).toBe(prepared.hash);
    expect(preparePlan({ ...contents, feedCount: 0 }).json).not.toBe(prepared.json);
    const done = { ...withUnicode, tasks: withUnicode.tasks.map((task, i) => (i === 3 ? { ...task, status: "done" as const } : task)) };
    expect(preparePlan({ ...contents, state: done }).hash).not.toBe(prepared.hash);
    expect(preparePlan({ ...contents, feedLinks: { ...contents.feedLinks, "event-assignment-103": "t-new" } }).hash).not.toBe(prepared.hash);
  });
});

describe("what never goes into a snapshot", () => {
  const SECRET = "ZZ-PRIVATE-DENTIST-7731";
  const deviceEvent = (overrides: Partial<GoogleCalendarEventLocal> = {}): GoogleCalendarEventLocal => ({
    id: `${SECRET}-id@2026-09-09T19:00:00.000Z`, calendarId: `${SECRET}-calendar`, title: `${SECRET} appointment`, description: `${SECRET} notes`,
    startDate: "2026-09-09", endDate: "2026-09-09", startTime: "14:00", endTime: "15:00", isAllDay: false, isRecurring: false, status: "active",
    syncedAt: "2026-09-07T13:05:00.000Z", source: "device", ...overrides,
  });

  it("PRIVACY: an event read from the iPhone's calendars is in no part of a snapshot, however full the state is of it", () => {
    const base = semester();
    const block: ScheduleBlock = base.scheduleBlocks.find((b) => b.type === "study")!;
    const state: AppState = {
      ...base,
      deviceCalendarEvents: [deviceEvent(), deviceEvent({ id: `${SECRET}-2`, title: `${SECRET} lunch`, isAllDay: true })],
      googleCalendarEvents: [deviceEvent({ id: `${SECRET}-g`, source: "google", title: `${SECRET} google event` })],
      googleCalendarConnected: true,
      googleCalendarLastSync: `${SECRET}-sync`,
      notificationSettings: { enabled: true, leadTimeHours: 24, reminders: [{ id: "r1", leadTimeHours: 1, label: `${SECRET} reminder` }] },
      undoSnapshots: [{ label: `${SECRET} undo`, at: "2026-09-07T13:00:00.000Z", scheduleBlocks: [{ ...block, title: `${SECRET} block` }], tasks: [] }],
      replanNotice: { label: `${SECRET} notice`, summary: `${SECRET} summary`, at: "2026-09-07T13:00:00.000Z" },
      inputsBeforeEdit: { calendarChanged: true, scheduleBlocks: [{ ...block, title: `${SECRET} before` }] },
    };
    const prepared = preparePlan(contentsOf(state));
    const snapshot = snapshotOf(contentsOf(state));
    expect(prepared.json).not.toContain(SECRET);
    expect(jsonInside(snapshot)).not.toContain(SECRET);
    expect(snapshot).not.toContain(SECRET);
    // None of the fields those things live in exists in a plan at all.
    const plan = JSON.parse(prepared.json) as { state: Record<string, unknown> };
    for (const field of ["deviceCalendarEvents", "googleCalendarEvents", "googleCalendarConnected", "googleCalendarLastSync", "notificationSettings", "undoSnapshots", "replanNotice", "inputsBeforeEdit"]) {
      expect(plan.state, field).not.toHaveProperty(field);
    }
    // The same state written to this iPhone's own storage does hold the event: the check above is not vacuous.
    expect(JSON.stringify(toLocalPersistedState(state))).toContain(SECRET);
  });

  it("PRIVACY: nor after the planner has moved a session off that event and told the student about it", () => {
    // The real path: a plan, an iPhone calendar event landing on a session, the automatic re-plan around it.
    const planned = run(semester(), { type: "ADD_RECURRING_EVENT", payload: { id: "job", title: "Job shift", days: ["Tue", "Thu"], startTime: "16:00", endTime: "21:00", color: "#EC4899", locked: true } }, { type: "AUTO_REPLAN", payload: { now: NOW } });
    const target = planned.scheduleBlocks.find((b) => b.type === "study" && b.taskId && b.completionStatus === "pending" && b.date > "2026-09-07")!;
    const event = deviceEvent({ id: `${SECRET}@${target.date}`, startDate: target.date, endDate: target.date, startTime: target.startTime, endTime: target.endTime });
    const after = run(planned, { type: "SET_DEVICE_CALENDAR_EVENTS", payload: [event] }, { type: "AUTO_REPLAN", payload: { now: NOW } });
    // The planner really worked around the event.
    expect(after.replanNotice?.label).toBe(CALENDAR_REPLAN_LABEL);
    expect(after.scheduleBlocks.some((b) => b.id === target.id && b.date === target.date && b.startTime === target.startTime && b.completionStatus === "pending")).toBe(false);
    expect(after.deviceCalendarEvents?.[0]?.title).toContain(SECRET);

    for (const state of [after, reducer(after, { type: "UNDO_REPLAN", now: new Date(NOW.getTime() + 60_000) })]) {
      const snapshot = snapshotOf(contentsOf(state));
      expect(jsonInside(snapshot)).not.toContain(SECRET);
      expect(jsonInside(snapshot)).not.toContain("appointment");
    }
  });

  it("PRIVACY: a course feed's link is never in a snapshot, only which of its items became tasks and how many feeds there were", () => {
    const TOKEN = "user_Qx7SECRETfeedTOKEN91";
    // What lib/lms-feed-store.ts keeps on the iPhone.
    const stored = {
      feeds: [{ id: "f1", url: `https://canvas.school.edu/feeds/calendars/${TOKEN}.ics`, label: "canvas.school.edu", addedAt: "2026-09-01T10:00:00.000Z", lastFetchedAt: "2026-09-07T10:00:00.000Z", lastStatus: "ok" as const, lastCount: 12 }],
      links: { "event-assignment-101": "task-a", "event-assignment-102": "__dismissed__" },
    };
    // The only two things of it a plan takes (components/plan-sync.tsx): the links and the number of feeds.
    const json = preparePlan(contentsOf(semester(), { feedLinks: stored.links, feedCount: stored.feeds.length })).json;
    expect(JSON.parse(json).courseFeeds).toEqual({ count: 1, links: stored.links });
    for (const secret of [TOKEN, "https://", "feeds/calendars", ".ics", "canvas.school.edu"]) expect(json, secret).not.toContain(secret);
    // Even handed the whole store where the links belong, nothing but uid -> task id pairs gets through.
    const mistaken = preparePlan(contentsOf(semester(), { feedLinks: stored as unknown as PlanContents["feedLinks"], feedCount: 1 })).json;
    expect(JSON.parse(mistaken).courseFeeds).toEqual({ count: 1, links: {} });
    expect(mistaken).not.toContain(TOKEN);
    const nested = preparePlan(contentsOf(semester(), { feedLinks: { ok: "task-a", feed: stored.feeds[0] } as unknown as PlanContents["feedLinks"], feedCount: 1 })).json;
    expect(JSON.parse(nested).courseFeeds.links).toEqual({ ok: "task-a" });
    expect(nested).not.toContain(TOKEN);
  });

  it("this iPhone's notification settings, OS notification ids and the time of the last plan run stay out", () => {
    const base = semester();
    const state: AppState = {
      ...base,
      notificationSettings: { enabled: true, leadTimeHours: 6, sessionStart: false },
      scheduleBlocks: base.scheduleBlocks.map((b, i) => (i === 0 ? { ...b, notificationId: "os-notification-41" } : b)),
      planAlerts: { shortfalls: [], overdueTasks: [], computedAt: "2026-09-07T13:05:00.000Z" },
    };
    const json = preparePlan(contentsOf(state)).json;
    expect(json).not.toContain("os-notification-41");
    expect(json).not.toContain("notificationId");
    expect(json).not.toContain("computedAt");
    expect(json).not.toContain("sessionStart");
    // A plan run that changes nothing but its own timestamp is not a change of the plan.
    const later = { ...state, planAlerts: { ...state.planAlerts!, computedAt: "2026-09-08T09:00:00.000Z" } };
    expect(preparePlan(contentsOf(later)).hash).toBe(preparePlan(contentsOf(state)).hash);
    // What the plan could not fit is kept: a loaded plan does not always trigger the re-plan that would work it out again.
    const short = { ...state, planAlerts: { computedAt: "x", overdueTasks: [], shortfalls: [{ taskId: state.tasks[0]!.id, taskName: "Essay", dueDate: "2026-09-20", requestedMinutes: 120, placedMinutes: 60, missingMinutes: 60, overdue: false, reason: "No free time left" }] } };
    const loaded = decodePlanSnapshot(snapshotOf(contentsOf(short)));
    expect(loaded.kind === "plan" && loaded.plan.state.planAlerts?.shortfalls).toEqual(short.planAlerts.shortfalls);
  });

  it("grade tracking is gone: a plan has no grade book, and the grade weights an earlier build kept on a class stay out", () => {
    const WEIGHT = "ZZ-OLD-GRADE-WEIGHT";
    const base = semester();
    const cls = base.classes[0]!;
    const clean: AppState = {
      ...base,
      syllabusImports: [{ id: "imp1", importedAt: "2026-08-21T10:00:00.000Z", courseName: cls.name, linkedClassId: cls.id, linkedClassName: cls.name, itemCount: 3, skippedCount: 0, isNewClass: false, previousClass: cls }],
    };
    // A state as an earlier build left it in memory: every class, and the copy an import keeps for its undo, with weights.
    const weights = (id: string) => ({ gradeComponents: [{ id: `${id}-gc-0`, name: WEIGHT, weight: 40 }] });
    const old = {
      ...clean,
      classes: clean.classes.map((c) => ({ ...c, ...weights(c.id) })),
      syllabusImports: clean.syllabusImports!.map((entry) => ({ ...entry, previousClass: { ...cls, ...weights(cls.id) } })),
    } as AppState;
    // This iPhone's own copy does hold them until it is next loaded: the checks below are not vacuous.
    expect(JSON.stringify(toLocalPersistedState(old))).toContain(WEIGHT);

    const prepared = preparePlan(contentsOf(old));
    for (const gone of [WEIGHT, "gradeComponents", "gradeBook"]) expect(prepared.json, gone).not.toContain(gone);
    // Nothing else of the classes is lost: it is, to the letter, the plan without them.
    expect(prepared.json).toBe(preparePlan(contentsOf(clean)).json);
    const decoded = decodePlanSnapshot(snapshotOf(contentsOf(old)));
    expect(decoded.kind === "plan" && decoded.plan.state.classes).toEqual(clean.classes);
  });

  it("a reset semester is saved as an emptied plan", () => {
    const reset = run(semester(), { type: "RESET_SEMESTER" });
    const afterReset = JSON.parse(preparePlan(contentsOf(reset)).json);
    expect(afterReset.state.classes).toEqual([]);
    expect(afterReset.state.tasks).toEqual([]);
    expect(isBlankPlan({ state: reset })).toBe(true);
  });
});

describe("reading a snapshot defensively", () => {
  const good = snapshotOf(contentsOf(semester()));
  const data = (JSON.parse(good) as { data: string }).data;

  it("something that is not a plan is unreadable", () => {
    for (const bad of [null, undefined, 42, {}, "", "{", "[]", "null", '"text"', JSON.stringify({ format: "other", v: 1, encoding: "gzip-base64", data }), JSON.stringify({ format: "trajectory-plan", v: 0, encoding: "gzip-base64", data }), JSON.stringify({ format: "trajectory-plan", v: 1.5, encoding: "gzip-base64", data }), JSON.stringify({ format: "trajectory-plan", v: 1, encoding: "gzip-base64" })]) {
      expect(decodePlanSnapshot(bad).kind, JSON.stringify(bad)?.slice(0, 60)).toBe("unreadable");
    }
  });

  it("a higher version or an unknown encoding was written by a newer version of Trajectory: it is told apart", () => {
    expect(decodePlanSnapshot(envelope(data, { v: PLAN_SNAPSHOT_VERSION + 1 })).kind).toBe("newer-version");
    expect(decodePlanSnapshot(envelope(data, { v: 7 })).kind).toBe("newer-version");
    expect(decodePlanSnapshot(envelope(data, { encoding: "zstd-base64" })).kind).toBe("newer-version");
    expect(decodePlanSnapshot(envelope("anything at all", { v: 2, encoding: "brotli" })).kind).toBe("newer-version");
    expect(decodePlanSnapshot(envelope(data)).kind).toBe("plan");
  });

  it("damaged data is unreadable, never a half-read plan", () => {
    const bytes = Buffer.from(data, "base64");
    const flipped = Buffer.from(bytes);
    flipped[Math.floor(bytes.length / 2)] ^= 0x55;
    const wrongChecksum = Buffer.from(bytes);
    wrongChecksum[bytes.length - 6] ^= 0xff;
    const wrongLength = Buffer.from(bytes);
    wrongLength[bytes.length - 4] ^= 0x01;
    for (const [name, bad] of [
      ["not base64", "%%%not-base64%%%"],
      ["base64 of plain text", Buffer.from("just some text, long enough to pass for a file").toString("base64")],
      ["cut short", bytes.subarray(0, bytes.length - 40).toString("base64")],
      ["cut in half", bytes.subarray(0, bytes.length >> 1).toString("base64")],
      ["a flipped byte", flipped.toString("base64")],
      ["a wrong checksum", wrongChecksum.toString("base64")],
      ["a wrong length", wrongLength.toString("base64")],
      ["empty", ""],
    ] as const) {
      expect(decodePlanSnapshot(envelope(bad)).kind, name).toBe("unreadable");
    }
  });

  it("valid gzip of something that is not a plan is unreadable", () => {
    for (const text of ["not json", "[1,2,3]", "null", '"plan"', "{}", '{"state":[]}', '{"state":"x"}', '{"gradeBook":{}}']) {
      expect(decodePlanSnapshot(envelope(gz(text))).kind, text).toBe("unreadable");
    }
  });

  it("a snapshot that claims to hold more than 32 MB is refused before anything is allocated", () => {
    const bytes = Buffer.from(data, "base64");
    const huge = Buffer.from(bytes);
    huge.writeUInt32LE(0xfffffff0, huge.length - 4); // "4 GB inside"
    const justOver = Buffer.from(bytes);
    justOver.writeUInt32LE(MAX_PLAN_JSON_BYTES + 1, justOver.length - 4);
    // Every buffer the decoder asks for is watched: none may be larger than the cap (and the test itself never
    // allocates one that is, should the cap ever go missing).
    const Real = Uint8Array;
    const asked: number[] = [];
    const Watched = function (this: unknown, ...args: unknown[]) {
      if (typeof args[0] === "number") {
        asked.push(args[0]);
        if (args[0] > MAX_PLAN_JSON_BYTES) throw new RangeError("a buffer larger than the cap was asked for");
      }
      return Reflect.construct(Real, args);
    } as unknown as typeof Uint8Array;
    vi.stubGlobal("Uint8Array", Watched);
    try {
      expect(decodePlanSnapshot(envelope(huge.toString("base64"))).kind).toBe("unreadable");
      expect(decodePlanSnapshot(envelope(justOver.toString("base64"))).kind).toBe("unreadable");
      expect(decodePlanSnapshot(envelope(data)).kind).toBe("plan");
    } finally {
      vi.unstubAllGlobals();
    }
    expect(asked.length).toBeGreaterThan(0);
    expect(Math.max(...asked)).toBeLessThanOrEqual(MAX_PLAN_JSON_BYTES);
    // And one that really is that large is not written in the first place.
    expect(encodePlanSnapshot("x".repeat(MAX_PLAN_JSON_BYTES + 1))).toEqual({ ok: false, reason: "too-large" });
    // Counted in bytes, as it is read back: eleven million three-byte characters are under the cap as characters
    // and over it as bytes.
    const wide = "数".repeat(11_200_000);
    expect(wide.length).toBeLessThan(MAX_PLAN_JSON_BYTES);
    expect(encodePlanSnapshot(wide)).toEqual({ ok: false, reason: "too-large" });
  });

  it("an envelope longer than the server stores is not written, and not read", async () => {
    // Text that does not compress: about one character of envelope per character of plan.
    let seed = 0x9e3779b9;
    const next = () => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return seed >>> 0;
    };
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const chars: string[] = [];
    for (let i = 0; i < 4_400_000; i++) chars.push(alphabet[next() >>> 26]!);
    const json = JSON.stringify({ state: { note: chars.join("") } });
    expect(encodePlanSnapshot(json)).toEqual({ ok: false, reason: "too-large" });
    expect(await encodePlanSnapshotInSlices(json, async () => undefined)).toEqual({ ok: false, reason: "too-large" });
    expect(decodePlanSnapshot(envelope("A".repeat(MAX_PLAN_SNAPSHOT_CHARS))).kind).toBe("unreadable");
  });

  it("loads through the tolerant loader: unknown fields are ignored, missing ones get defaults, old block types go", () => {
    const old = {
      future: { something: "a newer version added" },
      state: {
        onboardingComplete: true,
        journalEntries: [{ id: "j1" }],
        tasks: [{ id: "t1", name: "Essay", courseId: "", courseName: "General", dueDate: "2026-10-01", estimatedMinutes: 60, difficulty: 3, requiresOnCampus: false, status: "pending", createdAt: "2026-09-01T00:00:00.000Z" }],
        scheduleBlocks: [{ id: "b-meal", type: "meal", title: "Lunch", date: "2026-09-21", startTime: "12:30", endTime: "13:00", locked: false, accepted: true, color: "#F59E0B", completionStatus: "pending" }],
        healthPrefs: { bedtime: "late" },
        deviceCalendarEvents: [{ id: "someone-elses-event", title: "must not load", startDate: "2026-09-21", isAllDay: true, isRecurring: false, status: "active", calendarId: "c", syncedAt: "x" }],
        notificationSettings: { enabled: true, leadTimeHours: 1 },
      },
      gradeBook: { scores: "nope", targets: [] },
      courseFeeds: { links: { a: "t1", b: 5, c: null }, count: -3, feeds: [{ url: "https://x" }] },
    };
    const decoded = decodePlanSnapshot(envelope(gz(JSON.stringify(old))));
    expect(decoded.kind).toBe("plan");
    if (decoded.kind !== "plan") return;
    expect(decoded.plan.state).not.toHaveProperty("journalEntries");
    expect(decoded.plan.state.tasks).toHaveLength(1);
    expect(decoded.plan.state.scheduleBlocks).toEqual([]);
    expect(decoded.plan.state.classes).toEqual([]);
    expect(decoded.plan.state.healthPrefs.bedtime).toBe(createInitialState().healthPrefs.bedtime);
    expect(Object.keys(decoded.plan).sort()).toEqual(["feedCount", "feedLinks", "state"]); // "gradeBook" and "future" are not read
    expect(decoded.plan.feedLinks).toEqual({ a: "t1" });
    expect(decoded.plan.feedCount).toBe(0);
    // Whatever a snapshot says about them, device things never reach this iPhone's state (stateForLoadedPlan).
    const applied = stateForLoadedPlan(createInitialState(), decoded.plan);
    expect(applied.deviceCalendarEvents).toEqual([]);
    expect(applied.notificationSettings).toEqual(createInitialState().notificationSettings);
  });

  it("still reads a snapshot written while a plan had a grade book: the key is ignored, the plan is the same", () => {
    const contents = contentsOf(semester(), { feedLinks: { "event-1": "t1" }, feedCount: 1 });
    const prepared = preparePlan(contents);
    const cls = contents.state.classes[0]!;
    const withBook = {
      ...(JSON.parse(prepared.json) as Record<string, unknown>),
      gradeBook: { scores: [{ id: "s1", courseId: cls.id, componentId: null, label: "Quiz 1", earned: 9, possible: 10, recordedAt: "2026-09-01T10:00:00.000Z" }], targets: { [cls.id]: 90 } },
    };
    const decoded = decodePlanSnapshot(envelope(gz(canonicalJson(withBook))));
    expect(decoded.kind).toBe("plan");
    if (decoded.kind !== "plan") return;
    expect(Object.keys(decoded.plan).sort()).toEqual(["feedCount", "feedLinks", "state"]);
    expect(decoded.plan.feedLinks).toEqual({ "event-1": "t1" });
    // Saved again, it is the plan as this version writes it: the same text, without the grade book.
    expect(preparePlan(decoded.plan).json).toBe(prepared.json);
    expect(preparePlan(decoded.plan).json).not.toContain("gradeBook");
  });
});

describe("is there a plan on this iPhone?", () => {
  const blank = (state: Partial<AppState>) => isBlankPlan({ state: { ...createInitialState(), ...state } });
  const block = (type: ScheduleBlock["type"]): ScheduleBlock => ({ id: `b-${type}`, type, title: "Block", date: "2026-09-21", startTime: "09:00", endTime: "10:00", locked: false, accepted: true, color: "#4F6EF7", completionStatus: "pending" });
  const full = semester();

  it("a fresh install has none, and neither do settings, onboarding or iPhone calendar events make one", () => {
    expect(blank({})).toBe(true);
    expect(blank({
      onboardingComplete: true,
      user: { id: "local", email: "", name: "Sam", currentSemester: "", createdAt: "2026-08-20T10:00:00.000Z" },
      healthPrefs: { sleepTargetHours: 7, bedtime: "00:30", wakeTime: "08:00" },
      userPrefs: { studyStyle: "short_bursts", energyProfile: "night", noGoZones: [], scheduleIntensity: 80 },
      notificationSettings: { enabled: true, leadTimeHours: 1 },
      deviceCalendarEvents: [{ id: "e1", calendarId: "c", title: "Dentist", startDate: "2026-09-09", isAllDay: true, isRecurring: false, status: "active", syncedAt: "x", source: "device" }],
      googleCalendarConnected: true,
      scheduleBlocks: [block("sleep"), block("buffer")],
    })).toBe(true);
  });

  it("any one piece of a plan is a plan", () => {
    expect(blank({ classes: [full.classes[0]!] })).toBe(false);
    expect(blank({ tasks: [full.tasks[0]!] })).toBe(false);
    expect(blank({ recurringEvents: [{ id: "r1", title: "Work", days: ["Sat"], startTime: "10:00", endTime: "16:00", color: "#06B6D4", locked: true }] })).toBe(false);
    expect(blank({ semester: full.semester })).toBe(false);
    expect(blank({ syllabusImports: [{ id: "i1", importedAt: "x", courseName: "C", linkedClassId: "c", linkedClassName: "C", itemCount: 0, skippedCount: 0, isNewClass: false }] })).toBe(false);
    expect(blank({ examPreps: [{ id: "e1", classId: "c", className: "C", examDate: "2026-10-01", topics: [], rawInput: "", studyBlockIds: [], finalReviewGenerated: false, createdAt: "x" }] })).toBe(false);
    expect(blank({ studyGuides: [{ id: "g1", courseTitle: "C", overview: "", topics: [], studyTips: [], createdAt: "x" }] })).toBe(false);
    expect(blank({ practiceExams: [{ id: "p1", studyGuideId: "g1", courseTitle: "C", totalQuestions: 0, estimatedMinutes: 0, questions: [], createdAt: "x" }] })).toBe(false);
    expect(blank({ grades: [{ id: "gr1", classId: "c", letterGrade: "A", recordedAt: "x" }] })).toBe(false);
    // An event the student put on the calendar themselves.
    expect(blank({ scheduleBlocks: [block("sleep"), block("free")] })).toBe(false);
    expect(blank({ scheduleBlocks: [block("work")] })).toBe(false);
    expect(isBlankPlan({ state: full })).toBe(false);
  });

  it("pristine is the state a fresh install starts from, and what a wipe leaves behind", () => {
    const initial = createInitialState();
    expect(isPristineState(initial)).toBe(true);
    expect(isPristineState(reducer(full, { type: "LOGOUT" }))).toBe(true);
    // What is this iPhone's own does not make it any less pristine.
    expect(isPristineState({ ...initial, deviceCalendarEvents: [{ id: "e1", calendarId: "c", title: "Dentist", startDate: "2026-09-09", isAllDay: true, isRecurring: false, status: "active", syncedAt: "x", source: "device" }], notificationSettings: { enabled: true, leadTimeHours: 1 } })).toBe(true);
    // Anything of the plan does, even when there is still "no plan".
    expect(isPristineState({ ...initial, onboardingComplete: true })).toBe(false);
    expect(isPristineState({ ...initial, healthPrefs: { ...initial.healthPrefs, bedtime: "00:30" } })).toBe(false);
    expect(isPristineState({ ...initial, userPrefs: { ...initial.userPrefs, scheduleIntensity: 80 } })).toBe(false);
    expect(isPristineState({ ...initial, tasks: [full.tasks[0]!] })).toBe(false);
    expect(isPristineState(run(full, { type: "RESET_SEMESTER" }))).toBe(false); // a reset is the student's decision, and is saved
    expect(isPristineState(full)).toBe(false);
  });
});

describe("loading a plan onto an iPhone (stateForLoadedPlan)", () => {
  it("takes the plan and keeps what is this iPhone's own", () => {
    const mine: GoogleCalendarEventLocal = { id: "mine@1", calendarId: "home", title: "My dentist", startDate: "2026-09-09", isAllDay: true, isRecurring: false, status: "active", syncedAt: "x", source: "device" };
    const current: AppState = {
      ...createInitialState(),
      onboardingComplete: true,
      tasks: [{ id: "old", name: "Old task", courseId: "", courseName: "General", dueDate: "2026-09-10", estimatedMinutes: 30, difficulty: 2, requiresOnCampus: false, status: "pending", createdAt: "x" }],
      deviceCalendarEvents: [mine],
      googleCalendarEvents: [{ ...mine, id: "g1", source: "google" }],
      googleCalendarConnected: true,
      googleCalendarLastSync: "2026-09-07T10:00:00.000Z",
      notificationSettings: { enabled: true, leadTimeHours: 6, sessionStart: false },
      undoSnapshots: [{ label: "Plan updated", at: "2026-09-07T13:00:00.000Z", scheduleBlocks: [], tasks: [] }],
      replanNotice: { label: "x", summary: "y", at: "z" },
      inputsBeforeEdit: { calendarChanged: true },
    };
    const saved = semester();
    const decoded = decodePlanSnapshot(snapshotOf(contentsOf({ ...saved, notificationSettings: { enabled: false, leadTimeHours: 48 } })));
    if (decoded.kind !== "plan") throw new Error("unreadable");
    const next = stateForLoadedPlan(current, decoded.plan);

    expect(next.tasks).toEqual(saved.tasks);
    expect(next.classes).toEqual(saved.classes);
    expect(next.semester).toEqual(saved.semester);
    expect(next.onboardingComplete).toBe(true);
    // This iPhone's own.
    expect(next.deviceCalendarEvents).toBe(current.deviceCalendarEvents);
    expect(next.googleCalendarEvents).toBe(current.googleCalendarEvents);
    expect(next.googleCalendarConnected).toBe(true);
    expect(next.googleCalendarLastSync).toBe("2026-09-07T10:00:00.000Z");
    expect(next.notificationSettings).toBe(current.notificationSettings);
    // Undo belongs to the plan that was replaced.
    expect(next.undoSnapshots).toBeUndefined();
    expect(next.replanNotice).toBeUndefined();
    expect(next.inputsBeforeEdit).toBeUndefined();
    // And through the app's own LOAD_STATE it is the same state.
    const loaded = reducer(current, { type: "LOAD_STATE", payload: next });
    expect(loaded.tasks).toEqual(saved.tasks);
    expect(loaded.deviceCalendarEvents).toBe(current.deviceCalendarEvents);
    expect(loaded.undoSnapshots).toBeUndefined();
    expect(preparePlan(contentsOf(loaded)).hash).toBe(preparePlan(decoded.plan).hash);
  });

  it("a notification switch that is on never arrives on an iPhone that did not turn it on itself", () => {
    const decoded = decodePlanSnapshot(snapshotOf(contentsOf({ ...semester(), notificationSettings: { enabled: true, leadTimeHours: 1 } })));
    if (decoded.kind !== "plan") throw new Error("unreadable");
    expect(stateForLoadedPlan(createInitialState(), decoded.plan).notificationSettings.enabled).toBe(false);
  });
});

describe("noticing a change of the plan cheaply (planStateChanged)", () => {
  it("only what belongs to the plan counts", () => {
    const state = semester();
    expect(planStateChanged(state, state)).toBe(false);
    expect(planStateChanged(state, { ...state })).toBe(false);
    expect(planStateChanged(state, { ...state, deviceCalendarEvents: [] })).toBe(false);
    expect(planStateChanged(state, { ...state, googleCalendarEvents: [], googleCalendarConnected: true })).toBe(false);
    expect(planStateChanged(state, { ...state, notificationSettings: { enabled: true, leadTimeHours: 1 } })).toBe(false);
    expect(planStateChanged(state, { ...state, undoSnapshots: [], replanNotice: undefined, inputsBeforeEdit: {} })).toBe(false);
    expect(planStateChanged(state, { ...state, tasks: [...state.tasks] })).toBe(true);
    expect(planStateChanged(state, { ...state, scheduleBlocks: [...state.scheduleBlocks] })).toBe(true);
    expect(planStateChanged(state, { ...state, onboardingComplete: false })).toBe(true);
    expect(planStateChanged(state, { ...state, semester: undefined })).toBe(true);
    expect(planStateChanged(state, reducer(state, { type: "COMPLETE_BLOCK", payload: state.scheduleBlocks.find((b) => b.type === "study")!.id }))).toBe(true);
  });
});
