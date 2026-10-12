// The store a saved plan reads and replaces besides the app state: the course feeds (lib/lms-feed-store.ts), against
// an in-memory stand-in for the browser's storage (src/lib/storage.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const disk = vi.hoisted(() => ({ data: new Map<string, string>(), failWrites: false, failReads: false, readGate: null as Promise<void> | null, writeGate: null as Promise<void> | null }));
vi.mock("../../src/lib/storage", () => ({
  appStorage: {
    getItem: async (key: string) => {
      if (disk.readGate) await disk.readGate;
      if (disk.failReads) throw new Error("storage unavailable");
      return disk.data.get(key) ?? null;
    },
    setItem: async (key: string, value: string) => {
      if (disk.writeGate) await disk.writeGate;
      if (disk.failWrites) throw new Error("disk full");
      disk.data.set(key, value);
    },
    removeItem: async (key: string) => void disk.data.delete(key),
    getAllKeys: async () => Array.from(disk.data.keys()),
    multiRemove: async (keys: readonly string[]) => keys.forEach((key) => disk.data.delete(key)),
  },
  readLocal: () => null,
  writeLocal: () => true,
}));

import { addCourseFeed, loadCourseFeeds, readCourseFeedsForPlan, refreshCourseFeeds, removeCourseFeed, replaceCourseFeedLinks, subscribeCourseFeeds } from "../../src/lib/lms-feed-store";

const FEEDS_KEY = "@trajectory/courseFeeds";
const FEED_URL = "https://canvas.school.edu/feeds/calendars/user_PRIVATEtoken.ics";
const NOW = new Date(2026, 9, 5, 9, 0);

const ics = (...uids: string[]) => ["BEGIN:VCALENDAR", ...uids.flatMap((uid, i) => ["BEGIN:VEVENT", `UID:${uid}`, `SUMMARY:Homework ${i + 1} [CHEM 101]`, "DTSTART:20261020T170000Z", "END:VEVENT"]), "END:VCALENDAR"].join("\r\n");

/** Downloads still held back, so a test that fails half-way does not leave the store's queue blocked for the next. */
const held: (() => void)[] = [];

/** A download that answers when the test lets it. */
function slowFetch(text: string) {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  held.push(release);
  const fetchMock = vi.fn(async () => {
    await gate;
    return { ok: true, status: 200, text: async () => text };
  });
  vi.stubGlobal("fetch", fetchMock);
  return { release, fetchMock };
}

const storedFeeds = () => JSON.parse(disk.data.get(FEEDS_KEY) ?? "{}") as { feeds?: { id: string; url: string }[]; links?: Record<string, string> };

/** Reads (or writes) take their time: none is answered until the returned function is called. */
function hold(what: "readGate" | "writeGate"): () => void {
  let open: () => void = () => undefined;
  disk[what] = new Promise<void>((resolve) => {
    open = resolve;
  });
  return () => {
    disk[what] = null;
    open();
  };
}
const holdReads = () => hold("readGate");
const holdWrites = () => hold("writeGate");

beforeEach(() => {
  disk.data.clear();
  disk.failWrites = false;
  disk.failReads = false;
  disk.readGate = null;
  disk.writeGate = null;
});
afterEach(async () => {
  held.splice(0).forEach((release) => release());
  await new Promise((resolve) => setTimeout(resolve, 0));
  vi.unstubAllGlobals();
});

describe("the course feeds", () => {
  const seed = (links: Record<string, string> = { "event-old": "task-old" }) => {
    disk.data.set(FEEDS_KEY, JSON.stringify({ feeds: [{ id: "f1", url: FEED_URL, label: "canvas.school.edu", addedAt: "2026-09-01T10:00:00.000Z", lastFetchedAt: "2026-10-05T08:00:00.000Z", lastStatus: "ok", lastCount: 3 }], links }));
  };

  it("a loaded plan's links replace this iPhone's, and its own feeds (their private links) stay", async () => {
    seed();
    const seen: number[] = [];
    const off = subscribeCourseFeeds((state) => seen.push(Object.keys(state.links).length));
    expect(await replaceCourseFeedLinks({ "event-1": "task-1", "event-2": "__dismissed__" })).toBe(1);
    off();
    expect(storedFeeds().links).toEqual({ "event-1": "task-1", "event-2": "__dismissed__" });
    expect(storedFeeds().feeds).toHaveLength(1);
    expect(storedFeeds().feeds![0]).toMatchObject({ id: "f1", url: FEED_URL, lastCount: 3 });
    expect(seen).toEqual([2]);
    expect((await loadCourseFeeds()).feeds[0]!.url).toBe(FEED_URL);
  });

  it("for the saved plan, links that cannot be read are reported, never taken for none", async () => {
    seed();
    expect(await readCourseFeedsForPlan()).toMatchObject({ links: { "event-old": "task-old" } });
    expect((await readCourseFeedsForPlan()).feeds).toHaveLength(1);
    disk.failReads = true;
    // The screens show no feeds then (as before)…
    expect(await loadCourseFeeds()).toEqual({ feeds: [], links: {} });
    // …but a plan saved without its links would have every deadline imported a second time on the next iPhone.
    await expect(readCourseFeedsForPlan()).rejects.toThrow("storage unavailable");
    disk.failReads = false;
    disk.data.set(FEEDS_KEY, "{not feeds");
    expect(await readCourseFeedsForPlan()).toEqual({ feeds: [], links: {} });
  });

  it("on an iPhone without feeds there are simply the links", async () => {
    expect(await replaceCourseFeedLinks({ "event-1": "task-1" })).toBe(0);
    expect(storedFeeds()).toEqual({ feeds: [], links: { "event-1": "task-1" } });
  });

  it("when storage cannot be read or written it is reported, and the feeds are not lost", async () => {
    seed();
    const before = disk.data.get(FEEDS_KEY);
    disk.failReads = true;
    await expect(replaceCourseFeedLinks({ a: "b" })).rejects.toThrow("storage unavailable");
    disk.failReads = false;
    disk.failWrites = true;
    await expect(replaceCourseFeedLinks({ a: "b" })).rejects.toThrow("disk full");
    expect(disk.data.get(FEEDS_KEY)).toBe(before);
    // Nothing is stuck afterwards.
    disk.failWrites = false;
    expect(await replaceCourseFeedLinks({ a: "b" })).toBe(1);
    expect(storedFeeds().links).toEqual({ a: "b" });
  });

  it("a refresh that is under way when a plan is loaded reports nothing and writes nothing: what it found belongs to the plan that is gone", async () => {
    seed();
    const download = slowFetch(ics("event-assignment-101"));
    const refreshing = refreshCourseFeeds({ tasks: [], classes: [] }, { force: true, now: NOW });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(download.fetchMock).toHaveBeenCalledTimes(1);
    // The load does not wait for the download (a slow course site must not hold a plan up).
    expect(await replaceCourseFeedLinks({ "event-loaded": "task-loaded" })).toBe(1);
    expect(storedFeeds().links).toEqual({ "event-loaded": "task-loaded" });
    download.release();
    // The deadline it found is not handed over (the loaded plan may hold it already, under another task), the old
    // links are not put back, and the feed stays due so the next refresh starts from the loaded plan.
    expect(await refreshing).toEqual({ add: [], update: [], refreshed: 0, errors: [] });
    expect(storedFeeds().links).toEqual({ "event-loaded": "task-loaded" });
    expect(storedFeeds().feeds![0]).toMatchObject({ url: FEED_URL, lastFetchedAt: "2026-10-05T08:00:00.000Z" });
    // The next refresh works as ever.
    slowFetch(ics("event-assignment-101")).release();
    const next = await refreshCourseFeeds({ tasks: [], classes: [] }, { force: true, now: NOW });
    expect(next.add).toHaveLength(1);
    expect(Object.keys(storedFeeds().links!).sort()).toEqual(["event-assignment-101", "event-loaded"]);
  });

  it("the same when the load is only asked for, not yet written, as the refresh finishes", async () => {
    seed();
    const download = slowFetch(ics("event-assignment-101"));
    const refreshing = refreshCourseFeeds({ tasks: [], classes: [] }, { force: true, now: NOW });
    await new Promise((resolve) => setTimeout(resolve, 10));
    download.release();
    const replacing = replaceCourseFeedLinks({ "event-loaded": "task-loaded" }); // in the same breath
    expect((await refreshing).add).toEqual([]);
    expect(await replacing).toBe(1);
    expect(storedFeeds().links).toEqual({ "event-loaded": "task-loaded" });
  });

  it("and when it is asked for while the refresh is at its very last step: still nothing of the refresh is kept", async () => {
    seed();
    const download = slowFetch(ics("event-assignment-101"));
    const refreshing = refreshCourseFeeds({ tasks: [], classes: [] }, { force: true, now: NOW });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const releaseReads = holdReads();
    download.release();
    await new Promise((resolve) => setTimeout(resolve, 10)); // the refresh is reading the feeds as stored, to write onto them
    const replacing = replaceCourseFeedLinks({ "event-loaded": "task-loaded" });
    releaseReads();
    expect(await refreshing).toEqual({ add: [], update: [], refreshed: 0, errors: [] });
    expect(await replacing).toBe(1);
    expect(storedFeeds().links).toEqual({ "event-loaded": "task-loaded" });
    // Not even "fetched just now": the feed stays due, so the next refresh looks again, from the loaded plan.
    expect(storedFeeds().feeds![0]).toMatchObject({ url: FEED_URL, lastFetchedAt: "2026-10-05T08:00:00.000Z" });
  });

  it("and while the refresh is writing: what it found is not handed over, and the loaded links are written after its own", async () => {
    seed();
    const download = slowFetch(ics("event-assignment-101"));
    const refreshing = refreshCourseFeeds({ tasks: [], classes: [] }, { force: true, now: NOW });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const releaseWrites = holdWrites();
    download.release();
    await new Promise((resolve) => setTimeout(resolve, 10)); // the refresh is writing what it found
    const replacing = replaceCourseFeedLinks({ "event-loaded": "task-loaded" });
    releaseWrites();
    expect(await refreshing).toEqual({ add: [], update: [], refreshed: 0, errors: [] });
    expect(await replacing).toBe(1);
    expect(storedFeeds().links).toEqual({ "event-loaded": "task-loaded" });
  });

  it("a refresh that was waiting its turn behind another when the plan was loaded reports nothing either, and does not even ask the course site", async () => {
    seed();
    const download = slowFetch(ics("event-assignment-101"));
    const first = refreshCourseFeeds({ tasks: [], classes: [] }, { force: true, now: NOW });
    // Asked for with the tasks of the plan as it is now; it starts when the first one is done.
    const second = refreshCourseFeeds({ tasks: [], classes: [] }, { force: true, now: NOW });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await replaceCourseFeedLinks({ "event-loaded": "task-loaded" });
    download.release();
    expect(await first).toEqual({ add: [], update: [], refreshed: 0, errors: [] });
    // Its tasks are the replaced plan's: importing against them would add to the loaded plan what it may already hold.
    expect(await second).toEqual({ add: [], update: [], refreshed: 0, errors: [] });
    expect(download.fetchMock).toHaveBeenCalledTimes(1);
    expect(storedFeeds().links).toEqual({ "event-loaded": "task-loaded" });
    expect(storedFeeds().feeds![0]).toMatchObject({ lastFetchedAt: "2026-10-05T08:00:00.000Z" });
  });

  it("a feed removed in the same breath as a load: the feed stays removed and the loaded links stay loaded", async () => {
    seed();
    const removing = removeCourseFeed("f1");
    const replacing = replaceCourseFeedLinks({ "event-loaded": "task-loaded" }); // while the removal is under way
    await removing;
    expect(await replacing).toBe(0);
    expect(storedFeeds()).toEqual({ feeds: [], links: { "event-loaded": "task-loaded" } });
  });

  it("a feed added or removed while a refresh is downloading is not undone by it", async () => {
    seed();
    const download = slowFetch(ics("event-assignment-101"));
    const refreshing = refreshCourseFeeds({ tasks: [], classes: [] }, { force: true, now: NOW });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await removeCourseFeed("f1");
    expect(storedFeeds().feeds).toEqual([]);
    download.release();
    const result = await refreshing;
    expect(result.add).toHaveLength(1); // the deadline was found, and its link is kept
    expect(storedFeeds().feeds).toEqual([]); // but the removed feed does not come back
    expect(Object.keys(storedFeeds().links!).sort()).toEqual(["event-assignment-101", "event-old"]);
  });

  it("a refresh after the load starts from the loaded links: what the other iPhone imported is not imported again", async () => {
    seed({});
    await replaceCourseFeedLinks({ "event-assignment-101": "task-from-the-other-iphone" });
    slowFetch(ics("event-assignment-101", "event-assignment-102")).release();
    const tasks = [{ id: "task-from-the-other-iphone", name: "Homework 1", courseId: "", courseName: "CHEM 101", dueDate: "2026-10-20", dueTime: "12:00", estimatedMinutes: 90, difficulty: 3 as const, requiresOnCampus: false, status: "pending" as const, createdAt: "x" }];
    const result = await refreshCourseFeeds({ tasks, classes: [] }, { force: true, now: NOW });
    expect(result.add.map((task) => task.name)).toEqual(["Homework 2"]);
    expect(Object.keys(storedFeeds().links!).sort()).toEqual(["event-assignment-101", "event-assignment-102"]);
    expect(storedFeeds().links!["event-assignment-101"]).toBe("task-from-the-other-iphone");
  });

  it("adding a feed keeps links that were replaced while its link was being checked", async () => {
    const download = slowFetch(ics("event-assignment-101"));
    const adding = addCourseFeed(FEED_URL);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await replaceCourseFeedLinks({ "event-loaded": "task-loaded" });
    download.release();
    const added = await adding;
    expect(added.ok).toBe(true);
    expect(storedFeeds().links).toEqual({ "event-loaded": "task-loaded" });
    expect(storedFeeds().feeds!.map((feed) => feed.url)).toEqual([FEED_URL]);
    // The same link a second time is still refused, and removing a feed leaves the links alone.
    expect(await addCourseFeed(FEED_URL)).toEqual({ ok: false, message: "That feed is already added." });
    await removeCourseFeed(storedFeeds().feeds![0]!.id);
    expect(storedFeeds()).toEqual({ feeds: [], links: { "event-loaded": "task-loaded" } });
  });
});
