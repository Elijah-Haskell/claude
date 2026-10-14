/**
 * The plan saved to the account: the rules (pure, no platform imports). shared/plan-sync.ts is the contract with the
 * server, lib/plan-snapshot.ts says what a plan contains, lib/plan-sync-engine.ts carries these rules out and
 * lib/plan-sync-client.ts is what screens use.
 *
 * The copy on the iPhone is the one the screens work from. The account holds one snapshot, replaced whole. The one
 * thing that must never happen is a plan being replaced without anyone deciding so while it held something the other
 * side had not seen. So every decision here starts from two questions: has this iPhone seen what the account holds,
 * and does this iPhone hold something the account has not seen?
 */
import { PLAN_DEVICE_ID_PATTERN, type PlanHeader } from "../shared/plan-sync";

// ── What screens are told ─────────────────────────────────────

/**
 * - "off": nobody is signed in (or the browser preview, which has no accounts): nothing is saved anywhere.
 * - "checking": signed in, and the app is finding out what the account holds. Only right after a sign-in, or at a
 *   launch where this iPhone's plan is not yet known to be the account's; a normal launch goes straight to "ready".
 *   The sign-in flow waits on this.
 * - "choose": this iPhone and the account each hold a plan the other has not seen. <PlanSync /> is asking the student
 *   which one to keep; nothing is overwritten until they answer. (Also while it asks what to do with the plan of
 *   another account still on this iPhone.)
 * - "unreachable": the check could not reach the server. `retry()` asks again.
 * - "ready": this iPhone's plan is the account's plan. Changes are saved as they happen.
 */
export type PlanSyncPhase = "off" | "checking" | "choose" | "unreachable" | "ready";

/**
 * While "ready", what the "Saved to your account" row says:
 * - "saved": the account holds exactly this plan (`lastSavedAt` says since when);
 * - "saving": a save is on its way;
 * - "waiting": changed a moment ago, about to be saved;
 * - "offline": the last save could not reach the server; it is tried again by itself. Also whenever the plan is not
 *   saved for another reason: the account's plan was written by a newer version of the app (the row then says so),
 *   the server refused the session (signing in again is handled elsewhere), or this iPhone could not read its own
 *   plan from storage for a moment;
 * - "too-large": the server refused the plan as too large (never expected; shown so it is not silent).
 */
export type PlanSaveState = "saved" | "saving" | "waiting" | "offline" | "too-large";

export interface PlanSyncStatus {
  phase: PlanSyncPhase;
  save: PlanSaveState;
  /** When this iPhone last saved to, or loaded from, the account (ISO 8601); null when it never has. */
  lastSavedAt: string | null;
  /**
   * True when the plan now on this iPhone was brought here from the account since this launch (a new iPhone, a
   * reinstall, or the student chose the saved plan). Not for an iPhone that merely caught up with its own account.
   */
  restoredFromAccount: boolean;
}

export interface PlanSync extends PlanSyncStatus {
  /** "unreachable": ask the account again. "offline": try the save again now. Otherwise does nothing. */
  retry: () => void;
}

/** What <PlanSync /> has to ask the student. Nothing is replaced on either side until it is answered. */
export type PlanSyncQuestion =
  /** "Which plan do you want to keep?" `savedAt`: when the account's plan was saved (ISO 8601). */
  | { kind: "choose"; savedAt: string }
  /** This iPhone still holds the plan of another account: replace it, or sign out. */
  | { kind: "other-account" };

/** What <PlanSync /> tells the student once. */
export type PlanSyncNotice =
  /** The account's plan was saved by a newer version of the app: nothing is saved until the app is updated. */
  | { kind: "newer-version" }
  /** The account's plan could not be read at all. Treated like the one above: it is left alone. */
  | { kind: "unreadable" }
  /** A plan came back from the account, and it had a course feed this iPhone does not have. */
  | { kind: "feeds" };

/** The part of the engine's state only components/plan-sync.tsx reads. */
export interface PlanSyncPrompt {
  question: PlanSyncQuestion | null;
  notice: PlanSyncNotice | null;
  /** Saving is held back because the account's plan cannot be read by this version of the app. */
  blocked: "newer-version" | "unreadable" | null;
}

// ── What this iPhone remembers ────────────────────────────────

/** AsyncStorage key of the bookkeeping below. Removed by the device wipe, like every "trajectory_" key. */
export const PLAN_SYNC_STORAGE_KEY = "trajectory_plan_sync_v1";

/**
 * AsyncStorage key of the safety copy: the plan this iPhone held just before a saved plan replaced it because the
 * student chose so. One copy, overwritten by the next one, with the time it was made; no screen shows it.
 */
export const PLAN_SAFETY_COPY_STORAGE_KEY = "trajectory_plan_safety_copy_v1";

export interface PlanSyncBookkeeping {
  v: 1;
  /** The account (openId) this iPhone's plan belongs to; null = never tied to an account. */
  owner: string | null;
  /** The account revision this iPhone last saved or loaded; 0 = none. */
  revision: number;
  /** The plan may have changed since then (any change, the app's own re-plans included): a save may be due. */
  dirty: boolean;
  /**
   * The STUDENT changed the plan since then. Only this makes a newer plan in the account a question: what the app
   * derived by itself (a re-plan at launch, new priority scores) is derived again from whatever plan is loaded.
   */
  edited: boolean;
  /** When this iPhone last saved to, or loaded from, the account (this iPhone's clock, ISO 8601). */
  lastSavedAt: string | null;
  /** This iPhone's own random id (PLAN_DEVICE_ID_PATTERN), made once. Never a hardware id. */
  deviceId: string;
  /** Fingerprint (lib/plan-snapshot.ts preparePlan) of the account's plan at `revision`, as far as this iPhone knows. */
  hash: string | null;
  /**
   * The snapshots this iPhone sent over `revision` without getting an answer (newest first, a few at most): the
   * server may hold one of them even though its answer never arrived (ownUnansweredSave). Empty again as soon as this
   * iPhone knows which revision it is at.
   */
  sent: PlanSentSave[];
  /** Who saved `revision`, and when, as the server says it (PlanHeader): together they name one particular save. */
  savedBy: string | null;
  serverSavedAt: string | null;
}

/** One save that left this iPhone: the fingerprint of its plan and the length of its snapshot (PlanHeader.chars). */
export interface PlanSentSave {
  hash: string;
  chars: number;
}

/** How many unanswered saves are remembered. An iPhone asks the account before it sends again, so one is the rule. */
const MAX_SENT_SAVES = 4;

/** `sent` with one more save in front (the same plan sent again is listed once). */
export function rememberSentSave(sent: readonly PlanSentSave[], save: PlanSentSave): PlanSentSave[] {
  return [save, ...sent.filter((other) => other.hash !== save.hash)].slice(0, MAX_SENT_SAVES);
}

const DEVICE_ID_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";

/** A new random device id. It only tells one iPhone's saves from another's, so Math.random is random enough. */
export function newPlanDeviceId(random: () => number = Math.random): string {
  let id = "";
  for (let i = 0; i < 24; i++) id += DEVICE_ID_ALPHABET[Math.floor(random() * 64) & 63];
  return id;
}

export function freshBookkeeping(random?: () => number): PlanSyncBookkeeping {
  return { v: 1, owner: null, revision: 0, dirty: false, edited: false, lastSavedAt: null, deviceId: newPlanDeviceId(random), hash: null, sent: [], savedBy: null, serverSavedAt: null };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The stored bookkeeping. Anything missing or damaged reads as "this iPhone was never tied to an account", which is
 * the careful reading: a plan on it is then compared with the account's before anything is replaced.
 */
export function parseBookkeeping(raw: string | null | undefined, random?: () => number): PlanSyncBookkeeping {
  let value: unknown = null;
  try {
    value = raw ? JSON.parse(raw) : null;
  } catch {
    value = null;
  }
  const saved = isRecord(value) && value.v === 1 ? value : {};
  const text = (field: unknown) => (typeof field === "string" && field ? field : null);
  const owner = text(saved.owner);
  const revision = owner !== null && typeof saved.revision === "number" && Number.isInteger(saved.revision) && saved.revision > 0 ? saved.revision : 0;
  const deviceId = text(saved.deviceId);
  const sent = (Array.isArray(saved.sent) ? (saved.sent as unknown[]) : [])
    .filter((save): save is PlanSentSave => isRecord(save) && typeof save.hash === "string" && save.hash !== "" && typeof save.chars === "number" && Number.isInteger(save.chars) && save.chars > 0)
    .map((save) => ({ hash: save.hash, chars: save.chars }))
    .slice(0, MAX_SENT_SAVES);
  return {
    v: 1,
    owner,
    revision,
    dirty: saved.dirty === true,
    edited: saved.edited === true,
    lastSavedAt: owner !== null ? text(saved.lastSavedAt) : null,
    deviceId: deviceId && PLAN_DEVICE_ID_PATTERN.test(deviceId) ? deviceId : newPlanDeviceId(random),
    hash: revision > 0 ? text(saved.hash) : null,
    sent,
    savedBy: revision > 0 ? text(saved.savedBy) : null,
    serverSavedAt: revision > 0 ? text(saved.serverSavedAt) : null,
  };
}

export function serializeBookkeeping(book: PlanSyncBookkeeping): string {
  return JSON.stringify(book);
}

// ── When things happen ────────────────────────────────────────

/** A change is saved once nothing else has changed for this long. */
export const PLAN_SAVE_QUIET_MS = 8_000;
/** While the app stays open, at most one save in this long. */
export const PLAN_SAVE_MIN_INTERVAL_MS = 45_000;
/** A change is not kept waiting longer than this by changes that keep coming. */
export const PLAN_SAVE_MAX_WAIT_MS = 60_000;
/** Signing out waits this long at most for the last save. */
export const PLAN_SIGN_OUT_WAIT_MS = 8_000;
/** After the server said "too many saves". */
export const PLAN_RATE_LIMIT_WAIT_MS = 120_000;
/** Coming back to the app asks the account again unless it was asked this recently. */
export const PLAN_FOREGROUND_CHECK_INTERVAL_MS = 30_000;

const RETRY_DELAYS_MS = [15_000, 30_000, 60_000, 120_000] as const;
const RETRY_STEADY_MS = 300_000;

/** How long to wait before trying again after `failures` failed attempts in a row (1 = the first failure). */
export function retryDelayMs(failures: number): number {
  return RETRY_DELAYS_MS[Math.max(0, failures - 1)] ?? RETRY_STEADY_MS;
}

// ── What went wrong ───────────────────────────────────────────

/** Thrown by the transport when there is no session to send. Handled like an expired one. */
export class PlanNoSessionError extends Error {
  constructor() {
    super("No session.");
    this.name = "PlanNoSessionError";
  }
}

/**
 * Thrown by the transport for an HTTP 413. A request body over the server's limit is refused by the web server
 * itself, before tRPC sees it, so the answer has no tRPC error in it (and may not even be JSON).
 */
export class PlanTooLargeError extends Error {
  constructor() {
    super("Too large.");
    this.name = "PlanTooLargeError";
  }
}

/**
 * - "unauthorized": the session is missing, expired, not an account's, or the account was deleted. Saving stops
 *   quietly; signing in again is handled elsewhere.
 * - "rate-limited": too many saves in a short time (refused saves count too); wait.
 * - "too-large": the server will not take this plan.
 * - "unreachable": no connection, a timeout, or the server failed (its database is down: INTERNAL_SERVER_ERROR).
 *   Tried again by itself, and never read as "the account holds nothing".
 */
export type PlanSyncFailure = "unauthorized" | "rate-limited" | "too-large" | "unreachable";

/**
 * Reads a tRPC client error: the server's code under `data`, only the HTTP status when the body was not tRPC's, or
 * the transport's own error as `cause`.
 */
export function classifyPlanSyncError(error: unknown): PlanSyncFailure {
  const candidate = error as {
    name?: unknown;
    cause?: { name?: unknown } | null;
    data?: { code?: unknown; httpStatus?: unknown } | null;
    meta?: { response?: { status?: unknown } | null } | null;
  } | null;
  const names = [candidate?.name, candidate?.cause?.name];
  const code = candidate?.data?.code;
  const status = candidate?.data?.httpStatus ?? candidate?.meta?.response?.status;
  if (names.includes("PlanNoSessionError") || code === "UNAUTHORIZED" || code === "FORBIDDEN" || status === 401 || status === 403) return "unauthorized";
  if (code === "TOO_MANY_REQUESTS" || status === 429) return "rate-limited";
  if (names.includes("PlanTooLargeError") || code === "PAYLOAD_TOO_LARGE" || status === 413) return "too-large";
  return "unreachable";
}

/** The name or code of an error, for a log line. Never its message: a message can quote what was sent. */
export function errorLabel(error: unknown): string {
  const candidate = error as { name?: unknown; data?: { code?: unknown } | null } | null;
  const code = candidate?.data?.code;
  if (typeof code === "string") return code;
  return typeof candidate?.name === "string" ? candidate.name : "unknown error";
}

// ── The rules ─────────────────────────────────────────────────

/** Everything a decision is made from. */
export interface SyncFacts {
  /** The signed-in account (openId). */
  account: string;
  /** From the bookkeeping. */
  owner: string | null;
  revision: number;
  dirty: boolean;
  edited: boolean;
  savedBy: string | null;
  serverSavedAt: string | null;
  /** What the account holds now (`plan.header`); null = nothing. */
  header: PlanHeader | null;
  /** There is no plan on this iPhone (lib/plan-snapshot.ts isBlankPlan). */
  blank: boolean;
}

export type SyncStep =
  /** This iPhone holds the plan of another account. Never uploaded: the student is asked. */
  | { do: "ask-other-account" }
  /**
   * Nothing to send or fetch: this iPhone's plan is the account's as it stands. `account: "empty"`: the account
   * holds nothing, so this iPhone is at revision 0.
   */
  | { do: "settle"; account: "keep" | "empty" }
  /** Send this iPhone's plan: over the revision it is at, or (`over: "nothing"`) as the account's first plan. */
  | { do: "save"; over: "revision" | "nothing" }
  /**
   * The account holds a plan this iPhone is not known to have seen. Fetch it and compare the two (compareOutcome).
   * `mine`: whether this iPhone holds anything worth keeping. `whenDifferent`: what to do when the two really
   * differ: ask the student, load the account's quietly, or save this iPhone's over it. `restore`: loading it brings
   * the plan back to an iPhone that did not hold this account's plan.
   */
  | { do: "compare"; mine: "plan" | "nothing"; whenDifferent: "ask" | "load" | "save"; restore: boolean };

/** Two times the server gave for what should be the same save may differ by this much (rounding, two clocks). */
export const SAME_SAVE_TOLERANCE_MS = 5 * 60_000;

/** Whether `header` describes the very save this iPhone is at (same number, same saver, same moment). */
function isTheSaveIAmAt(header: PlanHeader, facts: Pick<SyncFacts, "savedBy" | "serverSavedAt">): boolean {
  if (facts.savedBy !== null && header.deviceId !== facts.savedBy) return false;
  const theirs = Date.parse(header.savedAt);
  const mine = facts.serverSavedAt === null ? NaN : Date.parse(facts.serverSavedAt);
  // A time that cannot be read proves nothing either way.
  if (!Number.isFinite(theirs) || !Number.isFinite(mine)) return true;
  return Math.abs(theirs - mine) <= SAME_SAVE_TOLERANCE_MS;
}

/** Whether the account's plan was saved no later than the save this iPhone last saw (both by the server's clock). */
function savedNoLaterThanMine(header: PlanHeader, facts: Pick<SyncFacts, "serverSavedAt">): boolean {
  const theirs = Date.parse(header.savedAt);
  const mine = facts.serverSavedAt === null ? NaN : Date.parse(facts.serverSavedAt);
  // Unreadable times: assume someone saved since, which leads to a question instead of an overwrite.
  if (!Number.isFinite(theirs) || !Number.isFinite(mine)) return false;
  return theirs <= mine + SAME_SAVE_TOLERANCE_MS;
}

/**
 * What to do once it is known what the account holds.
 *
 * The iPhone was never tied to an account (a first sign-in on it, or a plan made before accounts existed):
 *  - nothing saved, nothing here: done;
 *  - nothing saved, a plan here: it becomes the account's plan;
 *  - a plan saved, nothing here: it is loaded (a new iPhone, a reinstall);
 *  - a plan on both sides: the student chooses.
 *
 * The iPhone's plan is this account's:
 *  - nothing saved (any more): this iPhone's plan is saved as the first one, unless there is none;
 *  - the account is at the revision this iPhone has: save if anything changed;
 *  - the account is ahead: load it quietly, unless the student changed something here: then they choose;
 *  - the account is behind (the server lost history): save this iPhone's plan over it, unless there is none.
 *
 * Three refinements keep that honest in cases the revision number alone gets wrong:
 *  - an empty plan the student did not empty themselves is never saved over a plan the account holds: nothing but
 *    the student's own decision can empty a saved plan. (An iPhone that lost its own copy altogether is handled
 *    before these rules: the engine treats it as one that was never tied to the account, lib/plan-sync-engine.ts.)
 *  - "the same revision" must be the same save (saver and time), and "behind" must not have been saved after the
 *    save this iPhone last saw: otherwise the account's plan was started over somewhere else (an account deleted
 *    and made again), and the two are compared like two unrelated plans;
 *  - every "the account holds something else" goes through a comparison of the two plans first (compareOutcome).
 */
export function decideSync(facts: SyncFacts): SyncStep {
  const { header } = facts;
  if (facts.owner !== null && facts.owner !== facts.account) return { do: "ask-other-account" };

  if (facts.owner === null) {
    if (!header) return facts.blank ? { do: "settle", account: "empty" } : { do: "save", over: "nothing" };
    return facts.blank
      ? { do: "compare", mine: "nothing", whenDifferent: "load", restore: true }
      : { do: "compare", mine: "plan", whenDifferent: "ask", restore: true };
  }

  if (!header) return facts.blank ? { do: "settle", account: "empty" } : { do: "save", over: "nothing" };

  // An emptied plan is only "nothing" when the student did not empty it since the last save (a semester reset is a
  // decision like any other edit).
  const nothingHere = facts.blank && !facts.edited;
  const unrelated: SyncStep = nothingHere
    ? { do: "compare", mine: "nothing", whenDifferent: "load", restore: false }
    : { do: "compare", mine: "plan", whenDifferent: "ask", restore: false };

  if (header.revision === facts.revision) {
    if (!isTheSaveIAmAt(header, facts)) return unrelated;
    if (!facts.dirty) return { do: "settle", account: "keep" };
    // Changed, and empty without the student having emptied it: that is not a plan to save over the account's.
    return nothingHere ? { do: "compare", mine: "nothing", whenDifferent: "load", restore: false } : { do: "save", over: "revision" };
  }
  if (header.revision > facts.revision) {
    if (facts.edited) return { do: "compare", mine: "plan", whenDifferent: "ask", restore: false };
    // Nothing here and nothing ever saved from here: the account's first plan arriving is a plan coming back.
    return { do: "compare", mine: facts.blank ? "nothing" : "plan", whenDifferent: "load", restore: facts.blank && facts.revision === 0 };
  }
  if (!savedNoLaterThanMine(header, facts)) return unrelated;
  return facts.blank ? { do: "settle", account: "keep" } : { do: "compare", mine: "plan", whenDifferent: "save", restore: false };
}

/**
 * The save of this iPhone's own that the account's `header` describes, when its answer never arrived: the server
 * stored it, and only the answer was lost on the way. Nobody else saved, so there is nothing to ask and nothing to
 * fetch: this iPhone is simply at that revision, and saves again over it if its plan changed since. Null when the
 * header is not such a save.
 *
 * It takes all four: saved under this iPhone's id, a send still unanswered, exactly the next revision (every save is
 * sent over the revision this iPhone is at) and the same length as that send. The id alone is not proof: an iPhone
 * set up from another one's backup carries the id of the iPhone it was copied from, and that one may have saved
 * since. Then this gives null, the two plans are compared by content instead (compareOutcome), and a plan this
 * iPhone has never seen is loaded or asked about like any other device's.
 */
export function ownUnansweredSave(header: PlanHeader, book: Pick<PlanSyncBookkeeping, "deviceId" | "revision" | "sent">): PlanSentSave | null {
  if (header.deviceId !== book.deviceId || header.revision !== book.revision + 1) return null;
  const candidates = book.sent.filter((save) => save.chars === header.chars);
  // Two different plans of the same length: the length cannot tell which one arrived. The comparison by content can.
  return candidates.length === 1 ? candidates[0]! : null;
}

export type CompareOutcome =
  /** Both sides hold the same plan: this iPhone is simply at the account's revision. */
  | "same"
  /** The account holds a plan this iPhone already had; this iPhone's is the newer one and is saved over it. */
  | "save"
  /** The account's plan replaces this iPhone's without a question. */
  | "load"
  /** Each side holds something the other has not seen: the student chooses. */
  | "ask";

/**
 * Compares the account's plan with this iPhone's by their fingerprints (lib/plan-snapshot.ts preparePlan).
 * `syncedHash`: the plan this iPhone last saved or loaded. `sentHashes`: the plans it sent without an answer. When the
 * account holds either, it holds nothing this iPhone has not seen (a save whose answer was lost on the way is the
 * usual reason), so this iPhone's plan can simply be saved over it.
 */
export function compareOutcome(input: {
  serverHash: string;
  localHash: string;
  syncedHash: string | null;
  sentHashes: readonly string[];
  mine: "plan" | "nothing";
  whenDifferent: "ask" | "load" | "save";
}): CompareOutcome {
  if (input.serverHash === input.localHash) return "same";
  if (input.mine === "nothing") return "load";
  if (input.serverHash === input.syncedHash || input.sentHashes.includes(input.serverHash)) return "save";
  return input.whenDifferent;
}

// ── The safety copy ───────────────────────────────────────────

export interface PlanSafetyCopy {
  v: 1;
  /** When the copy was made (ISO 8601). */
  at: string;
  /** The account the replaced plan belonged to, if it was tied to one. */
  owner: string | null;
  /** Why it was replaced: the student chose the saved plan, or continued with their own account's. */
  why: "saved-plan-chosen" | "other-account";
  /** The replaced plan as a snapshot (lib/plan-snapshot.ts decodePlanSnapshot reads it), or as plain JSON when it was too large for one. */
  snapshot?: string;
  json?: string;
}

export function serializeSafetyCopy(copy: PlanSafetyCopy): string {
  return JSON.stringify(copy);
}

// ── Words ─────────────────────────────────────────────────────

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

function clock(date: Date): string {
  const hours = date.getHours();
  return `${hours % 12 || 12}:${String(date.getMinutes()).padStart(2, "0")} ${hours >= 12 ? "PM" : "AM"}`;
}

/** "today" / "yesterday" / "Oct 3" / "Oct 3, 2025", by the iPhone's calendar. */
function dayWords(date: Date, now: Date): string {
  const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((midnight(now) - midnight(date)) / 86_400_000);
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  const day = `${MONTHS[date.getMonth()]} ${date.getDate()}`;
  return date.getFullYear() === now.getFullYear() ? day : `${day}, ${date.getFullYear()}`;
}

/** "Just now" / "2 min ago" / "Today at 3:14 PM" / "Oct 3 at 3:14 PM"; null when there is no (readable) time. */
export function savedTimeLabel(iso: string | null, now: Date): string | null {
  const at = iso ? new Date(iso) : null;
  if (!at || !Number.isFinite(at.getTime())) return null;
  const seconds = (now.getTime() - at.getTime()) / 1000;
  if (seconds < 60) return "Just now"; // also when the two clocks disagree and it looks like the future
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  const day = dayWords(at, now);
  return `${day[0]!.toUpperCase()}${day.slice(1)} at ${clock(at)}`;
}

/** For a sentence: "today at 3:14 PM" / "yesterday at 9:05 AM" / "on Oct 3 at 3:14 PM"; "" when the time cannot be read. */
export function savedWhenPhrase(iso: string | null, now: Date): string {
  const at = iso ? new Date(iso) : null;
  if (!at || !Number.isFinite(at.getTime())) return "";
  const day = dayWords(at, now);
  return `${day === "today" || day === "yesterday" ? day : `on ${day}`} at ${clock(at)}`;
}

/** Every sentence the saved plan shows the student (components/plan-sync.tsx). */
export const PLAN_SYNC_COPY = {
  chooseTitle: "Which plan do you want to keep?",
  chooseMessage: (savedAt: string | null, now: Date) => {
    const when = savedWhenPhrase(savedAt, now);
    return `This iPhone has a plan, and your account has a different one${when ? `, saved ${when}` : ""}. The other one will be replaced.`;
  },
  useSavedPlan: "Use the saved plan",
  keepThisPlan: "Keep this iPhone's plan",
  otherAccountTitle: "Replace the plan on this iPhone?",
  otherAccountMessage: "This iPhone still holds the plan of another Trajectory account. Continuing replaces it with yours.",
  otherAccountContinue: "Continue",
  otherAccountSignOut: "Sign out",
  newerVersionTitle: "Reload Trajectory",
  newerVersionMessage: "Your account's plan was saved by a newer version of Trajectory. Reload this page to get the newest version and keep your plan saved.",
  unreadableTitle: "Your saved plan could not be read",
  unreadableMessage: "Trajectory could not read the plan saved to your account, so changes on this iPhone are not being saved for now. Reloading this page may fix this. If it does not, contact support.",
  feedsTitle: "Your plan is back",
  feedsMessage: "One thing stays on each iPhone: your course feed link (your Canvas calendar link, for example). Add it again in Settings under Calendars, then Course feeds, so new deadlines keep coming in.",
  ok: "OK",
} as const;

/** What the "Your plan" row in Settings says. */
export interface PlanSavedRowModel {
  title: string;
  status: string;
  /** "ok": saved. "busy": something is on its way. "attention": not saved, and the student may want to know. */
  tone: "ok" | "busy" | "attention";
  /** Tapping the row asks again (PlanSync.retry). */
  canRetry: boolean;
}

/** The row for a status; null when there is nothing to show (nobody signed in). */
export function planSavedRowModel(status: PlanSyncStatus, blocked: PlanSyncPrompt["blocked"], now: Date): PlanSavedRowModel | null {
  const row = (text: string, tone: PlanSavedRowModel["tone"], canRetry = false): PlanSavedRowModel => ({ title: "Your plan", status: text, tone, canRetry });
  switch (status.phase) {
    case "off":
      return null;
    case "checking":
      return row("Getting your plan…", "busy");
    case "choose":
      return row("Waiting for you to choose which plan to keep", "attention");
    case "unreachable":
      return row("Couldn't reach your account · select to try again", "attention", true);
    case "ready":
      break;
  }
  if (blocked === "newer-version") return row("Update Trajectory to keep saving", "attention", true);
  if (blocked === "unreadable") return row("Not saved · your saved plan could not be read", "attention", true);
  switch (status.save) {
    case "too-large":
      return row("Too large to save", "attention");
    case "offline":
      return row("Not saved yet · you're offline", "attention", true);
    case "saving":
    case "waiting":
      return row("Saving…", "busy");
    case "saved": {
      const when = savedTimeLabel(status.lastSavedAt, now);
      return row(when ? `Saved to your account · ${when}` : "Nothing to save yet", "ok");
    }
  }
}
