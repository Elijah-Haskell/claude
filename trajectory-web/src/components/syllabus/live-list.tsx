// The live import's list: while a syllabus is read, the deadlines the server has found so far, newest at the bottom.
// The rows of an answer land one after another, the list follows the newest row until the student moves it, and the
// count over it ticks up with the rows. Every row is one the server sent; none can be clicked (checking the dates is
// the next step's job). The rules are src/lib/live-list.ts; the server's side is the mobile repo's docs/live-import.md.

import { memo, useEffect, useRef, useState, type UIEvent } from "react";

import { alpha } from "../../engine/design";
import type { JobPollProgress } from "../../engine/poll-job";
import {
  followAfterScroll,
  LIVE_FOLLOW_SLOP,
  LIVE_FULL_NOTE,
  liveCountLabel,
  liveCountSpoken,
  liveDateLabel,
  liveEmptyLine,
  liveIsTest,
  liveKindLabel,
  liveListIsFull,
  liveRowName,
  liveRowSpoken,
  liveWeekday,
  revealStep,
  scrollsToNewest,
  shouldAnnounceCount,
  type LiveItem,
} from "../../lib/live-list";
import { Icon } from "../../ui/icon";
import { MONO_FONT, SectionLabel } from "../../ui/primitives";
import { useColors } from "../../ui/theme";
import { useReduceMotion } from "./use-reduce-motion";

interface Props {
  items: readonly LiveItem[];
  /** The course's name as the model has written it so far. */
  courseName: string | null;
  stage: JobPollProgress["stage"] | null;
  today: string;
  /** A reading that was picked up again: what it has found by now is simply there, without forty rows flowing in. */
  resumed?: boolean;
  /** The server has answered at least once. Before that the frame only says the reading is starting. */
  answered?: boolean;
}

/**
 * A browser cannot tell whether a screen reader is on (VoiceOver's position in the list is its own on the iPhone),
 * so the list follows its newest row for everyone and the count is said through a polite live region instead.
 */
const screenReader = false;

const EASE = "cubic-bezier(0.33, 1, 0.68, 1)";
const KIND_STYLE = { fontFamily: MONO_FONT, fontSize: 12, lineHeight: "16px", fontWeight: 500, letterSpacing: 0.8, textTransform: "uppercase" } as const;

/** Visually hidden, read aloud (what VoiceOver's announcement is on the iPhone). */
const HIDDEN = { position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap" } as const;

/** One found item: its name and kind, and its date (or that it has none yet). */
const LiveRow = memo(function LiveRow({ item, first, animate, today }: { item: LiveItem; first: boolean; animate: boolean; today: string }) {
  const colors = useColors();
  // A row that lands as part of the flow eases in once; one that was simply there never moves.
  const [entered, setEntered] = useState(!animate);
  useEffect(() => {
    if (entered) return;
    const frame = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(frame);
  }, [entered]);
  const test = liveIsTest(item);
  const weekday = liveWeekday(item.date);
  return (
    <div
      role="listitem"
      aria-label={liveRowSpoken(item)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        minHeight: 54,
        padding: "8px 14px",
        borderTop: first ? undefined : `1px solid ${colors.border}`,
        opacity: entered ? 1 : 0,
        transform: entered ? "none" : "translateY(8px)",
        transition: animate ? `opacity 260ms ${EASE}, transform 260ms ${EASE}` : undefined,
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {test ? <Icon name="flag" size={15} color={colors.gold} /> : null}
          <span className="truncate" style={{ flexShrink: 1, fontSize: 15.5, lineHeight: "20px", fontWeight: test ? 600 : 500, color: colors.foreground }}>{liveRowName(item)}</span>
        </div>
        <div className="truncate" style={{ ...KIND_STYLE, color: colors.muted }}>{liveKindLabel(item.type)}</div>
      </div>
      {item.date ? (
        <div style={{ textAlign: "right", flexShrink: 0 }}>
          <div style={{ fontFamily: MONO_FONT, fontSize: 13, lineHeight: "20px", fontWeight: 600, letterSpacing: 0.6, textTransform: "uppercase", fontVariantNumeric: "tabular-nums", color: colors.gold }}>{liveDateLabel(item.date, today)}</div>
          {weekday ? <div style={{ ...KIND_STYLE, color: colors.muted }}>{weekday}</div> : null}
        </div>
      ) : (
        <span style={{ ...KIND_STYLE, flexShrink: 0, color: colors.muted }}>{liveDateLabel(null)}</span>
      )}
    </div>
  );
});

/** The course's name, when the model has written it: it fades in over the list. */
function CourseName({ name, still }: { name: string; still: boolean }) {
  const colors = useColors();
  const [shown, setShown] = useState(still);
  useEffect(() => {
    if (shown) return;
    const frame = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(frame);
  }, [shown]);
  return (
    <div className="truncate" style={{ fontSize: 17, lineHeight: "22px", fontWeight: 700, letterSpacing: -0.2, color: colors.foreground, opacity: shown ? 1 : 0, transition: still ? undefined : `opacity 320ms ${EASE}` }}>
      {name}
    </div>
  );
}

/**
 * The list before its first row: a caret where the first row will land, and one line saying what will appear. The
 * caret blinks so the wait does not look stuck (it lasts five seconds or more: the model reads the whole document
 * before it writes its first item). No rows shaped like results: nothing has been found yet, and the frame says so.
 */
function EmptyList({ line, still }: { line: string; still: boolean }) {
  const colors = useColors();
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "16px 14px" }}>
      <span aria-hidden style={{ width: 2, height: 20, borderRadius: 1, flexShrink: 0, background: colors.peri, animation: still ? undefined : "blink 1.04s step-end infinite" }} />
      <span style={{ flex: 1, fontSize: 14, lineHeight: "20px", color: colors.muted }}>{line}</span>
    </div>
  );
}

export function LiveList({ items, courseName, stage, today, resumed = false, answered = true }: Props) {
  const colors = useColors();
  const reduceMotion = useReduceMotion();
  const total = items.length;
  const asking = resumed && !answered;

  // ── Rows landing ──
  // How many rows are on screen, and which one is landing now (it eases in). The steps are src/lib/live-list.ts revealStep.
  const [reveal, setReveal] = useState<{ shown: number; fresh: number }>({ shown: 0, fresh: -1 });
  const shown = Math.min(reveal.shown, total);
  // Rows that appeared at once (a list that arrives long): the list is then placed at its end, not scrolled there.
  const placeNext = useRef(false);
  useEffect(() => {
    const step = revealStep(shown, total, { instant: reduceMotion || (resumed && shown === 0) });
    if (!step) return;
    const timer = setTimeout(() => {
      if (step.jump) placeNext.current = true;
      setReveal((current) => (current.shown >= step.shown ? current : { shown: step.shown, fresh: step.fresh }));
    }, step.delayMs);
    return () => clearTimeout(timer);
  }, [shown, total, reduceMotion, resumed]);

  // ── Following the newest row ──
  const scroller = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  // A finger (or a pressed mouse button) on the list: it stops following wherever the student takes it, however slowly.
  const dragging = useRef(false);
  const lastOffset = useRef(0);
  const [following, setFollowing] = useState(true);
  // Rows have scrolled away under the frame's top edge: they fade out there instead of being cut off.
  const [scrolled, setScrolled] = useState(false);

  const setFollow = (next: boolean) => {
    if (next === follow.current) return;
    follow.current = next;
    setFollowing(next);
  };
  const distanceFromEnd = (el: HTMLDivElement) => el.scrollHeight - el.clientHeight - el.scrollTop;
  /**
   * Rows landed, or the frame changed size: go to the newest row, or note that the list is now behind it. The list
   * glides to a row that has just landed; it is simply placed at its end when the frame changed, when many rows
   * appeared at once, and with Reduce Motion.
   */
  const keepUp = (why: "rows" | "frame") => {
    const el = scroller.current;
    if (!el) return;
    const glide = why === "rows" && !placeNext.current && !reduceMotion;
    if (why === "rows") placeNext.current = false;
    if (scrollsToNewest({ following: follow.current, dragging: dragging.current, screenReader })) el.scrollTo({ top: el.scrollHeight, behavior: glide ? "smooth" : "auto" });
    else if (distanceFromEnd(el) > LIVE_FOLLOW_SLOP) setFollow(false);
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- rows landed: the content grew
  useEffect(() => {
    keepUp("rows");
  }, [shown]);
  // The frame changed size (the course's name arrived over it, a status line wrapped): stay on the newest row.
  useEffect(() => {
    const el = scroller.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      keepUp("frame");
    });
    observer.observe(el);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the scroller mounts with the first row
  }, [shown > 0]);
  const onScroll = (event: UIEvent<HTMLDivElement>) => {
    const el = event.currentTarget;
    const last = lastOffset.current;
    lastOffset.current = el.scrollTop;
    setScrolled(el.scrollTop > 6);
    setFollow(followAfterScroll({ following: follow.current, offsetY: el.scrollTop, lastOffsetY: last, distanceFromEnd: distanceFromEnd(el), byHand: dragging.current }));
  };
  const jumpToNewest = () => {
    setFollow(true);
    const el = scroller.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: reduceMotion ? "auto" : "smooth" });
  };

  // ── Said aloud ──
  // A screen reader hears the count now and then, not every row.
  const spoken = useRef({ count: 0, at: 0 });
  const [announced, setAnnounced] = useState("");
  useEffect(() => {
    const now = Date.now();
    if (!shouldAnnounceCount({ count: shown, lastCount: spoken.current.count, sinceLastMs: now - spoken.current.at, finishing: stage === "finishing", settled: shown >= total })) return;
    spoken.current = { count: shown, at: now };
    setAnnounced(liveCountSpoken(shown));
  }, [shown, total, stage]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, minHeight: 0 }}>
      {courseName ? <CourseName name={courseName} still={reduceMotion || resumed} /> : null}
      <SectionLabel title={liveCountLabel({ count: shown, asking })} />
      <span aria-live="polite" style={HIDDEN}>{announced}</span>
      <div style={{ position: "relative", minHeight: 0, borderRadius: 14, border: `1px solid ${colors.border}`, background: colors.surface, overflow: "hidden" }}>
        {shown === 0 ? (
          <EmptyList line={liveEmptyLine(stage, { asking, answered })} still={reduceMotion} />
        ) : (
          <div
            ref={scroller}
            role="list"
            aria-label="Found so far"
            onScroll={onScroll}
            onPointerDown={() => {
              dragging.current = true;
            }}
            onPointerUp={() => {
              dragging.current = false;
            }}
            onPointerCancel={() => {
              dragging.current = false;
            }}
            onPointerLeave={() => {
              dragging.current = false;
            }}
            style={{ maxHeight: "min(52vh, 480px)", minHeight: 120, overflowY: "auto" }}
          >
            {items.slice(0, shown).map((item, index) => (
              <LiveRow key={index} item={item} first={index === 0} animate={!reduceMotion && index === reveal.fresh} today={today} />
            ))}
            {liveListIsFull(shown) ? <p style={{ margin: 0, fontSize: 13, lineHeight: "18px", padding: "12px 14px", borderTop: `1px solid ${colors.border}`, color: colors.muted }}>{LIVE_FULL_NOTE}</p> : null}
          </div>
        )}
        {shown > 0 && scrolled ? <div aria-hidden style={{ position: "absolute", left: 0, right: 0, top: 0, height: 14, pointerEvents: "none", background: `linear-gradient(${colors.surface}, ${alpha(colors.surface, 0)})` }} /> : null}
        {shown > 0 && !following ? (
          <button type="button" onClick={jumpToNewest} aria-label="Jump to the newest" className="pressable" style={{ position: "absolute", bottom: 10, left: "50%", transform: "translateX(-50%)", display: "inline-flex", alignItems: "center", gap: 6, minHeight: 44, padding: "0 16px", borderRadius: 12, border: `1px solid ${colors.borderStrong}`, background: colors.panel, color: colors.foreground, fontSize: 14, lineHeight: "19px", fontWeight: 600 }}>
            <Icon name="chevronDown" size={16} color={colors.foreground} strokeWidth={2} />
            Newest
          </button>
        ) : null}
      </div>
    </div>
  );
}
