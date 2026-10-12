/**
 * The Trajectory server, as the iPhone app calls it: tRPC procedures over HTTP with the superjson transformer
 * (server/_core/trpc.ts), one call per request. The procedure names, inputs and answers below are transcribed from
 * server/routers.ts; the server validates every input itself.
 *
 * Every call carries the account's session as a Bearer token (lib/session.ts). What the mobile client's fetch wrapper
 * does (lib/trpc.ts there) happens here too:
 *  - an AI procedure (`ai.*`) is only sent once the student has agreed to AI processing (lib/ai-consent.ts);
 *  - an UNAUTHORIZED answer to a request that carried a session means that session is gone: reported once
 *    (lib/sign-in-prompt.ts), and the account layer asks the server once more before signing the student out;
 *  - a FORBIDDEN answer with a Pro-gate code opens the paywall; while this browser holds Pro the purchase is linked
 *    again and the call sent once more.
 * `quiet` calls (the session's own refresh, the saved plan's background saves) skip both prompts.
 */
import SuperJSON from "superjson";

import type { LiveItem } from "../shared/live-import";
import type { PlanHeader, PlanSaveInput, PlanSaveResult, SavedPlan } from "../shared/plan-sync";
import { appErrorCodeFromError, type AppErrorCode } from "../shared/pro";
import type { SyllabusExtraction } from "../engine/syllabus-extraction-utils";
import { requestAIProcessingConsent, requiresAIConsent } from "./ai-consent";
import { API_BASE_URL } from "./config";
import { bearerTokenOf, noteForbiddenResponse, noteSignedOutResponse } from "./sign-in-prompt";

// ── Who is calling ────────────────────────────────────────────

/** The session token every request carries; lib/session.ts registers how it is read. */
let tokenProvider: () => string | null = () => null;

export function setSessionTokenProvider(provider: () => string | null): void {
  tokenProvider = provider;
}

// ── What the server answers with ──────────────────────────────

export interface ApiUser {
  id: number;
  openId: string;
  name: string | null;
  email: string | null;
  loginMethod: string | null;
  lastSignedIn: Date | string | null;
}

export interface SignInResult {
  sessionToken: string;
  user: ApiUser;
}

export type ChatRole = "user" | "assistant";

export interface ParsedTask {
  name: string;
  courseName: string;
  estimatedMinutes: number;
  difficulty: number;
  dueDate: string;
  notes?: string;
}

export interface ParsedEvent {
  title: string;
  date: string;
  startTime: string;
  endTime: string;
  type: string;
  notes?: string;
}

export type WeekdayShort = "Mon" | "Tue" | "Wed" | "Thu" | "Fri" | "Sat" | "Sun";

export interface ParsedRecurringEvent {
  title: string;
  days: WeekdayShort[];
  startTime: string;
  endTime: string;
  color: string;
  description?: string;
}

export interface ParsedNewClass {
  name: string;
  days: WeekdayShort[];
  startTime: string;
  endTime: string;
  location?: string;
  color: string;
}

export interface ParsedTasksResult {
  tasks: ParsedTask[];
  events: ParsedEvent[];
  recurringEvents: ParsedRecurringEvent[];
  summary: string;
}

export interface EditBlockProposal {
  id: string;
  startTime?: string;
  endTime?: string;
  date?: string;
  title?: string;
}

export interface DeadlineChangeProposal {
  taskId: string;
  dueDate: string;
  dueTime?: string;
}

export interface ChatResult {
  type: "question" | "schedule" | "edit" | "deadline" | "chat";
  reply: string;
  tasks: ParsedTask[];
  events: ParsedEvent[];
  recurringEvents: ParsedRecurringEvent[];
  newClasses: ParsedNewClass[];
  editBlocks: EditBlockProposal[];
  deadlineChanges: DeadlineChangeProposal[];
}

export interface EditScheduleResult {
  editBlocks: Array<EditBlockProposal | Record<string, unknown>>;
  editRecurring: Array<{ id: string; startTime?: string; endTime?: string; days?: string[] } | Record<string, unknown>>;
  newEvents: ParsedEvent[];
  newRecurring: ParsedRecurringEvent[];
  healthPrefsUpdate?: { wakeTime?: string; bedtime?: string };
  summary: string;
  noMatchFound: boolean;
  fallbackMessage?: string;
}

/** The extraction procedures' input (SYLLABUS_EXTRACTION_INPUT in server/routers.ts). */
export interface SyllabusExtractionInput {
  pdfUrl?: string;
  pdfUrls?: string[];
  rawText?: string;
  courseName?: string;
  today: string;
  semesterStart?: string;
  semesterEnd?: string;
}

/** What a syllabus reading answers (server/syllabus-extract.ts SyllabusExtractionResult): the extraction plus counts. */
export interface SyllabusExtractionResult extends Record<string, unknown> {
  count: number;
  extraction?: SyllabusExtraction;
}

export interface SyllabusJobProgress {
  stage: "reading" | "reading-more" | "second-look" | "finishing";
  itemsFound?: number;
  items?: LiveItem[];
  courseName?: string | null;
}

/** ai.syllabusExtractionStatus (server/extraction-jobs.ts publicView). */
export interface SyllabusJobView {
  id: string;
  status: "queued" | "running" | "done" | "failed";
  progress?: SyllabusJobProgress;
  result?: SyllabusExtractionResult;
  error?: string;
  /** Milliseconds the job has run, when the server reports it. */
  elapsedMs?: number;
  [key: string]: unknown;
}

export interface SemesterStrategyResult {
  planSummary: string;
  taskPlans: Array<{
    taskId: string;
    rationale: string;
    priority: number;
    sessions: Array<{ label: string; purpose: string; minutes: number; earliestDaysBeforeDue: number; targetDaysBeforeDue: number }>;
  }>;
  warnings: Array<{ severity: string; taskId: string; message: string }>;
}

/**
 * Every procedure this app calls: its kind, input and answer. The study tools' answers (server/study-ai.ts) are
 * validated by the engine's parsers (src/engine/study-parsers.ts), so they are typed loosely here.
 */
export interface Procedures {
  "auth.me": { kind: "query"; input: void; output: ApiUser | null };
  "auth.apple": {
    kind: "mutation";
    input: { identityToken: string; appleUserId: string; email?: string; givenName?: string; familyName?: string; authorizationCode?: string };
    output: SignInResult;
  };
  "auth.refresh": { kind: "mutation"; input: void; output: { sessionToken: string } };
  "auth.logout": { kind: "mutation"; input: void; output: { success: true } };
  "account.delete": { kind: "mutation"; input: void; output: { success: true; appleRevoked: boolean } };
  "account.recheckPro": { kind: "mutation"; input: void; output: { pro: boolean } };
  "plan.header": { kind: "query"; input: void; output: PlanHeader | null };
  "plan.load": { kind: "query"; input: void; output: SavedPlan | null };
  "plan.save": { kind: "mutation"; input: PlanSaveInput; output: PlanSaveResult };
  "ai.uploadFile": {
    kind: "mutation";
    input: { base64: string; mimeType: "application/pdf" | "image/jpeg" | "image/png" | "image/webp"; purpose?: "syllabus" | "test-review" };
    output: { url: string };
  };
  "ai.uploadSyllabus": { kind: "mutation"; input: { fileName: string; base64Data: string; mimeType: string }; output: { url: string } };
  "ai.extractDocxText": { kind: "mutation"; input: { base64Data: string }; output: { text: string } };
  "ai.extractSyllabus": { kind: "mutation"; input: SyllabusExtractionInput; output: SyllabusExtractionResult };
  "ai.startSyllabusExtraction": { kind: "mutation"; input: SyllabusExtractionInput; output: { jobId: string } };
  "ai.syllabusExtractionStatus": { kind: "query"; input: { jobId: string }; output: SyllabusJobView };
  "ai.planSemesterStrategy": {
    kind: "mutation";
    input: {
      today: string;
      semesterStart?: string;
      semesterEnd?: string;
      breaks?: Array<{ name: string; startDate: string; endDate: string }>;
      energyProfile: "morning" | "afternoon" | "night";
      studyStyle: "short_bursts" | "deep_blocks";
      classes: Array<{ id: string; name: string; days: string[]; startTime: string; endTime: string; isAsynchronous?: boolean }>;
      tasks: Array<{ id: string; name: string; courseId: string; courseName: string; dueDate: string; estimatedMinutes: number; difficulty: number; notes?: string; type?: string; weightPercent?: number }>;
    };
    output: SemesterStrategyResult;
  };
  "ai.parseTasks": {
    kind: "mutation";
    input: { message: string; classes: Array<{ id: string; name: string }>; today: string; memoryContext?: string };
    output: ParsedTasksResult;
  };
  "ai.refineTasks": {
    kind: "mutation";
    input: { history: Array<{ role: ChatRole; content: string }>; message: string; classes: Array<{ id: string; name: string }>; today: string; memoryContext?: string };
    output: ParsedTasksResult;
  };
  "ai.editSchedule": {
    kind: "mutation";
    input: {
      message: string;
      today: string;
      scheduleBlocks: Array<{ id: string; title: string; date: string; startTime: string; endTime: string; type: string }>;
      recurringEvents: Array<{ id: string; title: string; days: string[]; startTime: string; endTime: string }>;
      healthPrefs?: { wakeTime?: string; bedtime?: string };
      tasks?: Array<{ id: string; name: string; courseName: string; dueDate: string; estimatedMinutes: number; difficulty: number; status: string }>;
      grades?: Array<{ classId: string; letterGrade: string; numericGrade?: number }>;
      memoryContext?: string;
    };
    output: EditScheduleResult;
  };
  "ai.conversationalChat": {
    kind: "mutation";
    input: {
      history: Array<{ role: ChatRole; content: string }>;
      message: string;
      classes: Array<{ id: string; name: string }>;
      today: string;
      memoryContext?: string;
      scheduleBlocks?: Array<{ id: string; title: string; date: string; startTime: string; endTime: string; type: string; completionStatus?: string; accepted?: boolean }>;
      tasks?: Array<{ id: string; name: string; courseName: string; dueDate: string; dueTime?: string; estimatedMinutes: number; difficulty: number; status: string; importance?: number }>;
      recurringEvents?: Array<{ id: string; title: string; days: string[]; startTime: string; endTime: string }>;
      healthPrefs?: { wakeTime?: string; bedtime?: string; sleepTargetHours?: number };
      grades?: Array<{ classId: string; letterGrade: string; numericGrade?: number }>;
    };
    output: ChatResult;
  };
  "ai.analyzeSyllabus": { kind: "mutation"; input: { syllabusText: string; courseName?: string }; output: unknown };
  "ai.generatePracticeExam": {
    kind: "mutation";
    input: { syllabusText: string; courseName?: string; questionCount?: number; focusTopics?: string[] };
    output: unknown;
  };
  "ai.generateExamContent": {
    kind: "mutation";
    input: { topics: string[]; rawInput?: string; pdfUrl?: string; imageUrls?: string[]; className?: string; examDate?: string; today?: string };
    output: unknown;
  };
  "ai.reviewTest": { kind: "mutation"; input: { imageUrls: string[]; courseName?: string; userQuestion?: string }; output: unknown };
}

export type ProcedurePath = keyof Procedures;
export type QueryPath = { [P in ProcedurePath]: Procedures[P]["kind"] extends "query" ? P : never }[ProcedurePath];
export type MutationPath = { [P in ProcedurePath]: Procedures[P]["kind"] extends "mutation" ? P : never }[ProcedurePath];
export type ProcedureInput<P extends ProcedurePath> = Procedures[P]["input"];
export type ProcedureOutput<P extends ProcedurePath> = Procedures[P]["output"];

// ── Errors ────────────────────────────────────────────────────

/** The server's answer to a call that failed: tRPC's code, the HTTP status and, for a refusal, the app's own code. */
export class ApiError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  readonly appCode: AppErrorCode | null;
  readonly path: string;
  /** For lib/plan-sync.ts classifyPlanSyncError, which reads a tRPC client error's `data`. */
  readonly data: { code: string; httpStatus: number; appCode?: AppErrorCode | null };

  constructor(input: { message: string; code: string; httpStatus: number; appCode?: AppErrorCode | null; path: string }) {
    super(input.message);
    this.name = "ApiError";
    this.code = input.code;
    this.httpStatus = input.httpStatus;
    this.appCode = input.appCode ?? null;
    this.path = input.path;
    this.data = { code: input.code, httpStatus: input.httpStatus, appCode: this.appCode };
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

/** "Not signed in" (the session is missing, expired or the account was deleted). */
export function isUnauthorizedError(error: unknown): boolean {
  return isApiError(error) && (error.code === "UNAUTHORIZED" || error.httpStatus === 401);
}

/** Could not reach the server at all (offline, a timeout, the request aborted by the caller). */
export class NetworkError extends Error {
  constructor(message = "Could not reach Trajectory. Check your connection and try again.") {
    super(message);
    this.name = "NetworkError";
  }
}

/** A sentence for the student from any error a call can throw. */
export function errorMessage(error: unknown, fallback = "Something went wrong. Please try again."): string {
  if (error instanceof ApiError || error instanceof NetworkError) return error.message || fallback;
  if (error instanceof Error && error.name === "AbortError") return "That took too long. Please try again.";
  return fallback;
}

type ErrorShape = { message?: unknown; code?: unknown; data?: { code?: unknown; httpStatus?: unknown; appCode?: unknown } };

/** The tRPC error envelope, superjson-wrapped (`{ error: { json: shape } }`) or plain (`{ error: shape }`). */
function errorFromEnvelope(envelope: unknown, status: number, path: string): ApiError {
  const raw = (envelope as { json?: ErrorShape } | ErrorShape | null) ?? {};
  const shape: ErrorShape = "json" in raw && raw.json && typeof raw.json === "object" ? raw.json : (raw as ErrorShape);
  const data = shape.data ?? {};
  const code = typeof data.code === "string" ? data.code : status === 401 ? "UNAUTHORIZED" : status === 403 ? "FORBIDDEN" : "INTERNAL_SERVER_ERROR";
  const httpStatus = typeof data.httpStatus === "number" ? data.httpStatus : status;
  const message = typeof shape.message === "string" && shape.message ? shape.message : httpMessage(status);
  return new ApiError({ message, code, httpStatus, appCode: appErrorCodeFromError({ data, message }), path });
}

function httpMessage(status: number): string {
  if (status === 413) return "That request is too large.";
  if (status === 429) return "Too many requests. Please try again in a moment.";
  if (status === 401) return "Please sign in again.";
  if (status === 403) return "This is not available for your account.";
  if (status >= 500) return "Something went wrong on our side. Please try again.";
  return "Something went wrong. Please try again.";
}

// ── The call ──────────────────────────────────────────────────

export interface CallOptions {
  /** Skip the session-ended and paywall prompts (the session's own refresh, background saves). */
  quiet?: boolean;
  /** Send this session token instead of the one the app holds (the refresh compares the two). */
  token?: string | null;
  signal?: AbortSignal;
  /** Give up after this long. Default: 60 s (uploads and AI calls take a while). */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;

function serializeInput(input: unknown): string {
  return JSON.stringify(SuperJSON.serialize(input === undefined ? null : input));
}

/** The result's `data`, superjson-wrapped (`{ json, meta? }`) by the transformer, or plain from an older server. */
function deserializeOutput(data: unknown): unknown {
  if (data && typeof data === "object" && "json" in (data as Record<string, unknown>)) {
    return SuperJSON.deserialize(data as { json: never; meta?: never });
  }
  return data;
}

async function call(path: string, kind: "query" | "mutation", input: unknown, options: CallOptions = {}): Promise<unknown> {
  const base = `${API_BASE_URL}/api/trpc/${path}`;
  const url = kind === "query" && input !== undefined ? `${base}?input=${encodeURIComponent(serializeInput(input))}` : base;
  if (requiresAIConsent(url) && !(await requestAIProcessingConsent())) {
    throw new ApiError({ message: "AI processing was not authorized by the user.", code: "CONSENT_DECLINED", httpStatus: 0, path });
  }
  const token = options.token === undefined ? tokenProvider() : options.token;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (kind === "mutation") headers["Content-Type"] = "application/json";
  const body = kind === "mutation" ? serializeInput(input) : undefined;
  const sentToken = bearerTokenOf(headers);

  const send = async (): Promise<Response> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const abort = () => controller.abort();
    options.signal?.addEventListener("abort", abort);
    try {
      return await fetch(url, { method: kind === "query" ? "GET" : "POST", headers, body, signal: controller.signal, credentials: "omit" });
    } catch (error) {
      if (options.signal?.aborted) throw error;
      throw new NetworkError(controller.signal.aborted ? "Trajectory took too long to answer. Please try again." : undefined);
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    }
  };

  let response = await send();
  if (!options.quiet) {
    if (response.status === 401) {
      let parsed: unknown;
      try {
        parsed = await response.clone().json();
      } catch {
        parsed = undefined;
      }
      noteSignedOutResponse({ url, status: response.status, body: parsed, sentToken });
    }
    if (response.status === 403) response = await noteForbiddenResponse(response, send, sentToken);
  }

  let parsed: unknown = null;
  const text = await response.text();
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }
  const envelope = parsed && typeof parsed === "object" ? (parsed as { result?: { data?: unknown }; error?: unknown }) : null;
  if (envelope && "result" in envelope && envelope.result) return deserializeOutput(envelope.result.data);
  if (envelope && "error" in envelope) throw errorFromEnvelope(envelope.error, response.status, path);
  // No tRPC envelope: the web server itself answered (413 from the body limit, a proxy page).
  const plain = envelope && typeof (envelope as { error?: unknown }).error === "string" ? (envelope as { error: string }).error : null;
  throw new ApiError({
    message: plain ?? httpMessage(response.status),
    code: response.status === 413 ? "PAYLOAD_TOO_LARGE" : response.status === 401 ? "UNAUTHORIZED" : response.status === 403 ? "FORBIDDEN" : response.status === 429 ? "TOO_MANY_REQUESTS" : "INTERNAL_SERVER_ERROR",
    httpStatus: response.status,
    path,
  });
}

type Args<P extends ProcedurePath> = ProcedureInput<P> extends void ? [input?: undefined, options?: CallOptions] : [input: ProcedureInput<P>, options?: CallOptions];

/** A read (`GET /api/trpc/<path>?input=`). */
export function query<P extends QueryPath>(path: P, ...args: Args<P>): Promise<ProcedureOutput<P>> {
  return call(path, "query", args[0], args[1]) as Promise<ProcedureOutput<P>>;
}

/** A write (`POST /api/trpc/<path>`). */
export function mutate<P extends MutationPath>(path: P, ...args: Args<P>): Promise<ProcedureOutput<P>> {
  return call(path, "mutation", args[0], args[1]) as Promise<ProcedureOutput<P>>;
}

/** The REST helpers the server keeps beside tRPC (server/_core/auth-routes.ts, server/google-calendar.ts). */
export async function restCall<T = unknown>(path: string, init: { method?: "GET" | "POST"; body?: unknown; timeoutMs?: number } = {}): Promise<T> {
  const token = tokenProvider();
  const headers: Record<string, string> = { Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path.startsWith("/") ? path : `/${path}`}`, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: controller.signal,
      credentials: "omit",
    });
  } catch {
    throw new NetworkError();
  } finally {
    clearTimeout(timer);
  }
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  if (!response.ok) {
    const message = parsed && typeof parsed === "object" && typeof (parsed as { error?: unknown }).error === "string" ? (parsed as { error: string }).error : httpMessage(response.status);
    throw new ApiError({ message, code: response.status === 401 ? "UNAUTHORIZED" : response.status === 403 ? "FORBIDDEN" : "INTERNAL_SERVER_ERROR", httpStatus: response.status, path });
  }
  return parsed as T;
}
