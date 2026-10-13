// Shared bits of the syllabus import (src/screens/syllabus.tsx; the iPhone app's components/syllabus/shared.tsx and
// step-bar.tsx): the icon of each kind of item, a short date, the step bar at the top of every step, the title block
// and the bottom bar every step uses, the big option of the first step, and the text link.

import type { CSSProperties, ReactNode } from "react";

import { alpha } from "../../engine/design";
import { parseLocalDate } from "../../engine/utils";
import { Icon, type IconName } from "../../ui/icon";
import { MONO_FONT } from "../../ui/primitives";
import { useColors } from "../../ui/theme";

/** Line icon per kind of item (the Tasks screen uses the same mapping). */
export const TYPE_ICON: Record<string, IconName> = { exam: "flag", quiz: "flag", assignment: "file", project: "layers", reading: "book", other: "list" };

export function formatShortDate(key: string): string {
  const date = parseLocalDate(key);
  return Number.isNaN(date.getTime()) ? key : date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** The top of every step: the way back (or out) on the left, "STEP 2 OF 4" on the right, four thin segments under. */
export function StepBar({ step, total = 4, icon = "back", label, onPress, disabled }: { step: number; total?: number; icon?: "back" | "close"; label: string; onPress: () => void; disabled?: boolean }) {
  const colors = useColors();
  return (
    <div style={{ paddingTop: 6, paddingBottom: 4 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <button type="button" className="pressable" onClick={onPress} disabled={disabled} aria-label={label} style={{ width: 44, height: 44, borderRadius: 13, display: "inline-flex", alignItems: "center", justifyContent: "center", background: colors.surface, border: `1px solid ${colors.borderStrong}`, opacity: disabled ? 0.5 : 1 }}>
          <Icon name={icon === "close" ? "close" : "chevronLeft"} size={20} color={colors.foreground} strokeWidth={2} />
        </button>
        <span style={{ fontFamily: MONO_FONT, fontSize: 12, lineHeight: "16px", fontWeight: 600, letterSpacing: 1.4, textTransform: "uppercase", color: colors.peri }}>Step {step} of {total}</span>
      </div>
      <div role="progressbar" aria-label={`Step ${step} of ${total}`} aria-valuemin={0} aria-valuemax={total} aria-valuenow={step} style={{ display: "flex", gap: 6, marginTop: 14 }}>
        {Array.from({ length: total }, (_, index) => (
          <span key={index} style={{ flex: 1, height: 3, borderRadius: 2, background: index < step ? colors.accent : colors.borderStrong }} />
        ))}
      </div>
    </div>
  );
}

/** A step's title and the line under it. */
export function FlowTitle({ title, sub }: { title: string; sub?: string }) {
  const colors = useColors();
  return (
    <div>
      <h1 style={{ margin: 0, fontSize: 26, lineHeight: "32px", fontWeight: 800, letterSpacing: -0.6, color: colors.foreground }}>{title}</h1>
      {sub ? <p style={{ margin: "6px 0 0", fontSize: 14.5, lineHeight: "20px", color: colors.muted }}>{sub}</p> : null}
    </div>
  );
}

/**
 * The bar at the bottom of a step: an optional line over the button (what is still missing, in gold, or a quiet
 * note), then the button(s). It stays in view above the tab bar (src/styles.css .flow-footer).
 */
export function FlowFooter({ hint, hintTone = "quiet", children }: { hint?: string | null; hintTone?: "quiet" | "gold" | "red"; children: ReactNode }) {
  const colors = useColors();
  return (
    <div className="flow-footer">
      {hint ? <p role={hintTone === "quiet" ? undefined : "alert"} style={{ margin: 0, fontSize: 13.5, lineHeight: "18px", textAlign: "center", color: hintTone === "quiet" ? colors.muted : hintTone === "gold" ? colors.gold : colors.error, fontWeight: hintTone === "quiet" ? 400 : 600 }}>{hint}</p> : null}
      {children}
    </div>
  );
}

/** A text link, 44px tall ("Paste the text instead", "Skip the term dates for now"). */
export function TextLink({ label, onPress, color, ariaLabel, style, disabled }: { label: string; onPress: () => void; color?: string; ariaLabel?: string; style?: CSSProperties; disabled?: boolean }) {
  const colors = useColors();
  return (
    <button type="button" className="link" onClick={onPress} disabled={disabled} aria-label={ariaLabel ?? label} style={{ minHeight: 44, fontSize: 14, lineHeight: "19px", fontWeight: 600, color: color ?? colors.peri, opacity: disabled ? 0.5 : 1, ...style }}>
      {label}
    </button>
  );
}

/** One of the first step's ways in: an icon in a well, what it is, a line about it. The whole card is the button. */
export function BigOption({ icon, title, sub, onPress, disabled, busy, ariaLabel, hint }: { icon: IconName; title: string; sub: string; onPress: () => void; disabled?: boolean; busy?: boolean; ariaLabel?: string; hint?: string }) {
  const colors = useColors();
  return (
    <button
      type="button"
      className="pressable"
      onClick={onPress}
      disabled={disabled}
      aria-label={ariaLabel ?? title}
      aria-busy={busy || undefined}
      title={hint}
      style={{ display: "flex", alignItems: "center", gap: 14, width: "100%", minHeight: 76, padding: 14, borderRadius: 16, border: `1px solid ${colors.border}`, background: colors.surface, textAlign: "left", opacity: disabled && !busy ? 0.55 : 1 }}
    >
      <span style={{ width: 46, height: 46, borderRadius: 14, flexShrink: 0, display: "inline-flex", alignItems: "center", justifyContent: "center", background: alpha(colors.primary, 0.18) }}>
        {busy ? <span className="spinner" /> : <Icon name={icon} size={24} color={colors.peri} />}
      </span>
      <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
        <span style={{ fontSize: 17, lineHeight: "22px", fontWeight: 600, color: colors.foreground }}>{title}</span>
        <span style={{ fontSize: 13, lineHeight: "18px", marginTop: 1, color: colors.muted }}>{sub}</span>
      </span>
      <Icon name="chevronRight" size={20} color={colors.muted} />
    </button>
  );
}
