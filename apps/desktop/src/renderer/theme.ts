import { createContext } from "react";

/**
 * The app's themes. Dark is the default; Midnight is Daedalus's original
 * navy, from before the flat layout. Midnight is a dark theme, so everything
 * that only asks "dark or light" gets "dark" for it.
 */
export type AppTheme = "dark" | "light" | "midnight";

export const APP_THEMES: ReadonlyArray<{ value: AppTheme; label: string }> = [
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
  { value: "midnight", label: "Midnight" },
];

export const isAppTheme = (value: unknown): value is AppTheme =>
  value === "dark" || value === "light" || value === "midnight";

export const appearanceOf = (theme: AppTheme): "dark" | "light" =>
  theme === "light" ? "light" : "dark";

/** xterm's colours, matched to the center so the terminal has no frame. */
export const terminalThemeFor = (theme: AppTheme) =>
  theme === "midnight"
    ? {
        background: "#11151d",
        foreground: "#dce5f2",
        cursor: "#8ed6c3",
        selectionBackground: "#38546b",
      }
    : {
        background: "#111112",
        foreground: "#e4e4e7",
        cursor: "#8ed6c3",
        selectionBackground: "#38546b",
      };

/** The theme, for components deep in the tree such as the terminal. */
export const AppThemeContext = createContext<AppTheme>("dark");
