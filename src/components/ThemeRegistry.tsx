"use client";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { ThemeProvider, CssBaseline } from "@mui/material";
import { publicTheme, privateTheme } from "@/app/theme";

export type WalletView = "public" | "private";
export type ThemeMode = "light" | "dark";

type ViewContextType = {
  view: WalletView;
  isPrivate: boolean;
  themeMode: ThemeMode;
  isDark: boolean;
  enterPrivate: () => void;
  exitPublic: () => void;
  toggleView: () => void;
  toggleTheme: () => void;
};

const ViewContext = createContext<ViewContextType>({
  view: "public",
  isPrivate: false,
  themeMode: "light",
  isDark: false,
  enterPrivate: () => {},
  exitPublic: () => {},
  toggleView: () => {},
  toggleTheme: () => {},
});

// Keep the hook name so existing consumers don't break.
export const useThemeMode = () => useContext(ViewContext);

// Veil colours by EFFECTIVE theme (not world): exiting into a dark public account
// must ink-dim to dark, never flash light.
const VEIL_DARK = "#0C0D0F";
const VEIL_LIGHT = "#F4F0E6";

const THEME_KEY = "LOCAL_THEME_MODE";

export function ThemeRegistry({ children }: { children: React.ReactNode }) {
  const [view, setView] = useState<WalletView>("public");
  // Your SAVED illumination preference — the public world's look, persisted. It's
  // never overwritten by entering/leaving private (see privateOverride), so a dark
  // lover stays dark across worlds; the private "dims to dark" is a display default.
  const [themeMode, setThemeMode] = useState<ThemeMode>("light");
  // Private-scoped override: null → the world default (dark) shows; set by tapping
  // illumination while private. Never persisted, and cleared on every world cross,
  // so entering the pool always defaults to dark WITHOUT touching your public pref.
  const [privateOverride, setPrivateOverride] = useState<ThemeMode | null>(null);
  const [veil, setVeil] = useState(false);
  const firstRender = useRef(true);

  // Restore the last illumination preference (independent of the world).
  useEffect(() => {
    try {
      const saved = localStorage.getItem(THEME_KEY);
      if (saved === "light" || saved === "dark") setThemeMode(saved);
    } catch {
      /* SSR / storage unavailable */
    }
  }, []);

  const applyTheme = (m: ThemeMode) => {
    setThemeMode(m);
    try {
      localStorage.setItem(THEME_KEY, m);
    } catch {
      /* SSR / storage unavailable */
    }
  };

  // The threshold: on a world change, a veil of the incoming color "ink-dims".
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    const reduced =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduced) return;
    setVeil(true);
    const t = setTimeout(() => setVeil(false), 520);
    return () => clearTimeout(t);
  }, [view]);

  const isPrivate = view === "private";
  // Effective illumination: public follows your saved preference; private defaults
  // to dark (the "descent" effect) unless you overrode it this visit.
  const isDark = isPrivate ? (privateOverride ?? "dark") === "dark" : themeMode === "dark";

  // Crossing a world boundary just clears the private override — it never writes
  // your public preference, so a dark lover stays dark on the way out.
  const enterPrivate = () => {
    setPrivateOverride(null);
    setView("private");
  };
  const exitPublic = () => {
    setPrivateOverride(null);
    setView("public");
  };
  const toggleView = () => (view === "private" ? exitPublic() : enterPrivate());
  // In private the toggle is a scoped override; in public it sets your saved pref.
  const toggleTheme = () =>
    isPrivate
      ? setPrivateOverride(isDark ? "light" : "dark")
      : applyTheme(themeMode === "dark" ? "light" : "dark");

  const theme = isDark ? privateTheme : publicTheme;

  return (
    <ViewContext.Provider
      value={{ view, isPrivate, themeMode, isDark, enterPrivate, exitPublic, toggleView, toggleTheme }}
    >
      <ThemeProvider theme={theme}>
        <CssBaseline />
        <style>{`::placeholder { color: ${isDark ? "#8A9099" : "#6E665A"}; opacity: 0.7; }`}</style>
        {children}
        {/* Threshold veil: covers the world change and fades out. */}
        <div
          key={view}
          aria-hidden
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 2000,
            pointerEvents: "none",
            backgroundColor: isDark ? VEIL_DARK : VEIL_LIGHT,
            opacity: 0,
            animation: veil ? "r1doVeil 520ms ease" : "none",
          }}
        />
      </ThemeProvider>
    </ViewContext.Provider>
  );
}
