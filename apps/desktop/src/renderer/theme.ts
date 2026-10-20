/** The app's themes. */
export type AppTheme = "dark" | "light";

export const APP_THEMES: ReadonlyArray<{ value: AppTheme; label: string }> = [
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
];

export const isAppTheme = (value: unknown): value is AppTheme =>
  value === "dark" || value === "light";

/** xterm's colours, matched to the center so the terminal has no frame. */
export const TERMINAL_THEME = {
  background: "#111112",
  foreground: "#e4e4e7",
  cursor: "#8ed6c3",
  selectionBackground: "#38546b",
};
