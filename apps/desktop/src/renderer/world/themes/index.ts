import type { WorldTheme } from "../world-theme";
import { islandTheme } from "./island";

/**
 * Every world concept the picker offers. Adding one is a file implementing
 * `WorldTheme` and a line here; nothing else in the app changes.
 */
export const WORLD_THEMES: readonly WorldTheme[] = [islandTheme];

export const DEFAULT_WORLD_THEME_ID = islandTheme.id;

export const worldThemeById = (id: string | null | undefined): WorldTheme =>
  WORLD_THEMES.find((theme) => theme.id === id) ??
  WORLD_THEMES.find((theme) => theme.id === DEFAULT_WORLD_THEME_ID)!;
