import { COMMAND_AREAS, type CommandArea } from "@daedalus/protocol";

/**
 * Where a command is being asked for: which areas focus is inside, and
 * whether it is in a field that types. Built from the focused element, so
 * the same question gets the same answer from a key, the menu or a palette.
 */
export interface CommandContext {
  /** The areas focus is inside, innermost first. Empty: nowhere in particular. */
  readonly areas: readonly CommandArea[];
  /**
   * Focus is in something that takes typing: an input, a textarea, a
   * contenteditable, Monaco or a terminal. A key with no ⌘, ⌃ or ⌥ never acts
   * as a command then.
   */
  readonly typing: boolean;
  /** The focused element, or the key's target. */
  readonly target: Element | null;
  readonly source: "key" | "menu" | "palette";
}

/** The parts of an element the context reads, so it can be tested without a DOM. */
export interface ElementLike {
  readonly tagName: string;
  readonly parentElement: ElementLike | null;
  getAttribute(name: string): string | null;
  readonly classList?: { contains(token: string): boolean };
  readonly isContentEditable?: boolean;
}

const AREAS = new Set<string>(COMMAND_AREAS);

/** Areas found from what an element is rather than from `data-area`. */
const areaByClass = (element: ElementLike): CommandArea | undefined => {
  if (element.classList?.contains("xterm")) return "terminal";
  if (element.classList?.contains("monaco-editor")) return "editor";
  return undefined;
};

const NON_TEXT_INPUTS = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "hidden",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
]);

/** Whether the element itself takes typing. */
export function isEditableElement(element: ElementLike): boolean {
  const tag = element.tagName.toUpperCase();
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT")
    return !NON_TEXT_INPUTS.has(
      (element.getAttribute("type") ?? "text").toLowerCase(),
    );
  if (element.isContentEditable) return true;
  const editable = element.getAttribute("contenteditable");
  return editable !== null && editable !== "false";
}

export function contextFor(
  element: ElementLike | null,
  source: CommandContext["source"],
): CommandContext {
  const areas: CommandArea[] = [];
  let typing = element ? isEditableElement(element) : false;
  for (let node = element; node; node = node.parentElement) {
    const found = areaByClass(node);
    // Anything inside Monaco or a terminal types, whatever has the caret.
    if (found) typing = true;
    const marked = node.getAttribute("data-area");
    for (const area of [found, marked])
      if (area && AREAS.has(area) && !areas.includes(area as CommandArea))
        areas.push(area as CommandArea);
  }
  return { areas, typing, target: element as Element | null, source };
}
