import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { findRipgrepExecutable } from "@daedalus/platform";
import {
  CONTENT_LINE_LIMIT,
  type ContentMatch,
  type ContentResult,
  isSkippedPath,
  LiveContentSearch,
  parseRipgrepLine,
  RIPGREP_MISSING_MESSAGE,
  ripgrepSkipArgs,
  type SearchRoot,
  SearchService,
} from "./search";

const matchLine = (
  text: string,
  submatches: { start: number; end: number }[],
  path = "./src/a.ts",
  line = 7,
) =>
  JSON.stringify({
    type: "match",
    data: {
      path: { text: path },
      lines: { text: `${text}\n` },
      line_number: line,
      submatches: submatches.map((sub) => ({ match: { text: "" }, ...sub })),
    },
  });

describe("parseRipgrepLine", () => {
  test("a match gives its path, line and hit", () => {
    expect(
      parseRipgrepLine(matchLine("  discount(code)", [{ start: 2, end: 10 }])),
    ).toEqual({
      path: "src/a.ts",
      line: 7,
      text: "  discount(code)",
      ranges: [[2, 10]],
    });
  });

  test("byte offsets become character offsets after multi-byte text", () => {
    // "é" is two bytes, "→" three: the hit starts at byte 6, character 3.
    const parsed = parseRipgrepLine(
      matchLine("é→ discount", [{ start: 6, end: 14 }]),
    );
    expect(parsed?.ranges).toEqual([[3, 11]]);
    expect(parsed?.text.slice(3, 11)).toBe("discount");
  });

  test("a long line is cut around its first hit, and the hit kept", () => {
    const text = `${"x".repeat(1000)}needle${"y".repeat(1000)}`;
    const parsed = parseRipgrepLine(
      matchLine(text, [{ start: 1000, end: 1006 }]),
    )!;
    expect(parsed.text.length).toBeLessThanOrEqual(CONTENT_LINE_LIMIT + 2);
    const [start, end] = parsed.ranges[0]!;
    expect(parsed.text.slice(start, end)).toBe("needle");
    expect(parsed.text.startsWith("…")).toBe(true);
    expect(parsed.text.endsWith("…")).toBe(true);
  });

  test("a path ripgrep gives as bytes is decoded", () => {
    const line = JSON.stringify({
      type: "match",
      data: {
        path: { bytes: Buffer.from("odd/näme.txt").toString("base64") },
        lines: { text: "hit\n" },
        line_number: 1,
        submatches: [{ start: 0, end: 3 }],
      },
    });
    expect(parseRipgrepLine(line)?.path).toBe("odd/näme.txt");
  });

  test("begin, end, summary and garbage are not matches", () => {
    expect(parseRipgrepLine('{"type":"begin","data":{}}')).toBeUndefined();
    expect(parseRipgrepLine('{"type":"summary","data":{}}')).toBeUndefined();
    expect(parseRipgrepLine("not json")).toBeUndefined();
    expect(parseRipgrepLine("")).toBeUndefined();
  });
});

describe("skip rules", () => {
  test("every root skips .git, node_modules and Daedalus markers", () => {
    expect(isSkippedPath(".git/HEAD", false)).toBe(true);
    expect(isSkippedPath("app/node_modules/x/index.js", false)).toBe(true);
    expect(isSkippedPath("ws/.daedalus/workspace.json", false)).toBe(true);
    expect(isSkippedPath("src/index.ts", false)).toBe(false);
    expect(isSkippedPath("repos/abc.git/objects/pack/x", false)).toBe(true);
  });

  test("Home skips session worktrees, which copy the workspace's repos", () => {
    expect(isSkippedPath("workspaces/w/worktrees/s/r/a.ts", true)).toBe(true);
    expect(isSkippedPath("workspaces/w/repos/r/a.ts", true)).toBe(false);
    expect(isSkippedPath("worktrees/s/r/a.ts", false)).toBe(false);
  });

  test("only Home skips its machinery folders, and only at the top", () => {
    expect(isSkippedPath("accounts/a/profile.json", true)).toBe(true);
    expect(isSkippedPath("logs/app.log", true)).toBe(true);
    expect(isSkippedPath("workspaces/w/accounts/notes.md", true)).toBe(false);
    expect(isSkippedPath("accounts/a/profile.json", false)).toBe(false);
  });

  test("Home skips SQLite and its sidecars", () => {
    for (const name of ["daedalus.db", "daedalus.db-wal", "daedalus.db-shm"])
      expect(isSkippedPath(name, true)).toBe(true);
    expect(isSkippedPath("notes.md", true)).toBe(false);
  });

  test("ripgrep gets the same rules as globs, anchored at Home", () => {
    const home = ripgrepSkipArgs({ path: "/h", home: true });
    expect(home).toContain("!/accounts/");
    expect(home).toContain("!*.db-wal");
    expect(home).toContain("!node_modules");
    const folder = ripgrepSkipArgs({ path: "/w", home: false });
    expect(folder).not.toContain("!/accounts/");
    expect(folder).toContain("!.git");
  });
});

describe("SearchService on a real tree", () => {
  let home: string;
  const write = async (path: string, text = "hello\n") => {
    await mkdir(dirname(join(home, path)), { recursive: true });
    await writeFile(join(home, path), text);
  };

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "daedalus-search-"));
    await write("accounts/a/secret.txt", "needle in accounts\n");
    await write("logs/app.log", "needle in logs\n");
    await write("daedalus.db");
    await write("daedalus.db-wal");
    await write("workspaces/w/notes.md", "one\nthe needle is here\nthree\n");
    await write("workspaces/w/.gitignore", "build/\n");
    await write("workspaces/w/build/out.js", "needle in build\n");
    await write("workspaces/w/node_modules/x/i.js", "needle\n");
    await write("workspaces/w/.daedalus/workspace.json", "{}\n");
    await write("workspaces/w/accounts/plan.md", "needle kept\n");
    await write("workspaces/w/worktrees/s/notes.md", "needle in worktree\n");
    await write("repos/lib.git/HEAD", "needle in bare repo\n");
  });

  afterAll(async () => {
    await rm(home, { recursive: true, force: true });
  });

  const hasRipgrep = Boolean(findRipgrepExecutable());

  test.if(hasRipgrep)(
    "lists files without what is ignored or skipped",
    async () => {
      const service = new SearchService();
      const { files, truncated } = await service.listFiles({
        path: home,
        home: true,
      });
      expect(truncated).toBe(false);
      expect(files.sort()).toEqual([
        "workspaces/w/.gitignore",
        "workspaces/w/accounts/plan.md",
        "workspaces/w/notes.md",
      ]);
    },
  );

  test.if(hasRipgrep)("finds lines, with the hit", async () => {
    const service = new SearchService();
    const { matches, unavailable } = await service.searchContent(
      { path: home, home: true },
      "needle",
    );
    expect(unavailable).toBeUndefined();
    expect(matches.map((match) => `${match.path}:${match.line}`)).toEqual([
      "workspaces/w/accounts/plan.md:1",
      "workspaces/w/notes.md:2",
    ]);
    const notes = matches[1]!;
    const [start, end] = notes.ranges[0]!;
    expect(notes.text.slice(start, end)).toBe("needle");
  });

  test.if(hasRipgrep)("stops at the cap and says so", async () => {
    const service = new SearchService();
    const result = await service.searchContent(
      { path: home, home: false },
      "needle",
      { limit: 2 },
    );
    expect(result.matches).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });

  test("a short query searches nothing", async () => {
    const service = new SearchService();
    expect(
      await service.searchContent({ path: home, home: true }, "ne"),
    ).toEqual({ matches: [], truncated: false });
  });

  test("without ripgrep, content search says so instead of failing", async () => {
    const service = new SearchService(() => undefined);
    expect(
      await service.searchContent({ path: home, home: true }, "needle"),
    ).toEqual({
      matches: [],
      truncated: false,
      unavailable: RIPGREP_MISSING_MESSAGE,
    });
  });

  test("without ripgrep, files are walked with the skip rules", async () => {
    const service = new SearchService(() => undefined);
    const { files } = await service.listFiles({ path: home, home: true });
    // The walk cannot read .gitignore, so build/ is listed; the rest is not.
    expect(files.sort()).toEqual([
      "workspaces/w/.gitignore",
      "workspaces/w/accounts/plan.md",
      "workspaces/w/build/out.js",
      "workspaces/w/notes.md",
    ]);
  });

  test("a list is reused until it is stale or refreshed", async () => {
    let now = 0;
    let walks = 0;
    const service = new SearchService(
      () => {
        walks += 1;
        return undefined;
      },
      undefined,
      () => now,
    );
    const root = { path: home, home: true };
    await service.listFiles(root);
    await service.listFiles(root);
    expect(walks).toBe(1);
    await service.listFiles(root, true);
    expect(walks).toBe(2);
    now = 60_000;
    await service.listFiles(root);
    expect(walks).toBe(3);
  });

  test("the walk stops at the file cap", async () => {
    const service = new SearchService(() => undefined, undefined, Date.now, 2);
    const { files, truncated } = await service.listFiles({
      path: home,
      home: true,
    });
    expect(files).toHaveLength(2);
    expect(truncated).toBe(true);
  });

  test("a preview shows the lines around a hit, inside the root only", async () => {
    const service = new SearchService();
    const root = { path: home, home: true };
    expect(await service.preview(root, "workspaces/w/notes.md", 2)).toEqual({
      start: 1,
      lines: ["one", "the needle is here", "three", ""],
    });
    await expect(service.preview(root, "../etc/passwd")).rejects.toThrow();
    await expect(service.preview(root, "/etc/passwd")).rejects.toThrow();
  });
});

describe("LiveContentSearch", () => {
  const match = (line: number): ContentMatch => ({
    path: "a.ts",
    line,
    text: "hit",
    ranges: [[0, 3]],
  });

  /** A search that finds what `feed` hands it, ending when told to. */
  const fakeService = () => {
    const runs: {
      query: string;
      signal?: AbortSignal;
      onMatch?: (match: ContentMatch) => void;
      finish: () => void;
    }[] = [];
    return {
      runs,
      service: {
        searchContent: (
          _root: SearchRoot,
          query: string,
          options: {
            signal?: AbortSignal;
            onMatch?: (match: ContentMatch) => void;
          } = {},
        ) =>
          new Promise<ContentResult>((resolve) => {
            runs.push({
              query,
              ...options,
              finish: () => resolve({ matches: [], truncated: false }),
            });
          }),
      },
    };
  };
  const root = { path: "/w", home: false };

  test("hands out lines as they are found, then says it is done", async () => {
    const { runs, service } = fakeService();
    const live = new LiveContentSearch(service, 20);
    const first = live.read(root, "hit");
    runs[0]!.onMatch!(match(1));
    expect(await first).toMatchObject({ from: 0, done: false });
    expect((await first).matches).toHaveLength(1);
    // Nothing new yet: the read gives up after the wait, empty.
    expect(await live.read(root, "hit", 1)).toMatchObject({
      matches: [],
      done: false,
    });
    const rest = live.read(root, "hit", 1);
    runs[0]!.onMatch!(match(2));
    expect((await rest).matches.map((item) => item.line)).toEqual([2]);
    runs[0]!.finish();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await live.read(root, "hit", 2)).toMatchObject({ done: true });
    expect(runs).toHaveLength(1);
  });

  test("a new query stops the search before it", async () => {
    const { runs, service } = fakeService();
    const live = new LiveContentSearch(service, 5);
    await live.read(root, "one");
    await live.read(root, "two");
    expect(runs.map((run) => run.query)).toEqual(["one", "two"]);
    expect(runs[0]!.signal?.aborted).toBe(true);
    expect(runs[1]!.signal?.aborted).toBe(false);
  });
});
