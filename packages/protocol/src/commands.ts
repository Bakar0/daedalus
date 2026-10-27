import { formatAccelerator } from "./keys";

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
 * Where focus is. The four regions carry `data-area` on their root; the rest
 * are found inside them: `tabs` is the center's dockview, `terminal` any
 * xterm, `editor` a Monaco editor.
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
] as const;

export type CommandArea = (typeof COMMAND_AREAS)[number];

export type CommandGroup = "App" | "View" | "Tabs" | "Terminal" | "Panels";

/** The menus of the menu bar that hold commands. */
export type CommandMenu = "Daedalus" | "View";

export interface CommandWhen {
  /** The keys act only when focus is inside one of these. */
  readonly areas?: readonly CommandArea[];
  /** ...and not inside any of these. */
  readonly not?: readonly CommandArea[];
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
   */
  readonly menu?: { readonly bar: CommandMenu; readonly section: number };
}

export const COMMAND_SPECS = [
  {
    id: "app.checkForUpdates",
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
    title: "Quit Daedalus",
    group: "App",
    keys: ["mod+q"],
    runsIn: "host",
    menu: { bar: "Daedalus", section: 1 },
  },
  {
    id: "view.workspace",
    title: "Workspace",
    group: "View",
    keys: ["mod+1"],
    menu: { bar: "View", section: 0 },
  },
  {
    id: "view.board",
    title: "Board",
    group: "View",
    keys: ["mod+2"],
    menu: { bar: "View", section: 0 },
  },
  {
    id: "view.session",
    title: "Session",
    group: "View",
    keys: ["mod+3"],
    menu: { bar: "View", section: 0 },
  },
  {
    id: "view.world",
    title: "World",
    group: "View",
    keys: ["mod+4"],
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
  // ⌥⌘B, the key VS Code gives its secondary side bar.
  {
    id: "panel.toggleWorkspacePanel",
    title: "Fold Workspace Panel",
    group: "Panels",
    keys: ["mod+alt+b"],
  },
  // The center tabs. Handled by the app rather than as Monaco commands so
  // they also work on a Markdown preview, an image or a diff. Save does not
  // act in a session terminal, which keeps ⌘S for the program; closing and
  // moving between tabs do, as they do on every other tab.
  {
    id: "tab.save",
    title: "Save",
    group: "Tabs",
    keys: ["mod+s"],
    when: { areas: ["tabs"], not: ["terminal"] },
  },
  {
    id: "tab.close",
    title: "Close Tab",
    group: "Tabs",
    keys: ["mod+w"],
    when: { areas: ["tabs"] },
  },
  {
    id: "tab.next",
    title: "Next Tab",
    group: "Tabs",
    keys: ["mod+shift+]"],
    when: { areas: ["tabs"] },
  },
  {
    id: "tab.previous",
    title: "Previous Tab",
    group: "Tabs",
    keys: ["mod+shift+["],
    when: { areas: ["tabs"] },
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
 * The key a command's menu item shows and owns, if it has one: its first key,
 * when that is a single chord a menu can show.
 */
export const menuAccelerator = (spec: CommandSpec): string | undefined =>
  spec.menu && spec.keys[0] ? formatAccelerator(spec.keys[0]) : undefined;

export interface MenuCommandItem {
  id: CommandId;
  title: string;
  accelerator?: string;
}

/** A menu's commands, a list per section, in section and table order. */
export function menuSections(bar: CommandMenu): MenuCommandItem[][] {
  const sections = new Map<number, MenuCommandItem[]>();
  for (const spec of COMMAND_SPECS as readonly (CommandSpec & {
    id: CommandId;
  })[]) {
    if (spec.menu?.bar !== bar) continue;
    const accelerator = menuAccelerator(spec);
    const item: MenuCommandItem = {
      id: spec.id,
      title: spec.title,
      ...(accelerator ? { accelerator } : {}),
    };
    const list = sections.get(spec.menu.section) ?? [];
    list.push(item);
    sections.set(spec.menu.section, list);
  }
  return [...sections.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, items]) => items);
}
