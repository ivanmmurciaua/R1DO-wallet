"use client";
import { createContext, useContext, useState } from "react";
import { ThemeProvider, CssBaseline } from "@mui/material";
import { lightTheme, darkTheme } from "@/app/theme";

type ThemeModeContextType = {
  isDark: boolean;
  toggleTheme: () => void;
};

const ThemeModeContext = createContext<ThemeModeContextType>({
  isDark: false,
  toggleTheme: () => {},
});

export const useThemeMode = () => useContext(ThemeModeContext);

export function ThemeRegistry({ children }: { children: React.ReactNode }) {
  const [isDark, setIsDark] = useState(false);

  const toggleTheme = () => setIsDark((prev) => !prev);

  return (
    <ThemeModeContext.Provider value={{ isDark, toggleTheme }}>
      <ThemeProvider theme={isDark ? darkTheme : lightTheme}>
        <CssBaseline />
        <style>{`::placeholder { color: ${isDark ? "#4a8f5c" : "#2d6a3f"}; opacity: 0.8; }`}</style>
        {children}
      </ThemeProvider>
    </ThemeModeContext.Provider>
  );
}
