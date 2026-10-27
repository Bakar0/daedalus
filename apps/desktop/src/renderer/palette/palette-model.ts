/**
 * The ⌘K palette's decisions as plain functions: what a query asks for, how
 * well a row matches it, which rows show in which order, and the commands
 * used lately. `CommandPalette.tsx` only draws the result.
 */

/** What a query's first character narrows the palette to. */
export type PaletteMode = "all" | "commands" | "tasks" | "sessions";

const PREFIXES: Record<string, PaletteMode> = {
  ">": "commands",
  "#": "tasks",
  "@": "sessions",
};

/** `>` commands only, `#` tasks, `@` sessions; anything else searches all. */
export function parsePaletteQuery(raw: string): {
  mode: PaletteMode;
  text: string;
} {
  const mode = PREFIXES[raw.slice(0, 1)];
  return mode
    ? { mode, text: raw.slice(1).trim() }
    : { mode: "all", text: raw.trim() };
}

const isBoundary = (text: string, index: number) =>
  index === 0 || /[\s\-_./:#@(›·]/.test(text[index - 1] ?? "");

/**
 * How well `query` matches `text`, higher is better, or undefined for no
 * match. A run of the query inside the text scores most (more at a word's
 * start, and the earlier the better); otherwise every query character must
 * appear in order, with points for characters that follow each other or
 * start a word. Case and spaces in the query are ignored for the latter.
 */
export function fuzzyScore(query: string, text: string): number | undefined {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const t = text.toLowerCase();
  const at = t.indexOf(q);
  if (at >= 0)
    return 1_000 + (isBoundary(t, at) ? 500 : 0) - at - t.length / 100;
  const chars = q.replace(/\s+/g, "");
  let score = 0;
  let from = 0;
  let previous = -2;
  for (const char of chars) {
    const index = t.indexOf(char, from);
    if (index < 0) return undefined;
    score += 10;
    if (index === previous + 1) score += 15;
    if (isBoundary(t, index)) score += 20;
    previous = index;
    from = index + 1;
  }
  return score - t.length / 100;
}

/** The palette's groups, in the order they show when nothing is typed. */
export type PaletteSection =
  "item" | "commands" | "sessions" | "tasks" | "workspaces";

export const SECTION_TITLES: Record<PaletteSection, string> = {
  item: "Actions",
  commands: "Commands",
  sessions: "Sessions",
  tasks: "Tasks",
  workspaces: "Workspaces",
};

const SECTION_ORDER: readonly PaletteSection[] = [
  "item",
  "commands",
  "sessions",
  "tasks",
  "workspaces",
];

const MODE_SECTIONS: Record<PaletteMode, readonly PaletteSection[]> = {
  all: SECTION_ORDER,
  commands: ["commands"],
  tasks: ["tasks"],
  sessions: ["sessions"],
};

/** One row of the palette. */
export interface PaletteEntry {
  /** Unique across the palette: `command:tab.close`, `session:<id>`. */
  key: string;
  section: PaletteSection;
  title: string;
  /** Muted text after the title: a workspace, a status. */
  detail?: string;
  /** More words it is found by, not shown. */
  keywords?: string;
  /** Its key as glyphs, shown on the right. */
  shortcut?: string;
}

export interface PaletteGroup<T extends PaletteEntry> {
  section: PaletteSection;
  title: string;
  entries: T[];
}

/** How many rows a group shows, so a big board does not flood the list. */
export const GROUP_LIMIT = 50;

/** A recent command's lift over one that matched equally well. */
const RECENT_BONUS = 300;

/**
 * The rows for a query, grouped. The prefix picks the groups. With no text
 * every row shows in its group's order, recently used commands first.
 * With text only matching rows show, best first, and the groups are ordered
 * by their best row, so Enter runs the best match wherever it is; the
 * focused item's actions stay first, as what the palette was opened for.
 */
export function rankPalette<T extends PaletteEntry>(
  entries: readonly T[],
  raw: string,
  recent: readonly string[] = [],
): PaletteGroup<T>[] {
  const { mode, text } = parsePaletteQuery(raw);
  const allowed = MODE_SECTIONS[mode];
  const recency = (entry: T) => {
    if (entry.section !== "commands") return -1;
    const index = recent.indexOf(entry.key);
    return index < 0 ? -1 : recent.length - index;
  };
  const scored = entries.flatMap((entry, order) => {
    if (!allowed.includes(entry.section)) return [];
    const score = text
      ? fuzzyScore(
          text,
          [entry.title, entry.keywords].filter(Boolean).join(" "),
        )
      : 0;
    if (score === undefined) return [];
    const lift = recency(entry);
    return [
      {
        entry,
        order,
        lift,
        score: score + (text && lift > 0 ? RECENT_BONUS : 0),
      },
    ];
  });
  const groups = allowed.flatMap((section) => {
    const rows = scored
      .filter((row) => row.entry.section === section)
      .sort((a, b) =>
        text
          ? b.score - a.score || a.order - b.order
          : b.lift - a.lift || a.order - b.order,
      );
    if (rows.length === 0) return [];
    return [
      {
        section,
        title: SECTION_TITLES[section],
        best: rows[0]?.score ?? 0,
        entries: rows.slice(0, GROUP_LIMIT).map((row) => row.entry),
      },
    ];
  });
  if (text)
    groups.sort((a, b) =>
      a.section === "item"
        ? -1
        : b.section === "item"
          ? 1
          : b.best - a.best ||
            SECTION_ORDER.indexOf(a.section) - SECTION_ORDER.indexOf(b.section),
    );
  return groups.map(({ section, title, entries: rows }) => ({
    section,
    title,
    entries: rows,
  }));
}

/** The rows in display order, for moving the active row with the arrows. */
export const flattenGroups = <T extends PaletteEntry>(
  groups: readonly PaletteGroup<T>[],
): T[] => groups.flatMap((group) => group.entries);

/** How many recent commands are kept. */
export const RECENT_LIMIT = 8;

/** `key` moved to the front of the recent list, which keeps its length. */
export function recordRecent(
  recent: readonly string[],
  key: string,
  limit = RECENT_LIMIT,
): string[] {
  return [key, ...recent.filter((item) => item !== key)].slice(0, limit);
}

const STORAGE_KEY = "daedalus.palette.recent";

/** The recent commands kept in this window's storage, if it has any. */
/**
 * The window's storage, read inside the caller's `try`: merely touching
 * `localStorage` throws where storage is denied.
 */
const windowStorage = (): Storage | undefined => globalThis.localStorage;

export function loadRecent(storage?: Pick<Storage, "getItem">): string[] {
  try {
    const store = storage ?? windowStorage();
    const parsed: unknown = JSON.parse(store?.getItem(STORAGE_KEY) ?? "[]");
    return Array.isArray(parsed)
      ? parsed
          .filter((item): item is string => typeof item === "string")
          .slice(0, RECENT_LIMIT)
      : [];
  } catch {
    return [];
  }
}

export function saveRecent(
  recent: readonly string[],
  storage?: Pick<Storage, "setItem">,
): void {
  try {
    (storage ?? windowStorage())?.setItem(STORAGE_KEY, JSON.stringify(recent));
  } catch {
    // Forgetting what was used lately costs an ordering, nothing more.
  }
}
