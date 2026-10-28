/**
 * The ⌘K palette's decisions as plain functions: how well a row matches a
 * query, which rows show in which order, the actions of a row, and what was
 * used lately. `CommandPalette.tsx` only draws the result.
 *
 * One field searches everything, as Raycast's does: sessions, tasks,
 * workspaces, every command, the views and the settings pages. There are no
 * prefixes; each row says what kind of thing it is.
 */

/** What a row is. */
export type PaletteKind =
  "session" | "task" | "workspace" | "action" | "view" | "setting" | "file";

export const KIND_LABELS: Record<PaletteKind, string> = {
  session: "Session",
  task: "Task",
  workspace: "Workspace",
  action: "Command",
  view: "View",
  setting: "Settings",
  file: "File",
};

/** Equal matches show in this order: places before commands. */
const KIND_ORDER: readonly PaletteKind[] = [
  "file",
  "session",
  "task",
  "workspace",
  "action",
  "view",
  "setting",
];

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

/** One row of the palette. */
export interface PaletteEntry {
  /** Unique across the palette: `command:tab.close`, `session:<id>`. */
  key: string;
  kind: PaletteKind;
  title: string;
  /** Muted text after the title: a workspace, a status. */
  subtitle?: string;
  /** More words it is found by, not shown. */
  keywords?: string;
  /** Its key as glyphs, shown on the right. */
  shortcut?: string;
}

export type PaletteSectionId =
  "selected" | "recent" | "suggestions" | "results";

export interface PaletteGroup<T extends PaletteEntry> {
  id: PaletteSectionId;
  title: string;
  entries: T[];
}

/** How many rows a search shows, so a big board does not flood the list. */
export const RESULT_LIMIT = 60;

/** How many recent rows show when nothing is typed. */
export const RECENT_SHOWN = 6;

/** A match on the title beats any match on the subtitle or keywords. */
const OTHER_TEXT_PENALTY = 600;
/** The lift of the most recent row; older ones get less. */
const RECENT_BONUS = 300;
/** The lift of the session used most recently (the ⌃Tab order). */
const BOOST_BONUS = 200;

/** A lift for being early in `list`: `bonus` for the first, less after. */
const lift = (list: readonly string[], key: string, bonus: number) => {
  const index = list.indexOf(key);
  return index < 0 ? 0 : bonus * (1 - index / Math.max(list.length, 1));
};

/**
 * How well an entry matches: on its title (fuzzily), else on all its words
 * (title, subtitle, keywords and kind), where each word of the query must
 * appear as written, so "session api" finds a session called "api" and a
 * workspace's name finds its sessions, without stray letters across a long
 * subtitle matching everything.
 */
export function entryScore(
  entry: PaletteEntry,
  query: string,
): number | undefined {
  const onTitle = fuzzyScore(query, entry.title);
  if (onTitle !== undefined) return onTitle;
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return 0;
  const text = [
    entry.title,
    entry.subtitle,
    entry.keywords,
    KIND_LABELS[entry.kind],
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  let total = 0;
  for (const word of words) {
    if (!text.includes(word)) return undefined;
    total += fuzzyScore(word, text) ?? 0;
  }
  return total / words.length - OTHER_TEXT_PENALTY;
}

export interface RankOptions {
  /** Keys chosen lately in the palette, most recent first. */
  recent?: readonly string[];
  /** Keys offered when nothing is typed, in order. */
  suggestions?: readonly string[];
  /** Keys to lift a little in a search (the sessions used lately). */
  boost?: readonly string[];
  /** The key of the item that had focus: first when nothing is typed. */
  selected?: string;
}

/**
 * The rows for a query, in sections. With nothing typed: the focused item,
 * then Recent (rows chosen lately), then Suggestions. With text: one list of
 * every matching row, best first, lifted by recent use, so Enter runs the
 * best match whatever kind it is.
 */
export function rankPalette<T extends PaletteEntry>(
  entries: readonly T[],
  query: string,
  { recent = [], suggestions = [], boost = [], selected }: RankOptions = {},
): PaletteGroup<T>[] {
  const text = query.trim();
  const byKey = new Map(entries.map((entry) => [entry.key, entry]));
  if (!text) {
    const shown = new Set<string>();
    const take = (keys: readonly string[], limit = Infinity) => {
      const rows: T[] = [];
      for (const key of keys) {
        const entry = byKey.get(key);
        if (!entry || shown.has(key) || rows.length >= limit) continue;
        shown.add(key);
        rows.push(entry);
      }
      return rows;
    };
    const groups: PaletteGroup<T>[] = [
      {
        id: "selected",
        title: "Selected",
        entries: take(selected ? [selected] : []),
      },
      { id: "recent", title: "Recent", entries: take(recent, RECENT_SHOWN) },
      { id: "suggestions", title: "Suggestions", entries: take(suggestions) },
    ];
    return groups.filter((group) => group.entries.length > 0);
  }
  const scored = entries.flatMap((entry, order) => {
    const score = entryScore(entry, text);
    if (score === undefined) return [];
    return [
      {
        entry,
        order,
        score:
          score +
          lift(recent, entry.key, RECENT_BONUS) +
          lift(boost, entry.key, BOOST_BONUS),
      },
    ];
  });
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      KIND_ORDER.indexOf(a.entry.kind) - KIND_ORDER.indexOf(b.entry.kind) ||
      a.order - b.order,
  );
  const rows = scored.slice(0, RESULT_LIMIT).map(({ entry }) => entry);
  return rows.length > 0
    ? [{ id: "results", title: "Results", entries: rows }]
    : [];
}

/** The rows in display order, for moving the active row with the arrows. */
export const flattenGroups = <T extends PaletteEntry>(
  groups: readonly PaletteGroup<T>[],
): T[] => groups.flatMap((group) => group.entries);

/** The parts of an action the Actions panel searches. */
export interface SearchableAction {
  id: string;
  label: string;
  description?: string;
}

/**
 * A row's actions that match the Actions panel's field, best first; all of
 * them, in their own order, when nothing is typed.
 */
export function filterActions<T extends SearchableAction>(
  actions: readonly T[],
  query: string,
): T[] {
  if (!query.trim()) return [...actions];
  return actions
    .flatMap((action, order) => {
      const onLabel = fuzzyScore(query, action.label);
      const score =
        onLabel ??
        (action.description
          ? fuzzyScore(query, `${action.label} ${action.description}`)
          : undefined);
      return score === undefined ? [] : [{ action, order, score }];
    })
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .map(({ action }) => action);
}

/** How many recent rows are kept. */
export const RECENT_LIMIT = 12;

/** `key` moved to the front of the recent list, which keeps its length. */
export function recordRecent(
  recent: readonly string[],
  key: string,
  limit = RECENT_LIMIT,
): string[] {
  return [key, ...recent.filter((item) => item !== key)].slice(0, limit);
}

const STORAGE_KEY = "daedalus.palette.recent";

/**
 * The window's storage, read inside the caller's `try`: merely touching
 * `localStorage` throws where storage is denied.
 */
const windowStorage = (): Storage | undefined => globalThis.localStorage;

/** The rows chosen lately, kept in this window's storage, if it has any. */
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
