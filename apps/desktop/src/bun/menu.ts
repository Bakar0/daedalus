import type { ApplicationMenuItemConfig } from "electrobun/main";

export const APPLICATION_MENU: ApplicationMenuItemConfig[] = [
  {
    label: "Daedalus",
    submenu: [
      { role: "about" },
      { type: "divider" },
      { role: "hide" },
      { role: "hideOthers" },
      { role: "showAll" },
      { type: "divider" },
      { role: "quit" },
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
