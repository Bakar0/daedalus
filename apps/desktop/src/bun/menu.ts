import type { ApplicationMenuItemConfig } from "electrobun/bun";
import { type CommandMenu, menuSections } from "@daedalus/protocol";

/**
 * A menu's commands, from the shared command table: the item's action is the
 * command id, and its accelerator comes from the command's key. A click
 * reaches `application-menu-clicked` with that id (see `index.ts`).
 */
export function commandItems(bar: CommandMenu): ApplicationMenuItemConfig[][] {
  return menuSections(bar).map((section) =>
    section.map(({ id, title, accelerator }) => ({
      label: title,
      action: id,
      ...(accelerator ? { accelerator } : {}),
    })),
  );
}

const divided = (
  sections: ApplicationMenuItemConfig[][],
): ApplicationMenuItemConfig[] =>
  sections.flatMap((section, index) =>
    index === 0 ? section : [{ type: "divider" } as const, ...section],
  );

export function buildApplicationMenu(): ApplicationMenuItemConfig[] {
  const [updates = [], quit = []] = commandItems("Daedalus");
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
    { label: "View", submenu: divided(commandItems("View")) },
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
