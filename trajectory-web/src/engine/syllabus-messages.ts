// Honest, non-technical failure messages for the syllabus intake.
// Never surfaces raw server / parser text ("JSON Parse error: Unexpected character: <") to a student, and every
// message says what to do next (try again, check the connection, paste the text, contact support).

import { proGateReasonFromError, PRO_GATE_CODES } from "../shared/pro";
import { NOT_SIGNED_IN_COPY } from "./account-copy";

export type IntakeStage = "read-file" | "upload" | "extract";

export interface IntakeFailure {
  title: string;
  message: string;
  /** Trying the same input again might work (a busy server, a dropped connection). */
  canRetry: boolean;
  /** Pasting the syllabus text is a sensible way forward. */
  offerPaste: boolean;
  /** The free plan's syllabus is used: the way forward is the paywall (the picked file stays on screen). */
  openPaywall?: boolean;
}

/** Where a student reaches a person (the app's contact address). */
export const SUPPORT_CONTACT = "elijahhaskell@trajectoryapp.org";
const CONTACT_LINE = `If it keeps happening, contact support at ${SUPPORT_CONTACT}.`;

function codeOf(error: unknown): string {
  const data = (error as { data?: { code?: unknown } } | null)?.data;
  return typeof data?.code === "string" ? data.code : "";
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "";
}

function nameOf(error: unknown): string {
  return error instanceof Error ? error.name : "";
}

/**
 * The server refused because this needs Pro: the free plan's one syllabus is already used (the stable
 * `data.appCode` from shared/pro.ts). The way forward is the paywall; the picked file stays.
 */
export function isFreeTierLimitError(error: unknown): boolean {
  return proGateReasonFromError(error) !== null;
}

/** Pasting only carries text: a schedule table saved as a picture is lost. Said wherever pasting is suggested. */
export const PASTE_PICTURE_NOTE = "Tables saved as pictures do not paste as text. If your schedule is a picture, upload the PDF or a photo of that page instead.";

/** What went wrong, in words a student can act on. */
export function describeIntakeFailure(error: unknown, stage: IntakeStage): IntakeFailure {
  const failure = describeFailure(error, stage);
  return failure.offerPaste ? { ...failure, message: `${failure.message} ${PASTE_PICTURE_NOTE}` } : failure;
}

function describeFailure(error: unknown, stage: IntakeStage): IntakeFailure {
  const code = codeOf(error);
  const text = messageOf(error);
  const lower = text.toLowerCase();
  const name = nameOf(error);

  const gate = proGateReasonFromError(error);
  if (gate) {
    return {
      title: gate === PRO_GATE_CODES.freeSyllabusLimit ? "Your free syllabus is used" : "Trajectory Pro needed",
      message: gate === PRO_GATE_CODES.freeSyllabusLimit
        ? "The free plan plans one syllabus. Upgrade to plan your other classes too; your file stays here, so tap Try again right after."
        : "Reading this syllabus needs Trajectory Pro. Your file stays here, so tap Try again after upgrading.",
      canRetry: true,
      offerPaste: false,
      openPaywall: true,
    };
  }
  if (lower.includes("already being read")) {
    return {
      title: "Still reading your last syllabus",
      message: "Trajectory is still reading a syllabus you sent a moment ago. Wait a minute for it to finish, then tap Try again.",
      canRetry: true,
      offerPaste: false,
    };
  }
  if (lower.includes("allowance")) {
    return {
      title: "Daily AI limit reached",
      message: "You have used today's AI allowance for reading syllabi. It resets at midnight UTC; your file stays here, so try again then.",
      canRetry: false,
      offerPaste: false,
    };
  }
  if (code === "TOO_MANY_REQUESTS") {
    return {
      title: "Too many requests",
      message: "Trajectory is getting a lot of requests from you or your network. Wait a minute, then tap Try again.",
      canRetry: true,
      offerPaste: false,
    };
  }
  if (code === "UNAUTHORIZED" || lower.includes("sign in")) {
    // Either the session is gone (the app then shows the sign-in screen, lib/sign-in-prompt.ts), or this one call went
    // out without it: the text is true in both cases (lib/account-copy.ts).
    return { title: NOT_SIGNED_IN_COPY.title, message: NOT_SIGNED_IN_COPY.message, canRetry: true, offerPaste: false };
  }
  if (lower.includes("consent") || lower.includes("not authorized by the user")) {
    return { title: "AI permission needed", message: "Reading a syllabus needs your permission to use AI. Tap Try again and allow it when asked.", canRetry: true, offerPaste: false };
  }
  if (lower.includes("couldn't read a usable schedule") || lower.includes("could not read a usable schedule")) {
    return {
      title: "Could not read this file",
      message: "The AI could not find a schedule in this file. If it is a scan or a photo, the text may be too faint. Pasting the text usually works.",
      canRetry: true,
      offerPaste: true,
    };
  }
  if (code === "NOT_FOUND" || lower.includes("has expired")) {
    return {
      title: "This reading expired",
      message: "The server no longer has this reading (it may have restarted). Tap Try again to read the file again.",
      canRetry: true,
      offerPaste: true,
    };
  }
  if (name === "JobPollTimeout" || lower.includes("took too long")) {
    return {
      title: "Taking longer than usual",
      message: `The server is taking unusually long with this syllabus. Tap Try again; if it happens again, paste the text instead. ${CONTACT_LINE}`,
      canRetry: true,
      offerPaste: true,
    };
  }
  const offline = name === "JobPollUnreachable" || lower.includes("network request failed") || lower.includes("failed to fetch") || lower.includes("network error") || lower.includes("timed out") || lower.includes("timeout");
  if (offline || code === "SERVICE_UNAVAILABLE" || code === "TIMEOUT" || code === "GATEWAY_TIMEOUT" || lower.includes("busy right now")) {
    return {
      title: offline ? "Connection problem" : "The AI is busy",
      message: offline
        ? stage === "extract"
          ? "Could not reach Trajectory. Check your connection, then tap Try again: if the server finished reading in the meantime, the result is picked up without starting over."
          : "Could not reach Trajectory. Check your connection and tap Try again: your file is kept."
        : "The AI service is busy right now. Try again in a minute, or paste the text instead.",
      canRetry: true,
      offerPaste: true,
    };
  }
  if (stage === "read-file") {
    return { title: "Could not open the file", message: "Trajectory could not read that file. Try another one, or paste the syllabus text.", canRetry: true, offerPaste: true };
  }
  if (stage === "upload") {
    return { title: "Upload failed", message: "The file could not be uploaded. Check your connection and tap Try again, or paste the syllabus text.", canRetry: true, offerPaste: true };
  }
  return { title: "Could not read the syllabus", message: `Something went wrong while reading it. Tap Try again, or paste the syllabus text instead. ${CONTACT_LINE}`, canRetry: true, offerPaste: true };
}
