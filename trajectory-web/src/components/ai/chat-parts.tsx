// Pieces of the Trajectory AI page (src/screens/ai.tsx): the example lines, a message, the thinking line, the
// review panel docked above the box (a change to review, or things to add), its rows, and the box itself.
// Look: what the student said is an outlined bubble on the right; what Trajectory AI says is plain text under a small
// violet label (violet = AI, as everywhere); every list is one outlined card; the send button is the app's blue.
// The mobile app's components/ai/chat-parts.tsx, written for the DOM.

import { useLayoutEffect, useState, type CSSProperties, type KeyboardEvent, type ReactNode, type RefObject } from "react";

import { legibleOn } from "../../engine/contrast";
import { alpha, brand, primaryGradient, radius } from "../../engine/design";
import type { ReplanSnapshot } from "../../engine/types";
import {
  DONE_PREFIX,
  daysUntil,
  difficultyLabel,
  formatMinutes,
  isAiAuthoredMessage,
  messageStamp,
  shortDate,
  splitDone,
  type ChatMessage,
  type ParsedTask,
} from "../../lib/ai-items";
import { Icon, type IconName } from "../../ui/icon";
import { DateInput, MONO_FONT, PrimaryButton, SectionLabel } from "../../ui/primitives";
import { useColors, type Palette } from "../../ui/theme";
import { AiReportSheet, type AiSurface } from "../ai-content-label";

export type { Palette };
type UndoSnapshot = ReplanSnapshot | undefined;

/** Violet as text on the page's background: light enough to read (engine/contrast.ts). */
export function aiInk(colors: Palette): string {
  return legibleOn(colors.violet, colors.background, 7);
}

export function difficultyColor(d: number, colors: Palette): string {
  if (d <= 2) return colors.success;
  if (d === 3) return colors.warning;
  return colors.error;
}

/** Plain text with **bold** spans (assistant replies and the app's own lines use them). */
export function RichText({ text, style, boldColor }: { text: string; style?: CSSProperties; boldColor?: string }) {
  const parts = text.split(/\*\*(.+?)\*\*/g);
  return (
    <span style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", ...style }}>
      {parts.map((part, i) => (i % 2 === 1 ? <strong key={i} style={{ fontWeight: 700, ...(boldColor ? { color: boldColor } : {}) }}>{part}</strong> : part))}
    </span>
  );
}

/** A 16px ring with a periwinkle head. */
export function Spinner({ color, track }: { color: string; track: string }) {
  return <span className="spinner" aria-hidden style={{ width: 16, height: 16, borderColor: track, borderTopColor: color }} />;
}

/**
 * The line under anything the model wrote: it says so, says it can be wrong, and offers Report (the App Store's
 * rule for AI content: components/ai-content-label.tsx has the sheet). `text` is the sentence before "Report".
 */
export function AiNote({ surface, content, text = "AI-generated. It can be wrong.", style }: { surface: AiSurface; content: string | (() => string); text?: string; style?: CSSProperties }) {
  const colors = useColors();
  const [open, setOpen] = useState(false);
  // One sentence that ends in "Report"; the whole line is the button, so it is easy to hit.
  return (
    <div style={style}>
      <button type="button" onClick={() => setOpen(true)} aria-label={`${text} It may be inaccurate. Report this ${surface}`} style={{ minHeight: 32, padding: "4px 0", fontSize: 13, lineHeight: "18px", color: colors.muted, textAlign: "left" }}>
        {text} <span style={{ color: colors.peri, fontWeight: 600 }}>Report</span>
      </button>
      {open ? <AiReportSheet visible surface={surface} content={typeof content === "function" ? content() : content} onClose={() => setOpen(false)} /> : null}
    </div>
  );
}

/** "✦ TRAJECTORY AI" over what it says. */
function Speaker({ colors }: { colors: Palette }) {
  const ink = aiInk(colors);
  return (
    <div aria-hidden style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <Icon name="spark" size={14} color={ink} />
      <span style={{ fontFamily: MONO_FONT, fontSize: 12, lineHeight: "16px", fontWeight: 600, letterSpacing: 1.4, textTransform: "uppercase", color: ink }}>Trajectory AI</span>
    </div>
  );
}

/** "Try saying" and the example lines, one outlined card: a click puts the line in the box. */
export function ExampleList({ colors, prompts, onPick, pickHint }: {
  colors: Palette;
  prompts: readonly string[];
  onPick: (prompt: string) => void;
  /** What picking an example does when it is not "put it in the box" (without Pro: it opens Trajectory Pro). */
  pickHint?: string;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <SectionLabel title="Try saying" />
      <div className="group">
        {prompts.map((prompt) => (
          <button
            key={prompt}
            type="button"
            className="row pressable"
            aria-label={pickHint ? `Use the example: ${prompt}. ${pickHint}` : `Use the example: ${prompt}`}
            onClick={() => onPick(prompt)}
            style={{ minHeight: 52, padding: "10px 14px" }}
          >
            <span style={{ flex: 1, minWidth: 0, fontSize: 15, lineHeight: "20px", color: colors.foreground, textAlign: "left" }}>{prompt}</span>
            <Icon name="arrow" size={16} color={colors.muted} strokeWidth={2} />
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * One message: what the student said (an outlined bubble on the right), the app's confirmation as a green note
 * (with Undo when it confirms the latest undoable change), or what Trajectory AI said, with the AI line under it
 * when the model wrote it.
 */
export function MessageRow({ item, colors, undoableId, undoSnapshot, onUndo }: {
  item: ChatMessage;
  colors: Palette;
  /** The one confirmation that may offer Undo (the latest confirmation of an undoable change). */
  undoableId?: string;
  undoSnapshot: UndoSnapshot;
  onUndo: () => void;
}) {
  if (item.role === "user") {
    return (
      <div style={{ display: "flex", justifyContent: "flex-end", paddingLeft: 44 }}>
        <div style={{ maxWidth: "100%", border: `1px solid ${alpha(colors.accent, 0.6)}`, background: alpha(colors.primary, 0.18), borderRadius: 14, borderBottomRightRadius: 4, padding: "10px 14px" }}>
          <span style={{ fontSize: 15, lineHeight: "22px", color: colors.foreground, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{item.content}</span>
        </div>
      </div>
    );
  }
  if (DONE_PREFIX.test(item.content)) {
    const { headline, rest } = splitDone(item.content);
    const stamp = messageStamp(item.id);
    const snapAt = undoSnapshot ? new Date(undoSnapshot.at).getTime() : NaN;
    const showUndo = Boolean(undoSnapshot) && item.id === undoableId && stamp !== null && stamp >= snapAt - 5000 && stamp <= snapAt + 120000;
    return (
      <div role="status" aria-live="polite" style={{ display: "flex", alignItems: "center", gap: 12, border: `1px solid ${alpha(colors.success, 0.45)}`, background: alpha(colors.success, 0.1), borderRadius: 14, padding: "12px 12px 12px 14px" }}>
        <Icon name="check" size={22} color={colors.success} strokeWidth={2.4} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 16, lineHeight: "21px", fontWeight: 600, color: colors.foreground }}>{headline}</div>
          {rest ? <RichText text={rest} style={{ display: "block", fontSize: 14, lineHeight: "19px", marginTop: 1, color: colors.muted }} /> : null}
        </div>
        {showUndo && undoSnapshot ? (
          <PrimaryButton label="Undo" tone="ghost" size="sm" left={<Icon name="undo" size={16} color={colors.foreground} strokeWidth={2} />} onPress={onUndo} ariaLabel={`Undo ${undoSnapshot.label}`} />
        ) : null}
      </div>
    );
  }
  return (
    <div>
      <Speaker colors={colors} />
      <RichText text={item.content} style={{ display: "block", marginTop: 6, fontSize: 15, lineHeight: "22px", color: colors.foreground }} />
      {isAiAuthoredMessage(item) ? <AiNote surface="chat reply" content={item.content} style={{ marginTop: 8 }} /> : null}
    </div>
  );
}

/** While it works: the label, a spinner and what it is doing. */
export function ThinkingRow({ colors, copy }: { colors: Palette; copy: string }) {
  return (
    <div role="status" aria-live="polite">
      <Speaker colors={colors} />
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 8, minHeight: 22 }}>
        <Spinner color={colors.peri} track={colors.borderStrong} />
        <span style={{ fontSize: 15, lineHeight: "22px", color: colors.muted }}>{copy}</span>
      </div>
    </div>
  );
}

/** The box at the bottom and its send button. Enter sends (a keyboard is the platform here); Shift+Enter starts a new line. */
export function Composer({ colors, inputRef, value, onChangeText, placeholder, canSend, onSend, sendHint }: {
  colors: Palette;
  inputRef?: RefObject<HTMLTextAreaElement | null>;
  value: string;
  onChangeText: (text: string) => void;
  placeholder: string;
  canSend: boolean;
  onSend: () => void;
  /** What Send does when it does not send (without Pro: it opens Trajectory Pro). */
  sendHint?: string;
}) {
  // One line until more is typed: the field grows with its text, up to 120px.
  useLayoutEffect(() => {
    const field = inputRef?.current;
    if (!field) return;
    field.style.height = "auto";
    field.style.height = `${Math.min(field.scrollHeight, 120)}px`;
  }, [value, inputRef]);

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (canSend) onSend();
    }
  }

  return (
    <div className="ai-composer" style={{ display: "flex", alignItems: "flex-end", gap: 8 }}>
      <div style={{ flex: 1, minWidth: 0, minHeight: 52, border: `1px solid ${colors.borderStrong}`, background: colors.background, borderRadius: radius.md, padding: "0 14px", display: "flex", alignItems: "center" }}>
        <textarea
          ref={inputRef}
          value={value}
          onChange={(event) => onChangeText(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          rows={1}
          maxLength={2000}
          aria-label={placeholder}
          style={{ flex: 1, width: "100%", minHeight: 50, maxHeight: 120, padding: "14px 0", border: 0, outline: "none", background: "transparent", color: colors.foreground, fontSize: 16, lineHeight: "21px", resize: "none" }}
        />
      </div>
      <button
        type="button"
        aria-label={sendHint ? `Send. ${sendHint}` : "Send"}
        disabled={!canSend}
        onClick={onSend}
        style={{ width: 52, height: 52, borderRadius: radius.md, flexShrink: 0, display: "inline-flex", alignItems: "center", justifyContent: "center", background: `linear-gradient(135deg, ${primaryGradient[0]}, ${primaryGradient[1]})`, opacity: canSend ? 1 : 0.45, boxShadow: canSend ? `0 6px 14px ${alpha(brand.blue, 0.4)}` : undefined }}
      >
        <Icon name="send" size={20} color={brand.white} />
      </button>
    </div>
  );
}

/**
 * The review panel docked above the box, so its buttons are always in reach: a label, a short scrolling list, an
 * optional line of our own, the buttons, then the AI line for what is shown.
 */
export function ReviewDock({ title, right, children, footer, actions, note }: {
  colors: Palette;
  title: string;
  right?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  actions: ReactNode;
  note: { surface: AiSurface; content: () => string; text: string };
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, paddingTop: 2 }}>
      <SectionLabel title={title} right={right} />
      {children}
      {footer}
      <div style={{ display: "flex", gap: 10 }}>{actions}</div>
      <AiNote surface={note.surface} content={note.content} text={note.text} />
    </div>
  );
}

/** The quiet hint at the right of a review panel's label ("Click one to edit"). */
export function DockHint({ colors, label }: { colors: Palette; label: string }) {
  return <span style={{ fontSize: 13, lineHeight: "18px", color: colors.muted }}>{label}</span>;
}

/** One outlined card for a panel's rows; it scrolls when the list is long. */
export function ReviewList({ children }: { children: ReactNode }) {
  return (
    <div className="group" style={{ maxHeight: 216, overflowY: "auto" }}>
      {children}
    </div>
  );
}

const rowTitle = (colors: Palette): CSSProperties => ({ fontSize: 16, lineHeight: "21px", fontWeight: 500, color: colors.foreground });
const rowMeta = (colors: Palette): CSSProperties => ({ fontSize: 13, lineHeight: "18px", marginTop: 2, color: colors.muted });

/** One change: its name, then the old time struck through, an arrow and the new one. */
export function ChangeRow({ title, from, to, isNew, colors }: { title: string; from: string; to: string; isNew?: boolean; first?: boolean; colors: Palette }) {
  return (
    <div style={{ padding: "10px 14px" }}>
      <div className="clamp2" style={rowTitle(colors)}>{title}</div>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 7, marginTop: 3 }}>
        {isNew ? <span style={{ fontFamily: MONO_FONT, fontSize: 12, lineHeight: "16px", fontWeight: 600, letterSpacing: 0.8, textTransform: "uppercase", border: `1px solid ${alpha(colors.violet, 0.55)}`, background: alpha(colors.violet, 0.16), color: aiInk(colors), borderRadius: 6, padding: "1px 6px" }}>New</span> : null}
        {from ? (
          <>
            <span style={{ fontSize: 13, lineHeight: "18px", color: colors.muted, textDecoration: "line-through" }}>{from}</span>
            <Icon name="arrow" size={14} color={colors.muted} strokeWidth={2} />
          </>
        ) : null}
        <span style={{ fontSize: 13, lineHeight: "18px", fontWeight: 600, color: colors.foreground }}>{to}</span>
      </div>
    </div>
  );
}

/** A found event or weekly commitment under review: its name, when it is, what it is, and a way to drop it. */
export function ItemRow({ colors, icon, title, meta, kind, onRemove }: {
  colors: Palette;
  icon: IconName;
  title: string;
  meta: string;
  /** "Event", "Every week". */
  kind: string;
  first?: boolean;
  onRemove?: () => void;
}) {
  return (
    <div className="row" style={{ padding: "9px 14px" }}>
      <span className="well" style={{ background: alpha(colors.peri, 0.12) }}>
        <Icon name={icon} size={18} color={colors.peri} />
      </span>
      <div className="row-text">
        <div className="clamp2" style={rowTitle(colors)}>{title}</div>
        <div className="truncate" style={rowMeta(colors)}>{kind} · {meta}</div>
      </div>
      {onRemove ? (
        <button type="button" onClick={onRemove} aria-label={`Remove ${title}`} style={{ width: 44, height: 44, display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
          <Icon name="close" size={16} color={colors.muted} strokeWidth={2} />
        </button>
      ) : null}
    </div>
  );
}

/** A found task under review: one line (class, time needed, due date); click it to change any of them or drop it. */
export function ParsedTaskCard({ task, index, onEdit, onRemove, colors }: {
  task: ParsedTask;
  index: number;
  first?: boolean;
  onEdit: (index: number, field: keyof ParsedTask, value: string | number) => void;
  onRemove: (index: number) => void;
  colors: Palette;
}) {
  const [expanded, setExpanded] = useState(false);
  const dueIn = task.dueDate ? daysUntil(task.dueDate) : null;
  const dueSoon = dueIn !== null && dueIn <= 3;
  const fieldInput: CSSProperties = { flex: 1, minWidth: 0, fontSize: 15, lineHeight: "20px", minHeight: 44, border: `1px solid ${colors.borderStrong}`, borderRadius: radius.md, padding: "9px 12px", background: colors.panel, color: colors.foreground };
  const fieldLabel: CSSProperties = { fontFamily: MONO_FONT, fontSize: 12, lineHeight: "16px", fontWeight: 600, letterSpacing: 1, textTransform: "uppercase", width: 92, flexShrink: 0, color: colors.muted };
  const fieldRow: CSSProperties = { display: "flex", alignItems: "center", gap: 10 };
  // The due date leads, so a long class name is what gets cut off, never the date.
  const meta = [formatMinutes(task.estimatedMinutes), task.courseName].filter(Boolean).join(" · ");

  return (
    <div>
      <button
        type="button"
        className="row pressable"
        onClick={() => setExpanded((open) => !open)}
        aria-expanded={expanded}
        aria-label={`${task.name}. ${expanded ? "Close" : "Click to edit"}`}
        style={{ padding: "9px 14px" }}
      >
        <span className="well" style={{ background: alpha(colors.peri, 0.12) }}>
          <Icon name="file" size={18} color={colors.peri} />
        </span>
        <span className="row-text" style={{ textAlign: "left" }}>
          <span className={expanded ? undefined : "truncate"} style={{ display: "block", ...rowTitle(colors) }}>{task.name}</span>
          <span className="truncate" style={{ display: "block", ...rowMeta(colors) }}>
            {task.dueDate ? <span style={{ color: dueSoon ? colors.gold : colors.muted }}>{`Due ${shortDate(task.dueDate)} · `}</span> : null}
            {meta}
          </span>
        </span>
        <Icon name={expanded ? "chevronDown" : "chevronRight"} size={18} color={colors.muted} />
      </button>

      {expanded ? (
        <div style={{ padding: "0 14px 12px", display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={fieldRow}>
            <span style={fieldLabel}>Task</span>
            <input style={fieldInput} value={task.name} onChange={(event) => onEdit(index, "name", event.target.value)} aria-label="Task name" />
          </div>
          <div style={fieldRow}>
            <span style={fieldLabel}>Class</span>
            <input style={fieldInput} value={task.courseName} onChange={(event) => onEdit(index, "courseName", event.target.value)} aria-label="Class" />
          </div>
          <div style={fieldRow}>
            <span style={fieldLabel}>Due</span>
            <DateInput value={task.dueDate ?? ""} onChange={(key) => onEdit(index, "dueDate", key)} ariaLabel={`Due date for ${task.name}`} style={{ flex: 1, minWidth: 0 }} />
          </div>
          {/* Said plainly: a task added without a date is given one a week out (lib/ai-items.ts taskFromParsed). */}
          {!(task.dueDate ?? "").trim() ? <div style={{ fontSize: 13, lineHeight: "18px", marginTop: -4, marginLeft: 102, color: colors.muted }}>No date given. It is added as due in a week unless you pick one.</div> : null}
          <div style={fieldRow}>
            <span style={fieldLabel}>Minutes</span>
            <input
              style={{ ...fieldInput, fontFamily: MONO_FONT }}
              value={String(task.estimatedMinutes)}
              inputMode="numeric"
              onChange={(event) => onEdit(index, "estimatedMinutes", parseInt(event.target.value, 10) || 30)}
              aria-label="Minutes it needs"
            />
          </div>
          <div style={fieldRow}>
            <span style={fieldLabel}>Difficulty</span>
            <div role="radiogroup" aria-label="Difficulty" style={{ display: "flex", gap: 6 }}>
              {[1, 2, 3, 4, 5].map((d) => {
                const on = task.difficulty === d;
                const tint = difficultyColor(d, colors);
                return (
                  <button
                    key={d}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    aria-label={`Difficulty ${d}: ${difficultyLabel(d)}`}
                    onClick={() => onEdit(index, "difficulty", d)}
                    style={{ width: 40, height: 40, borderRadius: radius.sm, border: `1px solid ${on ? tint : colors.borderStrong}`, background: on ? alpha(tint, 0.2) : colors.panel, display: "inline-flex", alignItems: "center", justifyContent: "center", fontFamily: MONO_FONT, fontSize: 13, fontWeight: 600, color: on ? tint : colors.muted }}
                  >
                    {d}
                  </button>
                );
              })}
            </div>
          </div>
          {task.notes ? (
            <div style={{ display: "flex", alignItems: "flex-start", gap: 8, marginTop: 2 }}>
              <Icon name="info" size={16} color={colors.peri} />
              <span style={{ flex: 1, fontSize: 13, lineHeight: "18px", color: colors.muted }}>{task.notes}</span>
            </div>
          ) : null}
          <button type="button" onClick={() => onRemove(index)} aria-label={`Remove ${task.name}`} style={{ alignSelf: "flex-start", minHeight: 44, display: "inline-flex", alignItems: "center", fontSize: 15, fontWeight: 600, color: colors.error }}>
            Remove
          </button>
        </div>
      ) : null}
    </div>
  );
}
