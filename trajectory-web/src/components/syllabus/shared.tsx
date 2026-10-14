// Shared bits of the syllabus import (src/screens/syllabus.tsx; the iPhone app's components/syllabus/shared.tsx and
// step-bar.tsx): the icon of each kind of item, a short date, the step bar at the top of every step, the title block
// and the bottom bar every step uses, the big option of the first step, and the text link.

import { useState, type CSSProperties, type ReactNode } from "react";

import { alpha } from "../../engine/design";
import { parseLocalDate } from "../../engine/utils";
import { Icon, type IconName } from "../../ui/icon";
import { useDesktop } from "../../ui/layout";
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
  // A computer: the title at the size of the other screens' titles.
  const desktop = useDesktop();
  return (
    <div>
      <h1 style={{ margin: 0, fontSize: desktop ? 32 : 26, lineHeight: desktop ? "38px" : "32px", fontWeight: 800, letterSpacing: desktop ? -0.9 : -0.6, color: colors.foreground }}>{title}</h1>
      {sub ? <p style={{ margin: "6px 0 0", fontSize: desktop ? 15 : 14.5, lineHeight: desktop ? "21px" : "20px", color: colors.muted, maxWidth: desktop ? 680 : undefined }}>{sub}</p> : null}
    </div>
  );
}

/**
 * The bar at the bottom of a step: an optional line over the button (what is still missing, in gold, or a quiet
 * note), then the button(s). It stays in view above the tab bar (src/styles.css .flow-footer).
 */
export function FlowFooter({ hint, hintTone = "quiet", children }: { hint?: string | null; hintTone?: "quiet" | "gold" | "red"; children: ReactNode }) {
  const colors = useColors();
  // A computer: one row, the line on the left of a button of its own width at the right (not a bar across the page).
  const desktop = useDesktop();
  const line = hint ? <p role={hintTone === "quiet" ? undefined : "alert"} style={{ margin: 0, fontSize: 13.5, lineHeight: "18px", textAlign: desktop ? "right" : "center", color: hintTone === "quiet" ? colors.muted : hintTone === "gold" ? colors.gold : colors.error, fontWeight: hintTone === "quiet" ? 400 : 600, flex: desktop ? 1 : undefined, minWidth: 0 }}>{hint}</p> : null;
  if (desktop) {
    return (
      <div className="flow-footer" style={{ flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: 20, padding: "14px 0" }}>
        {line}
        <div style={{ width: 320, flexShrink: 0, display: "flex", flexDirection: "column" }}>{children}</div>
      </div>
    );
  }
  return (
    <div className="flow-footer">
      {line}
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

/**
 * The first step's way in on a computer: a large dashed card that is the button, and that also takes files dropped on
 * it (the same as picking them).
 */
export function DropOption({ icon, title, sub, onPress, onDropFiles, disabled, busy, ariaLabel, hint }: { icon: IconName; title: string; sub: string; onPress: () => void; onDropFiles: (files: File[]) => void; disabled?: boolean; busy?: boolean; ariaLabel?: string; hint?: string }) {
  const colors = useColors();
  const [over, setOver] = useState(false);
  return (
    <button
      type="button"
      className="pressable"
      onClick={onPress}
      disabled={disabled}
      aria-label={ariaLabel ?? title}
      aria-busy={busy || undefined}
      title={hint}
      onDragOver={(event) => {
        if (disabled) return;
        event.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => {
        event.preventDefault();
        setOver(false);
        if (disabled) return;
        const files = Array.from(event.dataTransfer.files ?? []);
        if (files.length > 0) onDropFiles(files);
      }}
      style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 14, width: "100%", minHeight: 220, padding: 24, borderRadius: 20, border: `1.5px dashed ${over ? colors.accent : colors.borderStrong}`, background: over ? alpha(colors.primary, 0.12) : alpha(colors.surface, 0.6), textAlign: "center", opacity: disabled && !busy ? 0.55 : 1, transition: "border-color 120ms ease, background 120ms ease" }}
    >
      <span style={{ width: 60, height: 60, borderRadius: 18, display: "inline-flex", alignItems: "center", justifyContent: "center", background: alpha(colors.primary, 0.18) }}>
        {busy ? <span className="spinner" /> : <Icon name={icon} size={28} color={colors.peri} />}
      </span>
      <span style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={{ fontSize: 19, lineHeight: "24px", fontWeight: 600, color: colors.foreground }}>{title}</span>
        <span style={{ fontSize: 14, lineHeight: "19px", color: colors.muted }}>{sub}</span>
      </span>
    </button>
  );
}
