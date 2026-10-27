import type { ApplicationMenuItemConfig } from "electrobun/bun";
import {
  type CommandMenu,
  type KeyOverrides,
  menuSections,
} from "@daedalus/protocol";

type Item = ApplicationMenuItemConfig;

const commandItem = ({
  id,
  title,
  accelerator,
}: {
  id: string;
  title: string;
  accelerator?: string;
}): Item => ({
  label: title,
  action: id,
  ...(accelerator ? { accelerator } : {}),
});

/**
 * A menu's commands from the shared command table, by section number: the
 * item's action is the command id, and its accelerator comes from the
 * command's key, overrides applied. A click reaches
 * `application-menu-clicked` with that id (see `index.ts`).
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

export function buildApplicationMenu(
  overrides: KeyOverrides = {},
): ApplicationMenuItemConfig[] {
  const app = commandSections("Daedalus", overrides);
  const updates = app.get(0) ?? [];
  const quit = app.get(1) ?? [];
  return [
    {
      label: "Daedalus",
      submenu: [
        { role: "about" },
        ...updates,
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
    { label: "View", submenu: divided(commandSections("View", overrides)) },
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        { type: "divider" },
        { role: "bringAllToFront" },
      ],
    },
  ];
}

export const APPLICATION_MENU: ApplicationMenuItemConfig[] =
  buildApplicationMenu();
