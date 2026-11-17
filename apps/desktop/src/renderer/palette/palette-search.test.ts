import { describe, expect, test } from "vitest";
import {
  ALL_GROUP_SHOWN,
  cycleScope,
  fileScore,
  fuzzyScore,
  highlightRanges,
  PALETTE_SCOPES,
  type PaletteEntry,
  rankFiles,
  rankScoped,
  scopedInput,
  type SearchedRows,
} from "./palette-model";

const none: SearchedRows<PaletteEntry> = { rows: [], total: 0 };

describe("scopes", () => {
  test("Tab walks the chips in order and wraps; Shift-Tab goes back", () => {
    const order = PALETTE_SCOPES.map((scope) => scope.id);
    expect(order).toEqual([
      "all",
      "files",
      "content",
      "sessions",
      "plans",
      "commands",
    ]);
    let scope = cycleScope("all");
    const seen = [scope];
    for (let step = 1; step < order.length; step += 1) {
      scope = cycleScope(scope);
      seen.push(scope);
    }
    expect(seen).toEqual([...order.slice(1), "all"]);
    expect(cycleScope("all", true)).toBe("commands");
    expect(cycleScope("files", true)).toBe("all");
  });

  test("a / typed first switches to Content and is not kept", () => {
    expect(scopedInput("", "/", "all")).toEqual({
      query: "",
      scope: "content",
    });
    expect(scopedInput("", "/disc", "sessions")).toEqual({
      query: "disc",
      scope: "content",
    });
    // Later, a / is just text: paths have them.
    expect(scopedInput("src", "src/", "files")).toEqual({
      query: "src/",
      scope: "files",
    });
  });
});

describe("file ranking", () => {
  test("the name counts over the folders", () => {
    const name = fileScore("cart", "checkout/cart.ts")!;
    const folder = fileScore("cart", "checkout/cart/rate-limit.ts")!;
    expect(name).toBeGreaterThan(folder);
    expect(fileScore("zzz", "checkout/cart.ts")).toBeUndefined();
  });

  test("a query with a slash matches across the path", () => {
    expect(fileScore("cart/rate", "checkout/cart/rate-limit.ts")).toBeDefined();
  });

  test("ranks the best first, caps the list and counts every match", () => {
    const paths = [
      "docs/cart-api.md",
      "checkout/cart/rate-limit.ts",
      "checkout/cart/cart.ts",
      "README.md",
    ];
    const ranked = rankFiles(paths, "cart", 2);
    expect([...ranked.paths].sort()).toEqual([
      "checkout/cart/cart.ts",
      "docs/cart-api.md",
    ]);
    expect(ranked.total).toBe(3);
    expect(rankFiles(paths, "  ").total).toBe(0);
  });
});

describe("rankScoped", () => {
  const session = (n: number): PaletteEntry => ({
    key: `session:${n}`,
    kind: "session",
    title: `discount fix ${n}`,
  });
  const entries: PaletteEntry[] = [
    session(1),
    session(2),
    session(3),
    session(4),
    session(5),
    { key: "task:1", kind: "task", title: "#4 discount codes" },
    { key: "plan:a", kind: "plan", title: "Plan for discount" },
    { key: "command:x", kind: "action", title: "New Session" },
    { key: "setting:y", kind: "setting", title: "Discount Settings" },
  ];
  const fileRow = (path: string): PaletteEntry => ({
    key: `search-file:${path}`,
    kind: "file",
    title: path,
  });
  const files: SearchedRows<PaletteEntry> = {
    rows: ["a/discount.ts", "b/discount.ts", "c/discount.ts", "d/discount.ts"]
      .map(fileRow)
      .slice(0, 4),
    total: 9,
    best: 0,
  };
  const content: SearchedRows<PaletteEntry> = {
    rows: [{ key: "content:a:1", kind: "content", title: "discount()" }],
    total: 1,
  };

  test("All shows the best three of each kind, with All N for the rest", () => {
    const { groups } = rankScoped(
      entries,
      { files, content },
      "discount",
      "all",
    );
    const byId = new Map(groups.map((group) => [group.id, group]));
    expect(byId.get("sessions")?.entries).toHaveLength(ALL_GROUP_SHOWN);
    expect(byId.get("sessions")).toMatchObject({
      total: 5,
      scope: "sessions",
    });
    expect(byId.get("files")).toMatchObject({ total: 9, scope: "files" });
    expect(byId.get("files")?.entries).toHaveLength(ALL_GROUP_SHOWN);
    // A group that fits shows no "All N".
    expect(byId.get("content")?.total).toBeUndefined();
    expect(byId.get("plans")?.total).toBeUndefined();
    // Tasks have no scope of their own, but show under All.
    expect(byId.get("tasks")?.scope).toBeUndefined();
    expect(byId.get("tasks")?.entries).toHaveLength(1);
    expect(byId.get("commands")?.entries.map((row) => row.key)).toEqual([
      "setting:y",
    ]);
  });

  test("All puts the group with the best match first", () => {
    const { groups } = rankScoped(
      entries,
      { files: { ...files, best: 99_999 }, content },
      "discount",
      "all",
    );
    expect(groups[0]?.id).toBe("files");
    const sessionsFirst = rankScoped(
      entries,
      { files: { ...files, best: -1 }, content },
      "discount",
      "all",
    );
    expect(sessionsFirst.groups[0]?.id).toBe("sessions");
  });

  test("each chip counts its matches once there is a query", () => {
    expect(
      rankScoped(entries, { files, content }, "discount", "all").counts,
    ).toEqual({ files: 9, content: 1, sessions: 5, plans: 1, commands: 1 });
    expect(
      rankScoped(entries, { files: none, content: none }, "", "all").counts,
    ).toEqual({ files: 0, content: 0, sessions: 0, plans: 0, commands: 0 });
  });

  test("one scope lists all of its rows and nothing else", () => {
    const sessions = rankScoped(
      entries,
      { files, content },
      "discount",
      "sessions",
    );
    expect(sessions.groups).toHaveLength(1);
    expect(sessions.groups[0]?.entries).toHaveLength(5);
    const fileScope = rankScoped(
      entries,
      { files, content },
      "discount",
      "files",
    );
    expect(fileScope.groups[0]?.entries).toHaveLength(4);
    const commands = rankScoped(
      entries,
      { files: none, content: none },
      "",
      "commands",
    );
    expect(commands.groups[0]?.entries.map((row) => row.key)).toEqual([
      "command:x",
      "setting:y",
    ]);
  });

  test("files and content wait for a query", () => {
    expect(
      rankScoped(entries, { files, content: none }, "", "files").groups,
    ).toEqual([]);
  });

  test("All with nothing typed keeps Recent and Suggestions", () => {
    const { groups } = rankScoped(
      entries,
      { files: none, content: none },
      "",
      "all",
      { recent: ["session:2"], suggestions: ["command:x"] },
    );
    expect(groups.map((group) => group.id)).toEqual(["recent", "suggestions"]);
  });
});

describe("a command's words beat scattered file letters", () => {
  test("go home puts Go to Home above files that only hold its letters", () => {
    const paths = [
      "workspaces/w/repos/infra/integration_digest_hook_model.py",
      "workspaces/w/repos/infra/go_build/homepage_config.yml",
    ];
    const ranked = rankFiles(paths, "go home");
    const rows = ranked.paths.map((path): PaletteEntry => ({
      key: `search-file:${path}`,
      kind: "file",
      title: path,
    }));
    const commands: PaletteEntry[] = [
      { key: "command:view.home", kind: "view", title: "Go to Home" },
    ];
    const { groups } = rankScoped(
      commands,
      {
        files: { rows, total: rows.length, best: ranked.best },
        content: { rows: [], total: 0 },
      },
      "go home",
      "all",
    );
    expect(groups.map((group) => group.id)).toEqual(["commands", "files"]);
  });

  test("a file named by the query's words still ranks first", () => {
    const ranked = rankFiles(
      ["src/integration_digest_hook_model.py", "docs/go-home.md"],
      "go home",
    );
    expect(ranked.paths[0]).toBe("docs/go-home.md");
    expect(fuzzyScore("go home", "Go to Home")).toBeGreaterThan(
      fuzzyScore("go home", "integration_digest_hook_model.py") ?? 0,
    );
  });
});

describe("highlightRanges", () => {
  test("marks every occurrence, ignoring case", () => {
    expect(highlightRanges("ab", "Ab cab")).toEqual([
      [0, 2],
      [4, 6],
    ]);
  });

  test("falls back to the letters of a fuzzy match, joined when adjacent", () => {
    expect(highlightRanges("crt", "cart.ts")).toEqual([
      [0, 1],
      [2, 4],
    ]);
    expect(highlightRanges("crt", "cart.ts", false)).toEqual([]);
    expect(highlightRanges("xyz", "cart.ts")).toEqual([]);
  });
});
