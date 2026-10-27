import { useEffect, useRef, useSyncExternalStore } from "react";
import {
  COMMAND_SPECS,
  type CommandArea,
  type CommandId,
  type CommandSpec,
  type RendererCommandId,
  commandSpec,
  formatAriaKeyShortcuts,
  formatKeyGlyphs,
} from "@daedalus/protocol";
import { type CommandContext, contextFor } from "./context";
import {
  type Binding,
  type KeyOverrides,
  KeyMatcher,
  compileBindings,
  findConflicts,
  terminalKeepsKey,
} from "./dispatch";

/**
 * The command table at run time: the shared specs (`@daedalus/protocol`
 * `COMMAND_SPECS`: id, title, group, keys, where they act, menu place) joined
 * to the code that runs each command, which the component owning the state
 * registers with `useCommand`. One keydown dispatcher on the window runs
 * them; the menu, and later the palette, run them by id with `runCommand`.
 */

export interface CommandHandler {
  run(context: CommandContext): void;
  /** Omitted: always enabled while registered. */
  enabled?(context: CommandContext): boolean;
}

const handlers = new Map<CommandId, CommandHandler[]>();

/**
 * Adds the code for a command. Several may be registered for one id (two
 * editor areas, say); the latest one that is enabled runs.
 */
export function registerCommand(
  id: RendererCommandId,
  handler: CommandHandler,
): () => void {
  const list = handlers.get(id) ?? [];
  list.push(handler);
  handlers.set(id, list);
  return () => {
    const current = handlers.get(id);
    if (!current) return;
    const index = current.lastIndexOf(handler);
    if (index >= 0) current.splice(index, 1);
  };
}

const handlerFor = (id: CommandId, context: CommandContext) => {
  const list = handlers.get(id) ?? [];
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const handler = list[index];
    if (handler && (handler.enabled?.(context) ?? true)) return handler;
  }
  return undefined;
};

export const isCommandEnabled = (id: CommandId, context: CommandContext) =>
  handlerFor(id, context) !== undefined;

/** The context of whatever has focus now, for a command not run by a key. */
export const focusContext = (
  source: CommandContext["source"] = "palette",
): CommandContext =>
  contextFor(
    typeof document === "undefined" ? null : document.activeElement,
    source,
  );

/** Runs a command if it is enabled; says whether it ran. */
export function runCommand(
  id: CommandId,
  context: CommandContext = focusContext(),
): boolean {
  const handler = handlerFor(id, context);
  if (!handler) return false;
  handler.run(context);
  return true;
}

/**
 * Registers a command's code for as long as the component is mounted. The
 * latest `run` and `enabled` are always the ones called, so the handler may
 * close over state without re-registering on every render.
 */
export function useCommand(
  id: RendererCommandId,
  handler: CommandHandler,
): void {
  const latest = useRef(handler);
  latest.current = handler;
  useEffect(
    () =>
      registerCommand(id, {
        run: (context) => latest.current.run(context),
        enabled: (context) => latest.current.enabled?.(context) ?? true,
      }),
    [id],
  );
}

let overrides: KeyOverrides = {};
let bindings: Binding[] = compile();

function compile(): Binding[] {
  const compiled = compileBindings(COMMAND_SPECS, overrides);
  // A key two commands claim in the same place is decided by table order,
  // which is never what anyone meant. The table test fails on one; this
  // catches one a keybindings file introduces.
  if (import.meta.env?.DEV)
    for (const [a, b] of findConflicts(compiled))
      console.warn(
        `Key ${a.key} is bound to both ${a.id} and ${b.id} in the same place; ${a.id} wins.`,
      );
  return compiled;
}

export const currentBindings = (): readonly Binding[] => bindings;

/** Replaces the keys of some commands (for a keybindings file). */
export function setKeyOverrides(next: KeyOverrides): void {
  overrides = next;
  bindings = compile();
}

/** A command's keys as they stand, overrides applied. */
export const commandKeys = (id: CommandId): readonly string[] =>
  overrides[id] ?? commandSpec(id).keys;

/** Its first key as macOS glyphs (`⇧⌘]`), for menus, rows and tooltips. */
export const shortcutLabel = (id: CommandId): string | undefined => {
  const key = commandKeys(id)[0];
  return key ? formatKeyGlyphs(key) : undefined;
};

/** The value for `aria-keyshortcuts`, or undefined when it has no key. */
export const ariaKeyShortcuts = (id: CommandId): string | undefined =>
  formatAriaKeyShortcuts(commandKeys(id)) || undefined;

/** Every command with its keys, in table order, for a palette or a sheet. */
export const allCommands = (): (CommandSpec & {
  id: CommandId;
  keys: readonly string[];
})[] =>
  (COMMAND_SPECS as readonly (CommandSpec & { id: CommandId })[]).map(
    (spec) => ({ ...spec, keys: commandKeys(spec.id) }),
  );

const matcher = new KeyMatcher(() => bindings, isCommandEnabled);

const elementTarget = (event: Event) =>
  event.target instanceof Element ? event.target : null;

/**
 * The one keydown listener for commands, on the window in the capture phase,
 * so it sees a key before Monaco, dockview or a terminal does. A key it runs a
 * command for is stopped there; any other key goes on untouched.
 */
function onKeyDown(event: KeyboardEvent) {
  if (event.defaultPrevented || event.isComposing) return;
  const result = matcher.handle(event, contextFor(elementTarget(event), "key"));
  if (!result) return;
  event.preventDefault();
  event.stopPropagation();
  if (result.kind === "run")
    runCommand(result.binding.id, contextFor(elementTarget(event), "key"));
}

// Which area has focus, kept as focus moves, for whatever shows it (an area
// highlight, the shortcuts sheet listing that area's keys first).
let focusedAreas: readonly CommandArea[] = [];
const focusListeners = new Set<() => void>();
function onFocusIn(event: FocusEvent) {
  const areas = contextFor(elementTarget(event), "key").areas;
  if (areas.join() === focusedAreas.join()) return;
  focusedAreas = areas;
  for (const listener of focusListeners) listener();
}

let installs = 0;

/** Installs the dispatcher and focus tracking; returns the uninstall. */
export function installKeyDispatcher(target: Window = window): () => void {
  installs += 1;
  if (installs === 1) {
    target.addEventListener("keydown", onKeyDown, true);
    target.addEventListener("focusin", onFocusIn, true);
  }
  return () => {
    installs -= 1;
    if (installs > 0) return;
    target.removeEventListener("keydown", onKeyDown, true);
    target.removeEventListener("focusin", onFocusIn, true);
  };
}

export function useKeyDispatcher(): void {
  useEffect(() => installKeyDispatcher(), []);
}

/** The areas focus is in, innermost first, re-rendering when it moves. */
export function useFocusedAreas(): readonly CommandArea[] {
  return useSyncExternalStore(
    (listener) => {
      focusListeners.add(listener);
      return () => focusListeners.delete(listener);
    },
    () => focusedAreas,
  );
}

/**
 * For `Terminal.attachCustomKeyEventHandler`: true sends the key to the
 * shell, false keeps it for the app. See `terminalKeepsKey`.
 */
export function terminalKeyHandler(event: KeyboardEvent): boolean {
  return !terminalKeepsKey(
    event,
    contextFor(elementTarget(event), "key"),
    bindings,
    isCommandEnabled,
  );
}
