import type { ApplicationMenuItemConfig } from "electrobun/bun";
import { QUIT_MENU_ACTION, SHUTDOWN_MENU_ACTION } from "@daedalus/protocol";

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
      // The discoverable off switch, for people who never open a terminal.
      // It archives every live session, closes the terminals and ends the
      // Daedalus tmux server, which is exactly `daedal shutdown`.
      {
        label: "Quit and Shut Down Sessions",
        action: SHUTDOWN_MENU_ACTION,
        accelerator: "Command+Shift+Q",
      },
      // Deliberately not `{ role: "quit" }`. That is a native macOS role, so
      // Cmd+Q would terminate the app without ever reaching our code and the
      // user would never be told what keeps running.
      {
        label: "Quit Daedalus",
        action: QUIT_MENU_ACTION,
        accelerator: "Command+Q",
      },
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
      {
        label: "Workspace",
        action: "view-workspace",
        accelerator: "Command+1",
      },
      { label: "Board", action: "view-board", accelerator: "Command+2" },
      {
        label: "Sessions",
        action: "view-sessions",
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
