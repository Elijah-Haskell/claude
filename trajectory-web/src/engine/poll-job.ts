/**
 * Polls a background job until it settles. Pure control flow with an injected sleeper so the
 * schedule (interval, back-off, deadline) is unit-tested without real timers.
 *
 * A failed status check is NOT the job failing: the server keeps working (and has already charged for
 * the reading) while the phone drops a request, switches networks or is suspended. Transient check
 * failures (network, timeouts, 5xx, 429) are retried on the same schedule; polling only gives up on a
 * definitive answer from the server (the job failed, or the server no longer knows the job) or after
 * `maxErrorStreakMs` of nothing but failures.
 */
import type { LiveItem } from "../shared/live-import";

/**
 * Where a syllabus reading is (the app's own copy of the server's JobProgress, server/extraction-jobs.ts).
 * `items` and `courseName` are the live import (docs/live-import.md): the deliverables read so far, a preview and
 * not the result. A server from before the live import sends neither; the screen then shows the stage alone.
 */
export interface JobPollProgress {
  stage: "reading" | "reading-more" | "second-look" | "finishing";
  itemsFound?: number;
  items?: LiveItem[];
  courseName?: string | null;
}

export type JobPollStatus<T> =
  | { status: "queued" | "running"; elapsedMs: number; progress?: JobPollProgress }
  | { status: "done"; elapsedMs: number; result: T }
  | { status: "failed"; elapsedMs: number; error?: string };

export interface PollOptions {
  /** First wait before the first status check. */
  initialDelayMs?: number;
  /** Wait between checks; grows by `backoff` up to `maxIntervalMs`. */
  intervalMs?: number;
  /** Keep to `intervalMs` for this long before the waits start to grow (0: they grow from the first check on). */
  steadyMs?: number;
  backoff?: number;
  maxIntervalMs?: number;
  /** Give up after this long (the server keeps working; the user can retry). */
  deadlineMs?: number;
  /** Give up after failing to reach the server for this long in a row. */
  maxErrorStreakMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Called after every successful check so the UI can show elapsed time / a status line. */
  onTick?: (status: JobPollStatus<unknown>, attempt: number) => void;
  /** Called after every failed check that will be retried (the UI can say "reconnecting"). */
  onCheckError?: (error: unknown, streakMs: number) => void;
  /** Lets the screen cancel (unmount / user tapped cancel). */
  isCancelled?: () => boolean;
}

export class JobPollTimeout extends Error {
  constructor(public readonly elapsedMs: number) {
    super("This is taking longer than usual. The server is still reading your syllabus; try again in a minute.");
    this.name = "JobPollTimeout";
  }
}

export class JobPollCancelled extends Error {
  constructor() {
    super("Cancelled.");
    this.name = "JobPollCancelled";
  }
}

/** Could not reach the server for `maxErrorStreakMs`; `lastError` is the last failed check. */
export class JobPollUnreachable extends Error {
  constructor(public readonly streakMs: number, public readonly lastError: unknown) {
    super("Network request failed: Trajectory could not be reached for several minutes.");
    this.name = "JobPollUnreachable";
  }
}

/** The job itself failed on the server (a definitive answer, not a connection problem). */
export class JobFailed extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobFailed";
  }
}

export const DEFAULT_POLL_OPTIONS = {
  initialDelayMs: 2_000,
  intervalMs: 2_500,
  steadyMs: 0,
  backoff: 1.25,
  maxIntervalMs: 8_000,
  // Past the server's own cap on a job's run time (server/extraction-jobs.ts maxRunMs, 10 minutes).
  deadlineMs: 12 * 60_000,
  maxErrorStreakMs: 4 * 60_000,
};

/**
 * How a syllabus reading is asked about, so the list of deadlines found so far can fill in as they arrive
 * (docs/live-import.md): a first check after a second, then one a second. The server brings its list up to date at
 * most twice a second, so asking faster would show nothing more. After a minute and a half the waits grow again, as
 * they do for any job, so a reading that hangs is not asked at full speed until the deadline. Everything else (the
 * deadline, how failed checks are retried) is DEFAULT_POLL_OPTIONS.
 */
export const LIVE_READING_POLL_OPTIONS = {
  initialDelayMs: 1_000,
  intervalMs: 1_000,
  steadyMs: 90_000,
} as const;

/** Waits that never exceed the remaining budget, so the deadline is exact. */
export function pollSchedule(options: Required<Pick<PollOptions, "initialDelayMs" | "intervalMs" | "backoff" | "maxIntervalMs" | "deadlineMs">> & Pick<PollOptions, "steadyMs">): number[] {
  const waits: number[] = [];
  const steadyMs = options.steadyMs ?? 0;
  let elapsed = 0;
  let next = options.initialDelayMs;
  let interval = options.intervalMs;
  while (elapsed < options.deadlineMs) {
    const wait = Math.min(next, options.deadlineMs - elapsed);
    waits.push(wait);
    elapsed += wait;
    next = interval;
    if (elapsed >= steadyMs) interval = Math.min(options.maxIntervalMs, Math.round(interval * options.backoff));
  }
  return waits;
}

const DEFINITIVE_CODES = new Set(["NOT_FOUND", "UNAUTHORIZED", "FORBIDDEN", "BAD_REQUEST", "PARSE_ERROR", "METHOD_NOT_SUPPORTED", "UNPROCESSABLE_CONTENT", "PAYLOAD_TOO_LARGE"]);

/**
 * Is a failed status check worth retrying? Network failures, timeouts, 5xx, 429 and anything unrecognised
 * (a proxy's HTML error page that fails to parse) are; a definitive tRPC answer (the job is unknown, the
 * session is gone) is not.
 */
export function isTransientCheckError(error: unknown): boolean {
  if (error instanceof JobPollCancelled) return false;
  const data = (error as { data?: { code?: unknown; httpStatus?: unknown } } | null)?.data;
  const code = typeof data?.code === "string" ? data.code : "";
  if (code && DEFINITIVE_CODES.has(code)) return false;
  const status = typeof data?.httpStatus === "number" ? data.httpStatus : null;
  if (status !== null && status >= 400 && status < 500 && status !== 408 && status !== 429) return false;
  return true;
}

export async function pollJob<T>(
  check: () => Promise<JobPollStatus<T>>,
  options: PollOptions = {},
): Promise<T> {
  const cfg = { ...DEFAULT_POLL_OPTIONS, ...options };
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const waits = pollSchedule(cfg);
  let elapsedMs = 0;
  let errorStreakStart: number | null = null;
  for (let attempt = 0; attempt < waits.length; attempt++) {
    if (options.isCancelled?.()) throw new JobPollCancelled();
    await sleep(waits[attempt]);
    elapsedMs += waits[attempt];
    if (options.isCancelled?.()) throw new JobPollCancelled();
    let status: JobPollStatus<T>;
    try {
      status = await check();
    } catch (error) {
      if (options.isCancelled?.()) throw new JobPollCancelled();
      if (!isTransientCheckError(error)) throw error;
      errorStreakStart ??= elapsedMs - waits[attempt];
      const streakMs = elapsedMs - errorStreakStart;
      if (streakMs >= cfg.maxErrorStreakMs) throw new JobPollUnreachable(streakMs, error);
      options.onCheckError?.(error, streakMs);
      continue;
    }
    errorStreakStart = null;
    options.onTick?.(status, attempt + 1);
    if (status.status === "done") return status.result;
    if (status.status === "failed") throw new JobFailed(status.error || "We couldn't read this syllabus. Please try again or paste its text.");
  }
  throw new JobPollTimeout(elapsedMs);
}
