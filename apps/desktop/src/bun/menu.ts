import type { ApplicationMenuItemConfig } from "electrobun/bun";
import {
  type CommandMenu,
  type KeyOverrides,
  type MenuCommandItem,
  menuItemLabel,
  menuSections,
} from "@daedalus/protocol";

type Item = ApplicationMenuItemConfig;

const commandItem = ({
  id,
  title,
  accelerator,
  keyLabel,
}: MenuCommandItem): Item => ({
  label: menuItemLabel(title, keyLabel),
  action: id,
  ...(accelerator ? { accelerator } : {}),
});

/**
 * A menu's commands from the shared command table, by section number: the
 * item's action is the command id, and its accelerator comes from the
 * command's key, overrides applied. A `showKeyOnly` command has no
 * accelerator (Electrobun's menu cannot show a key without taking it), so
 * its key is written into its title and the renderer's dispatcher keeps it.
 * A click reaches `application-menu-clicked` with that id (see `index.ts`).
 */
export function commandSections(
  bar: CommandMenu,
  overrides: KeyOverrides = {},
): Map<number, Item[]> {
  return new Map(
    menuSections(bar, overrides).map(({ section, items }) => [
      section,
      items.map(commandItem),
    ]),
  );
}

/** Every section of a menu, a divider between each. */
const divided = (sections: Map<number, Item[]>): Item[] =>
  [...sections.values()].flatMap((section, index) =>
    index === 0 ? section : [{ type: "divider" } as const, ...section],
  );

/** The menus the command table fills, in menu bar order. */
const menuOf = (bar: CommandMenu, overrides: KeyOverrides): Item => ({
  label: bar,
  submenu: divided(commandSections(bar, overrides)),
});

/**
 * The menu bar, in the order every Mac app keeps: the app menu, File, Edit,
 * View, Go, Window, Help. Everything but the native roles comes from the
 * command table.
 */
export function buildApplicationMenu(
  overrides: KeyOverrides = {},
): ApplicationMenuItemConfig[] {
  const app = commandSections("Daedalus", overrides);
  const updates = app.get(0) ?? [];
  const quit = app.get(1) ?? [];
  const settings = app.get(2) ?? [];
  return [
    {
      label: "Daedalus",
      submenu: [
        { role: "about" },
        ...updates,
        { type: "divider" },
        ...settings,
        { type: "divider" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "showAll" },
        { type: "divider" },
        // Quit is deliberately a command, not `{ role: "quit" }`: that is a
        // native macOS role, so ⌘Q would terminate the app without ever
        // reaching our code. See `app.quit` in the command table.
        ...quit,
      ],
    },
    menuOf("File", overrides),
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "divider" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "pasteAndMatchStyle" },
        { role: "delete" },
        { role: "selectAll" },
      ],
    },
    menuOf("View", overrides),
    menuOf("Go", overrides),
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        { type: "divider" },
        { role: "bringAllToFront" },
      ],
    },
    menuOf("Help", overrides),
  ];
}

export const APPLICATION_MENU: ApplicationMenuItemConfig[] =
  buildApplicationMenu();
