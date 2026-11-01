import { createContext } from "react";

/**
 * The terminals' font size, which ⌘= and ⌘- change and ⌘0 resets, as in
 * Terminal.app and iTerm2. One size for every terminal, agent sessions and
 * integrated terminals alike, remembered in this window's storage.
 */
export const TERMINAL_FONT_SIZE = 13;
export const TERMINAL_FONT_SIZE_MIN = 8;
export const TERMINAL_FONT_SIZE_MAX = 32;
export const TERMINAL_FONT_SIZE_STORAGE_KEY = "daedalus.terminal.font-size";

export const clampTerminalFontSize = (size: number) =>
  Number.isFinite(size)
    ? Math.min(
        TERMINAL_FONT_SIZE_MAX,
        Math.max(TERMINAL_FONT_SIZE_MIN, Math.round(size)),
      )
    : TERMINAL_FONT_SIZE;

/** A stored size, or the default when there is none or it is not a number. */
export const parseTerminalFontSize = (stored: string | null) =>
  stored === null || stored.trim() === ""
    ? TERMINAL_FONT_SIZE
    : clampTerminalFontSize(Number(stored));

export const TerminalFontSizeContext = createContext(TERMINAL_FONT_SIZE);
