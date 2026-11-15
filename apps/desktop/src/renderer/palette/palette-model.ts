/**
 * The ⌘K palette's decisions as plain functions: how well a row matches a
 * query, which rows show in which order, the actions of a row, and what was
 * used lately. `CommandPalette.tsx` only draws the result.
 *
 * One field searches everything, as Raycast's does: sessions, tasks,
 * workspaces, every command, the views and the settings pages, and the files
 * of the workspace on screen (all of the Daedalus home at Home), by name and
 * by content, and its plans. Scope chips under the field narrow it to one
 * kind; Tab cycles them, and a leading `/` goes to Content. Each row says
 * what kind of thing it is.
 */

/** What a row is. */
export type PaletteKind =
  | "session"
  | "task"
  | "workspace"
  | "action"
  | "view"
  | "setting"
  | "file"
  | "content"
  | "plan"
  | "plan-task";

export const KIND_LABELS: Record<PaletteKind, string> = {
  session: "Session",
  task: "Task",
  workspace: "Workspace",
  action: "Command",
  view: "View",
  setting: "Settings",
  file: "File",
  content: "Content",
  plan: "Plan",
  "plan-task": "Plan task",
};

/** Equal matches show in this order: places before commands. */
const KIND_ORDER: readonly PaletteKind[] = [
  "file",
  "content",
  "plan",
  "plan-task",
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
  "selected" | "recent" | "suggestions" | "results" | PaletteBucket;

export interface PaletteGroup<T extends PaletteEntry> {
  id: PaletteSectionId;
  title: string;
  entries: T[];
  /** How many match in all, when the group shows only the first few. */
  total?: number;
  /** The scope that shows them all ("All N →"). */
  scope?: PaletteScope;
}

/** How many rows a search shows, so a big board does not flood the list. */
export const RESULT_LIMIT = 60;

/** How many rows of each kind All shows once something is typed. */
export const ALL_GROUP_SHOWN = 3;

/** Content search starts at this many characters, as the host's does. */
export const CONTENT_MIN_QUERY = 3;

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

/** Every entry that matches `text`, best first, lifted by recent use. */
function scoreEntries<T extends PaletteEntry>(
  entries: readonly T[],
  text: string,
  { recent = [], boost = [] }: Pick<RankOptions, "recent" | "boost">,
): { entry: T; score: number }[] {
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
  return scored;
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
  const rows = scoreEntries(entries, text, { recent, boost })
    .slice(0, RESULT_LIMIT)
    .map(({ entry }) => entry);
  return rows.length > 0
    ? [{ id: "results", title: "Results", entries: rows }]
    : [];
}

/** What the chips under the field narrow the palette to. */
export type PaletteScope =
  "all" | "files" | "content" | "sessions" | "plans" | "commands";

export const PALETTE_SCOPES: readonly { id: PaletteScope; label: string }[] = [
  { id: "all", label: "All" },
  { id: "files", label: "Files" },
  { id: "content", label: "Content" },
  { id: "sessions", label: "Sessions" },
  { id: "plans", label: "Plans" },
  { id: "commands", label: "Commands" },
];

/** The scope after `scope`, or before it with Shift, wrapping round. */
export function cycleScope(
  scope: PaletteScope,
  backwards = false,
): PaletteScope {
  const index = PALETTE_SCOPES.findIndex((item) => item.id === scope);
  const step = backwards ? PALETTE_SCOPES.length - 1 : 1;
  return PALETTE_SCOPES[(index + step) % PALETTE_SCOPES.length]!.id;
}

/**
 * The field's new text and scope after an edit: a `/` typed into an empty
 * field switches to Content and is not kept.
 */
export function scopedInput(
  previous: string,
  next: string,
  scope: PaletteScope,
): { query: string; scope: PaletteScope } {
  if (previous === "" && next.startsWith("/"))
    return { query: next.slice(1), scope: "content" };
  return { query: next, scope };
}

/** The groups All shows, in this order when their best matches tie. */
export type PaletteBucket =
  | "files"
  | "content"
  | "sessions"
  | "tasks"
  | "plans"
  | "workspaces"
  | "commands";

const BUCKETS: readonly {
  id: PaletteBucket;
  title: string;
  scope?: PaletteScope;
}[] = [
  { id: "files", title: "Files", scope: "files" },
  { id: "content", title: "Content", scope: "content" },
  { id: "sessions", title: "Sessions", scope: "sessions" },
  { id: "tasks", title: "Tasks" },
  { id: "plans", title: "Plans", scope: "plans" },
  { id: "workspaces", title: "Workspaces" },
  { id: "commands", title: "Commands", scope: "commands" },
];

/** The group a row belongs to. Tasks and workspaces have no scope of their own. */
export function bucketOf(kind: PaletteKind): PaletteBucket {
  switch (kind) {
    case "file":
      return "files";
    case "content":
      return "content";
    case "session":
      return "sessions";
    case "task":
      return "tasks";
    case "plan":
    case "plan-task":
      return "plans";
    case "workspace":
      return "workspaces";
    default:
      return "commands";
  }
}

/** Points a file gets when the query is in its name rather than its path. */
const NAME_BONUS = 300;

/**
 * How well `query` matches a file's path, higher is better: its name counts
 * over the folders it is in, so `cart` finds `cart.ts` before
 * `cart/rate-limit.ts`.
 */
export function fileScore(query: string, path: string): number | undefined {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const onName = fuzzyScore(query, name);
  if (onName !== undefined) return onName + NAME_BONUS - path.length / 100;
  return fuzzyScore(query, path);
}

/** The best `limit` paths for a query, and how many matched in all. */
export function rankFiles(
  paths: readonly string[],
  query: string,
  limit = 200,
): { paths: string[]; total: number; best?: number } {
  if (!query.trim()) return { paths: [], total: 0 };
  const scored: { path: string; score: number }[] = [];
  for (const path of paths) {
    const score = fileScore(query, path);
    if (score !== undefined) scored.push({ path, score });
  }
  scored.sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : 1));
  return {
    paths: scored.slice(0, limit).map((item) => item.path),
    total: scored.length,
    ...(scored[0] ? { best: scored[0].score } : {}),
  };
}

/** Rows that come from a search of their own rather than the entry list. */
export interface SearchedRows<T> {
  rows: readonly T[];
  /** How many matched in all; more than `rows` when the list is cut. */
  total: number;
  /** The best match's score, to place the group in All. */
  best?: number;
}

export interface ScopedResult<T extends PaletteEntry> {
  groups: PaletteGroup<T>[];
  /** How many rows match, by scope, for the chips. */
  counts: Record<Exclude<PaletteScope, "all">, number>;
}

/**
 * The rows for a query in a scope. All with nothing typed is `rankPalette`'s
 * Selected, Recent and Suggestions. All with text is one group per kind,
 * each its best `ALL_GROUP_SHOWN` rows with "All N →" to its scope, the
 * group with the best match first so Enter still runs the best match. One
 * scope lists everything it has that matches (all of it with nothing typed,
 * except files and content, which wait for a query).
 */
export function rankScoped<T extends PaletteEntry>(
  entries: readonly T[],
  searched: { files: SearchedRows<T>; content: SearchedRows<T> },
  query: string,
  scope: PaletteScope,
  options: RankOptions = {},
): ScopedResult<T> {
  const text = query.trim();
  const byBucket = new Map<PaletteBucket, { rows: T[]; best?: number }>();
  const add = (bucket: PaletteBucket, entry: T, score?: number) => {
    const group = byBucket.get(bucket) ?? { rows: [] };
    group.rows.push(entry);
    if (score !== undefined && group.best === undefined) group.best = score;
    byBucket.set(bucket, group);
  };
  if (text)
    for (const { entry, score } of scoreEntries(entries, text, options))
      add(bucketOf(entry.kind), entry, score);
  else for (const entry of entries) add(bucketOf(entry.kind), entry);
  const files = byBucket.get("files")?.rows ?? [];
  const fileKeys = new Set(files.map((row) => row.key));
  const fileRows = [
    ...files,
    ...searched.files.rows.filter((row) => !fileKeys.has(row.key)),
  ];
  const sizes = (bucket: PaletteBucket) => byBucket.get(bucket)?.rows ?? [];
  const counts = {
    files: text ? Math.max(searched.files.total, fileRows.length) : 0,
    content: searched.content.total,
    sessions: text ? sizes("sessions").length : 0,
    plans: text ? sizes("plans").length : 0,
    commands: text ? sizes("commands").length : 0,
  };
  const rowsOf = (bucket: PaletteBucket): readonly T[] =>
    bucket === "files"
      ? text
        ? fileRows
        : []
      : bucket === "content"
        ? searched.content.rows
        : sizes(bucket);
  const totalOf = (bucket: PaletteBucket) =>
    bucket === "files"
      ? counts.files
      : bucket === "content"
        ? counts.content
        : sizes(bucket).length;

  if (scope === "all") {
    if (!text) return { groups: rankPalette(entries, query, options), counts };
    const bestOf = (bucket: PaletteBucket) =>
      bucket === "files"
        ? Math.max(
            byBucket.get("files")?.best ?? -Infinity,
            searched.files.best ?? -Infinity,
          )
        : bucket === "content"
          ? (searched.content.best ?? -Infinity)
          : (byBucket.get(bucket)?.best ?? -Infinity);
    const groups = BUCKETS.map((bucket, order) => ({ bucket, order }))
      .filter(({ bucket }) => rowsOf(bucket.id).length > 0)
      .sort(
        (a, b) =>
          bestOf(b.bucket.id) - bestOf(a.bucket.id) || a.order - b.order,
      )
      .map(({ bucket }): PaletteGroup<T> => {
        const rows = rowsOf(bucket.id);
        const total = Math.max(totalOf(bucket.id), rows.length);
        return {
          id: bucket.id,
          title: bucket.title,
          entries: rows.slice(0, ALL_GROUP_SHOWN),
          ...(total > ALL_GROUP_SHOWN ? { total } : {}),
          ...(bucket.scope ? { scope: bucket.scope } : {}),
        };
      });
    return { groups, counts };
  }

  const wanted: PaletteBucket[] =
    scope === "files"
      ? ["files"]
      : scope === "content"
        ? ["content"]
        : scope === "sessions"
          ? ["sessions"]
          : scope === "plans"
            ? ["plans"]
            : ["commands"];
  const groups = wanted.flatMap((id): PaletteGroup<T>[] => {
    const bucket = BUCKETS.find((item) => item.id === id)!;
    const limit = id === "files" || id === "content" ? Infinity : RESULT_LIMIT;
    const rows = rowsOf(id).slice(0, text ? limit : Infinity);
    return rows.length > 0
      ? [{ id, title: bucket.title, entries: [...rows] }]
      : [];
  });
  return { groups, counts };
}

/**
 * Where `query` is in `text`, as [start, end) ranges for highlighting: every
 * occurrence of it, ignoring case, else (with `fuzzy`) the characters a
 * fuzzy match used.
 */
export function highlightRanges(
  query: string,
  text: string,
  fuzzy = true,
): [number, number][] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const t = text.toLowerCase();
  const ranges: [number, number][] = [];
  let at = t.indexOf(q);
  while (at >= 0) {
    ranges.push([at, at + q.length]);
    at = t.indexOf(q, at + q.length);
  }
  if (ranges.length > 0 || !fuzzy) return ranges;
  let from = 0;
  for (const char of q.replace(/\s+/g, "")) {
    const index = t.indexOf(char, from);
    if (index < 0) return [];
    const last = ranges[ranges.length - 1];
    if (last && last[1] === index) last[1] = index + 1;
    else ranges.push([index, index + 1]);
    from = index + 1;
  }
  return ranges;
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
