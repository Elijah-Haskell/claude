// WCAG contrast helpers: pick a text colour that stays readable on any block / button colour.
// Pure (no React Native imports) so it can be unit-tested and shared by the Week tab, the block sheet
// and the plan alert banner.

export const WHITE = "#FFFFFF";
export const BLACK = "#000000";
/** WCAG AA for normal-size text. */
export const MIN_TEXT_CONTRAST = 4.5;

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** "#RGB", "#RRGGBB" or "#RRGGBBAA" (alpha ignored) -> 0..255 channels; null when it is not a hex colour. */
export function parseHexColor(input: string): Rgb | null {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(input.trim());
  if (!match) return null;
  let hex = match[1]!;
  if (hex.length === 3) hex = hex.split("").map((c) => c + c).join("");
  return {
    r: parseInt(hex.slice(0, 2), 16),
    g: parseInt(hex.slice(2, 4), 16),
    b: parseInt(hex.slice(4, 6), 16),
  };
}

function toHex(rgb: Rgb): string {
  const part = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  return `#${part(rgb.r)}${part(rgb.g)}${part(rgb.b)}`.toUpperCase();
}

/** WCAG relative luminance (0 = black, 1 = white). */
export function relativeLuminance(rgb: Rgb): number {
  const channel = (value: number) => {
    const s = value / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b);
}

/** WCAG contrast ratio (1..21) between two hex colours; 1 when either cannot be parsed. */
export function contrastRatio(first: string, second: string): number {
  const a = parseHexColor(first);
  const b = parseHexColor(second);
  if (!a || !b) return 1;
  const l1 = relativeLuminance(a);
  const l2 = relativeLuminance(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

/** Mix a hex colour toward black by `amount` (0 = unchanged, 1 = black). */
export function darken(hex: string, amount: number): string {
  const rgb = parseHexColor(hex);
  if (!rgb) return hex;
  const keep = 1 - Math.max(0, Math.min(1, amount));
  return toHex({ r: rgb.r * keep, g: rgb.g * keep, b: rgb.b * keep });
}

export interface ReadableColors {
  /** The background to paint: the original colour, or a slightly darker shade of it when white text needs the help. */
  background: string;
  /** WHITE or BLACK, whichever reads at >= 4.5:1 on `background`. */
  text: string;
  /** Contrast ratio of `text` on `background`. */
  ratio: number;
}

/**
 * Text colour for a filled surface. Prefers white text on the course colour as-is; if that fails AA it
 * darkens the surface a little (keeps the hue recognisable); if even that is not enough (light colours such
 * as amber or lime) it switches to black text. The result always meets 4.5:1 for parseable colours.
 */
export function readableOn(background: string): ReadableColors {
  if (!parseHexColor(background)) return { background, text: WHITE, ratio: 1 };
  const asIs = contrastRatio(WHITE, background);
  if (asIs >= MIN_TEXT_CONTRAST) return { background, text: WHITE, ratio: asIs };
  for (let step = 1; step <= 5; step += 1) {
    const shade = darken(background, step * 0.05);
    const ratio = contrastRatio(WHITE, shade);
    if (ratio >= MIN_TEXT_CONTRAST) return { background: shade, text: WHITE, ratio };
  }
  const black = contrastRatio(BLACK, background);
  return { background, text: BLACK, ratio: black };
}

/** Mix a hex colour toward white by `amount` (0 = unchanged, 1 = white). */
export function lighten(hex: string, amount: number): string {
  const rgb = parseHexColor(hex);
  if (!rgb) return hex;
  const t = Math.max(0, Math.min(1, amount));
  return toHex({ r: rgb.r + (255 - rgb.r) * t, g: rgb.g + (255 - rgb.g) * t, b: rgb.b + (255 - rgb.b) * t });
}

/**
 * A colour used as TEXT (a class code, a small label) on `background`: the colour itself when it already reads at
 * `minRatio`, otherwise mixed toward white on a dark background or toward black on a light one, in small steps, until
 * it does. The hue stays recognisable; a colour that cannot be parsed is returned unchanged.
 */
export function legibleOn(color: string, background: string, minRatio: number = MIN_TEXT_CONTRAST): string {
  const fg = parseHexColor(color);
  const bg = parseHexColor(background);
  if (!fg || !bg) return color;
  if (contrastRatio(color, background) >= minRatio) return toHex(fg);
  const towardWhite = relativeLuminance(bg) < 0.4;
  for (let step = 1; step <= 20; step += 1) {
    const shade = towardWhite ? lighten(color, step * 0.05) : darken(color, step * 0.05);
    if (contrastRatio(shade, background) >= minRatio) return shade;
  }
  return towardWhite ? WHITE : BLACK;
}
