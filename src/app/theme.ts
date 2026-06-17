"use client";
import { createTheme } from "@mui/material/styles";

/* ════════════════════════════════════════════════════════════════════
   TWO WORLDS, ONE TOGGLE — no dark/light; the theme is decided by `view`.

   · publicTheme  — 和 (washi): Japanese, light, serene, warm paper + sumi
                    ink + indigo accent. Headings in Mincho serif.
   · privateTheme — 影 (kage): ninja, dark, stealthy, near-black + cold
                    low-saturation steel. Mono (terminal) everywhere.

   Designed INDEPENDENTLY (not one as an inversion of the other).
   ════════════════════════════════════════════════════════════════════ */

const SANS = "var(--font-geist-sans), system-ui, sans-serif";
const MONO = "var(--font-geist-mono), ui-monospace, monospace";
const MINCHO = "var(--font-mincho), serif";

/* ─────────────────────────── 和 · PUBLIC ──────────────────────────── */

const WASHI = {
  bg: "#F4F0E6", // washi paper
  paper: "#FCFAF3", // surface
  sumi: "#23211C", // ink
  muted: "#6E665A",
  ai: "#2E4F6B", // 藍 indigo (accent)
  aiDark: "#233E55",
  matcha: "#6E8B5B", // 抹茶 (positive)
  shu: "#B5502B", // 朱 vermilion (error/danger)
  hairline: "rgba(35,33,28,0.12)",
};

export const publicTheme = createTheme({
  palette: {
    mode: "light",
    primary: { main: WASHI.ai, light: "#3A5E7C", dark: WASHI.aiDark, contrastText: "#FCFAF3" },
    secondary: { main: WASHI.ai, contrastText: "#FCFAF3" },
    info: { main: WASHI.ai, contrastText: "#FCFAF3" },
    background: { default: WASHI.bg, paper: WASHI.paper },
    text: { primary: WASHI.sumi, secondary: WASHI.muted },
    divider: WASHI.hairline,
    error: { main: WASHI.shu },
    success: { main: WASHI.matcha },
  },
  typography: {
    fontFamily: SANS,
    h2: { fontFamily: MINCHO, fontWeight: 500, letterSpacing: "0.01em" },
    h4: { fontFamily: MINCHO, fontWeight: 500, letterSpacing: "0.01em" },
    h6: { fontFamily: MINCHO, fontWeight: 500, letterSpacing: "0.02em" },
    body2: { color: WASHI.muted, fontFamily: SANS },
    button: { letterSpacing: "0.03em" },
  },
  shape: { borderRadius: 10 },
  components: {
    MuiCssBaseline: {
      styleOverrides: {
        body: { backgroundColor: WASHI.bg, color: WASHI.sumi, fontFamily: SANS },
      },
    },
    MuiButton: {
      styleOverrides: {
        root: {
          textTransform: "none" as const,
          fontFamily: SANS,
          fontWeight: 600,
          letterSpacing: "0.02em",
          borderRadius: 10,
          paddingTop: 10,
          paddingBottom: 10,
          transition: "all 0.2s ease",
        },
        containedPrimary: {
          backgroundColor: WASHI.ai,
          color: "#FCFAF3",
          boxShadow: "none",
          "&:hover": { backgroundColor: WASHI.aiDark, boxShadow: "0 4px 14px rgba(46,79,107,0.22)" },
        },
        containedSecondary: {
          backgroundColor: "transparent",
          color: WASHI.ai,
          border: `1px solid ${WASHI.hairline}`,
          boxShadow: "none",
          "&:hover": { backgroundColor: "rgba(46,79,107,0.06)", border: `1px solid ${WASHI.ai}` },
        },
        outlinedPrimary: {
          borderColor: WASHI.hairline,
          color: WASHI.ai,
          "&:hover": { borderColor: WASHI.ai, backgroundColor: "rgba(46,79,107,0.05)" },
        },
        text: {
          color: WASHI.muted,
          fontFamily: SANS,
          "&:hover": { color: WASHI.ai, backgroundColor: "rgba(46,79,107,0.05)" },
        },
      },
    },
    MuiPaper: {
      styleOverrides: {
        root: {
          backgroundImage: "none",
          backgroundColor: WASHI.paper,
          border: `1px solid ${WASHI.hairline}`,
        },
      },
    },
    MuiListItem: { styleOverrides: { root: { borderRadius: 8 } } },
    MuiCircularProgress: { styleOverrides: { root: { color: WASHI.ai } } },
    MuiAlert: {
      styleOverrides: {
        filledSuccess: { backgroundColor: "#E7EFDF", color: "#3F5630", border: `1px solid rgba(110,139,91,0.4)` },
      },
    },
    MuiIconButton: {
      styleOverrides: {
        root: {
          borderRadius: 8,
          color: WASHI.muted,
          "&:hover": { color: WASHI.ai, backgroundColor: "rgba(46,79,107,0.06)" },
        },
      },
    },
    MuiPopover: {
      styleOverrides: {
        paper: { border: `1px solid ${WASHI.hairline}`, boxShadow: "0 6px 24px rgba(35,33,28,0.1)" },
      },
    },
  },
});

/* ─────────────────────────── 影 · PRIVATE ─────────────────────────── */

const KAGE = {
  bg: "#0C0D0F", // night sumi
  paper: "#15171A", // surface
  raised: "#1C1F23",
  text: "#E6E8EA",
  muted: "#8A9099",
  steel: "#5B8DB8", // cold steel (accent, low saturation)
  steelHi: "#74A6D0",
  teal: "#4C9A8F", // muted positive
  ember: "#C75B4A", // contained value/danger
  hairline: "rgba(255,255,255,0.08)",
};

export const privateTheme = createTheme({
  palette: {
    mode: "dark",
    primary: { main: KAGE.steel, light: KAGE.steelHi, dark: "#477191", contrastText: "#0C0D0F" },
    secondary: { main: KAGE.steel, contrastText: "#0C0D0F" },
    info: { main: KAGE.steel, contrastText: "#0C0D0F" },
    background: { default: KAGE.bg, paper: KAGE.paper },
    text: { primary: KAGE.text, secondary: KAGE.muted },
    divider: KAGE.hairline,
    error: { main: KAGE.ember },
    success: { main: KAGE.teal },
  },
  typography: {
    fontFamily: MONO,
    h2: { fontFamily: MONO, fontWeight: 700, letterSpacing: "0.04em" },
    h4: { fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase" as const },
    h6: { fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase" as const },
    body2: { color: KAGE.muted, fontFamily: MONO },
    button: { letterSpacing: "0.1em" },
  },
  shape: { borderRadius: 2 },
  components: {
    MuiCssBaseline: {
      styleOverrides: {
        body: { backgroundColor: KAGE.bg, color: KAGE.text, fontFamily: MONO },
      },
    },
    MuiButton: {
      styleOverrides: {
        root: {
          textTransform: "uppercase" as const,
          fontFamily: MONO,
          fontWeight: 700,
          letterSpacing: "0.1em",
          borderRadius: 2,
          paddingTop: 10,
          paddingBottom: 10,
          transition: "all 0.15s ease",
        },
        containedPrimary: {
          backgroundColor: KAGE.steel,
          color: "#0C0D0F",
          boxShadow: "0 0 10px rgba(91,141,184,0.18)",
          "&:hover": { backgroundColor: KAGE.steelHi, boxShadow: "0 0 18px rgba(91,141,184,0.35)" },
        },
        containedSecondary: {
          backgroundColor: "transparent",
          color: KAGE.steel,
          border: `1px solid ${KAGE.hairline}`,
          boxShadow: "none",
          "&:hover": { backgroundColor: "rgba(91,141,184,0.07)", border: `1px solid ${KAGE.steel}` },
        },
        outlinedPrimary: {
          borderColor: "rgba(91,141,184,0.4)",
          color: KAGE.steel,
          "&:hover": { borderColor: KAGE.steel, backgroundColor: "rgba(91,141,184,0.07)" },
        },
        text: {
          color: KAGE.muted,
          fontFamily: MONO,
          "&:hover": { color: KAGE.steel, backgroundColor: "rgba(91,141,184,0.05)" },
        },
      },
    },
    MuiPaper: {
      styleOverrides: {
        root: {
          backgroundImage: "none",
          backgroundColor: KAGE.paper,
          border: `1px solid ${KAGE.hairline}`,
        },
      },
    },
    MuiListItem: { styleOverrides: { root: { borderRadius: 0 } } },
    MuiCircularProgress: { styleOverrides: { root: { color: KAGE.steel } } },
    MuiAlert: {
      styleOverrides: {
        filledSuccess: { backgroundColor: "#0E1A19", color: KAGE.teal, border: `1px solid rgba(76,154,143,0.35)` },
      },
    },
    MuiIconButton: {
      styleOverrides: {
        root: {
          borderRadius: 2,
          color: KAGE.muted,
          "&:hover": { color: KAGE.steel, backgroundColor: "rgba(91,141,184,0.07)" },
        },
      },
    },
    MuiPopover: {
      styleOverrides: {
        paper: { border: `1px solid ${KAGE.hairline}`, boxShadow: "0 0 24px rgba(0,0,0,0.5)" },
      },
    },
  },
});
