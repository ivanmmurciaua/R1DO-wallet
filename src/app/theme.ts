"use client";
import { createTheme } from "@mui/material/styles";

const baseTypography = {
  fontFamily: "var(--font-geist-mono), monospace",
  h4: {
    fontWeight: 700,
    letterSpacing: "0.04em",
    textTransform: "uppercase" as const,
  },
  h6: { fontWeight: 700, letterSpacing: "0.04em" },
  button: { letterSpacing: "0.08em" },
};

const baseShape = { borderRadius: 2 };

const baseComponents = {
  MuiButton: {
    styleOverrides: {
      root: {
        textTransform: "uppercase" as const,
        fontFamily: "var(--font-geist-mono), monospace",
        fontWeight: 700,
        letterSpacing: "0.1em",
        borderRadius: 2,
        paddingTop: 10,
        paddingBottom: 10,
        transition: "all 0.15s ease",
      },
    },
  },
  MuiListItem: { styleOverrides: { root: { borderRadius: 0 } } },
  MuiIconButton: {
    styleOverrides: { root: { borderRadius: 2 } },
  },
};

export const lightTheme = createTheme({
  palette: {
    mode: "light",
    primary: {
      main: "#15803d",
      light: "#16a34a",
      dark: "#166534",
      contrastText: "#ffffff",
    },
    secondary: { main: "#15803d", contrastText: "#ffffff" },
    info: { main: "#15803d", contrastText: "#ffffff" },
    background: { default: "#f0f7f2", paper: "#ffffff" },
    text: { primary: "#0a2e14", secondary: "#2d6a3f" },
    divider: "rgba(21,128,61,0.15)",
    error: { main: "#dc2626" },
    success: { main: "#15803d" },
  },
  typography: {
    ...baseTypography,
    body2: { color: "#2d6a3f", fontFamily: "var(--font-geist-mono), monospace" },
  },
  shape: baseShape,
  components: {
    ...baseComponents,
    MuiCssBaseline: {
      styleOverrides: { body: { backgroundColor: "#f0f7f2" } },
    },
    MuiButton: {
      styleOverrides: {
        ...baseComponents.MuiButton.styleOverrides,
        containedPrimary: {
          backgroundColor: "#15803d",
          color: "#ffffff",
          boxShadow: "0 0 10px rgba(21,128,61,0.2)",
          "&:hover": {
            backgroundColor: "#166534",
            boxShadow: "0 0 16px rgba(21,128,61,0.35)",
          },
        },
        containedSecondary: {
          backgroundColor: "transparent",
          color: "#15803d",
          border: "1px solid rgba(21,128,61,0.4)",
          boxShadow: "none",
          "&:hover": {
            backgroundColor: "rgba(21,128,61,0.07)",
            border: "1px solid #15803d",
          },
        },
        containedInfo: {
          backgroundColor: "#15803d",
          color: "#ffffff",
          "&:hover": { backgroundColor: "#166534" },
        },
        outlinedPrimary: {
          borderColor: "rgba(21,128,61,0.4)",
          color: "#15803d",
          "&:hover": {
            borderColor: "#15803d",
            backgroundColor: "rgba(21,128,61,0.06)",
          },
        },
        text: {
          color: "#2d6a3f",
          fontFamily: "var(--font-geist-mono), monospace",
          "&:hover": {
            color: "#15803d",
            backgroundColor: "rgba(21,128,61,0.05)",
          },
        },
      },
    },
    MuiPaper: {
      styleOverrides: {
        root: {
          backgroundImage: "none",
          backgroundColor: "#ffffff",
          border: "1px solid rgba(21,128,61,0.15)",
        },
      },
    },
    MuiCircularProgress: { styleOverrides: { root: { color: "#15803d" } } },
    MuiAlert: {
      styleOverrides: {
        filledSuccess: {
          backgroundColor: "#dcfce7",
          color: "#166534",
          border: "1px solid rgba(21,128,61,0.3)",
        },
      },
    },
    MuiIconButton: {
      styleOverrides: {
        root: {
          borderRadius: 2,
          color: "#2d6a3f",
          "&:hover": {
            color: "#15803d",
            backgroundColor: "rgba(21,128,61,0.07)",
          },
        },
      },
    },
    MuiPopover: {
      styleOverrides: {
        paper: {
          border: "1px solid rgba(21,128,61,0.25)",
          boxShadow: "0 4px 20px rgba(21,128,61,0.1)",
        },
      },
    },
  },
});

export const darkTheme = createTheme({
  palette: {
    mode: "dark",
    primary: {
      main: "#00e54d",
      light: "#00ff5e",
      dark: "#00b33d",
      contrastText: "#000000",
    },
    secondary: { main: "#00e54d", contrastText: "#000000" },
    info: { main: "#00e54d", contrastText: "#000000" },
    background: { default: "#000000", paper: "#050505" },
    text: { primary: "#ccffcc", secondary: "#4a8f5c" },
    divider: "rgba(0,229,77,0.15)",
    error: { main: "#ff4444" },
    success: { main: "#00e54d" },
  },
  typography: {
    ...baseTypography,
    body2: { color: "#4a8f5c", fontFamily: "var(--font-geist-mono), monospace" },
  },
  shape: baseShape,
  components: {
    ...baseComponents,
    MuiCssBaseline: {
      styleOverrides: { body: { backgroundColor: "#000000" } },
    },
    MuiButton: {
      styleOverrides: {
        ...baseComponents.MuiButton.styleOverrides,
        containedPrimary: {
          backgroundColor: "#00e54d",
          color: "#000000",
          boxShadow: "0 0 12px rgba(0,229,77,0.3)",
          "&:hover": {
            backgroundColor: "#00ff5e",
            boxShadow: "0 0 20px rgba(0,229,77,0.6)",
          },
        },
        containedSecondary: {
          backgroundColor: "transparent",
          color: "#00e54d",
          border: "1px solid rgba(0,229,77,0.4)",
          boxShadow: "none",
          "&:hover": {
            backgroundColor: "rgba(0,229,77,0.07)",
            border: "1px solid #00e54d",
          },
        },
        containedInfo: {
          backgroundColor: "#00e54d",
          color: "#000000",
          boxShadow: "0 0 12px rgba(0,229,77,0.3)",
          "&:hover": {
            backgroundColor: "#00ff5e",
            boxShadow: "0 0 20px rgba(0,229,77,0.6)",
          },
        },
        outlinedPrimary: {
          borderColor: "rgba(0,229,77,0.5)",
          color: "#00e54d",
          "&:hover": {
            borderColor: "#00e54d",
            backgroundColor: "rgba(0,229,77,0.07)",
            boxShadow: "0 0 12px rgba(0,229,77,0.2)",
          },
        },
        text: {
          color: "#4a8f5c",
          fontFamily: "var(--font-geist-mono), monospace",
          "&:hover": {
            color: "#00e54d",
            backgroundColor: "rgba(0,229,77,0.05)",
          },
        },
      },
    },
    MuiPaper: {
      styleOverrides: {
        root: {
          backgroundImage: "none",
          backgroundColor: "#050505",
          border: "1px solid rgba(0,229,77,0.15)",
        },
      },
    },
    MuiCircularProgress: { styleOverrides: { root: { color: "#00e54d" } } },
    MuiAlert: {
      styleOverrides: {
        filledSuccess: {
          backgroundColor: "#001a0d",
          color: "#00e54d",
          border: "1px solid rgba(0,229,77,0.3)",
        },
      },
    },
    MuiIconButton: {
      styleOverrides: {
        root: {
          borderRadius: 2,
          color: "#4a8f5c",
          "&:hover": {
            color: "#00e54d",
            backgroundColor: "rgba(0,229,77,0.07)",
          },
        },
      },
    },
    MuiPopover: {
      styleOverrides: {
        paper: {
          border: "1px solid rgba(0,229,77,0.3)",
          boxShadow: "0 0 20px rgba(0,229,77,0.1)",
        },
      },
    },
  },
});
