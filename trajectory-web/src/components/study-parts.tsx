// The pieces the study tools share (the mobile app's components/study/study-guide-parts.tsx, practice-parts.tsx and the
// FlowFooter / BigOption of components/syllabus/shared.tsx): the bar with the back button, the page's head, a 12px tag,
// the small label inside a row, outlined chips, a row that opens in place, a failure said on the screen, a question
// asked in place before something is erased, the bar at the bottom of a flow, an answer to choose in a practice exam.
// Same look as the rest of the web app: outlines, hairlines, nothing under 12px, 44px to the touch.

import type { CSSProperties, ReactNode } from "react";

import { alpha } from "../engine/design";
import type { TagTone } from "../engine/study-tools-view";
import type { StudyErrorInfo } from "../lib/study-errors";
import { Icon, type IconName } from "../ui/icon";
import { useDesktop } from "../ui/layout";
import { MONO_FONT, Note } from "../ui/primitives";
import { useColors } from "../ui/theme";

export { ThinBar } from "../screens/study";

/** A 44px outlined square button for the top of a screen (back, close, more, start again). */
export function ToolIconButton({ icon, onPress, ariaLabel, size = 20, disabled }: { icon: IconName; onPress: () => void; ariaLabel: string; size?: number; disabled?: boolean }) {
  const colors = useColors();
  return (
    <button type="button" onClick={onPress} aria-label={ariaLabel} disabled={disabled} className="pressable" style={{ width: 44, height: 44, borderRadius: 13, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", background: colors.surface, border: `1px solid ${colors.borderStrong}`, opacity: disabled ? 0.5 : 1 }}>
      <Icon name={icon} size={size} color={colors.foreground} strokeWidth={2} />
    </button>
  );
}

/** The bar over a screen: back on the left, at most one more button on the right. */
export function ToolTop({ onBack, backLabel = "Back", backIcon = "chevronLeft", right }: { onBack: () => void; backLabel?: string; backIcon?: IconName; right?: ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", paddingTop: 4 }}>
      <ToolIconButton icon={backIcon} size={backIcon === "close" ? 18 : 20} onPress={onBack} ariaLabel={backLabel} />
      {right}
    </div>
  );
}

/**
 * A screen's head: the small line over the title (mono capitals, or `lead`: a class's chip and what this is), the
 * title, and a sentence or two under it.
 */
export function ToolHead({ eyebrow, lead, title, sub, children, style, right }: { eyebrow?: string; lead?: ReactNode; title: string; sub?: string | null; children?: ReactNode; style?: CSSProperties; right?: ReactNode }) {
  const colors = useColors();
  // A computer: the title at the size of the other screens' titles, and room on the right for the page's main button.
  const desktop = useDesktop();
  const text = (
    <div style={right ? { flex: 1, minWidth: 0 } : { padding: "0 4px", ...style }}>
      {lead ? <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>{lead}</div> : eyebrow ? <div className="eyebrow clamp2" style={{ marginBottom: 4 }}>{eyebrow}</div> : null}
      <h1 style={{ margin: 0, fontSize: desktop ? 34 : 30, lineHeight: desktop ? "40px" : "35px", fontWeight: 800, letterSpacing: desktop ? -1 : -0.75, color: colors.foreground }}>{title}</h1>
      {sub ? <p style={{ margin: "6px 0 0", fontSize: 15, lineHeight: "21px", color: colors.muted, maxWidth: desktop ? 720 : undefined }}>{sub}</p> : null}
      {children}
    </div>
  );
  if (!right) return text;
  return (
    <div style={{ padding: "0 4px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 24, ...style }}>
      {text}
      <div style={{ flexShrink: 0, display: "flex", alignItems: "center", gap: 10 }}>{right}</div>
    </div>
  );
}

/** What stands next to a class's chip in a head ("Study guide", "Test review"). */
export function LeadText({ children }: { children: string }) {
  const colors = useColors();
  return <span className="truncate" style={{ fontSize: 14, lineHeight: "19px", color: colors.muted, flexShrink: 1 }}>{children}</span>;
}

/** A count at the right of a section label, in mono. */
export function MonoCount({ children }: { children: ReactNode }) {
  const colors = useColors();
  return <span style={{ fontFamily: MONO_FONT, fontSize: 12.5, lineHeight: "17px", fontWeight: 600, color: colors.muted }}>{children}</span>;
}

function useTagColors(tone: TagTone) {
  const colors = useColors();
  if (tone === "blue") return { background: alpha(colors.primary, 0.18), border: alpha(colors.accent, 0.65), text: colors.peri };
  if (tone === "green") return { background: alpha(colors.success, 0.12), border: alpha(colors.success, 0.5), text: colors.success };
  if (tone === "red") return { background: alpha(colors.error, 0.12), border: alpha(colors.error, 0.5), text: colors.error };
  if (tone === "gold") return { background: alpha(colors.gold, 0.14), border: alpha(colors.gold, 0.5), text: colors.gold };
  return { background: "transparent", border: colors.borderStrong, text: colors.muted };
}

/** A small tag in mono capitals, 12px ("HIGH", "CORRECT", "MEDIUM"). */
export function Tag({ label, tone = "neutral", style }: { label: string; tone?: TagTone; style?: CSSProperties }) {
  const look = useTagColors(tone);
  return (
    <span style={{ height: 24, padding: "0 8px", borderRadius: 7, border: `1px solid ${look.border}`, background: look.background, display: "inline-flex", alignItems: "center", flexShrink: 0, ...style }}>
      <span className="truncate" style={{ fontFamily: MONO_FONT, fontSize: 12, lineHeight: "16px", fontWeight: 600, letterSpacing: 1, textTransform: "uppercase", color: look.text }}>{label}</span>
    </span>
  );
}

/** The small label inside an opened row ("KEY TERMS", "YOUR ANSWER"). */
export function SmallLabel({ children, style }: { children: string; style?: CSSProperties }) {
  const colors = useColors();
  return <div style={{ fontFamily: MONO_FONT, fontSize: 12, lineHeight: "16px", fontWeight: 600, letterSpacing: 1, textTransform: "uppercase", color: colors.muted, ...style }}>{children}</div>;
}

/** Key terms, concepts to review: small outlined chips that wrap. */
export function Chips({ items, style }: { items: readonly string[]; style?: CSSProperties }) {
  const colors = useColors();
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, ...style }}>
      {items.map((item, index) => (
        <span key={`${index}-${item}`} style={{ minHeight: 30, padding: "5px 10px", borderRadius: 9, border: `1px solid ${colors.borderStrong}`, background: colors.panel, display: "inline-flex", alignItems: "center", maxWidth: "100%", fontSize: 13, lineHeight: "18px", fontWeight: 500, color: colors.foreground }}>{item}</span>
      ))}
    </div>
  );
}

/**
 * A row of a group that opens in place. The line with the title is the button (it says whether it is open); what it
 * holds is drawn under it, inside the same row. Inside a FieldGroup the hairline between rows is the group's.
 */
export function FoldRow({ open, onToggle, lead, title, sub, right, ariaLabel, children }: {
  open: boolean;
  onToggle: () => void;
  /** Before the title (a question's number). */
  lead?: ReactNode;
  title: string;
  sub?: string | null;
  /** Between the title and the chevron (a tag). */
  right?: ReactNode;
  ariaLabel?: string;
  children: ReactNode;
}) {
  const colors = useColors();
  return (
    <div>
      <button type="button" className="row pressable" onClick={onToggle} aria-expanded={open} aria-label={ariaLabel ?? title} style={{ minHeight: 58, padding: "10px 14px" }}>
        {lead}
        <span className="row-text">
          <span className={open ? undefined : "clamp2"} style={{ display: "block", fontSize: 16, lineHeight: "21px", fontWeight: 600, color: colors.foreground }}>{title}</span>
          {sub ? <span className={open ? undefined : "truncate"} style={{ display: "block", fontSize: 13, lineHeight: "18px", marginTop: 1, color: colors.muted }}>{sub}</span> : null}
        </span>
        {right}
        <span style={{ display: "inline-flex", transform: open ? "rotate(180deg)" : undefined, flexShrink: 0 }}>
          <Icon name="chevronDown" size={18} color={colors.muted} />
        </span>
      </button>
      {open ? <div style={{ padding: "0 14px 14px", display: "flex", flexDirection: "column", gap: 10 }}>{children}</div> : null}
    </div>
  );
}

/** A paragraph inside an opened row. */
export function FoldText({ children, strong }: { children: string; strong?: boolean }) {
  const colors = useColors();
  return <p style={{ margin: 0, fontSize: 14, lineHeight: "21px", color: strong ? colors.foreground : colors.muted, whiteSpace: "pre-wrap" }}>{children}</p>;
}

/** A text link, 44px tall. */
export function ToolLink({ label, onPress, color, ariaLabel, disabled, style }: { label: string; onPress: () => void; color?: string; ariaLabel?: string; disabled?: boolean; style?: CSSProperties }) {
  const colors = useColors();
  return (
    <button type="button" className="link" onClick={onPress} aria-label={ariaLabel ?? label} disabled={disabled} style={{ minHeight: 44, padding: "0 8px", fontSize: 15, lineHeight: "20px", fontWeight: 600, color: color ?? colors.peri, opacity: disabled ? 0.5 : 1, ...style }}>
      {label}
    </button>
  );
}

/** Something failed: what happened, in words, on the screen. "Try again" only when trying again can help. */
export function ToolError({ info, onRetry, onDismiss, retryLabel = "Try again", style }: { info: StudyErrorInfo; onRetry?: () => void; onDismiss?: () => void; retryLabel?: string; style?: CSSProperties }) {
  const colors = useColors();
  const showRetry = Boolean(info.retryable && onRetry);
  return (
    <Note tone="red" icon="warning" role="alert" style={style}>
      <div style={{ fontSize: 15, lineHeight: "20px", fontWeight: 600, color: colors.foreground }}>{info.title}</div>
      <div style={{ fontSize: 14, lineHeight: "20px", color: colors.muted }}>{info.message}</div>
      {showRetry || onDismiss ? (
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 2, marginBottom: -8, marginLeft: -8 }}>
          {showRetry && onRetry ? <ToolLink label={retryLabel} onPress={onRetry} color={colors.error} /> : null}
          {onDismiss ? <ToolLink label="Dismiss" onPress={onDismiss} color={colors.muted} /> : null}
        </div>
      ) : null}
    </Note>
  );
}

/** A question asked in place before something is erased: the sentence, then the two answers. */
export function ConfirmNote({ question, confirmLabel, cancelLabel, onConfirm, onCancel, confirmAriaLabel, cancelAriaLabel, style }: {
  question: string;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  confirmAriaLabel?: string;
  cancelAriaLabel?: string;
  style?: CSSProperties;
}) {
  const colors = useColors();
  return (
    <Note tone="red" icon="warning" role="alert" style={style}>
      <div style={{ fontSize: 14, lineHeight: "20px", color: colors.foreground }}>{question}</div>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 2, marginBottom: -8, marginLeft: -8 }}>
        <ToolLink label={confirmLabel} onPress={onConfirm} color={colors.error} ariaLabel={confirmAriaLabel} />
        <ToolLink label={cancelLabel} onPress={onCancel} ariaLabel={cancelAriaLabel} />
      </div>
    </Note>
  );
}

/** The bar at the bottom of a flow: something over it (a failure), an optional line (what is still missing), then the button(s). */
export function FlowFooter({ hint, hintTone = "quiet", above, children }: { hint?: string | null; hintTone?: "quiet" | "gold" | "red"; above?: ReactNode; children: ReactNode }) {
  const colors = useColors();
  return (
    <div className="flow-footer">
      {above}
      {hint ? (
        <p role={hintTone === "quiet" ? undefined : "alert"} style={{ margin: 0, fontSize: 13.5, lineHeight: "18px", textAlign: "center", color: hintTone === "quiet" ? colors.muted : hintTone === "gold" ? colors.gold : colors.error, fontWeight: hintTone === "quiet" ? 400 : 600 }}>
          {hint}
        </p>
      ) : null}
      {children}
    </div>
  );
}

/** One of a step's ways in: an icon in a well, what it is, a line about it. The whole card is the button. */
export function BigOption({ icon, title, sub, onPress, disabled, busy, ariaLabel }: { icon: IconName; title: string; sub: string; onPress: () => void; disabled?: boolean; busy?: boolean; ariaLabel?: string }) {
  const colors = useColors();
  return (
    <button type="button" onClick={onPress} disabled={disabled} aria-label={ariaLabel ?? title} aria-busy={busy || undefined} className="pressable" style={{ display: "flex", alignItems: "center", gap: 14, padding: 14, borderRadius: 16, border: `1px solid ${colors.border}`, background: colors.surface, minHeight: 76, width: "100%", opacity: disabled && !busy ? 0.55 : 1 }}>
      <span style={{ width: 46, height: 46, borderRadius: 14, display: "inline-flex", alignItems: "center", justifyContent: "center", background: alpha(colors.primary, 0.18), flexShrink: 0 }}>
        {busy ? <span className="spinner" /> : <Icon name={icon} size={24} color={colors.peri} />}
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: "block", fontSize: 17, lineHeight: "22px", fontWeight: 600, color: colors.foreground }}>{title}</span>
        <span style={{ display: "block", fontSize: 13, lineHeight: "18px", marginTop: 1, color: colors.muted }}>{sub}</span>
      </span>
      <Icon name="chevronRight" size={20} color={colors.muted} />
    </button>
  );
}

// ── A practice exam's own pieces ─────────────────────────────

/** The bar over a question: close, "Question 3 of 15", how far through. */
export function ExamTop({ onClose, label, fraction }: { onClose: () => void; label: string; fraction: number }) {
  const colors = useColors();
  return (
    <div style={{ padding: "4px 4px 0" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <ToolIconButton icon="close" size={18} onPress={onClose} ariaLabel="Close the practice exam" />
        <span className="eyebrow truncate" style={{ flex: 1, textAlign: "center", color: colors.peri }}>{label}</span>
        <span style={{ width: 44 }} />
      </div>
      <ThinBarInline fraction={fraction} />
    </div>
  );
}

/** The thin bar under the exam's top bar (the same bar the Study tab draws, placed here without a circular import). */
function ThinBarInline({ fraction }: { fraction: number }) {
  const colors = useColors();
  return (
    <div aria-hidden style={{ height: 6, borderRadius: 3, overflow: "hidden", marginTop: 14, background: alpha(colors.peri, 0.14) }}>
      <div style={{ height: 6, borderRadius: 3, background: colors.accent, width: `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%` }} />
    </div>
  );
}

export type ChoiceState = "idle" | "selected" | "right" | "wrong";

function useChoiceColors(state: ChoiceState) {
  const colors = useColors();
  if (state === "right") return { border: colors.success, background: alpha(colors.success, 0.1), badge: alpha(colors.success, 0.6), letter: colors.success };
  if (state === "wrong") return { border: colors.error, background: alpha(colors.error, 0.1), badge: alpha(colors.error, 0.6), letter: colors.error };
  if (state === "selected") return { border: colors.accent, background: alpha(colors.primary, 0.12), badge: colors.accent, letter: colors.foreground };
  return { border: colors.borderStrong, background: colors.surface, badge: colors.borderStrong, letter: colors.muted };
}

/** An answer to choose: a lettered outlined row (the accent outline once chosen, green with a tick for the right one and red with a cross for a wrong choice after Submit). */
export function ChoiceRow({ badge, text, state, selected, onPress, disabled, ariaLabel }: {
  badge: string;
  text: string;
  state: ChoiceState;
  /** The student's own choice (also after Submit, when the row is drawn as right or wrong). */
  selected: boolean;
  onPress: () => void;
  disabled: boolean;
  ariaLabel: string;
}) {
  const colors = useColors();
  const look = useChoiceColors(state);
  return (
    <button type="button" role="radio" aria-checked={selected} aria-label={ariaLabel} onClick={onPress} disabled={disabled} style={{ display: "flex", alignItems: "center", gap: 12, minHeight: 54, padding: "10px 14px", borderRadius: 14, border: `1px solid ${look.border}`, background: look.background, width: "100%", textAlign: "left" }}>
      <span style={{ width: 28, height: 28, borderRadius: 8, border: `1px solid ${look.badge}`, display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
        <span style={{ fontFamily: MONO_FONT, fontSize: 13, lineHeight: "17px", fontWeight: 600, color: look.letter }}>{badge}</span>
      </span>
      <span style={{ flex: 1, fontSize: 15, lineHeight: "20px", color: colors.foreground }}>{text}</span>
      {state === "right" ? <Icon name="check" size={18} color={colors.success} strokeWidth={2.4} /> : state === "wrong" ? <Icon name="close" size={18} color={colors.error} strokeWidth={2.2} /> : null}
    </button>
  );
}
