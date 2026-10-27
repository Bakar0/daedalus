import { useEffect, useRef, useSyncExternalStore } from "react";
import {
  COMMAND_SPECS,
  type CommandArea,
  type CommandId,
  type CommandSpec,
  type HostCommandId,
  type KeyOverrides,
  type RejectedKey,
  type RendererCommandId,
  commandSpec,
  formatAriaKeyShortcuts,
  formatKeyGlyphs,
  isHostCommandId,
  keysOf,
  validateKeyOverrides,
} from "@daedalus/protocol";
import { hasOpenScope } from "../use-focus-scope";
import { type CommandContext, contextFor } from "./context";
import {
  type Binding,
  KeyMatcher,
  compileBindings,
  findConflicts,
  isComposingKey,
  rankIn,
  swallowsNativeRepeat,
  terminalKeepsKey,
} from "./dispatch";

/**
 * The command table at run time: the shared specs (`@daedalus/protocol`
 * `COMMAND_SPECS`: id, title, group, keys, where they act, menu place) joined
 * to the code that runs each command. A renderer command's code is registered
 * by the component owning its state, with `useCommand`; a host command runs
 * in the bun process through the bridge `connectHost` installs. One keydown
 * dispatcher on the window runs them; the menu, and later the palette, run
 * them by id with `runCommand`.
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

/** How the window reaches the host: its commands and its menu bar's keys. */
export interface HostBridge {
  run(command: HostCommandId): void;
  setKeyOverrides(overrides: KeyOverrides): void;
}

let host: HostBridge | undefined;

/** Connects the host; returns the disconnect. */
export function connectHost(bridge: HostBridge): () => void {
  host = bridge;
  bridge.setKeyOverrides(overrides);
  return () => {
    if (host === bridge) host = undefined;
  };
}

/** Whether the command acts where the context says focus is. */
const actsHere = (id: CommandId, context: CommandContext) => {
  const spec = commandSpec(id);
  if (context.modal && !spec.inModal) return false;
  return (
    rankIn(spec.when, context.areas, { forKey: context.source === "key" }) !==
    undefined
  );
};

const handlerFor = (
  id: CommandId,
  context: CommandContext,
): CommandHandler | undefined => {
  if (isHostCommandId(id)) {
    const bridge = host;
    return bridge ? { run: () => bridge.run(id) } : undefined;
  }
  const list = handlers.get(id) ?? [];
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const handler = list[index];
    if (handler && (handler.enabled?.(context) ?? true)) return handler;
  }
  return undefined;
};

/** Enabled by its own code; the dispatcher checks where it acts itself. */
const handlerEnabled = (id: CommandId, context: CommandContext) =>
  handlerFor(id, context) !== undefined;

/**
 * Whether the command would run now: it acts where focus is (its `when`,
 * and no dialog in the way unless it is `inModal`), and its code says it is
 * enabled. The same answer for a key, a menu click and the palette.
 */
export const isCommandEnabled = (id: CommandId, context: CommandContext) =>
  actsHere(id, context) && handlerEnabled(id, context);

const currentContext = (
  element: Element | null,
  source: CommandContext["source"],
) => contextFor(element, source, { modal: hasOpenScope() });

/** The context of whatever has focus now, for a command not run by a key. */
export const focusContext = (
  source: CommandContext["source"] = "palette",
): CommandContext =>
  currentContext(
    typeof document === "undefined" ? null : document.activeElement,
    source,
  );

/** Runs a command if it is enabled here; says whether it ran. */
export function runCommand(
  id: CommandId,
  context: CommandContext = focusContext(),
): boolean {
  if (!actsHere(id, context)) return false;
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
let bindings: readonly Binding[] = compile(overrides);

function compile(next: KeyOverrides): Binding[] {
  const compiled = compileBindings(COMMAND_SPECS, next);
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

/**
 * Replaces the person's keys (from a keybindings file, say). Every key is
 * checked first; one that does not parse, or names no command, is dropped
 * and returned, and the rest take effect together, here and in the menu bar.
 */
export function setKeyOverrides(raw: unknown): RejectedKey[] {
  const { overrides: next, rejected } = validateKeyOverrides(raw);
  const compiled = compile(next);
  overrides = next;
  bindings = compiled;
  matcher.reset();
  host?.setKeyOverrides(next);
  return rejected;
}

/** A command's keys as they stand, overrides applied. */
export const commandKeys = (id: CommandId): readonly string[] =>
  keysOf(commandSpec(id), overrides);

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

// The dispatcher asks only whether the code is enabled: the bindings it
// matches have already been filtered by area and dialog.
const matcher = new KeyMatcher(() => bindings, handlerEnabled);

const elementTarget = (event: Event) =>
  event.target instanceof Element ? event.target : null;

/**
 * The one keydown listener for commands, on the window in the capture phase,
 * so it sees a key before Monaco, dockview or a terminal does. A key it runs a
 * command for is stopped there; any other key goes on untouched.
 */
function onKeyDown(event: KeyboardEvent) {
  if (event.defaultPrevented || isComposingKey(event)) return;
  const context = currentContext(elementTarget(event), "key");
  if (swallowsNativeRepeat(event, context, bindings)) {
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  const result = matcher.handle(event, context);
  if (!result) return;
  event.preventDefault();
  event.stopPropagation();
  if (result.kind === "run") runCommand(result.binding.id, context);
}

// Which area has focus, kept as focus moves, for whatever shows it (an area
// highlight, the shortcuts sheet listing that area's keys first).
let focusedAreas: readonly CommandArea[] = [];
const focusListeners = new Set<() => void>();
function onFocusIn(event: FocusEvent) {
  // A sequence started in one place does not finish in another.
  matcher.reset();
  const areas = contextFor(elementTarget(event), "key").areas;
  if (areas.join() === focusedAreas.join()) return;
  focusedAreas = areas;
  for (const listener of focusListeners) listener();
}
const onBlur = () => matcher.reset();

let installs = 0;

/** Installs the dispatcher and focus tracking on the window; returns the uninstall. */
export function installKeyDispatcher(): () => void {
  installs += 1;
  if (installs === 1) {
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("focusin", onFocusIn, true);
    window.addEventListener("blur", onBlur);
  }
  return () => {
    installs -= 1;
    if (installs > 0) return;
    window.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("focusin", onFocusIn, true);
    window.removeEventListener("blur", onBlur);
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
    currentContext(elementTarget(event), "key"),
    bindings,
    handlerEnabled,
  );
}
