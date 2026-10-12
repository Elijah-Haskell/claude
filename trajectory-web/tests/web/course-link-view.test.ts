import { describe, expect, it } from "vitest";

import { addLinkHint, checkedAgo, COURSE_LINK_COPY, COURSE_SITES, feedChangeSummary, feedStatus, linkAddedNote, linkCheckedNote, linkRefusedNote } from "../../src/lib/course-link-view";

const NOW = new Date(2026, 9, 7, 12, 0, 0);
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60000).toISOString();

describe("what the screen has always promised, word for word", () => {
  it("the link stays on the phone", () => {
    expect(COURSE_LINK_COPY.privacy).toBe("The link is private to you. It stays on this phone and is fetched straight from your school, never through Trajectory's server.");
  });

  it("what a link brings in", () => {
    expect(COURSE_LINK_COPY.scope).toBe("Only assignments, quizzes and exams are imported (not lectures or office hours), from today on. Each keeps its course and due time.");
  });

  it("where the link is on each of the four course sites", () => {
    expect(COURSE_SITES).toEqual([
      { name: "Canvas", steps: "Calendar, then Calendar Feed (bottom of the right sidebar). Copy the link." },
      { name: "Moodle", steps: "Calendar, Import or export calendars, Export calendar, Get calendar URL." },
      { name: "Blackboard", steps: "Calendar, the settings gear, Share Calendar. Copy the link." },
      { name: "Brightspace (D2L)", steps: "Calendar, Subscribe. Copy the link." },
    ]);
  });

  it("removing a link says what happens to the deadlines it added", () => {
    expect(COURSE_LINK_COPY.removeQuestion).toBe("Remove this link? Deadlines it already added stay in your tasks; they just stop following the course site.");
  });
});

describe("when a link was last checked", () => {
  it("counts minutes, then hours, then names the day", () => {
    expect(checkedAgo(ago(0), NOW)).toBe("just now");
    expect(checkedAgo(ago(5), NOW)).toBe("5 min ago");
    expect(checkedAgo(ago(59), NOW)).toBe("59 min ago");
    expect(checkedAgo(ago(60), NOW)).toBe("1 h ago");
    expect(checkedAgo(ago(23 * 60 + 59), NOW)).toBe("23 h ago");
    expect(checkedAgo(ago(2 * 24 * 60), NOW)).toBe("Oct 5");
  });

  it("says nothing for a link never checked or a date it cannot read, and never a time in the future", () => {
    expect(checkedAgo(undefined, NOW)).toBe("");
    expect(checkedAgo("not a date", NOW)).toBe("");
    expect(checkedAgo(ago(-30), NOW)).toBe("just now");
  });
});

describe("a linked calendar's row", () => {
  it("says when it was checked and how many deadlines are coming", () => {
    expect(feedStatus({ lastFetchedAt: ago(5), lastStatus: "ok", lastCount: 12 }, NOW)).toEqual({ line: "Checked 5 min ago · 12 upcoming deadlines", failed: false });
    expect(feedStatus({ lastFetchedAt: ago(5), lastStatus: "ok", lastCount: 1 }, NOW).line).toBe("Checked 5 min ago · 1 upcoming deadline");
    expect(feedStatus({ lastFetchedAt: ago(5), lastStatus: "ok", lastCount: 0 }, NOW).line).toBe("Checked 5 min ago · 0 upcoming deadlines");
    // A count nobody has: no count, rather than a made-up one.
    expect(feedStatus({ lastFetchedAt: ago(90) }, NOW).line).toBe("Checked 1 h ago");
  });

  it("says a link has not been checked instead of 'checked never'", () => {
    expect(feedStatus({}, NOW)).toEqual({ line: "Not checked yet", failed: false });
  });

  it("says what went wrong the last time, in the course site's own words when there are any", () => {
    expect(feedStatus({ lastFetchedAt: ago(5), lastStatus: "error", lastError: "Could not reach the course site. Check your connection.", lastCount: 12 }, NOW)).toEqual({
      line: "Could not reach the course site. Check your connection.",
      failed: true,
    });
    expect(feedStatus({ lastStatus: "error" }, NOW)).toEqual({ line: "The last check failed.", failed: true });
  });
});

describe("what a check brought in", () => {
  it("says what changed, singular and plural", () => {
    expect(feedChangeSummary(0, 0)).toBe("Everything is already up to date.");
    expect(feedChangeSummary(1, 0)).toBe("1 new deadline added. Your plan is being rewritten around them.");
    expect(feedChangeSummary(3, 0)).toBe("3 new deadlines added. Your plan is being rewritten around them.");
    expect(feedChangeSummary(0, 1)).toBe("1 due date updated. Your plan is being rewritten around them.");
    expect(feedChangeSummary(2, 4)).toBe("2 new deadlines added and 4 due dates updated. Your plan is being rewritten around them.");
  });
});

describe("the line over 'Add link'", () => {
  it("asks for the link until there is text in the field", () => {
    expect(addLinkHint("")).toBe("Paste the link first");
    expect(addLinkHint("   \n")).toBe("Paste the link first");
    expect(addLinkHint("https://school.instructure.com/feeds/calendars/user_1.ics")).toBeNull();
  });
});

describe("the notes that stand where the alerts were", () => {
  it("a link that was not accepted: red, with the reason", () => {
    expect(linkRefusedNote("That feed is already added.")).toEqual({ tone: "red", text: "Could not add this link. That feed is already added." });
  });

  it("a link that was added: green, with what its first check brought in", () => {
    expect(linkAddedNote({ added: 3, updated: 0 })).toEqual({ tone: "green", text: "Link added. 3 new deadlines added. Your plan is being rewritten around them." });
    expect(linkAddedNote({ added: 0, updated: 0 })).toEqual({ tone: "green", text: "Link added. Everything is already up to date." });
  });

  it("a link that was added but could not be checked: red, and it still says the link was added", () => {
    expect(linkAddedNote({ added: 0, updated: 0, error: "The course site took too long to answer. Try again later." })).toEqual({
      tone: "red",
      text: "The link was added, but checking it failed. The course site took too long to answer. Try again later.",
    });
  });

  it("'Check now': what it brought in, or why it failed", () => {
    expect(linkCheckedNote({ added: 0, updated: 2 })).toEqual({ tone: "green", text: "2 due dates updated. Your plan is being rewritten around them." });
    expect(linkCheckedNote({ added: 5, updated: 1, error: "Could not reach the course site. Check your connection." })).toEqual({ tone: "red", text: "Could not reach the course site. Check your connection." });
  });
});
