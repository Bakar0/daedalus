/**
 * The phone's theme, as the Mac's: Dark (the default), Light, or Midnight,
 * the original navy. The Mac's choice lives on the Mac, so the phone keeps
 * its own, in this browser's storage.
 */
export type PhoneTheme = "dark" | "light" | "midnight";

export const PHONE_THEMES: ReadonlyArray<{ value: PhoneTheme; label: string }> =
  [
    { value: "dark", label: "Dark" },
    { value: "light", label: "Light" },
    { value: "midnight", label: "Midnight" },
  ];

const KEY = "daedalus.phone.theme";

/** The top bar's colour, for the browser's own chrome around the page. */
const BAR_COLOR: Record<PhoneTheme, string> = {
  dark: "#111112",
  light: "#fbfbfb",
  midnight: "#0e1321",
};

const isPhoneTheme = (value: unknown): value is PhoneTheme =>
  value === "dark" || value === "light" || value === "midnight";

export function storedTheme(): PhoneTheme {
  try {
    const value = localStorage.getItem(KEY);
    return isPhoneTheme(value) ? value : "dark";
  } catch {
    return "dark";
  }
}

/** Marks the page with the theme; styles.css keys every colour off it. */
export function applyTheme(theme: PhoneTheme) {
  document.documentElement.dataset.theme = theme;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", BAR_COLOR[theme]);
}

export function setTheme(theme: PhoneTheme) {
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // Storage unavailable: the choice lasts until the tab closes.
  }
  applyTheme(theme);
}
