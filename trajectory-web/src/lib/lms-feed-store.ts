/**
 * Course calendar feeds in this browser: the saved feed links (private URLs, never sent to Trajectory's server),
 * fetching them, and turning them into task changes via the pure lib/lms-feed.ts. The caller applies the result with
 * ADD_TASK / UPDATE_TASK (see components/course-feed-refresher.tsx and screens/course-feeds.tsx).
 *
 * Of what is stored here, only `links` (which feed item became which task) is part of the plan saved to the account
 * (lib/plan-snapshot.ts), so adding the same feed again on another device imports nothing twice. A feed itself (its
 * link, its label, when it was fetched) never leaves the browser it was added in.
 *
 * One thing the browser adds: a course site that does not allow web pages to read the feed (no CORS headers) cannot be
 * fetched from here, and the error says so.
 */
import { generateId } from "../engine/utils";
import type { ClassBlock, Task } from "../engine/types";
import { feedIsDue, feedItemsFromIcs, feedLabel, importFeedItems, normalizeFeedUrl, type FeedLinks } from "./lms-feed";
import { appStorage } from "./storage";

const STORAGE_KEY = "@trajectory/courseFeeds";
const FETCH_TIMEOUT_MS = 20_000;
const MAX_FEEDS = 10;

export interface CourseFeed {
  id: string;
  url: string;
  label: string;
  addedAt: string;
  lastFetchedAt?: string;
  lastStatus?: "ok" | "error";
  lastError?: string;
  /** Deadlines found in the feed on the last refresh. */
  lastCount?: number;
}

export interface CourseFeedsState {
  feeds: CourseFeed[];
  links: FeedLinks;
}

type Listener = (state: CourseFeedsState) => void;
const listeners = new Set<Listener>();

/** What is stored, read as feeds and links. Text that is neither reads as none. */
function parseCourseFeeds(raw: string | null): CourseFeedsState {
  try {
    const parsed = raw ? (JSON.parse(raw) as Partial<CourseFeedsState>) : {};
    return {
      feeds: Array.isArray(parsed.feeds) ? parsed.feeds.filter((f) => f && typeof f.url === "string") : [],
      links: parsed.links && typeof parsed.links === "object" ? parsed.links : {},
    };
  } catch {
    return { feeds: [], links: {} };
  }
}

export async function loadCourseFeeds(): Promise<CourseFeedsState> {
  try {
    return parseCourseFeeds(await appStorage.getItem(STORAGE_KEY));
  } catch {
    return { feeds: [], links: {} };
  }
}

/**
 * The feeds and links for the plan saved to the account. Like loadCourseFeeds, except that storage failing to answer
 * is reported instead of read as "no links": a plan saved without them would make every deadline of a feed look new
 * on the device that loads it, and be imported a second time.
 */
export async function readCourseFeedsForPlan(): Promise<CourseFeedsState> {
  return parseCourseFeeds(await appStorage.getItem(STORAGE_KEY));
}

async function saveCourseFeeds(state: CourseFeedsState): Promise<void> {
  await appStorage.setItem(STORAGE_KEY, JSON.stringify(state)).catch(() => undefined);
  for (const listener of listeners) listener(state);
}

export function subscribeCourseFeeds(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Download a feed. Throws a readable Error for network / HTTP / not-a-calendar problems. */
export async function fetchFeedText(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { Accept: "text/calendar, text/plain, */*" } });
    if (!res.ok) throw new Error(res.status === 401 || res.status === 403 || res.status === 404
      ? "The feed link was not accepted. Copy it again from your course site (it may have been reset)."
      : `The course site answered with an error (${res.status}). Try again later.`);
    const text = await res.text();
    if (!/BEGIN:VCALENDAR/i.test(text)) throw new Error("That link is not a calendar feed. Look for a link ending in .ics.");
    return text;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") throw new Error("The course site took too long to answer. Try again later.");
    if (err instanceof TypeError) throw new Error("Could not reach the course site. Check your connection; some course sites also stop web browsers from reading the feed, and then the iPhone app can read it instead.");
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export interface FeedRefreshResult {
  add: Task[];
  update: Task[];
  refreshed: number;
  errors: string[];
}

let refreshChain: Promise<unknown> = Promise.resolve();
let storeChain: Promise<unknown> = Promise.resolve();

/**
 * One read-change-write of the stored feeds at a time (the last step of a refresh, adding or removing a feed, a
 * loaded plan's links): each starts from what the one before it wrote, so none can put back what another replaced.
 * Nothing in the queue waits for the network.
 */
function queued<T>(work: () => Promise<T>): Promise<T> {
  const run = storeChain.then(work);
  storeChain = run.catch(() => undefined);
  return run;
}

/**
 * Goes up whenever a loaded plan replaces the links (replaceCourseFeedLinks). A refresh that started before has
 * worked from tasks and links that are gone: what it found must not be written, and must not be added to the loaded
 * plan (the same assignment would be there twice).
 */
let linksEpoch = 0;

const NOTHING_REFRESHED = (): FeedRefreshResult => ({ add: [], update: [], refreshed: 0, errors: [] });

/**
 * Refresh saved feeds (only those not fetched in the last 6 hours unless `force`) and compute the task changes.
 * Serialised, so a foreground refresh and a "Check now" cannot both add the same assignment.
 */
export function refreshCourseFeeds(
  appState: { tasks: readonly Task[]; classes: readonly ClassBlock[] },
  opts: { force?: boolean; onlyFeedId?: string; now?: Date } = {},
): Promise<FeedRefreshResult> {
  const epoch = linksEpoch;
  const run = refreshChain.then(async (): Promise<FeedRefreshResult> => {
    if (epoch !== linksEpoch) return NOTHING_REFRESHED();
    const now = opts.now ?? new Date();
    const stored = await loadCourseFeeds();
    const result = NOTHING_REFRESHED();
    let links = stored.links;
    let tasks = [...appState.tasks];
    const refreshed = new Map<string, CourseFeed>();
    for (const feed of stored.feeds) {
      const wanted = opts.onlyFeedId ? feed.id === opts.onlyFeedId : opts.force || feedIsDue(feed.lastFetchedAt, now);
      if (!wanted) continue;
      try {
        const text = await fetchFeedText(feed.url);
        const { items } = feedItemsFromIcs(text, { now });
        const applied = importFeedItems({ tasks, classes: appState.classes }, items, links, { now, makeId: generateId, sourceLabel: `${feed.label} calendar feed` });
        links = applied.links;
        result.add.push(...applied.add);
        result.update.push(...applied.update);
        const updatedIds = new Set(applied.update.map((t) => t.id));
        tasks = [...tasks.map((t) => (updatedIds.has(t.id) ? applied.update.find((u) => u.id === t.id)! : t)), ...applied.add];
        result.refreshed++;
        refreshed.set(feed.id, { ...feed, lastFetchedAt: now.toISOString(), lastStatus: "ok", lastError: undefined, lastCount: items.length });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Could not refresh this feed.";
        result.errors.push(message);
        refreshed.set(feed.id, { ...feed, lastFetchedAt: now.toISOString(), lastStatus: "error", lastError: message });
      }
    }
    return queued(async (): Promise<FeedRefreshResult> => {
      const current = await loadCourseFeeds();
      if (epoch !== linksEpoch) return NOTHING_REFRESHED();
      await saveCourseFeeds({ feeds: current.feeds.map((feed) => refreshed.get(feed.id) ?? feed), links });
      return epoch === linksEpoch ? result : NOTHING_REFRESHED();
    });
  });
  refreshChain = run.catch(() => undefined);
  return run;
}

export type AddFeedResult = { ok: true; feed: CourseFeed } | { ok: false; message: string };

/** Validate (fetch + parse) and save a new feed link. Does not import anything by itself. */
export async function addCourseFeed(input: string): Promise<AddFeedResult> {
  const url = normalizeFeedUrl(input);
  if (!url) return { ok: false, message: "Paste the full feed link (it starts with https:// or webcal://)." };
  const refusal = (state: CourseFeedsState): AddFeedResult | null => {
    if (state.feeds.some((f) => f.url === url)) return { ok: false, message: "That feed is already added." };
    if (state.feeds.length >= MAX_FEEDS) return { ok: false, message: `You can add up to ${MAX_FEEDS} feeds.` };
    return null;
  };
  const refusedAtOnce = refusal(await loadCourseFeeds());
  if (refusedAtOnce) return refusedAtOnce;
  try {
    await fetchFeedText(url);
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : "Could not read that feed." };
  }
  const feed: CourseFeed = { id: generateId(), url, label: feedLabel(url), addedAt: new Date().toISOString() };
  return queued(async (): Promise<AddFeedResult> => {
    const state = await loadCourseFeeds();
    const refused = refusal(state);
    if (refused) return refused;
    await saveCourseFeeds({ ...state, feeds: [...state.feeds, feed] });
    return { ok: true, feed };
  });
}

/** Forget a feed. Tasks it created stay (they are the student's now). */
export function removeCourseFeed(id: string): Promise<void> {
  return queued(async () => {
    const state = await loadCourseFeeds();
    await saveCourseFeeds({ ...state, feeds: state.feeds.filter((f) => f.id !== id) });
  });
}

/**
 * Puts a loaded plan's links in place of this browser's and keeps this browser's own feeds (a plan never holds a
 * feed's link). Resolves with how many feeds this browser has. A read or a write that fails is reported instead of
 * swallowed: the plan must not count as loaded when part of it is not on disk.
 */
export function replaceCourseFeedLinks(links: FeedLinks): Promise<number> {
  linksEpoch++;
  return queued(async () => {
    const { feeds } = parseCourseFeeds(await appStorage.getItem(STORAGE_KEY));
    const next: CourseFeedsState = { feeds, links: { ...links } };
    await appStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    for (const listener of listeners) listener(next);
    return feeds.length;
  });
}
