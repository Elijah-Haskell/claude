// The web versions of the mobile app's UI pieces (components/ui): the same shapes, written for the DOM.

import type { CSSProperties, ReactNode } from "react";

import { legibleOn, parseHexColor } from "../engine/contrast";
import { alpha, brand, radius } from "../engine/design";
import type { BadgeTone } from "../engine/task-list";
import { Icon, type IconName } from "./icon";
import { useColors } from "./theme";

export const MONO_FONT = '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace';

/** Eyebrow / label style used across the app: mono, uppercase, tracked. */
export function eyebrowStyle(color: string, size = 10.5): CSSProperties {
  return { fontFamily: MONO_FONT, fontSize: size, fontWeight: 600, letterSpacing: size * 0.14, textTransform: "uppercase", color };
}

/** Mono style for clock times and counts. */
export function monoStyle(size: number, color?: string, weight: 400 | 500 | 600 = 500): CSSProperties {
  return { fontFamily: MONO_FONT, fontSize: size, fontWeight: weight, ...(color ? { color } : {}) };
}

// ── Card ─────────────────────────────────────────────────────

export type CardTone = "surface" | "inset" | "glow" | "violet" | "gold" | "danger";

export function Card({ tone = "surface", padded = true, radiusSize = radius.lg, style, className, children, onClick, ariaLabel }: { tone?: CardTone; padded?: boolean; radiusSize?: number; style?: CSSProperties; className?: string; children?: ReactNode; onClick?: () => void; ariaLabel?: string }) {
  const colors = useColors();
  const look: CSSProperties = (() => {
    switch (tone) {
      case "inset":
        return { background: colors.panel, borderColor: colors.border };
      case "glow":
        return { background: alpha(colors.primary, 0.14), borderColor: colors.accent, boxShadow: `0 6px 14px ${alpha(colors.primary, 0.35)}` };
      case "violet":
        return { background: alpha(colors.violet, 0.14), borderColor: alpha(colors.violet, 0.5) };
      case "gold":
        return { background: alpha(colors.gold, 0.12), borderColor: alpha(colors.gold, 0.5) };
      case "danger":
        return { background: alpha(colors.error, 0.1), borderColor: alpha(colors.error, 0.4) };
      default:
        return { background: colors.surface, borderColor: colors.border };
    }
  })();
  const base: CSSProperties = { borderRadius: radiusSize, border: "1px solid", ...(padded ? { padding: 16 } : {}), ...look, ...style };
  if (onClick) {
    return (
      <button type="button" className={className} onClick={onClick} aria-label={ariaLabel} style={{ display: "block", width: "100%", textAlign: "left", ...base }}>
        {children}
      </button>
    );
  }
  return (
    <div className={className} style={base}>
      {children}
    </div>
  );
}

// ── Pill ─────────────────────────────────────────────────────

export type PillTone = "neutral" | "blue" | "peri" | "gold" | "violet" | "green" | "red" | "solid" | "solidViolet";

export function usePillColors(tone: PillTone) {
  const colors = useColors();
  switch (tone) {
    case "blue":
      return { background: alpha(colors.primary, 0.16), border: alpha(colors.accent, 0.5), text: colors.accent };
    case "peri":
      return { background: alpha(colors.peri, 0.12), border: alpha(colors.peri, 0.4), text: colors.peri };
    case "gold":
      return { background: alpha(colors.gold, 0.15), border: alpha(colors.gold, 0.5), text: colors.gold };
    case "violet":
      return { background: alpha(colors.violet, 0.16), border: alpha(colors.violet, 0.5), text: colors.violet };
    case "green":
      return { background: alpha(colors.success, 0.14), border: alpha(colors.success, 0.45), text: colors.success };
    case "red":
      return { background: alpha(colors.error, 0.14), border: alpha(colors.error, 0.5), text: colors.error };
    case "solid":
      return { background: colors.primary, border: colors.primary, text: "#FFFFFF" };
    case "solidViolet":
      return { background: colors.violet, border: colors.violet, text: "#FFFFFF" };
    default:
      return { background: alpha(colors.peri, 0.08), border: colors.borderStrong, text: colors.muted };
  }
}

export function Pill({ label, tone = "neutral", mono = true, size = "sm", left, style }: { label: string; tone?: PillTone; mono?: boolean; size?: "xs" | "sm" | "md"; left?: ReactNode; style?: CSSProperties }) {
  const look = usePillColors(tone);
  const font = size === "xs" ? 9 : size === "sm" ? 10.5 : 12;
  const padY = size === "xs" ? 3 : size === "sm" ? 4 : 6;
  const padX = size === "xs" ? 7 : size === "sm" ? 9 : 12;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5, maxWidth: "100%", padding: `${padY}px ${padX}px`, borderRadius: size === "md" ? radius.sm : radius.xs, border: `1px solid ${look.border}`, background: look.background, ...style }}>
      {left}
      <span style={mono ? eyebrowStyle(look.text, font) : { fontSize: font + 1, fontWeight: 600, color: look.text }} className="truncate">
        {label}
      </span>
    </span>
  );
}

// ── DateBadge ────────────────────────────────────────────────

export function useBadgeColors(tone: BadgeTone) {
  const colors = useColors();
  if (tone === "gold") return { background: alpha(colors.gold, 0.15), border: alpha(colors.gold, 0.5), text: colors.gold };
  if (tone === "red") return { background: alpha(colors.error, 0.14), border: alpha(colors.error, 0.5), text: colors.error };
  return { background: "transparent", border: colors.borderStrong, text: colors.muted };
}

export function DateBadge({ label, tone = "neutral", left, suffix, compact, style }: { label: string; tone?: BadgeTone; left?: ReactNode; suffix?: string; compact?: boolean; style?: CSSProperties }) {
  const look = useBadgeColors(tone);
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5, height: compact ? 24 : 26, padding: `0 ${compact ? 7 : 9}px`, borderRadius: 8, border: `1px solid ${look.border}`, background: look.background, flexShrink: 0, maxWidth: "100%", ...style }}>
      {left}
      <span className="truncate" style={{ fontFamily: MONO_FONT, fontSize: 12, lineHeight: "16px", fontWeight: 600, letterSpacing: compact ? 0.5 : 1, textTransform: "uppercase", color: look.text }}>
        {label}
      </span>
      {suffix ? <span style={{ fontFamily: MONO_FONT, fontSize: 12, lineHeight: "16px", fontWeight: 600, color: look.text, flexShrink: 0 }}>{suffix}</span> : null}
    </span>
  );
}

// ── SectionLabel ─────────────────────────────────────────────

export function SectionLabel({ title, right, color, style }: { title: string; right?: ReactNode; color?: string; style?: CSSProperties }) {
  const colors = useColors();
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, minHeight: 24, ...style }}>
      <h2 className="truncate" style={{ margin: 0, fontFamily: MONO_FONT, fontSize: 12.5, lineHeight: "17px", fontWeight: 600, letterSpacing: 1, textTransform: "uppercase", color: color ?? colors.peri, flexShrink: 1 }}>
        {title}
      </h2>
      <div style={{ flex: 1, minWidth: 12, height: 1, background: colors.borderStrong }} />
      {right}
    </div>
  );
}

// ── Fields ───────────────────────────────────────────────────

export function FieldLabel({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  const colors = useColors();
  return <div style={{ fontFamily: MONO_FONT, fontSize: 12, lineHeight: "16px", fontWeight: 600, letterSpacing: 1.2, textTransform: "uppercase", marginBottom: 7, color: colors.muted, ...style }}>{children}</div>;
}

export function FieldGroup({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div className="group" style={style}>
      {children}
    </div>
  );
}

export function FieldRow({ icon, label, detail, children, stacked, tint }: { icon: IconName; label: string; detail?: string; first?: boolean; children?: ReactNode; stacked?: boolean; tint?: string }) {
  const colors = useColors();
  const base = tint ?? colors.peri;
  return (
    <div className="row" style={stacked ? { flexDirection: "column", alignItems: "stretch", gap: 10, padding: "12px 14px" } : { justifyContent: "space-between" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexShrink: 1, minWidth: 0 }}>
        <div className="well" style={{ background: alpha(base, 0.12) }}>
          <Icon name={icon} size={18} color={base} />
        </div>
        <div style={{ flexShrink: 1, minWidth: 0 }}>
          <div className="row-label">{label}</div>
          {detail ? <div className="row-detail">{detail}</div> : null}
        </div>
      </div>
      {children ? <div style={stacked ? { alignSelf: "stretch" } : { flexShrink: 0, maxWidth: "62%", display: "flex", alignItems: "center", justifyContent: "flex-end" }}>{children}</div> : null}
    </div>
  );
}

export function FieldPickRow({ icon, label, detail, value, unset, tone = "default", onPress, ariaLabel, chevron = true }: { icon: IconName; label: string; detail?: string; value?: string; unset?: boolean; tone?: "default" | "violet"; onPress: () => void; first?: boolean; ariaLabel?: string; chevron?: boolean }) {
  const colors = useColors();
  const tint = unset ? colors.gold : tone === "violet" ? colors.violet : colors.peri;
  return (
    <button type="button" className="row pressable" onClick={onPress} aria-label={ariaLabel ?? [label, value, detail].filter(Boolean).join(". ")}>
      <div className="well" style={{ background: alpha(tint, unset || tone === "violet" ? 0.16 : 0.12) }}>
        <Icon name={icon} size={18} color={tint} />
      </div>
      <div className="row-text">
        <div className="row-label clamp2">{label}</div>
        {detail ? <div className="row-detail clamp2">{detail}</div> : null}
      </div>
      {value ? <div className="truncate" style={{ fontSize: 15, lineHeight: "20px", flexShrink: 0, maxWidth: "46%", color: unset ? colors.gold : colors.muted, fontWeight: unset ? 600 : 400 }}>{value}</div> : null}
      {chevron ? <Icon name="chevronRight" size={18} color={colors.muted} /> : null}
    </button>
  );
}

// ── Note ─────────────────────────────────────────────────────

export type NoteTone = "blue" | "plain" | "gold" | "green" | "red";

export function Note({ tone = "blue", icon = "info", children, style, role }: { tone?: NoteTone; icon?: IconName; children: ReactNode; style?: CSSProperties; role?: "alert" | "status" }) {
  const colors = useColors();
  const look = (() => {
    if (tone === "plain") return { background: colors.surface, border: colors.border, icon: colors.peri, text: colors.muted };
    const base = tone === "gold" ? colors.gold : tone === "green" ? colors.success : tone === "red" ? colors.error : colors.primary;
    return { background: alpha(base, tone === "blue" ? 0.16 : 0.1), border: alpha(base, tone === "blue" ? 0.55 : 0.45), icon: tone === "blue" ? colors.peri : base, text: tone === "blue" ? colors.muted : colors.foreground };
  })();
  return (
    <div role={role} style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "12px 14px", borderRadius: 14, border: `1px solid ${look.border}`, background: look.background, ...style }}>
      <Icon name={icon} size={20} color={look.icon} style={{ marginTop: 1 }} />
      {typeof children === "string" ? <div style={{ flex: 1, fontSize: 14, lineHeight: "20px", color: look.text }}>{children}</div> : <div style={{ flex: 1, minWidth: 0 }}>{children}</div>}
    </div>
  );
}

// ── Segmented ────────────────────────────────────────────────

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
  badge?: string | number;
  ariaLabel?: string;
}

export function Segmented<T extends string>({ options, value, onChange, style, scroll }: { options: SegmentOption<T>[]; value: T; onChange: (value: T) => void; style?: CSSProperties; scroll?: boolean }) {
  const colors = useColors();
  return (
    <div role="tablist" className={scroll ? "hidden-scrollbar" : undefined} style={{ display: "flex", gap: 4, padding: 4, borderRadius: 14, background: colors.panel, border: `1px solid ${colors.border}`, overflowX: scroll ? "auto" : undefined, ...style }}>
      {options.map((option) => {
        const on = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-selected={on}
            aria-label={option.ariaLabel ?? option.label}
            onClick={() => onChange(option.value)}
            style={{ flex: scroll ? "0 0 auto" : 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 5, minHeight: 36, minWidth: 44, padding: `8px ${scroll ? 12 : 6}px`, borderRadius: 10, border: `1px solid ${on ? alpha(colors.accent, 0.7) : "transparent"}`, background: on ? alpha(colors.primary, 0.22) : "transparent", whiteSpace: "nowrap" }}
          >
            {option.badge !== undefined ? (
              <span style={{ minWidth: 18, height: 18, borderRadius: 9, padding: "0 4px", display: "inline-flex", alignItems: "center", justifyContent: "center", background: alpha(colors.peri, on ? 0.22 : 0.14), fontFamily: MONO_FONT, fontSize: 12, fontWeight: 600, color: on ? colors.foreground : colors.peri }}>{String(option.badge)}</span>
            ) : null}
            <span className="truncate" style={{ fontSize: 14, fontWeight: 600, color: on ? colors.foreground : colors.muted }}>{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}

// ── PrimaryButton ────────────────────────────────────────────

export type ButtonTone = "primary" | "violet" | "ghost" | "danger" | "gold";
export type ButtonSize = "sm" | "md" | "lg";

const SIZES: Record<ButtonSize, { height: number; font: number; padX: number; radius: number }> = {
  sm: { height: 38, font: 13, padX: 14, radius: radius.sm },
  md: { height: 48, font: 15, padX: 20, radius: radius.md },
  lg: { height: 54, font: 16, padX: 24, radius: 14 },
};

export function PrimaryButton({ label, tone = "primary", size = "md", loading, left, right, style, fullWidth, disabled, onPress, ariaLabel, type = "button" }: { label: string; tone?: ButtonTone; size?: ButtonSize; loading?: boolean; left?: ReactNode; right?: ReactNode; style?: CSSProperties; fullWidth?: boolean; disabled?: boolean; onPress?: () => void; ariaLabel?: string; type?: "button" | "submit" }) {
  const colors = useColors();
  const dims = SIZES[size];
  const inactive = Boolean(disabled) || Boolean(loading);
  const filled = tone === "primary" || tone === "violet" || tone === "gold";
  const labelColor = tone === "ghost" ? colors.foreground : tone === "danger" ? colors.error : tone === "gold" ? "#1B1400" : brand.white;
  const gradient = tone === "violet" ? "linear-gradient(135deg, #7B5CF0, #8B6CF6)" : tone === "gold" ? "linear-gradient(135deg, #E5B142, #F0C463)" : "linear-gradient(135deg, #4F6EF7, #6B87FF)";
  const glowColor = tone === "violet" ? brand.violet : brand.blue;
  return (
    <button
      type={type}
      aria-label={ariaLabel ?? label}
      aria-disabled={inactive}
      disabled={inactive}
      onClick={onPress}
      style={{
        minHeight: dims.height,
        padding: `6px ${dims.padX}px`,
        borderRadius: dims.radius,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        width: fullWidth ? "100%" : undefined,
        background: filled ? gradient : tone === "danger" ? alpha(colors.error, 0.12) : alpha(colors.peri, 0.08),
        border: filled ? "0" : `1px solid ${tone === "danger" ? alpha(colors.error, 0.45) : colors.borderStrong}`,
        opacity: inactive ? 0.55 : 1,
        boxShadow: filled && !inactive ? `0 6px 14px ${alpha(glowColor, 0.4)}` : undefined,
        color: labelColor,
        fontSize: dims.font,
        fontWeight: 600,
        letterSpacing: 0.1,
        textAlign: "center",
        ...style,
      }}
    >
      {loading ? <span className="spinner" style={{ borderTopColor: labelColor }} /> : left}
      <span style={{ flexShrink: 1 }}>{label}</span>
      {right}
    </button>
  );
}

// ── Header ───────────────────────────────────────────────────

export function ScreenHeader({ eyebrow, title, subtitle, right, compact, style }: { eyebrow?: string; title: string; subtitle?: string; right?: ReactNode; compact?: boolean; style?: CSSProperties }) {
  return (
    <div className="screen-header" style={style}>
      <div style={{ flex: 1, minWidth: 0 }}>
        {eyebrow ? <div className="eyebrow truncate" style={{ marginBottom: 4 }}>{eyebrow}</div> : null}
        <h1 className={`screen-title${compact ? " compact" : ""}`}>{title}</h1>
        {subtitle ? <p className="screen-subtitle">{subtitle}</p> : null}
      </div>
      {right ? <div style={{ display: "flex", alignItems: "center", gap: 8, paddingTop: eyebrow ? 14 : 2, flexShrink: 0 }}>{right}</div> : null}
    </div>
  );
}

export function HeaderIconButton({ children, onPress, ariaLabel, active }: { children: ReactNode; onPress: () => void; ariaLabel: string; active?: boolean }) {
  const colors = useColors();
  return (
    <button type="button" aria-label={ariaLabel} onClick={onPress} className="pressable" style={{ width: 40, height: 40, borderRadius: 13, display: "flex", alignItems: "center", justifyContent: "center", background: active ? colors.primary : colors.surface, border: `1px solid ${active ? colors.primary : colors.borderStrong}` }}>
      {children}
    </button>
  );
}

/** The 44pt close button at the top right of a sheet. */
export function CloseButton({ onPress, ariaLabel = "Close" }: { onPress: () => void; ariaLabel?: string }) {
  const colors = useColors();
  return (
    <button type="button" aria-label={ariaLabel} onClick={onPress} className="pressable" style={{ width: 44, height: 44, borderRadius: 13, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", background: colors.surface, border: `1px solid ${colors.borderStrong}` }}>
      <Icon name="close" size={18} color={colors.muted} strokeWidth={2} />
    </button>
  );
}

// ── CheckBox ─────────────────────────────────────────────────

export function CheckBox({ checked, onPress, ariaLabel, disabled, size = 24, style }: { checked: boolean; onPress?: () => void; ariaLabel: string; disabled?: boolean; size?: number; style?: CSSProperties }) {
  const colors = useColors();
  const box = (
    <span style={{ width: size, height: size, borderRadius: Math.round(size * 0.3), border: `1.5px solid ${checked ? colors.success : alpha(colors.muted, 0.75)}`, background: checked ? alpha(colors.success, 0.14) : "transparent", display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
      {checked ? <Icon name="check" size={Math.round(size * 0.62)} color={colors.success} strokeWidth={2.8} /> : null}
    </span>
  );
  const frame: CSSProperties = { width: 44, height: 44, display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0, ...style };
  if (!onPress) return <span style={frame}>{box}</span>;
  return (
    <button type="button" role="checkbox" aria-checked={checked} aria-label={ariaLabel} disabled={disabled} onClick={onPress} style={frame}>
      {box}
    </button>
  );
}

// ── CourseChip ───────────────────────────────────────────────

export function CourseChip({ label, color, style }: { label: string; color?: string; style?: CSSProperties }) {
  const colors = useColors();
  const base = color && parseHexColor(color) ? color : colors.peri;
  return (
    <span style={{ height: 20, padding: "0 6px", borderRadius: 6, border: `1px solid ${alpha(base, 0.55)}`, background: alpha(base, 0.16), display: "inline-flex", alignItems: "center", flexShrink: 0, ...style }}>
      <span className="truncate" style={{ fontFamily: MONO_FONT, fontSize: 12, lineHeight: "16px", fontWeight: 600, letterSpacing: 0.4, color: legibleOn(base, colors.surface) }}>{label}</span>
    </span>
  );
}

// ── ProgressRing ─────────────────────────────────────────────

export function ProgressRing({ progress, size = 46, stroke = 4, color, trackColor, label, labelSize, children }: { progress: number; size?: number; stroke?: number; color?: string; trackColor?: string; label?: string; labelSize?: number; children?: ReactNode }) {
  const colors = useColors();
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const clamped = Math.max(0, Math.min(1, Number.isFinite(progress) ? progress : 0));
  return (
    <div role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(clamped * 100)} style={{ width: size, height: size, position: "relative", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
      <svg width={size} height={size} style={{ position: "absolute", inset: 0, transform: "rotate(-90deg)" }} aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={r} stroke={trackColor ?? colors.border} strokeWidth={stroke} fill="none" />
        <circle cx={size / 2} cy={size / 2} r={r} stroke={color ?? colors.accent} strokeWidth={stroke} fill="none" strokeLinecap="round" strokeDasharray={`${c} ${c}`} strokeDashoffset={c * (1 - clamped)} />
      </svg>
      {children ?? (label ? <span style={{ fontFamily: MONO_FONT, fontSize: labelSize ?? Math.max(9, size * 0.24), fontWeight: 600, color: colors.foreground, position: "relative" }}>{label}</span> : null)}
    </div>
  );
}

// ── AppSwitch ────────────────────────────────────────────────

export function AppSwitch({ value, onValueChange, ariaLabel, disabled }: { value: boolean; onValueChange: (value: boolean) => void; ariaLabel: string; disabled?: boolean }) {
  const colors = useColors();
  return (
    <button type="button" role="switch" aria-checked={value} aria-label={ariaLabel} disabled={disabled} onClick={() => onValueChange(!value)} style={{ width: 50, height: 30, borderRadius: 15, padding: 2, background: value ? colors.primary : colors.borderStrong, position: "relative", transition: "background 160ms", flexShrink: 0, opacity: disabled ? 0.5 : 1 }}>
      <span style={{ display: "block", width: 26, height: 26, borderRadius: 13, background: brand.white, transform: value ? "translateX(20px)" : "translateX(0)", transition: "transform 160ms", boxShadow: "0 1px 3px rgba(0,0,0,0.3)" }} />
    </button>
  );
}

// ── Chip (the website's `.chip`: a small action inside a row) ──

export type ChipTone = "neutral" | "red" | "gold" | "violet";

export function Chip({ label, onPress, tone = "neutral", icon, ariaLabel, right }: { label: ReactNode; onPress: () => void; tone?: ChipTone; icon?: IconName; ariaLabel?: string; right?: ReactNode }) {
  const colors = useColors();
  const look = tone === "red"
    ? { bg: alpha(colors.error, 0.14), border: alpha(colors.error, 0.5), text: colors.error }
    : tone === "gold"
      ? { bg: alpha(colors.gold, 0.15), border: alpha(colors.gold, 0.5), text: colors.gold }
      : tone === "violet"
        ? { bg: colors.violet, border: colors.violet, text: brand.white }
        : { bg: alpha(colors.peri, 0.08), border: colors.borderStrong, text: colors.foreground };
  return (
    <button type="button" aria-label={ariaLabel ?? (typeof label === "string" ? label : undefined)} onClick={onPress} style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 12px", borderRadius: 9, border: `1px solid ${look.border}`, background: look.bg, color: look.text, fontSize: 12, fontWeight: 600, minHeight: 32 }}>
      {icon ? <Icon name={icon} size={13} color={look.text} /> : null}
      <span className="truncate">{label}</span>
      {right}
    </button>
  );
}

// ── Tile and TileRow (the bento tile and its rows) ───────────

export function Tile({ tag, tagColor, title, body, icon, children, style, padding = 18 }: { tag?: string; tagColor?: string; title?: string; body?: string; icon?: IconName; children?: ReactNode; style?: CSSProperties; padding?: number }) {
  const colors = useColors();
  return (
    <div style={{ borderRadius: 22, border: `1px solid ${colors.border}`, overflow: "hidden", padding, display: "flex", flexDirection: "column", gap: 14, background: `linear-gradient(90deg, ${alpha(colors.surface, 0.55)}, ${alpha(colors.panel, 0.78)})`, ...style }}>
      {tag || title || body || icon ? (
        <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            {tag ? <div style={{ ...eyebrowStyle(tagColor ?? colors.peri, 10.5), marginBottom: 8 }}>{tag}</div> : null}
            {title ? <div style={{ fontSize: 19, lineHeight: "24px", fontWeight: 700, letterSpacing: -0.4, color: colors.foreground }}>{title}</div> : null}
            {body ? <div style={{ fontSize: 13.5, lineHeight: "20px", color: colors.muted, marginTop: title ? 6 : 0 }}>{body}</div> : null}
          </div>
          {icon ? <Icon name={icon} size={20} color={tagColor ?? colors.peri} /> : null}
        </div>
      ) : null}
      {children}
    </div>
  );
}

export function TileRow({ icon, title, subtitle, right, onPress, ariaLabel, iconColor, iconBackground, dim }: { icon: IconName; title: string; subtitle?: string; right?: ReactNode; onPress?: () => void; ariaLabel?: string; iconColor?: string; iconBackground?: string; dim?: boolean }) {
  const colors = useColors();
  const inner = (
    <>
      <div style={{ width: 36, height: 36, borderRadius: 11, background: iconBackground ?? alpha(colors.peri, 0.14), display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
        <Icon name={icon} size={18} color={iconColor ?? colors.peri} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: colors.foreground }}>{title}</div>
        {subtitle ? <div style={{ fontSize: 12.5, color: colors.muted, marginTop: 1 }}>{subtitle}</div> : null}
      </div>
      {right}
    </>
  );
  const frame: CSSProperties = { display: "flex", alignItems: "center", gap: 14, padding: "11px 14px", borderRadius: 14, background: "var(--row-tint)", border: `1px solid ${colors.border}`, opacity: dim ? 0.55 : 1, width: "100%" };
  if (!onPress) return <div style={frame}>{inner}</div>;
  return (
    <button type="button" className="pressable" onClick={onPress} aria-label={ariaLabel ?? title} style={frame}>
      {inner}
    </button>
  );
}

// ── Form controls that the browser provides: a date, a time ──

export function DateInput({ value, onChange, ariaLabel, min, style }: { value: string; onChange: (value: string) => void; ariaLabel: string; min?: string; style?: CSSProperties }) {
  const colors = useColors();
  return (
    <input
      type="date"
      aria-label={ariaLabel}
      value={value}
      min={min}
      onChange={(event) => onChange(event.target.value)}
      style={{ height: 44, minWidth: 150, borderRadius: 12, border: `1px solid ${colors.borderStrong}`, background: colors.panel, color: value ? colors.foreground : colors.gold, padding: "0 12px", fontFamily: MONO_FONT, fontSize: 14, fontWeight: 500, ...style }}
    />
  );
}

export function TimeInput({ value, onChange, ariaLabel, style, unsetTone }: { value: string; onChange: (value: string) => void; ariaLabel: string; style?: CSSProperties; unsetTone?: boolean }) {
  const colors = useColors();
  return (
    <input
      type="time"
      step={300}
      aria-label={ariaLabel}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      style={{ height: 44, minWidth: 110, borderRadius: 12, border: `1px solid ${colors.borderStrong}`, background: colors.panel, color: value || !unsetTone ? colors.foreground : colors.gold, padding: "0 12px", fontFamily: MONO_FONT, fontSize: 14, fontWeight: 500, ...style }}
    />
  );
}

/** A -/+ stepper with a mono value between. */
export function Stepper({ value, onLess, onMore, lessLabel, moreLabel, lessDisabled, moreDisabled, width = 56 }: { value: string; onLess: () => void; onMore: () => void; lessLabel: string; moreLabel: string; lessDisabled?: boolean; moreDisabled?: boolean; width?: number }) {
  const colors = useColors();
  const button: CSSProperties = { width: 36, height: 44, borderRadius: radius.md, border: `1px solid ${colors.borderStrong}`, background: colors.panel, display: "flex", alignItems: "center", justifyContent: "center" };
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
      <button type="button" aria-label={lessLabel} disabled={lessDisabled} onClick={onLess} style={{ ...button, opacity: lessDisabled ? 0.4 : 1 }}>
        <Icon name="minus" size={18} color={colors.foreground} strokeWidth={2} />
      </button>
      <span style={{ minWidth: width, textAlign: "center", fontFamily: MONO_FONT, fontSize: 14, lineHeight: "19px", fontWeight: 600, color: colors.peri }}>{value}</span>
      <button type="button" aria-label={moreLabel} disabled={moreDisabled} onClick={onMore} style={{ ...button, opacity: moreDisabled ? 0.4 : 1 }}>
        <Icon name="plus" size={18} color={colors.foreground} strokeWidth={2} />
      </button>
    </div>
  );
}

/** A quiet in-place question with two answers ("Delete this? · Delete · Keep"), the app's replacement for alerts. */
export function InlineConfirm({ question, confirmLabel, onConfirm, onCancel, cancelLabel = "Keep" }: { question: string; confirmLabel: string; onConfirm: () => void; onCancel: () => void; cancelLabel?: string }) {
  const colors = useColors();
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
      <span style={{ flex: 1, minWidth: 160, fontSize: 13, lineHeight: "18px", color: colors.foreground }}>{question}</span>
      <button type="button" className="link danger" onClick={onConfirm} style={{ minHeight: 44, padding: "0 8px", fontSize: 15 }}>
        {confirmLabel}
      </button>
      <button type="button" className="link" onClick={onCancel} style={{ minHeight: 44, padding: "0 8px", fontSize: 15 }}>
        {cancelLabel}
      </button>
    </div>
  );
}

/** The seven weekday toggles of a class or a commitment. */
export function DayToggles({ days, onToggle }: { days: readonly string[]; onToggle: (day: "Mon" | "Tue" | "Wed" | "Thu" | "Fri" | "Sat" | "Sun") => void }) {
  const colors = useColors();
  const all = [
    { day: "Mon", letter: "M", name: "Monday" },
    { day: "Tue", letter: "T", name: "Tuesday" },
    { day: "Wed", letter: "W", name: "Wednesday" },
    { day: "Thu", letter: "T", name: "Thursday" },
    { day: "Fri", letter: "F", name: "Friday" },
    { day: "Sat", letter: "S", name: "Saturday" },
    { day: "Sun", letter: "S", name: "Sunday" },
  ] as const;
  return (
    <div style={{ display: "flex", gap: 6 }}>
      {all.map(({ day, letter, name }) => {
        const on = days.includes(day);
        return (
          <button key={day} type="button" role="checkbox" aria-checked={on} aria-label={name} onClick={() => onToggle(day)} style={{ flex: 1, height: 46, borderRadius: radius.md, border: `1px solid ${on ? colors.accent : colors.borderStrong}`, background: on ? alpha(colors.primary, 0.2) : colors.panel, color: on ? colors.foreground : colors.muted, fontSize: 15, fontWeight: 600 }}>
            {letter}
          </button>
        );
      })}
    </div>
  );
}

/** Colour swatches (a class's or a commitment's colour). */
export function Swatches({ options, value, onChange }: { options: readonly string[]; value: string; onChange: (color: string) => void }) {
  const colors = useColors();
  return (
    <div role="radiogroup" style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
      {options.map((swatch, index) => {
        const on = swatch === value;
        return (
          <button key={swatch} type="button" role="radio" aria-checked={on} aria-label={`Colour ${index + 1} of ${options.length}`} onClick={() => onChange(swatch)} style={{ width: 44, height: 44, borderRadius: 13, border: `2px solid ${on ? colors.foreground : "transparent"}`, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <span style={{ width: 32, height: 32, borderRadius: 9, background: swatch, display: "flex", alignItems: "center", justifyContent: "center" }}>{on ? <Icon name="check" size={16} color="#FFFFFF" strokeWidth={2.6} /> : null}</span>
          </button>
        );
      })}
    </div>
  );
}
