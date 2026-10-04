import type { SessionColorDto } from "@daedalus/protocol";

/**
 * The session colors as the World paints them: the dark theme's values from
 * `--session-*` in styles.css. A figure's trim is drawn on the figure itself,
 * not on the page, so it keeps the brighter set in either theme.
 */
export const SESSION_COLOR_HEX: Readonly<Record<SessionColorDto, number>> = {
  red: 0xe5675f,
  orange: 0xe8894a,
  gold: 0xf0b44c,
  green: 0x5fb878,
  teal: 0x4cb5ad,
  blue: 0x5b9be6,
  purple: 0xa07ee0,
  pink: 0xe076b0,
};
