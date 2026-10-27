/**
 * Delete and Backspace on a focused center tab. Dockview (8.4) closes the
 * panel itself on those keys, with `panel.api.close()`, which skips the
 * app's close: the unsaved-changes question for a file. The editor area
 * catches the key first, in the capture phase, and closes through its own
 * `close` instead.
 */

/** The marker each of our tab components puts on its root. */
export const TAB_PANEL_ATTRIBUTE = "data-panel-id";

/** What `tabCloseRequest` reads of the event's target. */
export interface TabKeyTarget {
  readonly classList: { contains(name: string): boolean };
  querySelector(
    selector: string,
  ): { getAttribute(name: string): string | null } | null;
}

/**
 * The id of the panel whose tab the key would close, or undefined when the
 * key is not Delete or Backspace, or is not on a tab. As dockview does, only
 * the tab element itself counts: Backspace in anything inside a tab is that
 * thing's own.
 */
export function tabCloseRequest(event: {
  key: string;
  target: unknown;
}): string | undefined {
  if (event.key !== "Delete" && event.key !== "Backspace") return undefined;
  const target = event.target as Partial<TabKeyTarget> | null;
  if (
    !target ||
    typeof target.classList?.contains !== "function" ||
    typeof target.querySelector !== "function" ||
    !target.classList.contains("dv-tab")
  )
    return undefined;
  return (
    target
      .querySelector(`[${TAB_PANEL_ATTRIBUTE}]`)
      ?.getAttribute(TAB_PANEL_ATTRIBUTE) ?? undefined
  );
}

/**
 * Whether Delete or Backspace may close a tab of this kind. A terminal tab
 * would end its shell, which a stray key must not do; ⌘W and the tab's ×
 * still close it. Every other tab only closes a view.
 */
export const deleteKeyCloses = (kind: string | undefined): boolean =>
  kind !== "terminal";
