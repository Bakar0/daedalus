import type { ApplicationMenuItemConfig } from "electrobun/bun";

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
    label: "View",
    submenu: [
      { label: "Board", action: "view-board", accelerator: "Command+1" },
      {
        label: "Sessions",
        action: "view-sessions",
        accelerator: "Command+2",
      },
      {
        label: "Workspace",
        action: "view-workspace",
        accelerator: "Command+3",
      },
      { type: "divider" },
      {
        label: "Toggle Integrated Terminal",
        action: "toggle-terminal",
        accelerator: "Control+`",
      },
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
