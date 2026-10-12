import { describe, expect, it } from "vitest";
import {
  DEFAULT_POLL_OPTIONS,
  isTransientCheckError,
  JobFailed,
  JobPollCancelled,
  JobPollTimeout,
  JobPollUnreachable,
  pollJob,
  pollSchedule,
  type JobPollStatus,
} from "../../src/engine/poll-job";

const noSleep = async () => {};

describe("pollSchedule", () => {
  it("backs off toward the max interval and lands exactly on the deadline", () => {
    const waits = pollSchedule({ initialDelayMs: 2_000, intervalMs: 2_500, backoff: 1.25, maxIntervalMs: 8_000, deadlineMs: 60_000 });
    expect(waits[0]).toBe(2_000);
    expect(waits[1]).toBe(2_500);
    expect(Math.max(...waits)).toBeLessThanOrEqual(8_000);
    expect(waits.reduce((a, b) => a + b, 0)).toBe(60_000);
    expect(waits.every((w) => w > 0)).toBe(true);
  });

  it("defaults outlast the server's own 10-minute cap on a job, with a sane number of checks", () => {
    const waits = pollSchedule(DEFAULT_POLL_OPTIONS);
    expect(waits.reduce((a, b) => a + b, 0)).toBe(12 * 60_000);
    expect(waits.length).toBeGreaterThan(60);
    expect(waits.length).toBeLessThan(120);
  });
});

const trpcError = (code: string, httpStatus?: number) => Object.assign(new Error(code), { data: { code, httpStatus } });

describe("isTransientCheckError", () => {
  it("retries network failures, timeouts, 5xx, 429 and unparseable proxy pages", () => {
    expect(isTransientCheckError(new TypeError("Network request failed"))).toBe(true);
    expect(isTransientCheckError(new Error("JSON Parse error: Unexpected character: <"))).toBe(true);
    expect(isTransientCheckError(trpcError("INTERNAL_SERVER_ERROR", 500))).toBe(true);
    expect(isTransientCheckError(trpcError("SERVICE_UNAVAILABLE", 503))).toBe(true);
    expect(isTransientCheckError(trpcError("TOO_MANY_REQUESTS", 429))).toBe(true);
    expect(isTransientCheckError(trpcError("TIMEOUT", 408))).toBe(true);
  });

  it("stops on a definitive answer: unknown/expired job, no session, refused", () => {
    expect(isTransientCheckError(trpcError("NOT_FOUND", 404))).toBe(false);
    expect(isTransientCheckError(trpcError("UNAUTHORIZED", 401))).toBe(false);
    expect(isTransientCheckError(trpcError("FORBIDDEN", 403))).toBe(false);
    expect(isTransientCheckError(new JobPollCancelled())).toBe(false);
  });
});

describe("pollJob", () => {
  it("returns the result once the job is done and reports each tick", async () => {
    const seq: JobPollStatus<string>[] = [
      { status: "queued", elapsedMs: 0 },
      { status: "running", elapsedMs: 2_000 },
      { status: "done", elapsedMs: 5_000, result: "payload" },
    ];
    const ticks: string[] = [];
    const result = await pollJob(async () => seq.shift()!, { sleep: noSleep, onTick: (s, n) => ticks.push(`${n}:${s.status}`) });
    expect(result).toBe("payload");
    expect(ticks).toEqual(["1:queued", "2:running", "3:done"]);
  });

  it("throws the job's own error message when it fails", async () => {
    await expect(pollJob(async () => ({ status: "failed", elapsedMs: 1, error: "No readable text." }), { sleep: noSleep })).rejects.toThrow("No readable text.");
  });

  it("gives up at the deadline with a friendly timeout", async () => {
    let checks = 0;
    const attempt = pollJob(async () => { checks++; return { status: "running", elapsedMs: 0 }; }, { sleep: noSleep, deadlineMs: 20_000, initialDelayMs: 5_000, intervalMs: 5_000, backoff: 1, maxIntervalMs: 5_000 });
    await expect(attempt).rejects.toBeInstanceOf(JobPollTimeout);
    expect(checks).toBe(4);
  });

  it("a network blip does not abandon the reading: failed checks are retried and the result still arrives", async () => {
    const seq: Array<JobPollStatus<string> | Error> = [
      { status: "running", elapsedMs: 2_000, progress: { stage: "reading" } },
      new TypeError("Network request failed"),
      Object.assign(new Error("Bad Gateway"), { data: { code: "INTERNAL_SERVER_ERROR", httpStatus: 502 } }),
      { status: "running", elapsedMs: 60_000, progress: { stage: "reading-more", itemsFound: 38 } },
      { status: "done", elapsedMs: 80_000, result: "payload" },
    ];
    const errors: number[] = [];
    const ticks: string[] = [];
    const result = await pollJob(
      async () => {
        const next = seq.shift()!;
        if (next instanceof Error) throw next;
        return next;
      },
      { sleep: noSleep, onCheckError: (_e, streak) => errors.push(streak), onTick: (s) => ticks.push(s.status) },
    );
    expect(result).toBe("payload");
    expect(errors).toHaveLength(2);
    expect(ticks).toEqual(["running", "running", "done"]);
  });

  it("gives up only after several minutes of nothing but failed checks", async () => {
    let checks = 0;
    const attempt = pollJob(async () => { checks++; throw new TypeError("Network request failed"); }, { sleep: noSleep, maxErrorStreakMs: 60_000, initialDelayMs: 5_000, intervalMs: 5_000, backoff: 1, maxIntervalMs: 5_000 });
    const error = await attempt.catch((e) => e);
    expect(error).toBeInstanceOf(JobPollUnreachable);
    expect((error as JobPollUnreachable).streakMs).toBeGreaterThanOrEqual(60_000);
    expect(checks).toBe(12); // 12 x 5 s, not one strike
  });

  it("one good answer resets the failure streak", async () => {
    let n = 0;
    const result = await pollJob(
      async (): Promise<JobPollStatus<string>> => {
        n++;
        if (n === 20) return { status: "done", elapsedMs: 0, result: "ok" };
        if (n % 5 === 0) return { status: "running", elapsedMs: 0 };
        throw new TypeError("Network request failed");
      },
      { sleep: noSleep, maxErrorStreakMs: 25_000, initialDelayMs: 5_000, intervalMs: 5_000, backoff: 1, maxIntervalMs: 5_000 },
    );
    expect(result).toBe("ok");
  });

  it("a definitive answer (the server no longer knows the job) ends polling at once", async () => {
    let checks = 0;
    const gone = Object.assign(new Error("This syllabus reading has expired."), { data: { code: "NOT_FOUND", httpStatus: 404 } });
    await expect(pollJob(async () => { checks++; throw gone; }, { sleep: noSleep })).rejects.toBe(gone);
    expect(checks).toBe(1);
  });

  it("a job that failed on the server is a JobFailed with its own message", async () => {
    const error = (await pollJob(async () => ({ status: "failed", elapsedMs: 1, error: "No readable text." }), { sleep: noSleep }).catch((e: unknown) => e)) as Error;
    expect(error).toBeInstanceOf(JobFailed);
    expect(error.message).toBe("No readable text.");
  });

  it("stops promptly when cancelled", async () => {
    let cancelled = false;
    let checks = 0;
    const attempt = pollJob(async () => { checks++; cancelled = true; return { status: "running", elapsedMs: 0 }; }, { sleep: noSleep, isCancelled: () => cancelled });
    await expect(attempt).rejects.toBeInstanceOf(JobPollCancelled);
    expect(checks).toBe(1);
  });
});
