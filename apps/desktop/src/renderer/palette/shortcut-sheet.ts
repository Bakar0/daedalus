/**
 * The shortcuts sheet's content as data: every command with keys, grouped as the
 * command table groups them, plus the keys elements answer to themselves
 * (the sidebar tree, the board, the file tree, a terminal), which are not
 * commands. The sections for where focus is come first.
 */
import {
  type CommandArea,
  type CommandId,
  commandSpec,
  parseKey,
  type CommandGroup,
  type CommandWhen,
  formatKeyGlyphs,
} from "@daedalus/protocol";

export interface SheetRow {
  label: string;
  /** Each alternative as glyphs: `["⌘S"]`, `["↑", "↓"]`. */
  keys: string[];
  /** The person rebound it; its keys are theirs, not the defaults. */
  changed?: boolean;
}

export interface SheetSection {
  title: string;
  /** Where its keys act; the sheet lists it first when focus is there. */
  areas: readonly CommandArea[];
  rows: SheetRow[];
}

/** The areas a command group belongs to, beyond its commands' own `when`. */
const GROUP_AREAS: Partial<Record<CommandGroup, readonly CommandArea[]>> = {
  Tabs: ["tabs", "editor", "center"],
  Terminal: ["terminal-panel", "terminal"],
  Panels: ["right-panel"],
  Go: ["sidebar"],
};

/** The parts of a command the sheet reads. */
export interface SheetCommand {
  title: string;
  group: CommandGroup;
  keys: readonly string[];
  when?: CommandWhen;
  changed?: boolean;
}

/**
 * One section per command group, in the order the table first uses each
 * group; a command with no key is left out.
 */
export function commandSheetSections(
  commands: readonly SheetCommand[],
): SheetSection[] {
  const groups = new Map<CommandGroup, SheetSection>();
  for (const command of commands) {
    if (command.keys.length === 0) continue;
    const section = groups.get(command.group) ?? {
      title: command.group,
      areas: [...(GROUP_AREAS[command.group] ?? [])],
      rows: [],
    };
    const areas = new Set(section.areas);
    for (const area of command.when?.areas ?? []) areas.add(area);
    groups.set(command.group, {
      ...section,
      areas: [...areas],
      rows: [
        ...section.rows,
        {
          label: command.title,
          keys: command.keys.map(formatKeyGlyphs),
          ...(command.changed ? { changed: true } : {}),
        },
      ],
    });
  }
  return [...groups.values()];
}

const glyphs = (...keys: string[]) => keys.map(formatKeyGlyphs);

/** The command keys the element sections name, overrides applied. */
export interface ElementSectionKeys {
  /** `palette.open`: in the palette it opens a row's actions. */
  palette: readonly string[];
  /** `session.switch` and `session.switchBack`. */
  switchSession: readonly string[];
  switchBack: readonly string[];
}

const defaultKeys = (id: CommandId) => commandSpec(id).keys;

/** The modifiers a key holds down, as glyphs: `⌃` for ⌃Tab. */
const heldGlyphs = (key: string | undefined) => {
  const chord = key ? parseKey(key)[0] : undefined;
  return chord
    ? `${chord.ctrl ? "⌃" : ""}${chord.alt ? "⌥" : ""}${chord.mod ? "⌘" : ""}`
    : "";
};

/**
 * Keys that belong to elements rather than commands, as docs/desktop.md
 * describes them. They are not rebound themselves, but the palette's
 * actions key and the switcher's keys are commands' keys, so a rebound
 * one shows as the person set it.
 */
export function elementKeySections(
  keys: ElementSectionKeys = {
    palette: defaultKeys("palette.open"),
    switchSession: defaultKeys("session.switch"),
    switchBack: defaultKeys("session.switchBack"),
  },
): SheetSection[] {
  const held = heldGlyphs(keys.switchSession[0]);
  return [
    {
      title: "Command palette",
      areas: [],
      rows: [
        { label: "Move between results", keys: glyphs("up", "down") },
        { label: "Run the result's main action", keys: glyphs("enter") },
        {
          label: "Show the result's actions",
          keys: glyphs(...keys.palette.slice(0, 1), "right"),
        },
        { label: "Back from the actions", keys: glyphs("escape", "left") },
        { label: "Close", keys: glyphs("escape") },
      ],
    },
    {
      title: "Session switcher",
      areas: [],
      rows: [
        {
          label: held
            ? `Next / previous session, while ${held} is held`
            : "Next / previous session",
          keys: glyphs(
            ...keys.switchSession.slice(0, 1),
            ...keys.switchBack.slice(0, 1),
          ),
        },
        {
          label: "Open the highlighted session",
          keys: held ? [`Release ${held}`] : glyphs("enter"),
        },
        { label: "Cancel", keys: glyphs("escape") },
      ],
    },
    ...STATIC_ELEMENT_SECTIONS,
  ];
}

const STATIC_ELEMENT_SECTIONS: readonly SheetSection[] = [
  {
    title: "Sidebar tree",
    areas: ["sidebar"],
    rows: [
      { label: "Move between items", keys: glyphs("up", "down") },
      {
        label: "Unfold a workspace, or enter its first session",
        keys: glyphs("right"),
      },
      { label: "Fold a workspace, or go to its parent", keys: glyphs("left") },
      { label: "First / last item", keys: glyphs("home", "end") },
      { label: "Next item starting with a letter", keys: ["A–Z"] },
      {
        label: "Select a workspace, or open a session in its terminal",
        keys: glyphs("enter"),
      },
      { label: "Reorder", keys: glyphs("alt+up", "alt+down") },
      {
        label: "Dismiss a failed launch, delete an archived session",
        keys: glyphs("delete"),
      },
    ],
  },
  {
    title: "Board",
    areas: ["board"],
    rows: [
      {
        label: "Move within a lane and on to the next",
        keys: glyphs("up", "down"),
      },
      { label: "Change lane", keys: glyphs("left", "right") },
      { label: "First / last card of the lane", keys: glyphs("home", "end") },
      { label: "Open the task", keys: glyphs("enter", "space") },
      { label: "Quick capture: add the task", keys: glyphs("enter") },
    ],
  },
  {
    title: "File tree",
    areas: ["right-panel"],
    rows: [
      {
        label: "Move, unfold and fold",
        keys: glyphs("up", "down", "left", "right"),
      },
      { label: "Rename", keys: glyphs("f2") },
      { label: "Open the file in a kept tab", keys: glyphs("mod+down") },
      { label: "Cut / copy / paste", keys: glyphs("mod+x", "mod+c", "mod+v") },
      { label: "Delete", keys: glyphs("mod+backspace", "delete") },
      { label: "Undo the last delete", keys: glyphs("mod+z") },
    ],
  },
  {
    title: "Terminal",
    areas: ["terminal", "terminal-panel"],
    rows: [
      { label: "New line without sending", keys: glyphs("shift+enter") },
      {
        label: "Start / end of the line",
        keys: glyphs("mod+left", "mod+right"),
      },
    ],
  },
  {
    title: "Task page",
    areas: ["center"],
    rows: [
      { label: "Save the brief", keys: glyphs("mod+enter") },
      { label: "Close the task page", keys: glyphs("escape") },
    ],
  },
  {
    title: "Tab strip",
    areas: ["tabs"],
    rows: [
      { label: "Move between tabs", keys: glyphs("left", "right") },
      { label: "First / last tab", keys: glyphs("home", "end") },
      { label: "Close the tab", keys: glyphs("delete") },
    ],
  },
  {
    title: "Menus and dialogs",
    areas: [],
    rows: [
      { label: "Move between items", keys: glyphs("up", "down") },
      { label: "Close, and give focus back", keys: glyphs("escape") },
    ],
  },
];

/**
 * The sections in the order the sheet shows them: those whose areas focus
 * is inside first, the innermost area's first, then the rest in their own
 * order.
 */
export function orderSheetSections(
  sections: readonly SheetSection[],
  focused: readonly CommandArea[],
): SheetSection[] {
  const rank = (section: SheetSection) => {
    const index = focused.findIndex((area) => section.areas.includes(area));
    return index < 0 ? Number.POSITIVE_INFINITY : index;
  };
  return sections
    .map((section, order) => ({ section, order, rank: rank(section) }))
    .sort((a, b) => a.rank - b.rank || a.order - b.order)
    .map(({ section }) => section);
}

/**
 * Only the rows that match the search: every word of it appears in the
 * row's label, its section's title or its keys' glyphs (so `⇧⌘[` and `tab
 * close` both find theirs). A section with none left is dropped.
 */
export function filterSheetSections(
  sections: readonly SheetSection[],
  query: string,
): SheetSection[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...sections];
  return sections.flatMap((section) => {
    const rows = section.rows.filter((row) => {
      const haystack =
        `${row.label} ${section.title} ${row.keys.join(" ")}`.toLowerCase();
      return words.every((word) => haystack.includes(word));
    });
    return rows.length > 0 ? [{ ...section, rows }] : [];
  });
}
