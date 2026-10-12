import { describe, expect, it } from "vitest";

import {
  clearPendingExtraction,
  isSameSource,
  loadPendingExtraction,
  parsePendingExtraction,
  PENDING_EXTRACTION_KEY,
  PENDING_EXTRACTION_MAX_AGE_MS,
  savePendingExtraction,
} from "../../src/lib/pending-extraction";
import { JobPollTimeout, JobPollUnreachable } from "../../src/engine/poll-job";
import { describeIntakeFailure, isFreeTierLimitError } from "../../src/engine/syllabus-messages";
import { FREE_SYLLABUS_LIMIT_ERR_MSG, PRO_GATE_CODES } from "../../src/shared/pro";

/** The store the browser gives (localStorage behind the async interface), in memory for the test. */
function memoryStore() {
  const rows = new Map<string, string>();
  return {
    rows,
    getItem: async (k: string) => rows.get(k) ?? null,
    setItem: async (k: string, v: string) => void rows.set(k, v),
    removeItem: async (k: string) => void rows.delete(k),
  };
}

const NOW = 1_800_000_000_000;
const record = {
  jobId: "job-1",
  startedAt: NOW - 60_000,
  source: { kind: "file" as const, input: { pdfUrl: "https://files.test/uploads/u1/syllabus/a.pdf" }, local: { uri: "blob:https://app.test/a", name: "FINC 3100.pdf", mimeType: "application/pdf", kind: "pdf" as const } },
  courseHint: "Finance",
};

describe("the in-flight reading is remembered so a closed tab picks it up again", () => {
  it("saves and loads the job id with the file reference (never the document)", async () => {
    const store = memoryStore();
    await savePendingExtraction(record, store);
    const raw = store.rows.get(PENDING_EXTRACTION_KEY)!;
    expect(raw).not.toContain("rawText");
    expect(await loadPendingExtraction(NOW, store)).toMatchObject({ jobId: "job-1", courseHint: "Finance", source: { local: { name: "FINC 3100.pdf" } } });
  });

  it("forgets a record older than the server keeps a reading, and damaged records", async () => {
    const store = memoryStore();
    await savePendingExtraction({ ...record, startedAt: NOW - PENDING_EXTRACTION_MAX_AGE_MS - 1 }, store);
    expect(await loadPendingExtraction(NOW, store)).toBeNull();
    expect(store.rows.has(PENDING_EXTRACTION_KEY)).toBe(false);
    expect(parsePendingExtraction("{not json", NOW)).toBeNull();
    expect(parsePendingExtraction(JSON.stringify({ version: 1, jobId: "", startedAt: NOW, source: { kind: "file", input: {} } }), NOW)).toBeNull();
  });

  it("a pasted reading is remembered by its job alone: no text, no file", async () => {
    const store = memoryStore();
    await savePendingExtraction({ jobId: "job-3", startedAt: NOW - 5_000, source: { kind: "paste", input: {} }, courseHint: "" }, store);
    expect(await loadPendingExtraction(NOW, store)).toMatchObject({ jobId: "job-3", source: { kind: "paste" } });
  });

  it("clearing with a job id leaves a newer reading alone", async () => {
    const store = memoryStore();
    await savePendingExtraction({ ...record, jobId: "job-2", startedAt: Date.now() }, store);
    await clearPendingExtraction("job-1", store);
    expect(store.rows.has(PENDING_EXTRACTION_KEY)).toBe(true);
    await clearPendingExtraction("job-2", store);
    expect(store.rows.has(PENDING_EXTRACTION_KEY)).toBe(false);
  });

  it("a store that throws (storage blocked) never breaks the screen", async () => {
    const broken = {
      getItem: async () => {
        throw new Error("blocked");
      },
      setItem: async () => {
        throw new Error("blocked");
      },
      removeItem: async () => {
        throw new Error("blocked");
      },
    };
    await expect(savePendingExtraction(record, broken)).resolves.toBeUndefined();
    await expect(loadPendingExtraction(NOW, broken)).resolves.toBeNull();
    await expect(clearPendingExtraction(undefined, broken)).resolves.toBeUndefined();
  });

  it("matches a retry to the remembered reading by its uploaded file(s)", () => {
    expect(isSameSource(record.source, { input: { pdfUrl: record.source.input.pdfUrl } })).toBe(true);
    expect(isSameSource(record.source, { input: { pdfUrl: "https://files.test/other.pdf" } })).toBe(false);
    expect(isSameSource({ input: { pdfUrls: ["a", "b"] } }, { input: { pdfUrls: ["a", "b"] } })).toBe(true);
    expect(isSameSource({ input: { pdfUrls: ["a", "b"] } }, { input: { pdfUrls: ["a"] } })).toBe(false);
    expect(isSameSource({ input: {} }, { input: {} })).toBe(false);
  });
});

describe("failure messages say what to do next", () => {
  it("losing the connection while polling says the result is picked up on retry", () => {
    const f = describeIntakeFailure(new JobPollUnreachable(240_000, new TypeError("Failed to fetch")), "extract");
    expect(f).toMatchObject({ title: "Connection problem", canRetry: true });
    expect(f.message).toMatch(/Try again/);
    expect(f.message).toMatch(/without starting over/);
  });

  it("an expired reading and a very slow one are retryable, with a support contact for the slow one", () => {
    expect(describeIntakeFailure(Object.assign(new Error("This syllabus reading has expired."), { data: { code: "NOT_FOUND" } }), "extract")).toMatchObject({ title: "This reading expired", canRetry: true });
    const slow = describeIntakeFailure(new JobPollTimeout(720_000), "extract");
    expect(slow).toMatchObject({ title: "Taking longer than usual", canRetry: true });
    expect(slow.message).toMatch(/contact support/);
  });

  it("'already being read' is not mistaken for the daily limit", () => {
    const f = describeIntakeFailure(Object.assign(new Error("A syllabus is already being read. Wait for it to finish before starting another."), { data: { code: "TOO_MANY_REQUESTS" } }), "extract");
    expect(f).toMatchObject({ title: "Still reading your last syllabus", canRetry: true });
  });

  it("the free plan's limit opens the paywall and keeps the file", () => {
    const err = Object.assign(new Error(FREE_SYLLABUS_LIMIT_ERR_MSG), { data: { code: "FORBIDDEN", appCode: PRO_GATE_CODES.freeSyllabusLimit } });
    expect(isFreeTierLimitError(err)).toBe(true);
    const f = describeIntakeFailure(err, "extract");
    expect(f).toMatchObject({ openPaywall: true, canRetry: true, offerPaste: false });
    expect(f.message).toMatch(/file stays here/);
    expect(isFreeTierLimitError(Object.assign(new Error("nope"), { data: { code: "FORBIDDEN" } }))).toBe(false);
  });

  it("every generic failure ends with a way forward", () => {
    for (const stage of ["read-file", "upload", "extract"] as const) {
      expect(describeIntakeFailure(new Error("x"), stage).message).toMatch(/try again|Try again|paste/);
    }
  });
});
