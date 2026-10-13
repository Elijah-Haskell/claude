// The wait, twice: while the syllabus is read (step 1), and while the plan is built from the checked dates (step 4).
// What was sent, the named rows (src/engine/syllabus-review.ts readingRows: only what the server really reports), the
// time so far with the usual range beside it, and, while a file or pages are read, that the page can be left.
//
// A reading the server reports on as it goes gets the other layout (`live`): the same facts, pinned in a short block
// at the top, and under them the list of deadlines found so far (components/syllabus/live-list.tsx), which is the
// part that scrolls. The clock and the Cancel button stay in view however long the list gets.

import { alpha } from "../../engine/design";
import type { JobPollProgress } from "../../engine/poll-job";
import { formatClock, readingTimeFraction, type ReadingRow } from "../../engine/syllabus-review";
import { LIVE_LEAVE_NOTE, liveStatus, type LiveItem } from "../../lib/live-list";
import { Icon } from "../../ui/icon";
import { FieldGroup, MONO_FONT, Note, PrimaryButton } from "../../ui/primitives";
import { useColors } from "../../ui/theme";
import { LiveList } from "./live-list";
import { FlowFooter, FlowTitle } from "./shared";

interface Props {
  title: string;
  /** What is being read: the file's name, "3 pages", "Pasted text". */
  sourceName: string;
  sourceDetail: string;
  rows: ReadingRow[];
  /** The clock and its line; absent while the plan is built (that takes a moment, not minutes). */
  elapsedMs?: number;
  expectation?: string | null;
  /** The time bar under the clock (a file or pages only). */
  showBar?: boolean;
  /** "You can leave this page…" */
  leaveNote?: string | null;
  onCancel?: () => void;
  /** The live import: what the server has found so far. Absent (or null) is the screen without a list. */
  live?: LiveReading | null;
}

export interface LiveReading {
  /** The rows the server has sent, in its order. A preview: never the reading's result. */
  items: readonly LiveItem[];
  courseName: string | null;
  stage: JobPollProgress["stage"] | null;
  /** The last check did not get through; the rows shown stay. */
  reconnecting: boolean;
  /** A reading that was picked up again (the list arrives already long). */
  resumed: boolean;
  /** The server has answered at least once. */
  answered: boolean;
  today: string;
}

const CLOCK = { fontFamily: MONO_FONT, fontWeight: 600, fontVariantNumeric: "tabular-nums" } as const;

function RowMark({ state }: { state: ReadingRow["state"] }) {
  const colors = useColors();
  if (state === "done") {
    return (
      <span style={{ width: 26, height: 26, borderRadius: 8, flexShrink: 0, display: "inline-flex", alignItems: "center", justifyContent: "center", border: `1.5px solid ${colors.success}`, background: alpha(colors.success, 0.14) }}>
        <Icon name="check" size={15} color={colors.success} strokeWidth={2.8} />
      </span>
    );
  }
  if (state === "now") {
    return (
      <span style={{ width: 26, height: 26, flexShrink: 0, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
        <span className="spinner" />
      </span>
    );
  }
  return <span style={{ width: 26, height: 26, borderRadius: 8, flexShrink: 0, border: `1.5px solid ${colors.borderStrong}` }} />;
}

/** The bar follows the clock smoothly between the server's answers (one every second or so). */
function TimeBar({ fraction }: { fraction: number }) {
  const colors = useColors();
  return (
    <div aria-hidden style={{ height: 6, borderRadius: 3, overflow: "hidden", background: alpha(colors.peri, 0.14) }}>
      <div style={{ height: 6, borderRadius: 3, background: colors.accent, width: `${Math.round(fraction * 1000) / 10}%`, transition: "width 2400ms linear" }} />
    </div>
  );
}

/** The wait with the list of what has been found so far. */
function LiveReadingStep({ title, sourceName, sourceDetail, elapsedMs, expectation, showBar, leaveNote, onCancel, live }: Omit<Props, "rows" | "live"> & { live: LiveReading }) {
  const colors = useColors();
  const status = liveStatus({ stage: live.stage, reconnecting: live.reconnecting, expectation });
  return (
    <>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <FlowTitle title={title} />
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Icon name="file" size={16} color={colors.peri} />
          <span className="truncate" style={{ flex: 1, fontSize: 14, lineHeight: "19px", color: colors.muted }}>
            <span style={{ color: colors.foreground, fontWeight: 600 }}>{sourceName}</span>
            {sourceDetail ? `  ·  ${sourceDetail}` : ""}
          </span>
        </div>
        <div
          role="status"
          aria-label={[status.title, status.sub ?? "", elapsedMs !== undefined ? `${Math.round(elapsedMs / 1000)} seconds so far` : ""].filter(Boolean).join(". ")}
          style={{ display: "flex", flexDirection: "column", gap: 8, padding: "12px 14px", borderRadius: 14, border: `1px solid ${colors.border}`, background: colors.surface }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span className="spinner" />
            <span className="truncate" style={{ flex: 1, fontSize: 16, lineHeight: "21px", fontWeight: 600, color: colors.foreground }}>{status.title}</span>
            {elapsedMs !== undefined ? <span style={{ ...CLOCK, fontSize: 17, lineHeight: "21px", letterSpacing: -0.2, color: colors.foreground }}>{formatClock(elapsedMs)}</span> : null}
          </div>
          {status.sub ? <span style={{ fontSize: 13, lineHeight: "18px", color: live.reconnecting ? colors.gold : colors.muted }}>{status.sub}</span> : null}
          {showBar && elapsedMs !== undefined ? <TimeBar fraction={readingTimeFraction(elapsedMs)} /> : null}
        </div>
      </div>

      <div style={{ paddingTop: 6 }}>
        <LiveList items={live.items} courseName={live.courseName} stage={live.stage} today={live.today} resumed={live.resumed} answered={live.answered} />
      </div>

      {onCancel ? (
        <FlowFooter hint={leaveNote ? LIVE_LEAVE_NOTE : null}>
          <PrimaryButton tone="ghost" size="lg" fullWidth label="Cancel" onPress={onCancel} ariaLabel="Cancel reading the syllabus" />
        </FlowFooter>
      ) : null}
    </>
  );
}

export function ReadingStep(props: Props) {
  const { live, rows, ...rest } = props;
  return live ? <LiveReadingStep {...rest} live={live} /> : <PlainReadingStep {...rest} rows={rows} />;
}

function PlainReadingStep({ title, sourceName, sourceDetail, rows, elapsedMs, expectation, showBar, leaveNote, onCancel }: Omit<Props, "live">) {
  const colors = useColors();
  const current = rows.find((row) => row.state === "now");
  const spoken = [title, current ? `${current.title}${current.sub ? `. ${current.sub}` : ""}` : "", elapsedMs !== undefined ? `${Math.round(elapsedMs / 1000)} seconds so far` : ""].filter(Boolean).join(". ");
  return (
    <>
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <div role="status" aria-live="polite" aria-label={spoken}>
          <FlowTitle title={title} />
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 14px", borderRadius: 14, border: `1px solid ${colors.border}`, background: colors.surface }}>
          <Icon name="file" size={24} color={colors.peri} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="truncate" style={{ fontSize: 15, lineHeight: "20px", fontWeight: 600, color: colors.foreground }}>{sourceName}</div>
            <div className="truncate" style={{ fontSize: 13, lineHeight: "18px", color: colors.muted }}>{sourceDetail}</div>
          </div>
        </div>

        <FieldGroup>
          {rows.map((row, index) => (
            <div key={row.key} style={{ display: "flex", alignItems: "center", gap: 12, minHeight: 60, padding: "9px 14px", borderTop: index > 0 ? `1px solid ${colors.border}` : undefined }}>
              <RowMark state={row.state} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 16, lineHeight: "21px", color: row.state === "wait" ? colors.muted : colors.foreground, fontWeight: row.state === "now" ? 600 : 500 }}>{row.title}</div>
                {row.sub ? <div style={{ fontSize: 13, lineHeight: "18px", marginTop: 1, color: colors.muted }}>{row.sub}</div> : null}
              </div>
            </div>
          ))}
        </FieldGroup>

        {elapsedMs !== undefined ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
              <span style={{ ...CLOCK, fontSize: 30, lineHeight: "36px", letterSpacing: -0.6, color: colors.foreground }}>{formatClock(elapsedMs)}</span>
              {expectation ? <span style={{ fontSize: 15, lineHeight: "21px", flexShrink: 1, color: colors.muted }}>{expectation}</span> : null}
            </div>
            {showBar ? <TimeBar fraction={readingTimeFraction(elapsedMs)} /> : null}
          </div>
        ) : null}

        {leaveNote ? <Note icon="info">{leaveNote}</Note> : null}
      </div>

      {onCancel ? (
        <FlowFooter>
          <PrimaryButton tone="ghost" size="lg" fullWidth label="Cancel" onPress={onCancel} ariaLabel="Cancel reading the syllabus" />
        </FlowFooter>
      ) : null}
    </>
  );
}
