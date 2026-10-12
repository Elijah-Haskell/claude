/**
 * Turns whatever a study-feature call threw (an ApiError from src/lib/api.ts, the "AI consent declined" error the
 * API client throws, a network failure, an answer the parsers refused) into a message a student can act on.
 * The mobile app's lib/study-errors.ts; pure and duck-typed, so it imports neither the API client nor React.
 */
import { NOT_SIGNED_IN_COPY } from "../engine/account-copy";

export type StudyErrorKind =
  | "quota"
  | "offline"
  | "auth"
  | "consent"
  | "too_large"
  | "unsupported"
  | "busy"
  | "invalid"
  | "unknown";

export interface StudyErrorInfo {
  kind: StudyErrorKind;
  title: string;
  message: string;
  /** Trying the same thing again can work (as opposed to "choose a smaller file"). */
  retryable: boolean;
}

/** The message src/lib/api.ts throws when the student declines the AI-processing prompt (the same text as lib/trpc.ts). */
export const AI_CONSENT_DECLINED_MESSAGE = "AI processing was not authorized by the user.";

function codeOf(error: unknown): string {
  if (!error || typeof error !== "object") return "";
  const e = error as { data?: { code?: unknown }; shape?: { data?: { code?: unknown } }; code?: unknown };
  const candidate = e.data?.code ?? e.shape?.data?.code ?? e.code;
  return typeof candidate === "string" ? candidate : "";
}

function messageOf(error: unknown): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string") {
    return (error as { message: string }).message;
  }
  return "";
}

/** The API client's "could not reach the server at all" error (src/lib/api.ts NetworkError), known by its name. */
function isNetworkError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { name?: unknown }).name === "NetworkError");
}

/** A server message we wrote (short, plain sentence) rather than a stack trace, SQL, or a zod issue dump. */
function isFriendly(message: string): boolean {
  const m = message.trim();
  if (m.length === 0 || m.length > 280) return false;
  if (/^[\[{]/.test(m)) return false; // zod issues arrive as a JSON array
  return !/\b(stack|at \w+\.\w+|ECONN|ENOTFOUND|SQL|TypeError|undefined|null|Unexpected token)\b/i.test(m);
}

/** The account copy says "this iPhone"; here the plan is in this browser. */
const here = (text: string) => text.replace(/this iPhone/g, "this browser");

export function describeStudyError(error: unknown, action = "do that"): StudyErrorInfo {
  const message = messageOf(error);
  const code = codeOf(error);

  if (message === AI_CONSENT_DECLINED_MESSAGE || /not authorized by the user/i.test(message)) {
    return {
      kind: "consent",
      title: "AI processing is off",
      message: "This feature sends your content to an AI service, so it needs your OK. Press the button again and choose Allow when asked.",
      retryable: true,
    };
  }

  if (code === "TOO_MANY_REQUESTS") {
    return {
      kind: "quota",
      title: "AI limit reached",
      message: isFriendly(message) ? message : "You've reached the AI usage limit for now. Please wait a bit and try again. Your saved plan is unaffected.",
      retryable: true,
    };
  }
  if (code === "UNAUTHORIZED") {
    // Either the session is gone (the app then shows the sign-in screen, lib/sign-in-prompt.ts), or this one call went
    // out without it: the text is true in both cases (engine/account-copy.ts).
    return { kind: "auth", title: NOT_SIGNED_IN_COPY.title, message: here(NOT_SIGNED_IN_COPY.message), retryable: true };
  }
  if (code === "PAYLOAD_TOO_LARGE") {
    return { kind: "too_large", title: "File too large", message: isFriendly(message) ? message : "That file is too large. Choose a smaller one.", retryable: false };
  }
  if (code === "UNSUPPORTED_MEDIA_TYPE") {
    return { kind: "unsupported", title: "File type not supported", message: isFriendly(message) ? message : "That file type isn't supported. Use a JPEG, PNG or PDF.", retryable: false };
  }
  if (code === "BAD_REQUEST") {
    return {
      kind: "invalid",
      title: "Couldn't use that input",
      message: isFriendly(message) ? message : "Something in that request was too long or not valid. Try shorter text or fewer photos.",
      retryable: false,
    };
  }
  if (code === "SERVICE_UNAVAILABLE" || code === "GATEWAY_TIMEOUT" || code === "TIMEOUT" || code === "BAD_GATEWAY") {
    return { kind: "busy", title: "AI is busy", message: isFriendly(message) ? message : "The AI service is busy right now. Please try again in a moment.", retryable: true };
  }

  if (isNetworkError(error) || (!code && /network request failed|failed to fetch|network error|internet connection|offline|econnrefused|timed out/i.test(message))) {
    return { kind: "offline", title: "No connection", message: "We couldn't reach Trajectory. Check your internet connection and try again.", retryable: true };
  }

  return {
    kind: "unknown",
    title: "Something went wrong",
    message: isFriendly(message) ? message : `We couldn't ${action}. Please try again.`,
    retryable: true,
  };
}
