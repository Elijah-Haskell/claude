// Pieces of the computer layout shared by the Settings family of screens (Settings, Classes, Work and activities,
// Imported syllabi, Course site link, Calendars, Reminders, Delete account, the privacy policy and Pro). The phone
// layout never uses them: each screen renders its phone layout unchanged below 900px (src/ui/layout.ts useDesktop).

import { useEffect, useState, type CSSProperties, type ReactNode } from "react";

import { legibleOn } from "../engine/contrast";
import { alpha } from "../engine/design";
import type { DayOfWeek } from "../engine/types";
import { Icon, type IconName } from "../ui/icon";
import { HeaderIconButton, MONO_FONT } from "../ui/primitives";
import { useColors } from "../ui/theme";

/** Whether the window is at least `px` wide (for a layout that needs more room than src/ui/layout.ts's two widths). */
export function useMinWidth(px: number): boolean {
  const query = `(min-width: ${px}px)`;
  const [matches, setMatches] = useState(() => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(query).matches);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const list = window.matchMedia(query);
    const update = () => setMatches(list.matches);
    update();
    list.addEventListener("change", update);
    return () => list.removeEventListener("change", update);
  }, [query]);
  return matches;
}

/**
 * A page's header on a computer: the back button on the title's line (not on a row of its own above it), the eyebrow
 * over the title, the subtitle under it, and the page's own actions at the right end.
 */
export function DesktopPageHead({ back, eyebrow, title, subtitle, right }: { back?: { onPress: () => void; ariaLabel: string }; eyebrow?: string; title: ReactNode; subtitle?: string; right?: ReactNode }) {
  const colors = useColors();
  return (
    <header style={{ display: "flex", alignItems: "flex-start", gap: 16, paddingBottom: 6 }}>
      {back ? (
        <div style={{ paddingTop: eyebrow ? 20 : 0, flexShrink: 0 }}>
          <HeaderIconButton onPress={back.onPress} ariaLabel={back.ariaLabel}>
            <Icon name="chevronLeft" size={20} color={colors.foreground} strokeWidth={2} />
          </HeaderIconButton>
        </div>
      ) : null}
      <div style={{ flex: 1, minWidth: 0 }}>
        {eyebrow ? <div className="eyebrow truncate" style={{ marginBottom: 4 }}>{eyebrow}</div> : null}
        {typeof title === "string" ? <h1 className="screen-title">{title}</h1> : title}
        {subtitle ? <p className="screen-subtitle" style={{ maxWidth: 640 }}>{subtitle}</p> : null}
      </div>
      {right ? <div style={{ display: "flex", alignItems: "center", gap: 10, paddingTop: eyebrow ? 20 : 0, flexShrink: 0 }}>{right}</div> : null}
    </header>
  );
}

/**
 * A titled panel: an outlined group whose first line names it (with its icon), the rows under it divided as in any
 * group. `body` pads non-row content to the rows' edges.
 */
export function Panel({ title, icon, tint, right, children, style, ariaLabel }: { title: string; icon?: IconName; tint?: string; right?: ReactNode; children: ReactNode; style?: CSSProperties; ariaLabel?: string }) {
  const colors = useColors();
  const color = tint ?? colors.peri;
  return (
    <section className="group" aria-label={ariaLabel} style={{ boxShadow: "0 1px 0 rgba(255, 255, 255, 0.02) inset", ...style }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, minHeight: 52, padding: "12px 18px", background: alpha(colors.panel, 0.55) }}>
        {icon ? <Icon name={icon} size={17} color={color} /> : null}
        <h2 className="truncate" style={{ flex: 1, minWidth: 0, margin: 0, fontFamily: MONO_FONT, fontSize: 12.5, lineHeight: "17px", fontWeight: 600, letterSpacing: 1, textTransform: "uppercase", color }}>{title}</h2>
        {right}
      </div>
      {children}
    </section>
  );
}

/** Padding for what a panel holds that is not a row (a form, a note), aligned with the rows' edges. */
export function PanelBody({ children, gap = 12, style }: { children: ReactNode; gap?: number; style?: CSSProperties }) {
  return <div style={{ display: "flex", flexDirection: "column", gap, padding: "16px 18px 18px", ...style }}>{children}</div>;
}

/** The "add one more" card at the end of a grid of cards: dashed, quiet, lit on hover. */
export function AddTile({ label, ariaLabel, onPress, minHeight = 120 }: { label: string; ariaLabel?: string; onPress: () => void; minHeight?: number }) {
  const colors = useColors();
  return (
    <button
      type="button"
      className="card pressable"
      aria-label={ariaLabel}
      onClick={onPress}
      style={{ minHeight, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10, borderStyle: "dashed", borderColor: colors.borderStrong, background: "transparent", color: colors.muted, fontSize: 15, fontWeight: 600, transition: "border-color 140ms ease, color 140ms ease, background 140ms ease" }}
      onMouseEnter={(event) => {
        event.currentTarget.style.borderColor = colors.accent;
        event.currentTarget.style.color = colors.foreground;
      }}
      onMouseLeave={(event) => {
        event.currentTarget.style.borderColor = colors.borderStrong;
        event.currentTarget.style.color = colors.muted;
      }}
    >
      <span style={{ width: 40, height: 40, borderRadius: 12, display: "inline-flex", alignItems: "center", justifyContent: "center", background: alpha(colors.peri, 0.12) }}>
        <Icon name="plus" size={20} color={colors.peri} strokeWidth={2} />
      </span>
      {label}
    </button>
  );
}

/** A small icon + text line inside a card ("Mon Wed · 10:00 – 11:15 AM", the room). */
export function MetaLine({ icon, children, color, tint }: { icon: IconName; children: ReactNode; color?: string; tint?: string }) {
  const colors = useColors();
  return (
    <span style={{ display: "flex", alignItems: "flex-start", gap: 8, fontSize: 13.5, lineHeight: "19px", color: color ?? colors.muted, minWidth: 0 }}>
      <Icon name={icon} size={15} color={tint ?? colors.dim} style={{ marginTop: 2, flexShrink: 0 }} />
      <span className="clamp2" style={{ minWidth: 0 }}>{children}</span>
    </span>
  );
}

/** The days of the week, Monday first, with the class's meeting days lit in its colour (a computer's class card). */
export function WeekDots({ days, color }: { days: readonly DayOfWeek[]; color: string }) {
  const colors = useColors();
  const ORDER: DayOfWeek[] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  return (
    <span aria-hidden="true" style={{ display: "flex", gap: 5 }}>
      {ORDER.map((day) => {
        const on = days.includes(day);
        return (
          <span key={day} style={{ width: 26, height: 24, borderRadius: 7, display: "inline-flex", alignItems: "center", justifyContent: "center", fontFamily: MONO_FONT, fontSize: 11, fontWeight: 600, border: `1px solid ${on ? alpha(color, 0.55) : colors.border}`, background: on ? alpha(color, 0.18) : "transparent", color: on ? legibleOn(color, colors.surface, 5.5) : colors.dim }}>
            {day.charAt(0)}
          </span>
        );
      })}
    </span>
  );
}
