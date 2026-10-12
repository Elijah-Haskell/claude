import { describe, expect, it } from "vitest";
import { BLACK, contrastRatio, darken, legibleOn, lighten, MIN_TEXT_CONTRAST, parseHexColor, readableOn, WHITE } from "../../src/engine/contrast";
import { BLOCK_COLORS, COURSE_COLORS } from "../../src/engine/types";

// The Week tab, block sheet and plan banner all put text on arbitrary course colours: it has to stay legible.
describe("contrast helpers", () => {
  it("parses hex colours and rejects everything else", () => {
    expect(parseHexColor("#4F6EF7")).toEqual({ r: 79, g: 110, b: 247 });
    expect(parseHexColor("#fff")).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseHexColor("#11223380")).toEqual({ r: 17, g: 34, b: 51 });
    expect(parseHexColor("rgb(1,2,3)")).toBeNull();
    expect(parseHexColor("blue")).toBeNull();
  });

  it("computes WCAG ratios (black on white is 21:1; the audit's failing pairs really fail)", () => {
    expect(contrastRatio(BLACK, WHITE)).toBeCloseTo(21, 5);
    expect(contrastRatio(WHITE, WHITE)).toBeCloseTo(1, 5);
    expect(contrastRatio(WHITE, "#22C55E")).toBeLessThan(2.4); // audit: 2.28
    expect(contrastRatio(WHITE, "#F59E0B")).toBeLessThan(2.3); // audit: 2.15
    expect(contrastRatio(WHITE, "#4F6EF7")).toBeCloseTo(4.28, 1); // audit: 4.28
    expect(contrastRatio("nope", WHITE)).toBe(1);
  });

  it("darkens toward black", () => {
    expect(darken("#FFFFFF", 0.5)).toBe("#808080");
    expect(darken("#4F6EF7", 0)).toBe("#4F6EF7");
    expect(darken("#4F6EF7", 1)).toBe("#000000");
  });

  it("keeps white text on dark colours and switches to black on light ones", () => {
    expect(readableOn("#1E293B")).toMatchObject({ background: "#1E293B", text: WHITE });
    expect(readableOn("#F59E0B").text).toBe(BLACK); // amber
    expect(readableOn("#84CC16").text).toBe(BLACK); // lime
    expect(readableOn("#22C55E").text).toBe(BLACK); // success green
  });

  it("nudges a just-too-light brand colour darker instead of abandoning white text", () => {
    const indigo = readableOn("#4F6EF7"); // white is 4.28:1 as-is
    expect(indigo.text).toBe(WHITE);
    expect(indigo.background).not.toBe("#4F6EF7");
    expect(contrastRatio(indigo.text, indigo.background)).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
    expect(indigo.ratio).toBeCloseTo(contrastRatio(indigo.text, indigo.background), 5);
  });

  it("meets 4.5:1 for every course, block and theme colour", () => {
    const palette = [
      ...COURSE_COLORS,
      ...Object.values(BLOCK_COLORS),
      "#475569", "#EF4444", "#F87171", "#4ADE80", "#FBBF24", "#6B87FF", "#0F1117", "#F8F9FF",
    ];
    for (const color of palette) {
      const { background, text } = readableOn(color);
      expect(contrastRatio(text, background), `${color} -> ${text} on ${background}`).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
    }
  });

  it("meets 4.5:1 for any colour at all (coarse sweep of the whole RGB cube)", () => {
    const steps = [0, 32, 64, 96, 128, 160, 192, 224, 255];
    let worst = Infinity;
    for (const r of steps) for (const g of steps) for (const b of steps) {
      const hex = `#${[r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
      const { background, text } = readableOn(hex);
      worst = Math.min(worst, contrastRatio(text, background));
    }
    expect(worst).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
  });

  it("falls back to white text for colours it cannot parse", () => {
    expect(readableOn("papayawhip")).toEqual({ background: "papayawhip", text: WHITE, ratio: 1 });
  });
});

// Class codes and small labels are drawn IN the course colour on the navy (or light) surface.
describe("legibleOn: a course colour as text", () => {
  const NAVY = "#10163A";
  const PAPER = "#FFFFFF";

  it("lightens toward white", () => {
    expect(lighten("#000000", 0.5)).toBe("#808080");
    expect(lighten("#4F6EF7", 0)).toBe("#4F6EF7");
    expect(lighten("#4F6EF7", 1)).toBe(WHITE);
    expect(lighten("nope", 0.5)).toBe("nope");
  });

  it("keeps a colour that already reads well", () => {
    expect(legibleOn("#8FB3F5", NAVY)).toBe("#8FB3F5");
    expect(legibleOn("#1F3AB8", PAPER)).toBe("#1F3AB8");
  });

  it("every course colour reads at 4.5:1 on the navy surface and on white, and keeps its hue", () => {
    for (const color of [...COURSE_COLORS, ...Object.values(BLOCK_COLORS)]) {
      for (const background of [NAVY, "#0A0E24", PAPER, "#F4F6FF"]) {
        const text = legibleOn(color, background);
        expect(contrastRatio(text, background)).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
      }
    }
    // Lightened, not replaced: the brand blue stays more blue than red on navy.
    const blue = parseHexColor(legibleOn("#4F6EF7", NAVY))!;
    expect(blue.b).toBeGreaterThan(blue.r);
  });

  it("returns what it was given when a colour cannot be parsed", () => {
    expect(legibleOn("papayawhip", NAVY)).toBe("papayawhip");
    expect(legibleOn("#4F6EF7", "navy")).toBe("#4F6EF7");
  });
});
