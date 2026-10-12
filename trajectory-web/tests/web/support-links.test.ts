import { describe, expect, it } from "vitest";

import {
  AI_REPORT_REASONS,
  HELP_URL,
  PRIVACY_URL,
  REPORT_EXCERPT_MAX,
  SUPPORT_EMAIL,
  TERMS_URL,
  buildAiReportMailto,
  buildSupportMailto,
} from "../../src/lib/support-links";

function parseMailto(url: string) {
  const [address, query] = url.replace(/^mailto:/, "").split("?");
  const params = new URLSearchParams(query);
  return { address, subject: params.get("subject") ?? "", body: params.get("body") ?? "" };
}

describe("AI content report e-mail", () => {
  it("goes to support with the surface in the subject and the reason, note and excerpt in the body", () => {
    const mail = parseMailto(buildAiReportMailto({ surface: "study guide", reason: AI_REPORT_REASONS[0], excerpt: "Mitosis has 9 phases.", note: "It has 4." }));
    expect(mail.address).toBe(SUPPORT_EMAIL);
    expect(mail.subject).toBe("AI content report: study guide");
    expect(mail.body).toContain("Reason: Wrong or made-up information");
    expect(mail.body).toContain("What's wrong:\nIt has 4.");
    expect(mail.body).toContain("AI-generated content:\nMitosis has 9 phases.");
  });

  it("names the app version when given one, and nothing about the account", () => {
    const mail = parseMailto(buildAiReportMailto({ surface: "chat reply", reason: "Wrong dates or times", excerpt: "Tuesday", appVersion: "1.1.0 (web)" }));
    expect(mail.body).toContain("App version: 1.1.0 (web)");
    expect(mail.body).not.toMatch(/@example|openId|session/i);
  });

  it("clips a long excerpt and leaves out an empty note", () => {
    const mail = parseMailto(buildAiReportMailto({ surface: "chat reply", reason: "Something else", excerpt: "x".repeat(5000), note: "   " }));
    expect(mail.body).not.toContain("What's wrong");
    const excerpt = mail.body.split("AI-generated content:\n")[1]!;
    expect(excerpt.length).toBeLessThanOrEqual(REPORT_EXCERPT_MAX);
    expect(excerpt.endsWith("…")).toBe(true);
  });

  it("never cuts an emoji in half at the clip point (encodeURIComponent would throw)", () => {
    // The chat's own replies use emoji; put one exactly across the clip boundary.
    const excerpt = "a".repeat(REPORT_EXCERPT_MAX - 2) + "\u{1F44B}" + "b".repeat(50);
    const url = buildAiReportMailto({ surface: "chat reply", reason: "Something else", excerpt });
    const body = parseMailto(url).body.split("AI-generated content:\n")[1]!;
    expect(body.endsWith("…")).toBe(true);
    expect(body).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });
});

describe("support and legal links", () => {
  it("Contact support opens a mail to the support address", () => {
    const mail = parseMailto(buildSupportMailto("1.0.7"));
    expect(mail.address).toBe(SUPPORT_EMAIL);
    expect(mail.subject).toBe("Trajectory support");
    expect(mail.body).toContain("Trajectory 1.0.7");
  });

  it("the legal and help pages are the website's, never the API host", () => {
    expect([PRIVACY_URL, TERMS_URL, HELP_URL]).toEqual([
      "https://www.trajectoryapp.org/privacy.html",
      "https://www.trajectoryapp.org/terms.html",
      "https://www.trajectoryapp.org/support.html",
    ]);
    for (const url of [PRIVACY_URL, TERMS_URL, HELP_URL]) expect(url).not.toMatch(/manus\.space/);
  });
});
