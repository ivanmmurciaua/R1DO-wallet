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

const VEIL_BG: Record<WalletView, string> = {
  public: "#F4F0E6",
  private: "#0C0D0F",
};

const THEME_KEY = "LOCAL_THEME_MODE";

export function ThemeRegistry({ children }: { children: React.ReactNode }) {
  const [view, setView] = useState<WalletView>("public");
  // Illumination is its own axis now. Each world sets a DEFAULT on entry
  // (public → light, private → dark, so crossing into Railgun still "dims"),
  // but the light/dark button overrides it freely — you can be private-in-light.
  const [themeMode, setThemeMode] = useState<ThemeMode>("light");
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

  // Entering a world applies its default illumination; leaving it restores light.
  const enterPrivate = () => {
    setView("private");
    applyTheme("dark");
  };
  const exitPublic = () => {
    setView("public");
    applyTheme("light");
  };
  const toggleView = () => (view === "private" ? exitPublic() : enterPrivate());
  const toggleTheme = () => applyTheme(themeMode === "dark" ? "light" : "dark");

  const isPrivate = view === "private";
  const isDark = themeMode === "dark";
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
            backgroundColor: VEIL_BG[view],
            opacity: 0,
            animation: veil ? "r1doVeil 520ms ease" : "none",
          }}
        />
      </ThemeProvider>
    </ViewContext.Provider>
  );
}
