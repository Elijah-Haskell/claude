// The brand palette as JavaScript (for tints computed with alpha()) and the appearance switch. The CSS tokens in
// src/styles.css carry the same values; `data-theme` on <html> picks the scheme.

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export type ColorScheme = "dark" | "light";

export interface Palette {
  background: string;
  surface: string;
  panel: string;
  foreground: string;
  muted: string;
  dim: string;
  border: string;
  borderStrong: string;
  primary: string;
  accent: string;
  peri: string;
  gold: string;
  violet: string;
  success: string;
  warning: string;
  error: string;
}

export const PALETTES: Record<ColorScheme, Palette> = {
  dark: {
    background: "#060816",
    surface: "#10163A",
    panel: "#0B0F2A",
    foreground: "#EEF1FF",
    muted: "#9BA5CC",
    dim: "#6E799F",
    border: "#212B4C",
    borderStrong: "#2F3C5E",
    primary: "#4F6EF7",
    accent: "#6B87FF",
    peri: "#8FB3F5",
    gold: "#E5B142",
    violet: "#8B6CF6",
    success: "#4ADE80",
    warning: "#E5B142",
    error: "#F87171",
  },
  light: {
    background: "#F4F6FF",
    surface: "#FFFFFF",
    panel: "#EEF1FB",
    foreground: "#0D1230",
    muted: "#5B6584",
    dim: "#8A93B2",
    border: "#DDE3F5",
    borderStrong: "#C5CEEA",
    primary: "#4F6EF7",
    accent: "#3D5BE6",
    peri: "#4F73C9",
    gold: "#B8861B",
    violet: "#6D4FE0",
    success: "#16A34A",
    warning: "#B8861B",
    error: "#DC2626",
  },
};

export const THEME_STORAGE_KEY = "trajectory_web_theme";

interface ThemeValue {
  scheme: ColorScheme;
  colors: Palette;
  setScheme: (scheme: ColorScheme) => void;
}

const ThemeContext = createContext<ThemeValue | null>(null);

function readSavedScheme(): ColorScheme {
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    if (saved === "light" || saved === "dark") return saved;
  } catch {
    // storage unavailable: dark, the brand's default
  }
  return "dark";
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [scheme, setSchemeState] = useState<ColorScheme>(readSavedScheme);
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", scheme);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", PALETTES[scheme].background);
  }, [scheme]);
  const setScheme = useCallback((next: ColorScheme) => {
    setSchemeState(next);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // a matter of taste, not part of the plan
    }
  }, []);
  const value = useMemo<ThemeValue>(() => ({ scheme, colors: PALETTES[scheme], setScheme }), [scheme, setScheme]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}

/** The palette of the current scheme (the mobile app's useColors()). */
export function useColors(): Palette {
  return useTheme().colors;
}
