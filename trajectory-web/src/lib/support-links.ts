// Where students reach a person, the public legal pages, and the "report AI content" e-mail (App Store 2026 AI
// guideline). Pure (no React) so the mail builders are unit-tested (the mobile app's components/ui/support-links.ts).
// The pages are the website's (trajectoryapp.org, shared/const.ts): Settings and the paywall link here.

import { SUPPORT_EMAIL, WEBSITE_PRIVACY_URL, WEBSITE_SUPPORT_URL, WEBSITE_TERMS_URL } from "../shared/const";

export { SUPPORT_EMAIL };
export const PRIVACY_URL = WEBSITE_PRIVACY_URL;
export const TERMS_URL = WEBSITE_TERMS_URL;
export const HELP_URL = WEBSITE_SUPPORT_URL;

/** What kind of AI output a report is about (goes into the subject line so reports can be sorted). */
export type AiSurface = "chat reply" | "study guide" | "practice exam" | "test review" | "plan change" | "parsed tasks" | "exam prep";

export const AI_REPORT_REASONS = [
  "Wrong or made-up information",
  "Wrong dates or times",
  "Harmful or offensive",
  "Not relevant to my request",
  "Something else",
] as const;
export type AiReportReason = (typeof AI_REPORT_REASONS)[number];

/** Longest excerpt of the AI content put in the e-mail (mail apps truncate very long mailto links). */
export const REPORT_EXCERPT_MAX = 1200;

function clip(text: string, max: number): string {
  const clean = text.replace(/\r\n/g, "\n").trim();
  if (clean.length <= max) return clean;
  // Never cut an emoji (a surrogate pair) in half: encodeURIComponent throws on a lone surrogate.
  let cut = clean.slice(0, max - 1);
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}…`;
}

/**
 * mailto: link for a report. Contains only the surface, the chosen reason, the content excerpt and whatever the
 * student typed as a note: no name, e-mail, device id or account data. The student sees the draft before sending.
 */
export function buildAiReportMailto(input: { surface: AiSurface; reason: AiReportReason; excerpt: string; note?: string; appVersion?: string }): string {
  const subject = `AI content report: ${input.surface}`;
  const head = [`Reason: ${input.reason}`, `Where: ${input.surface}`];
  if (input.appVersion) head.push(`App version: ${input.appVersion}`);
  const sections = [head.join("\n")];
  if (input.note?.trim()) sections.push(`What's wrong:\n${clip(input.note, 600)}`);
  sections.push(`AI-generated content:\n${clip(input.excerpt || "(empty)", REPORT_EXCERPT_MAX)}`);
  return `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(sections.join("\n\n"))}`;
}

/** mailto: link for "Contact support". */
export function buildSupportMailto(appVersion?: string): string {
  const body = appVersion ? `\n\n---\nTrajectory ${appVersion}` : "";
  return `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent("Trajectory support")}${body ? `&body=${encodeURIComponent(body)}` : ""}`;
}
