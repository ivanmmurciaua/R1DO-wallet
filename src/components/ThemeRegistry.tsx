"use client";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { ThemeProvider, CssBaseline } from "@mui/material";
import { publicTheme, privateTheme } from "@/app/theme";

export type WalletView = "public" | "private";

type ViewContextType = {
  view: WalletView;
  isPrivate: boolean;
  enterPrivate: () => void;
  exitPublic: () => void;
  toggleView: () => void;
};

const ViewContext = createContext<ViewContextType>({
  view: "public",
  isPrivate: false,
  enterPrivate: () => {},
  exitPublic: () => {},
  toggleView: () => {},
});

// Keep the hook name so existing consumers don't break.
export const useThemeMode = () => useContext(ViewContext);

const VEIL_BG: Record<WalletView, string> = {
  public: "#F4F0E6",
  private: "#0C0D0F",
};

export function ThemeRegistry({ children }: { children: React.ReactNode }) {
  const [view, setView] = useState<WalletView>("public");
  const [veil, setVeil] = useState(false);
  const firstRender = useRef(true);

  // Allowed cleanup: dark/light is gone, so we wipe its leftover key.
  useEffect(() => {
    try {
      localStorage.removeItem("LOCAL_THEME_MODE");
    } catch {
      /* SSR / storage unavailable */
    }
  }, []);

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

  const enterPrivate = () => setView("private");
  const exitPublic = () => setView("public");
  const toggleView = () =>
    setView((v) => (v === "private" ? "public" : "private"));

  const isPrivate = view === "private";
  const theme = isPrivate ? privateTheme : publicTheme;

  return (
    <ViewContext.Provider value={{ view, isPrivate, enterPrivate, exitPublic, toggleView }}>
      <ThemeProvider theme={theme}>
        <CssBaseline />
        <style>{`::placeholder { color: ${isPrivate ? "#8A9099" : "#6E665A"}; opacity: 0.7; }`}</style>
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
