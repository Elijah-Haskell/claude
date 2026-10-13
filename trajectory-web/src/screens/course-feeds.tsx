/**
 * Course site link, opened from Settings (the iPhone app's app/course-feeds.tsx): paste the calendar link of Canvas
 * (or another course site) once; its assignments and due dates become tasks and follow the course site when a
 * professor moves a date. Fetched by this browser, refreshed when the tab comes back at most every 6 hours
 * (components/headless/course-feed-refresher.tsx). The private link never leaves the browser.
 *
 * Links already added come first, each with "Check now" and "Remove" (which asks first, in its row). What adding or
 * checking a link brought in, or why it failed, is said in a note on the page. What every line says is
 * lib/course-link-view.ts.
 */
import { useEffect, useRef, useState } from "react";

import { applyFeedChanges } from "../components/headless/course-feed-refresher";
import { alpha, radius } from "../engine/design";
import { addLinkHint, COURSE_LINK_COPY, COURSE_SITES, feedStatus, linkAddedNote, linkCheckedNote, linkRefusedNote, type LinkNote } from "../lib/course-link-view";
import { addCourseFeed, loadCourseFeeds, refreshCourseFeeds, removeCourseFeed, subscribeCourseFeeds, type CourseFeed } from "../lib/lms-feed-store";
import { goBack } from "../router";
import { useApp } from "../state/app-provider";
import { Icon } from "../ui/icon";
import { FieldGroup, FieldLabel, HeaderIconButton, Note, PrimaryButton, ScreenHeader, SectionLabel } from "../ui/primitives";
import { useColors } from "../ui/theme";

const LINK_TEXT = { fontSize: 15, lineHeight: "20px", fontWeight: 600 } as const;
const ACTION = { minHeight: 44, minWidth: 44, display: "inline-flex", alignItems: "center", gap: 6 } as const;

export function CourseFeedsScreen() {
  const colors = useColors();
  const { state, dispatch } = useApp();
  // The import awaits network calls: read the tasks as they are when it finishes, not when the button was pressed.
  const stateRef = useRef(state);
  stateRef.current = state;
  const [feeds, setFeeds] = useState<CourseFeed[]>([]);
  const [url, setUrl] = useState("");
  const [adding, setAdding] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  // What the last "Add link" and the last "Check now" came to, said on the page.
  const [addNote, setAddNote] = useState<LinkNote | null>(null);
  const [checked, setChecked] = useState<{ feedId: string; note: LinkNote } | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [openSite, setOpenSite] = useState<string | null>(null);

  useEffect(() => {
    loadCourseFeeds().then((s) => setFeeds(s.feeds)).catch(() => undefined);
    return subscribeCourseFeeds((s) => setFeeds(s.feeds));
  }, []);

  async function importFrom(feedId: string): Promise<{ added: number; updated: number; error?: string }> {
    const latest = stateRef.current;
    const result = await refreshCourseFeeds({ tasks: latest.tasks, classes: latest.classes }, { onlyFeedId: feedId });
    applyFeedChanges(dispatch, result, stateRef.current.tasks);
    return { added: result.add.length, updated: result.update.length, error: result.errors[0] };
  }

  const hint = addLinkHint(url);

  async function handleAdd() {
    if (adding || hint) return;
    setAdding(true);
    setAddNote(null);
    // Saved or not: what the page says when something unexpected goes wrong depends on it.
    let saved = false;
    try {
      const added = await addCourseFeed(url);
      if (!added.ok) {
        setAddNote(linkRefusedNote(added.message));
        return;
      }
      saved = true;
      setUrl("");
      setAddNote(linkAddedNote(await importFrom(added.feed.id)));
    } catch {
      setAddNote(saved ? linkAddedNote({ added: 0, updated: 0, error: "Try \"Check now\" in a moment." }) : linkRefusedNote("Try again in a moment."));
    } finally {
      setAdding(false);
    }
  }

  async function handleCheck(feed: CourseFeed) {
    setBusyId(feed.id);
    setChecked(null);
    try {
      setChecked({ feedId: feed.id, note: linkCheckedNote(await importFrom(feed.id)) });
    } catch {
      setChecked({ feedId: feed.id, note: linkCheckedNote({ added: 0, updated: 0, error: "Could not check this link. Try again in a moment." }) });
    } finally {
      setBusyId(null);
    }
  }

  function remove(feed: CourseFeed) {
    setRemovingId(null);
    void removeCourseFeed(feed.id);
  }

  const now = new Date();

  return (
    <div className="screen" style={{ maxWidth: 560, gap: 14 }}>
      <div style={{ display: "flex", paddingTop: 4 }}>
        <HeaderIconButton onPress={() => goBack("settings")} ariaLabel="Back">
          <Icon name="chevronLeft" size={20} color={colors.foreground} strokeWidth={2} />
        </HeaderIconButton>
      </div>
      <ScreenHeader eyebrow="Keep dates current" title="Course site link" subtitle={COURSE_LINK_COPY.sub} />

      {feeds.length > 0 ? (
        <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <SectionLabel title="Linked" />
          <FieldGroup>
            {feeds.map((feed) => {
              const status = feedStatus(feed, now);
              const busy = busyId === feed.id;
              const tint = status.failed ? colors.gold : colors.peri;
              return (
                <div key={feed.id} style={{ padding: "12px 14px 4px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <span className="well" style={{ background: alpha(tint, status.failed ? 0.16 : 0.12) }}>
                      <Icon name="link" size={18} color={tint} />
                    </span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="clamp2" style={{ fontSize: 16, lineHeight: "21px", fontWeight: 600, color: colors.foreground }}>{feed.label}</div>
                      <div style={{ fontSize: 13, lineHeight: "18px", marginTop: 1, color: status.failed ? colors.gold : colors.muted }}>{status.line}</div>
                    </div>
                  </div>
                  {removingId === feed.id ? (
                    <div>
                      <p role="alert" style={{ margin: "10px 0 0", fontSize: 14, lineHeight: "20px", color: colors.foreground }}>{COURSE_LINK_COPY.removeQuestion}</p>
                      <div style={{ display: "flex", alignItems: "center", gap: 22 }}>
                        <button type="button" className="link danger" aria-label={`Remove the link ${feed.label}`} onClick={() => remove(feed)} style={{ ...ACTION, ...LINK_TEXT }}>Remove</button>
                        <button type="button" className="link" aria-label="Keep the link" onClick={() => setRemovingId(null)} style={{ ...ACTION, ...LINK_TEXT }}>Keep</button>
                      </div>
                    </div>
                  ) : (
                    <div style={{ display: "flex", alignItems: "center", gap: 22 }}>
                      <button
                        type="button"
                        className="link"
                        onClick={() => void handleCheck(feed)}
                        disabled={busyId !== null}
                        aria-label={busy ? `Checking ${feed.label}` : `Check ${feed.label} now`}
                        aria-busy={busy}
                        style={{ ...ACTION, ...LINK_TEXT, opacity: busyId !== null && !busy ? 0.5 : 1 }}
                      >
                        {busy ? <span className="spinner" style={{ width: 16, height: 16 }} /> : <Icon name="refresh" size={16} color={colors.peri} />}
                        {busy ? "Checking" : "Check now"}
                      </button>
                      <button type="button" className="link danger" aria-label={`Remove the link ${feed.label}. It asks first`} onClick={() => setRemovingId(feed.id)} style={{ ...ACTION, ...LINK_TEXT }}>Remove</button>
                    </div>
                  )}
                  {/* A failed check is already said by the link's own line (in gold): not twice. */}
                  {checked?.feedId === feed.id && checked.note.text !== status.line ? (
                    <Note tone={checked.note.tone} icon={checked.note.tone === "green" ? "check" : "warning"} role="alert" style={{ marginBottom: 10 }}>
                      {checked.note.text}
                    </Note>
                  ) : null}
                </div>
              );
            })}
          </FieldGroup>
        </section>
      ) : null}

      <div>
        <FieldLabel>{COURSE_LINK_COPY.field}</FieldLabel>
        <div style={{ display: "flex", alignItems: "center", gap: 10, height: 52, borderRadius: radius.md, border: `1px solid ${colors.borderStrong}`, background: colors.panel, padding: "0 14px" }}>
          <Icon name="link" size={20} color={colors.peri} />
          <input
            type="text"
            inputMode="url"
            value={url}
            onChange={(event) => {
              setUrl(event.target.value);
              // What went wrong with the last link is about that link, not the one being typed.
              if (addNote?.tone === "red") setAddNote(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void handleAdd();
              }
            }}
            placeholder={COURSE_LINK_COPY.placeholder}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            aria-label={COURSE_LINK_COPY.field}
            style={{ flex: 1, minWidth: 0, height: 50, fontSize: 16, border: 0, background: "transparent", color: colors.foreground, padding: 0 }}
          />
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {hint ? <p style={{ margin: 0, fontSize: 14, lineHeight: "19px", fontWeight: 600, textAlign: "center", color: colors.gold }}>{hint}</p> : null}
        <PrimaryButton size="lg" fullWidth label="Add link" loading={adding} disabled={adding || hint !== null} onPress={() => void handleAdd()} ariaLabel={hint ? `Add link. ${hint}` : "Add link"} />
        {addNote ? (
          <Note tone={addNote.tone} icon={addNote.tone === "green" ? "check" : "warning"} role="alert">
            {addNote.text}
          </Note>
        ) : null}
      </div>

      <Note tone="plain" icon="lock">{COURSE_LINK_COPY.privacy}</Note>

      <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <SectionLabel title="Where to find it" />
        <FieldGroup>
          {COURSE_SITES.map((site) => {
            const open = openSite === site.name;
            return (
              <div key={site.name}>
                <button
                  type="button"
                  className="row pressable"
                  onClick={() => setOpenSite(open ? null : site.name)}
                  aria-expanded={open}
                  aria-label={`${site.name}: where to find the link`}
                  style={{ justifyContent: "space-between", minHeight: 52 }}
                >
                  <span style={{ flex: 1, fontSize: 16, lineHeight: "21px", fontWeight: 500, color: colors.foreground }}>{site.name}</span>
                  <span style={{ display: "inline-flex", transform: open ? "rotate(180deg)" : undefined, transition: "transform 160ms" }}>
                    <Icon name="chevronDown" size={18} color={colors.muted} />
                  </span>
                </button>
                {open ? <p style={{ margin: "-4px 0 0", padding: "0 14px 14px", fontSize: 14, lineHeight: "20px", color: colors.muted }}>{site.steps}</p> : null}
              </div>
            );
          })}
        </FieldGroup>
        <p className="caption" style={{ margin: 0, padding: "0 2px" }}>{COURSE_LINK_COPY.scope}</p>
      </section>
    </div>
  );
}
