import {
  formatAccelerator,
  formatKeyGlyphs,
  normalizeKey,
  isShellChord,
  parseKey,
  reservedKeyReason,
} from "./keys";

/**
 * The app's commands as data: what each is called, its default keys, where
 * those keys act and where it sits in the menu bar. The renderer adds the
 * code that runs each one (`apps/desktop/src/renderer/commands`); the host
 * builds the native menu from the same entries (`apps/desktop/src/bun/menu.ts`),
 * so a command is named, keyed and placed once. Data rather than code so a
 * keybindings file can override the keys later, and the palette, the
 * shortcuts sheet and tooltips can show them.
 */

/**
 * Where focus is. The regions (sidebar, center, right panel, terminal panel,
 * and toasts while any show) carry `data-area` on their root; the rest are
 * found inside them: `tabs` is the center's dockview, `terminal` any xterm,
 * `editor` a Monaco editor, `board` the task cards.
 */
export const COMMAND_AREAS = [
  "sidebar",
  "center",
  "right-panel",
  "terminal-panel",
  "tabs",
  "editor",
  "terminal",
  "board",
  "list",
  "toasts",
] as const;

export type CommandArea = (typeof COMMAND_AREAS)[number];

export type CommandGroup =
  "App" | "File" | "Go" | "View" | "Tabs" | "Terminal" | "Panels" | "Help";

/** The menus of the menu bar that hold commands. */
export type CommandMenu = "Daedalus" | "File" | "View" | "Go" | "Help";

export interface CommandWhen {
  /** The keys act only when focus is inside one of these. */
  readonly areas?: readonly CommandArea[];
  /** ...and not inside any of these. */
  readonly not?: readonly CommandArea[];
  /**
   * The keys alone leave these areas to whatever owns them there (a key
   * rebound onto one of Monaco's, say); the command itself still runs from
   * them by the menu or the palette. `not` excludes the command, this only its keys.
   */
  readonly keysNot?: readonly CommandArea[];
}

export interface CommandSpec {
  readonly id: string;
  /** As the menu and the palette show it. */
  readonly title: string;
  readonly group: CommandGroup;
  /**
   * Default keys, each a chord (`mod+shift+]`) or a sequence (`mod+k mod+s`);
   * see `parseKey`. The first is the one menus and tooltips show.
   */
  readonly keys: readonly string[];
  /** Where the keys act. Omitted, they act everywhere. */
  readonly when?: CommandWhen;
  /**
   * Which side runs it. A `host` command is handled by the bun process (quit,
   * a second window); the rest are sent to the renderer by id.
   */
  readonly runsIn?: "host" | "renderer";
  /**
   * Its place in the menu bar: the menu, and a section; sections are divided
   * by a separator and items keep table order. A menu item with a key owns
   * that key: macOS delivers it through the menu, by id, so the renderer's
   * dispatcher leaves it alone and nothing runs twice.
   *
   * A native key equivalent fires wherever focus is, before a field, Monaco
   * or a terminal sees it, and Electrobun's menu has no way to show a key
   * without owning it. So a command whose key must still reach those when
   * the command does not act there (⌘W outside the tabs, ⌘K inside a
   * dialog, ⌃Tab whose release the switcher waits for) sets `showKeyOnly`:
   * its item gets no accelerator, its title carries the key's glyphs
   * instead, and the dispatcher keeps the key, with its `when` and its
   * dialog rule.
   */
  readonly menu?: {
    readonly bar: CommandMenu;
    readonly section: number;
    readonly showKeyOnly?: boolean;
  };
  /** A held key repeats the command. Off by default: a held ⌘W closes one tab. */
  readonly allowRepeat?: boolean;
  /**
   * Its keys act while a dialog is open. Off by default, since a dialog owns
   * the keyboard: the page behind it is inert and its commands wait.
   */
  readonly inModal?: boolean;
}

export const COMMAND_SPECS = [
  {
    id: "app.checkForUpdates",
    inModal: true,
    title: "Check for Updates…",
    group: "App",
    keys: [],
    runsIn: "host",
    menu: { bar: "Daedalus", section: 0 },
  },
  // The discoverable off switch, for people who never open a terminal. It
  // archives every live session, closes the terminals and ends the Daedalus
  // tmux server, which is exactly `daedal shutdown`.
  {
    id: "app.quitAndShutDown",
    inModal: true,
    title: "Quit and Shut Down Sessions",
    group: "App",
    keys: ["mod+shift+q"],
    runsIn: "host",
    menu: { bar: "Daedalus", section: 1 },
  },
  // Deliberately not `{ role: "quit" }`. That is a native macOS role, so ⌘Q
  // would terminate the app without ever reaching our code and the user would
  // never be told what keeps running.
  {
    id: "app.quit",
    inModal: true,
    title: "Quit Daedalus",
    group: "App",
    keys: ["mod+q"],
    runsIn: "host",
    menu: { bar: "Daedalus", section: 1 },
  },
  // The views keep their View menu items and palette rows; ⌘1 to ⌘9 are
  // the center's tabs now, as in a browser.
  {
    id: "view.workspace",
    title: "Workspace",
    group: "View",
    keys: [],
    menu: { bar: "View", section: 0 },
  },
  {
    id: "view.board",
    title: "Board",
    group: "View",
    keys: [],
    menu: { bar: "View", section: 0 },
  },
  {
    id: "view.session",
    title: "Session",
    group: "View",
    keys: [],
    menu: { bar: "View", section: 0 },
  },
  {
    id: "view.world",
    title: "World",
    group: "View",
    keys: [],
    menu: { bar: "View", section: 0 },
  },
  {
    id: "view.worldWindow",
    title: "Open World in New Window",
    group: "View",
    keys: ["mod+alt+4"],
    runsIn: "host",
    menu: { bar: "View", section: 0 },
  },
  {
    id: "terminal.toggle",
    title: "Toggle Integrated Terminal",
    group: "Terminal",
    keys: ["ctrl+`"],
    menu: { bar: "View", section: 1 },
  },
  // ⌘B opens and closes the right side panel, as it does VS Code's side bar.
  // Monaco binds nothing to ⌘B, and a terminal leaves ⌘ keys to the app.
  {
    id: "panel.toggleWorkspacePanel",
    title: "Toggle Side Panel",
    group: "Panels",
    keys: ["mod+b"],
    menu: { bar: "View", section: 1 },
  },
  // The side panel's tabs, from the palette: no keys.
  {
    id: "panel.files",
    title: "Show Files Panel",
    group: "Panels",
    keys: [],
  },
  {
    id: "panel.repositories",
    title: "Show Repositories Panel",
    group: "Panels",
    keys: [],
  },
  {
    id: "panel.tasks",
    title: "Show Tasks Panel",
    group: "Panels",
    keys: [],
  },
  // The center tabs. Handled by the app rather than as Monaco commands so
  // they also work on a Markdown preview, an image or a diff. Save does not
  // act in a session terminal, which keeps ⌘S for the program; closing and
  // moving between tabs do, as they do on every other tab. Their menu items
  // only show the keys: outside the tabs ⌘S and ⌘W belong to whatever has
  // focus.
  {
    id: "tab.save",
    title: "Save",
    group: "Tabs",
    keys: ["mod+s"],
    when: { areas: ["tabs"], not: ["terminal"] },
    menu: { bar: "File", section: 1, showKeyOnly: true },
  },
  {
    id: "tab.close",
    title: "Close Tab",
    group: "Tabs",
    keys: ["mod+w"],
    when: { areas: ["tabs"] },
    menu: { bar: "File", section: 1, showKeyOnly: true },
  },
  {
    id: "tab.next",
    title: "Next Tab",
    group: "Tabs",
    keys: ["mod+shift+]"],
    when: { areas: ["tabs"] },
    menu: { bar: "Go", section: 1, showKeyOnly: true },
  },
  {
    id: "tab.previous",
    title: "Previous Tab",
    group: "Tabs",
    keys: ["mod+shift+["],
    when: { areas: ["tabs"] },
    menu: { bar: "Go", section: 1, showKeyOnly: true },
  },
  // ⌘1 to ⌘8 pick the center's tab by its place, ⌘9 the last, as a browser
  // does. They act from anywhere, a terminal included, so they are the
  // dispatcher's rather than menu items: nine items would bury the Go menu.
  {
    id: "tab.goTo1",
    title: "Go to Tab 1",
    group: "Tabs",
    keys: ["mod+1"],
  },
  {
    id: "tab.goTo2",
    title: "Go to Tab 2",
    group: "Tabs",
    keys: ["mod+2"],
  },
  {
    id: "tab.goTo3",
    title: "Go to Tab 3",
    group: "Tabs",
    keys: ["mod+3"],
  },
  {
    id: "tab.goTo4",
    title: "Go to Tab 4",
    group: "Tabs",
    keys: ["mod+4"],
  },
  {
    id: "tab.goTo5",
    title: "Go to Tab 5",
    group: "Tabs",
    keys: ["mod+5"],
  },
  {
    id: "tab.goTo6",
    title: "Go to Tab 6",
    group: "Tabs",
    keys: ["mod+6"],
  },
  {
    id: "tab.goTo7",
    title: "Go to Tab 7",
    group: "Tabs",
    keys: ["mod+7"],
  },
  {
    id: "tab.goTo8",
    title: "Go to Tab 8",
    group: "Tabs",
    keys: ["mod+8"],
  },
  {
    id: "tab.goToLast",
    title: "Go to Last Tab",
    group: "Tabs",
    keys: ["mod+9"],
  },
  // ⌃Tab is the session switcher, as ⌘Tab is the app switcher: held ⌃, each
  // Tab moves down the sessions in the order they were last used (⌃⇧Tab
  // up), and letting go of ⌃ opens the highlighted one. A quick tap goes back
  // to the previous session. The dispatcher keeps it from a terminal and
  // Monaco (which binds no ⌃Tab on a Mac); a held Tab keeps moving.
  {
    id: "session.switch",
    title: "Switch Session",
    group: "Go",
    keys: ["ctrl+tab"],
    allowRepeat: true,
    menu: { bar: "Go", section: 0, showKeyOnly: true },
  },
  {
    id: "session.switchBack",
    title: "Switch Session, Backwards",
    group: "Go",
    keys: ["ctrl+shift+tab"],
    allowRepeat: true,
  },
  {
    id: "session.nextNeedsYou",
    title: "Next Session That Needs You",
    group: "Go",
    keys: [],
    menu: { bar: "Go", section: 0 },
  },
  {
    id: "session.new",
    title: "New Session…",
    group: "File",
    keys: ["mod+n"],
    menu: { bar: "File", section: 0 },
  },
  {
    id: "task.new",
    title: "New Task…",
    group: "File",
    keys: ["mod+shift+n"],
    menu: { bar: "File", section: 0 },
  },
  {
    id: "terminal.new",
    title: "New Terminal",
    group: "File",
    keys: ["mod+t"],
    menu: { bar: "File", section: 0 },
  },
  {
    id: "app.settings",
    title: "Settings…",
    group: "App",
    keys: ["mod+,"],
    menu: { bar: "Daedalus", section: 2 },
  },
  // The focused item's own actions: ⇧F10, or the menu key on a keyboard
  // that has one. A sidebar item and a file opens its menu; a board card,
  // which has none, opens the palette on its actions.
  {
    id: "item.menu",
    title: "Show Item Actions",
    group: "Go",
    keys: ["shift+f10", "contextmenu"],
    when: { areas: ["sidebar", "board", "right-panel"] },
  },
  // ⌘K is the one place to go: sessions, tasks, workspaces, every command,
  // the settings pages, and each item's actions. The dispatcher keeps it, so
  // the palette's own field sees it (⌘K there opens a row's actions). It
  // acts from a terminal and the editor too, as a bound ⌘ key does; Monaco's
  // ⌘K chords give way to it.
  {
    id: "palette.open",
    title: "Command Palette…",
    group: "Go",
    keys: ["mod+k"],
    menu: { bar: "Go", section: 2, showKeyOnly: true },
  },
  // No key: the Help menu and the palette open it.
  {
    id: "help.shortcuts",
    title: "Keyboard Shortcuts",
    group: "Help",
    keys: [],
    menu: { bar: "Help", section: 0 },
  },
] as const satisfies readonly CommandSpec[];

type Spec = (typeof COMMAND_SPECS)[number];

export type CommandId = Spec["id"];
export type HostCommandId = Extract<Spec, { runsIn: "host" }>["id"];
/** A command the renderer runs; the host forwards a menu click on one. */
export type RendererCommandId = Exclude<CommandId, HostCommandId>;

const SPECS: readonly CommandSpec[] = COMMAND_SPECS;

export const isCommandId = (value: unknown): value is CommandId =>
  typeof value === "string" && SPECS.some((spec) => spec.id === value);

export const isHostCommandId = (value: unknown): value is HostCommandId =>
  typeof value === "string" &&
  SPECS.some((spec) => spec.id === value && spec.runsIn === "host");

export const isRendererCommandId = (
  value: unknown,
): value is RendererCommandId => isCommandId(value) && !isHostCommandId(value);

export const commandSpec = (id: CommandId): CommandSpec =>
  SPECS.find((spec) => spec.id === id) as CommandSpec;

/**
 * Keys a person chose, replacing a command's default keys; an empty list
 * unbinds it. Both sides read them: the renderer's dispatcher and the host's
 * menu, so a rebound menu command has one live key.
 */
export type KeyOverrides = Partial<Record<CommandId, readonly string[]>>;

/** A command's keys, overrides applied. */
export const keysOf = (
  spec: CommandSpec,
  overrides: KeyOverrides = {},
): readonly string[] => overrides[spec.id as CommandId] ?? spec.keys;

export interface RejectedKey {
  id: string;
  key?: string;
  reason: string;
}

/**
 * Reads overrides from anywhere (a keybindings file, an RPC), keeping every
 * key that parses and reporting the rest, so one typo costs one key rather
 * than the whole file. A key macOS reserves (`reservedKeyReason`) is
 * reported like a typo.
 */
export function validateKeyOverrides(raw: unknown): {
  overrides: KeyOverrides;
  rejected: RejectedKey[];
} {
  const overrides: Partial<Record<CommandId, string[]>> = {};
  const rejected: RejectedKey[] = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    return {
      overrides,
      rejected: raw === undefined ? [] : [{ id: "", reason: "Not an object" }],
    };
  for (const [id, keys] of Object.entries(raw)) {
    if (!isCommandId(id)) {
      rejected.push({ id, reason: "Unknown command" });
      continue;
    }
    if (!Array.isArray(keys)) {
      rejected.push({ id, reason: "Keys must be a list" });
      continue;
    }
    const valid: string[] = [];
    for (const key of keys) {
      try {
        if (typeof key !== "string") throw new Error("Not a string");
        normalizeKey(key);
        const reserved = reservedKeyReason(key);
        if (reserved) throw new Error(`Reserved: ${reserved}`);
        valid.push(key);
      } catch (error) {
        rejected.push({
          id,
          key: String(key),
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    // An entry none of whose keys could be used keeps the defaults rather
    // than unbinding the command: `[]` is how a file unbinds one.
    if (valid.length > 0 || keys.length === 0) overrides[id] = valid;
  }
  return { overrides, rejected };
}

/**
 * The person's keybindings as the host holds them: the file they live in,
 * the overrides that took effect, and what in the file was skipped.
 */
export interface KeybindingsDto {
  /** `keybindings.json` in the Daedalus home. */
  path: string;
  overrides: KeyOverrides;
  /** Entries the file has that did not take effect, and why. */
  rejected: RejectedKey[];
}

/**
 * One command's keys to write: a list replaces its defaults (empty unbinds
 * it), `null` goes back to the defaults.
 */
export interface KeybindingChange {
  id: CommandId;
  keys: readonly string[] | null;
}

/**
 * The key a command's menu item shows and owns, if it has one: its first key,
 * overrides applied, when that is a single chord a menu can show. A
 * `showKeyOnly` item owns none; see `menuKeyLabel`.
 */
export const menuAccelerator = (
  spec: CommandSpec,
  overrides: KeyOverrides = {},
): string | undefined => {
  const first = keysOf(spec, overrides)[0];
  if (!spec.menu || spec.menu.showKeyOnly || !first) return undefined;
  // A key that types, or a ⌃ letter, is never a native accelerator: the
  // item only shows it and the dispatcher keeps it (`isShellChord`).
  const chord = parseKey(first);
  if (chord.length === 1 && isShellChord(chord[0]!)) return undefined;
  return formatAccelerator(first);
};

/**
 * The glyphs a menu item writes in its title when it shows its key without
 * owning it (`⌘W`): a `showKeyOnly` item, or one whose key a menu cannot
 * own (a sequence, a key that types, a ⌃ letter). So the menu still teaches
 * the key the dispatcher keeps. Undefined for an item whose accelerator is
 * the key, or one whose key was unbound.
 */
export const menuKeyLabel = (
  spec: CommandSpec,
  overrides: KeyOverrides = {},
): string | undefined => {
  const first = keysOf(spec, overrides)[0];
  if (!spec.menu || !first || menuAccelerator(spec, overrides))
    return undefined;
  return formatKeyGlyphs(first);
};

/**
 * A menu item's title with the key it only shows. macOS draws an
 * accelerator right-aligned, which a title cannot do, so the glyphs follow
 * in parentheses, as a hint rather than a second column.
 */
export const menuItemLabel = (title: string, keyLabel?: string): string =>
  keyLabel ? `${title} (${keyLabel})` : title;

export interface MenuCommandItem {
  id: CommandId;
  title: string;
  accelerator?: string;
  /** The key a `showKeyOnly` item shows in its title, as glyphs. */
  keyLabel?: string;
}

export interface MenuSection {
  section: number;
  items: MenuCommandItem[];
}

/** A menu's commands by section, in section and table order. */
export function menuSections(
  bar: CommandMenu,
  overrides: KeyOverrides = {},
): MenuSection[] {
  const sections = new Map<number, MenuCommandItem[]>();
  for (const spec of COMMAND_SPECS as readonly (CommandSpec & {
    id: CommandId;
  })[]) {
    if (spec.menu?.bar !== bar) continue;
    const accelerator = menuAccelerator(spec, overrides);
    const keyLabel = menuKeyLabel(spec, overrides);
    const item: MenuCommandItem = {
      id: spec.id,
      title: spec.title,
      ...(accelerator ? { accelerator } : {}),
      ...(keyLabel ? { keyLabel } : {}),
    };
    const list = sections.get(spec.menu.section) ?? [];
    list.push(item);
    sections.set(spec.menu.section, list);
  }
  return [...sections.entries()]
    .sort(([a], [b]) => a - b)
    .map(([section, items]) => ({ section, items }));
}
