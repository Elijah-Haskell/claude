// Design tokens shared by every screen — the app-side copy of the trajectoryapp.org look.
// Colours that depend on light/dark come from useColors(); what lives here is fixed brand colour,
// radii, block-kind tints and small helpers. Pure module (no React) so it is unit-testable.

/** Fixed brand colours (identical in both schemes). */
export const brand = {
  blue: "#4F6EF7",
  blue2: "#6B87FF",
  peri: "#8FB3F5",
  gold: "#E5B142",
  violet: "#8B6CF6",
  green: "#4ADE80",
  red: "#F87171",
  ink: "#060816",
  night: "#0A0E24",
  deep: "#10163A",
  panel: "#0D1230",
  white: "#FFFFFF",
} as const;

export const radius = {
  xs: 8,
  sm: 10,
  md: 12,
  lg: 16,
  xl: 22,
  pill: 999,
} as const;

export const space = {
  screen: 18,
  card: 16,
  gap: 12,
} as const;

/** "#RRGGBB" + 0..1 -> "rgba(r,g,b,a)". Non-hex input is returned unchanged. */
export function alpha(hex: string, a: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1]!, 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r},${g},${b},${Math.max(0, Math.min(1, a))})`;
}

/** The website's "primary" CTA gradient (left -> right). */
export const primaryGradient = [brand.blue, brand.blue2] as const;
/** AI surfaces. */
export const violetGradient = ["#7B5CF0", brand.violet] as const;

export type BlockKind = "class" | "study" | "task" | "exam" | "recurring" | "personal" | "gcal";

export interface KindTint {
  background: string;
  border: string;
  text: string;
  dashed?: boolean;
}

/** Block tints from the website's week grid (.k-class, .k-study, .k-task, .k-exam, .k-job). Dark scheme. */
export const kindTintsDark: Record<BlockKind, KindTint> = {
  class: { background: "rgba(79,110,247,0.26)", border: "rgba(107,135,255,0.7)", text: "#DCE4FF" },
  study: { background: "rgba(143,179,245,0.18)", border: "rgba(143,179,245,0.6)", text: "#D8E6FF" },
  task: { background: "rgba(139,108,246,0.24)", border: "rgba(139,108,246,0.65)", text: "#E4DCFF" },
  exam: { background: "rgba(229,177,66,0.2)", border: "rgba(229,177,66,0.85)", text: "#FFE7A8" },
  recurring: { background: "rgba(155,165,204,0.13)", border: "rgba(155,165,204,0.35)", text: "#9BA5CC", dashed: true },
  personal: { background: "rgba(74,222,128,0.14)", border: "rgba(74,222,128,0.5)", text: "#C9F5D9" },
  gcal: { background: "rgba(155,165,204,0.18)", border: "rgba(155,165,204,0.45)", text: "#C7CEE6" },
};

/** Same kinds on a light background. */
export const kindTintsLight: Record<BlockKind, KindTint> = {
  class: { background: "rgba(79,110,247,0.14)", border: "rgba(79,110,247,0.55)", text: "#1F3AB8" },
  study: { background: "rgba(79,115,201,0.14)", border: "rgba(79,115,201,0.5)", text: "#1E3F86" },
  task: { background: "rgba(109,79,224,0.14)", border: "rgba(109,79,224,0.5)", text: "#3F2A9E" },
  exam: { background: "rgba(184,134,27,0.16)", border: "rgba(184,134,27,0.7)", text: "#6E4E08" },
  recurring: { background: "rgba(91,101,132,0.10)", border: "rgba(91,101,132,0.35)", text: "#4A5470", dashed: true },
  personal: { background: "rgba(22,163,74,0.12)", border: "rgba(22,163,74,0.45)", text: "#166534" },
  gcal: { background: "rgba(91,101,132,0.14)", border: "rgba(91,101,132,0.4)", text: "#3C4560" },
};

export function kindTints(scheme: "light" | "dark"): Record<BlockKind, KindTint> {
  return scheme === "dark" ? kindTintsDark : kindTintsLight;
}

/** Soft glow used on the "now" block and focused cards (iOS shadow + Android elevation). */
export function glow(color: string, strength = 0.45) {
  return {
    shadowColor: color,
    shadowOpacity: strength,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 6 },
    elevation: 6,
  } as const;
}
