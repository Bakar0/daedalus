import { lstat, readdir } from "node:fs/promises";
import { isAbsolute, join, normalize, relative, sep } from "node:path";
import {
  findRipgrepExecutable,
  streamCommandLines,
  type LineStreamResult,
} from "@daedalus/platform";
import { DaedalusError } from "../errors";

/**
 * Search for the ⌘K palette: the files under a root and the lines inside
 * them. The root is a workspace's folder, or at Home the whole Daedalus home.
 * Both lists skip what git ignores, `.git`, `node_modules` and Daedalus's
 * own markers; at Home also the folders that hold accounts, logs and other
 * machinery nobody searches for, and the databases.
 *
 * The file list comes from `rg --files` (a walk in JS when there is no
 * ripgrep), cached per root for a short while; the palette scores it itself.
 * Content search is ripgrep's, stopped at a cap or when the query changes.
 */

/** Where a search looks. `home` adds Home's own skip list. */
export interface SearchRoot {
  path: string;
  home: boolean;
}

/**
 * Skipped under every root, at any depth; also any folder ending in `.git`,
 * a bare repository like the library's mirrors in `repos/`.
 */
export const SKIPPED_EVERYWHERE = [".git", "node_modules", ".daedalus"];

/** Skipped at the top of the Daedalus home. */
export const HOME_SKIPPED_FOLDERS = [
  "accounts",
  "remote",
  "claude-settings",
  "inbox",
  "logs",
  "telemetry",
  "trash",
];

/**
 * Session worktrees at Home: each is another checkout of a repository the
 * workspace has under `repos/`, so at Home they would list every file once
 * per session. A workspace's own search still covers its worktrees.
 */
export const HOME_SKIPPED_WORKTREES = "workspaces/*/worktrees";

/** File names skipped at Home: SQLite and its sidecars. */
export const HOME_SKIPPED_FILES = ["*.db", "*.db-wal", "*.db-shm"];

/** The most files a list holds; a bigger tree says it was cut. */
export const SEARCH_FILE_LIMIT = 50_000;
/** How long a root's list is reused before it is read again. */
export const SEARCH_FILE_TTL_MS = 30_000;
/** The most lines a content search returns. */
export const CONTENT_RESULT_LIMIT = 200;
/** The longest matching line returned, in characters. */
export const CONTENT_LINE_LIMIT = 240;
/** Content search starts at this many characters. */
export const CONTENT_MIN_QUERY = 3;
/** The largest file a preview reads. */
const PREVIEW_MAX_BYTES = 1024 * 1024;

export const RIPGREP_MISSING_MESSAGE =
  "Content search needs ripgrep, and none was found: the app's own is missing and there is no rg on PATH. Install it with `brew install ripgrep`.";

/** ripgrep's globs for a root's skip rules. */
export function ripgrepSkipArgs(root: SearchRoot): string[] {
  const globs = [
    ...SKIPPED_EVERYWHERE.map((name) => `!${name}`),
    "!*.git/",
    ...(root.home
      ? [
          ...HOME_SKIPPED_FOLDERS.map((name) => `!/${name}/`),
          `!/${HOME_SKIPPED_WORKTREES}/`,
          ...HOME_SKIPPED_FILES.map((name) => `!${name}`),
        ]
      : []),
  ];
  return globs.flatMap((glob) => ["--glob", glob]);
}

/** The same rules as `ripgrepSkipArgs`, for the walk without ripgrep. */
export function isSkippedPath(relativePath: string, home: boolean): boolean {
  const parts = relativePath.split("/");
  if (
    parts.some(
      (part) => SKIPPED_EVERYWHERE.includes(part) || part.endsWith(".git"),
    )
  )
    return true;
  if (!home) return false;
  if (HOME_SKIPPED_FOLDERS.includes(parts[0]!)) return true;
  if (parts[0] === "workspaces" && parts[2] === "worktrees") return true;
  const name = parts[parts.length - 1] ?? "";
  return /\.db(-wal|-shm)?$/.test(name);
}

const COMMON_ARGS = ["--no-config", "--hidden", "--no-require-git"];

export interface ContentMatch {
  /** Relative to the root, with forward slashes. */
  path: string;
  line: number;
  /** The line, cut to `CONTENT_LINE_LIMIT` around its first hit. */
  text: string;
  /** Where the query is in `text`: [start, end) in characters. */
  ranges: [number, number][];
}

const stripDot = (path: string) =>
  path.startsWith("./") ? path.slice(2) : path;

const textOf = (value: unknown): string | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const record = value as { text?: unknown; bytes?: unknown };
  if (typeof record.text === "string") return record.text;
  if (typeof record.bytes === "string")
    return Buffer.from(record.bytes, "base64").toString("utf8");
  return undefined;
};

/**
 * One line of `rg --json` as a match, or undefined for anything else (begin,
 * end, summary, context). ripgrep gives hits as byte offsets; they become
 * character offsets here, and a long line is cut around its first hit.
 */
export function parseRipgrepLine(
  line: string,
  lineLimit = CONTENT_LINE_LIMIT,
): ContentMatch | undefined {
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!message || typeof message !== "object") return undefined;
  const { type, data } = message as { type?: unknown; data?: unknown };
  if (type !== "match" || !data || typeof data !== "object") return undefined;
  const record = data as {
    path?: unknown;
    lines?: unknown;
    line_number?: unknown;
    submatches?: unknown;
  };
  const path = textOf(record.path);
  const raw = textOf(record.lines);
  if (path === undefined || raw === undefined) return undefined;
  if (typeof record.line_number !== "number") return undefined;
  const full = raw.replace(/\r?\n$/, "");
  const bytes = new TextEncoder().encode(full);
  const decoder = new TextDecoder();
  const charAt = (byte: number) =>
    decoder.decode(bytes.slice(0, Math.min(byte, bytes.length))).length;
  const hits: [number, number][] = [];
  for (const sub of Array.isArray(record.submatches) ? record.submatches : []) {
    const { start, end } = (sub ?? {}) as { start?: unknown; end?: unknown };
    if (typeof start === "number" && typeof end === "number" && end > start)
      hits.push([charAt(start), charAt(end)]);
  }
  let text = full;
  let ranges = hits;
  if (full.length > lineLimit) {
    const first = hits[0]?.[0] ?? 0;
    const from = first > lineLimit / 3 ? first - Math.floor(lineLimit / 6) : 0;
    const to = Math.min(full.length, from + lineLimit);
    const lead = from > 0 ? "…" : "";
    text = `${lead}${full.slice(from, to)}${to < full.length ? "…" : ""}`;
    ranges = hits
      .filter(([start, end]) => start >= from && end <= to)
      .map(([start, end]) => [
        start - from + lead.length,
        end - from + lead.length,
      ]);
  }
  return { path: stripDot(path), line: record.line_number, text, ranges };
}

export interface FileList {
  files: string[];
  /** The tree held more than `SEARCH_FILE_LIMIT` files. */
  truncated: boolean;
}

export interface ContentResult {
  matches: ContentMatch[];
  /** More lines matched than were returned. */
  truncated: boolean;
  /** Set when there is no ripgrep to search with. */
  unavailable?: string;
}

export interface FilePreview {
  /** The first line's number. */
  start: number;
  lines: string[];
}

type Stream = typeof streamCommandLines;

export class SearchService {
  private readonly lists = new Map<
    string,
    { at: number; list: Promise<FileList> }
  >();

  constructor(
    private readonly ripgrep: () => string | undefined = () =>
      findRipgrepExecutable(),
    private readonly stream: Stream = streamCommandLines,
    private readonly now: () => number = Date.now,
    private readonly fileLimit = SEARCH_FILE_LIMIT,
  ) {}

  /**
   * The files under a root, relative and with forward slashes. Reused for
   * `SEARCH_FILE_TTL_MS`; `refresh` reads the tree again now.
   */
  listFiles(root: SearchRoot, refresh = false): Promise<FileList> {
    const key = `${root.home ? "home" : "folder"}:${root.path}`;
    const cached = this.lists.get(key);
    if (cached && !refresh && this.now() - cached.at < SEARCH_FILE_TTL_MS)
      return cached.list;
    const list = this.readFiles(root);
    this.lists.set(key, { at: this.now(), list });
    list.catch(() => {
      if (this.lists.get(key)?.list === list) this.lists.delete(key);
    });
    return list;
  }

  private async readFiles(root: SearchRoot): Promise<FileList> {
    const rg = this.ripgrep();
    if (!rg) return this.walk(root);
    const files: string[] = [];
    let truncated = false;
    const result = await this.stream(
      rg,
      ["--files", ...COMMON_ARGS, ...ripgrepSkipArgs(root), "."],
      {
        cwd: root.path,
        onLine: (line) => {
          if (!line) return true;
          if (files.length >= this.fileLimit) {
            truncated = true;
            return false;
          }
          files.push(stripDot(line));
          return true;
        },
      },
    );
    failUnlessFinished(result);
    return { files, truncated };
  }

  /** The list without ripgrep: the skip rules, but not `.gitignore`. */
  private async walk(root: SearchRoot): Promise<FileList> {
    const files: string[] = [];
    const folders = [""];
    while (folders.length > 0) {
      const folder = folders.shift()!;
      const entries = await readdir(join(root.path, folder), {
        withFileTypes: true,
      }).catch(() => []);
      for (const entry of entries) {
        const path = folder ? `${folder}/${entry.name}` : entry.name;
        if (isSkippedPath(path, root.home)) continue;
        if (entry.isDirectory()) folders.push(path);
        else if (entry.isFile()) {
          if (files.length >= this.fileLimit) return { files, truncated: true };
          files.push(path);
        }
      }
    }
    return { files, truncated: false };
  }

  /**
   * The lines under a root that hold `query`, as typed (not a pattern):
   * case-insensitive unless it has a capital. At most `limit` lines, and
   * none for a query under `CONTENT_MIN_QUERY` characters. Aborting
   * `signal` stops ripgrep and gives what was found so far.
   */
  async searchContent(
    root: SearchRoot,
    query: string,
    options: {
      signal?: AbortSignal;
      limit?: number;
      /** Each line as ripgrep finds it, before the search ends. */
      onMatch?: (match: ContentMatch) => void;
    } = {},
  ): Promise<ContentResult> {
    const limit = options.limit ?? CONTENT_RESULT_LIMIT;
    if (query.trim().length < CONTENT_MIN_QUERY)
      return { matches: [], truncated: false };
    const rg = this.ripgrep();
    if (!rg)
      return {
        matches: [],
        truncated: false,
        unavailable: RIPGREP_MISSING_MESSAGE,
      };
    const matches: ContentMatch[] = [];
    let truncated = false;
    const result = await this.stream(
      rg,
      [
        "--json",
        ...COMMON_ARGS,
        "--fixed-strings",
        "--smart-case",
        "--max-filesize",
        "1M",
        "--max-count",
        "20",
        ...ripgrepSkipArgs(root),
        "--",
        query,
        ".",
      ],
      {
        cwd: root.path,
        ...(options.signal ? { signal: options.signal } : {}),
        onLine: (line) => {
          const match = parseRipgrepLine(line);
          if (!match) return true;
          if (matches.length >= limit) {
            truncated = true;
            return false;
          }
          matches.push(match);
          options.onMatch?.(match);
          return true;
        },
      },
    );
    if (!options.signal?.aborted) failUnlessFinished(result);
    matches.sort((a, b) =>
      a.path === b.path ? a.line - b.line : a.path < b.path ? -1 : 1,
    );
    return { matches, truncated };
  }

  /**
   * Lines of a text file under a root: around `line` when given, else its
   * start. Refuses a path outside the root, a link, or a binary file.
   */
  async preview(
    root: SearchRoot,
    path: string,
    line?: number,
    count = 40,
  ): Promise<FilePreview> {
    if (isAbsolute(path) || normalize(path).split(sep).includes(".."))
      throw new DaedalusError("VALIDATION", `'${path}' is not under the root`);
    const absolute = join(root.path, path);
    if (relative(root.path, absolute).startsWith(".."))
      throw new DaedalusError("VALIDATION", `'${path}' is not under the root`);
    const info = await lstat(absolute).catch(() => undefined);
    if (!info?.isFile())
      throw new DaedalusError("NOT_FOUND", `No file at ${path}`);
    const bytes = new Uint8Array(
      await Bun.file(absolute).slice(0, PREVIEW_MAX_BYTES).arrayBuffer(),
    );
    if (bytes.slice(0, 8192).includes(0)) return { start: 1, lines: [] };
    const all = new TextDecoder().decode(bytes).split(/\r?\n/);
    const start = line ? Math.max(1, line - 4) : 1;
    return {
      start,
      lines: all
        .slice(start - 1, start - 1 + count)
        .map((text) =>
          text.length > CONTENT_LINE_LIMIT
            ? `${text.slice(0, CONTENT_LINE_LIMIT)}…`
            : text,
        ),
    };
  }
}

/**
 * ripgrep exits 0 with matches, 1 with none, and 2 when it hit an error on
 * the way, such as a file it may not read; what it found is still the answer.
 */
function failUnlessFinished(result: LineStreamResult): void {
  if (result.stopped || [0, 1, 2].includes(result.exitCode)) return;
  throw new DaedalusError(
    "INTERNAL",
    `ripgrep failed: ${result.stderr.trim().split("\n")[0] || `exit ${result.exitCode}`}`,
  );
}

/** A slice of a running content search, from the line asked for on. */
export interface ContentSlice {
  matches: ContentMatch[];
  /** The index of the first line in `matches`. */
  from: number;
  /** The search has ended; nothing more will come. */
  done: boolean;
  truncated: boolean;
  unavailable?: string;
}

/**
 * One content search at a time, read in slices while it runs, so the
 * palette shows lines as ripgrep finds them. Asking for another query or
 * root stops the one before. A read waits until there is a line past
 * `from`, the search ends, or `waitMs` passes, whichever is first.
 */
export class LiveContentSearch {
  private current:
    | {
        key: string;
        matches: ContentMatch[];
        done: boolean;
        truncated: boolean;
        unavailable?: string;
        error?: unknown;
        controller: AbortController;
        changed: Set<() => void>;
      }
    | undefined;

  constructor(
    private readonly service: Pick<SearchService, "searchContent">,
    private readonly waitMs = 300,
  ) {}

  async read(root: SearchRoot, query: string, from = 0): Promise<ContentSlice> {
    const key = `${root.home ? "home" : "folder"}:${root.path}\0${query}`;
    if (this.current?.key !== key) this.start(key, root, query);
    const search = this.current!;
    if (search.matches.length <= from && !search.done)
      await new Promise<void>((resolve) => {
        const timer = setTimeout(finish, this.waitMs);
        function finish() {
          clearTimeout(timer);
          search.changed.delete(check);
          resolve();
        }
        function check() {
          if (search.matches.length > from || search.done) finish();
        }
        search.changed.add(check);
      });
    if (search.error) throw search.error;
    return {
      matches: search.matches.slice(from),
      from,
      done: search.done,
      truncated: search.truncated,
      ...(search.unavailable ? { unavailable: search.unavailable } : {}),
    };
  }

  /** Stops the running search, if any. */
  stop(): void {
    this.current?.controller.abort();
    this.current = undefined;
  }

  private start(key: string, root: SearchRoot, query: string): void {
    this.current?.controller.abort();
    const search: NonNullable<LiveContentSearch["current"]> = {
      key,
      matches: [],
      done: false,
      truncated: false,
      controller: new AbortController(),
      changed: new Set(),
    };
    this.current = search;
    const notify = () => {
      for (const check of [...search.changed]) check();
    };
    this.service
      .searchContent(root, query, {
        signal: search.controller.signal,
        onMatch: (match) => {
          search.matches.push(match);
          notify();
        },
      })
      .then(
        (result) => {
          search.truncated = result.truncated;
          if (result.unavailable) search.unavailable = result.unavailable;
        },
        (error: unknown) => {
          search.error = error;
        },
      )
      .finally(() => {
        search.done = true;
        notify();
      });
  }
}
