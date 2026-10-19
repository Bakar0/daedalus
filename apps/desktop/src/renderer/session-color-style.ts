import { customSessionColor, type SessionColorDto } from "@daedalus/protocol";
import type { CSSProperties } from "react";

/**
 * The inline style a picked color needs: the named colors come from
 * styles.css by `data-color`, a picked one sets `--session-color` itself.
 */
export function sessionColorStyle(
  color: SessionColorDto | null | undefined,
): CSSProperties | undefined {
  const hex = customSessionColor(color);
  return hex ? ({ "--session-color": hex } as CSSProperties) : undefined;
}
