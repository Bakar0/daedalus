import { describe, expect, test } from "vitest";
import { COMMAND_SPECS, type CommandArea } from "@daedalus/protocol";
import {
  flattenGroups,
  fuzzyScore,
  GROUP_LIMIT,
  loadRecent,
  type PaletteEntry,
  parsePaletteQuery,
  rankPalette,
  recordRecent,
  saveRecent,
} from "./palette-model";
import {
  commandSheetSections,
  ELEMENT_KEY_SECTIONS,
  filterSheetSections,
  orderSheetSections,
} from "./shortcut-sheet";
import { type ItemActionResolver, itemActionsFor } from "../item-actions";
import {
  sessionItemActions,
  sessionMenuEntries,
  type SessionMenuModel,
  workspaceItemActions,
} from "../SessionMenu";

describe("parsePaletteQuery", () => {
  test("a prefix narrows the palette, anything else searches it all", () => {
    expect(parsePaletteQuery(">close")).toEqual({
      mode: "commands",
      text: "close",
    });
    expect(parsePaletteQuery("#12")).toEqual({ mode: "tasks", text: "12" });
    expect(parsePaletteQuery("@ api")).toEqual({
      mode: "sessions",
      text: "api",
    });
    expect(parsePaletteQuery("  back ")).toEqual({ mode: "all", text: "back" });
    expect(parsePaletteQuery("")).toEqual({ mode: "all", text: "" });
  });
});

describe("fuzzyScore", () => {
  test("a run of the query beats scattered letters, a word start beats the middle", () => {
    const run = fuzzyScore("tab", "Close Tab");
    const scattered = fuzzyScore("tab", "Toggle Terminal Bar");
    const middle = fuzzyScore("ab", "Close Tab");
    const start = fuzzyScore("ta", "Close Tab");
    expect(run).toBeGreaterThan(scattered ?? 0);
    expect(start).toBeGreaterThan(middle ?? 0);
  });

  test("letters in order match across words; out of order does not", () => {
    expect(fuzzyScore("nsn", "Next Session That Needs You")).toBeDefined();
    expect(fuzzyScore("zq", "Next Session")).toBeUndefined();
  });

  test("ignores case, and an empty query matches everything equally", () => {
    expect(fuzzyScore("CLOSE", "close tab")).toBeDefined();
    expect(fuzzyScore("", "anything")).toBe(0);
  });
});

const entry = (
  key: string,
  section: PaletteEntry["section"],
  title: string,
): PaletteEntry => ({ key, section, title });

const entries: PaletteEntry[] = [
  entry("item:rename", "item", "Rename…"),
  entry("command:tab.close", "commands", "Close Tab"),
  entry("command:history.back", "commands", "Back"),
  entry("command:session.new", "commands", "New Session"),
  entry("session:a", "sessions", "api refactor"),
  entry("session:b", "sessions", "billing"),
  entry("task:1", "tasks", "#12 Fix the close button"),
  entry("workspace:w", "workspaces", "daedalus"),
];

const titles = (raw: string, recent: string[] = []) =>
  rankPalette(entries, raw, recent).map((group) => [
    group.section,
    group.entries.map((row) => row.title),
  ]);

describe("rankPalette", () => {
  test("with nothing typed, every group in order, the item's actions first", () => {
    expect(titles("").map(([section]) => section)).toEqual([
      "item",
      "commands",
      "sessions",
      "tasks",
      "workspaces",
    ]);
  });

  test("recently used commands float up", () => {
    const commands = titles("", [
      "command:session.new",
      "command:history.back",
    ])[1];
    expect(commands).toEqual([
      "commands",
      ["New Session", "Back", "Close Tab"],
    ]);
  });

  test("a recent command wins a close match, but not a much better one", () => {
    const rows = flattenGroups(
      rankPalette(
        [
          entry("command:a", "commands", "Close Tab"),
          entry("command:b", "commands", "Close Panel"),
        ],
        "close",
        ["command:b"],
      ),
    );
    expect(rows.map((row) => row.key)).toEqual(["command:b", "command:a"]);
  });

  test("typing keeps only matches, and the group with the best one comes first", () => {
    expect(titles("billing")).toEqual([["sessions", ["billing"]]]);
    const close = titles("close");
    expect(close.map(([section]) => section)).toEqual(["commands", "tasks"]);
  });

  test("the focused item's actions stay first while they match", () => {
    expect(titles("re")[0]).toEqual(["item", ["Rename…"]]);
  });

  test("> lists commands only, # tasks, @ sessions", () => {
    expect(titles(">").map(([section]) => section)).toEqual(["commands"]);
    expect(titles("#12")).toEqual([["tasks", ["#12 Fix the close button"]]]);
    expect(titles("@")).toEqual([["sessions", ["api refactor", "billing"]]]);
    expect(titles(">billing")).toEqual([]);
  });

  test("a group shows at most its limit", () => {
    const many = Array.from({ length: GROUP_LIMIT + 10 }, (_, index) =>
      entry(`task:${index}`, "tasks", `#${index} task`),
    );
    expect(rankPalette(many, "")[0]?.entries).toHaveLength(GROUP_LIMIT);
  });
});

describe("recent commands", () => {
  test("the latest goes first, without duplicates, up to the limit", () => {
    expect(recordRecent(["a", "b", "c"], "b")).toEqual(["b", "a", "c"]);
    expect(recordRecent(["a", "b"], "c", 2)).toEqual(["c", "a"]);
  });

  test("are kept in storage, and bad storage costs nothing", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    };
    saveRecent(["command:a"], storage);
    expect(loadRecent(storage)).toEqual(["command:a"]);
    store.set("daedalus.palette.recent", "{not json");
    expect(loadRecent(storage)).toEqual([]);
    const throwing = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(loadRecent(throwing)).toEqual([]);
    expect(() => saveRecent(["x"], throwing)).not.toThrow();
  });
});

describe("item actions", () => {
  const model = (overrides: Partial<SessionMenuModel> = {}) => {
    const calls: string[] = [];
    const value: SessionMenuModel = {
      name: "api",
      pinned: false,
      color: null,
      routines: true,
      orchestration: false,
      offerAbilities: true,
      offerOrchestration: true,
      onRename: () => calls.push("rename"),
      onPin: (pinned) => calls.push(`pin:${pinned}`),
      onColor: (color) => calls.push(`color:${color}`),
      onRoutines: (granted) => calls.push(`routines:${granted}`),
      onOrchestration: (granted) => calls.push(`team:${granted}`),
      actions: [
        {
          id: "archive",
          label: "Archive",
          confirm: "Running work stops.",
          run: () => calls.push("archive"),
        },
      ],
      ...overrides,
    };
    return { value, calls };
  };

  test("the session menu and the palette list the same actions", () => {
    const { value, calls } = model();
    const { base, abilities } = sessionMenuEntries(value);
    const listed = sessionItemActions(value);
    expect(listed.map((action) => action.id)).toEqual([
      "archive",
      ...base.map((action) => action.id),
      ...abilities.map((action) => action.id),
      ...listed
        .filter((action) => action.id.startsWith("color-"))
        .map((action) => action.id),
    ]);
    expect(base.map((action) => action.label)).toEqual([
      "Rename…",
      "Pin to top",
    ]);
    expect(abilities.map((action) => [action.id, action.checked])).toEqual([
      ["routines", true],
      ["orchestration", false],
    ]);
    // A card action keeps its confirmation in the palette.
    expect(listed[0]).toMatchObject({ confirm: "Running work stops." });
    for (const id of ["pin", "routines", "orchestration", "color-red"])
      listed.find((action) => action.id === id)?.run();
    expect(calls).toEqual([
      "pin:true",
      "routines:false",
      "team:true",
      "color:red",
    ]);
  });

  test("a terminal, or a team's member, offers no abilities it cannot hold", () => {
    expect(
      sessionMenuEntries(model({ offerAbilities: false }).value).abilities,
    ).toEqual([]);
    expect(
      sessionMenuEntries(
        model({ offerOrchestration: false }).value,
      ).abilities.map((action) => action.id),
    ).toEqual(["routines"]);
  });

  test("a workspace lists its card actions, then rename", () => {
    const listed = workspaceItemActions({
      actions: [{ id: "secrets", label: "Secrets", run: () => {} }],
      onRename: () => {},
    });
    expect(listed.map((action) => action.id)).toEqual(["secrets", "rename"]);
  });

  test("the newest resolver that knows the element answers", () => {
    const element = {} as Element;
    const older: ItemActionResolver = () => ({
      title: "old",
      actions: [{ id: "a", label: "A", run: () => {} }],
    });
    const newer: ItemActionResolver = () => ({
      title: "new",
      actions: [{ id: "b", label: "B", run: () => {} }],
    });
    const none: ItemActionResolver = () => undefined;
    expect(itemActionsFor(element, [older, newer])?.title).toBe("new");
    expect(itemActionsFor(element, [older, none])?.title).toBe("old");
    expect(itemActionsFor(null, [older])).toBeUndefined();
    expect(
      itemActionsFor(element, [() => ({ title: "empty", actions: [] })]),
    ).toBeUndefined();
  });
});

describe("the shortcuts sheet", () => {
  const sections = [
    ...commandSheetSections(COMMAND_SPECS),
    ...ELEMENT_KEY_SECTIONS,
  ];

  test("lists every command with a key once, grouped as the table groups them", () => {
    const listed = commandSheetSections(COMMAND_SPECS).flatMap((section) =>
      section.rows.map((row) => row.label),
    );
    expect(new Set(listed)).toEqual(
      new Set(
        COMMAND_SPECS.filter((spec) => spec.keys.length > 0).map(
          (spec) => spec.title,
        ),
      ),
    );
    expect(new Set(listed).size).toBe(listed.length);
    const tabs = commandSheetSections(COMMAND_SPECS).find(
      (section) => section.title === "Tabs",
    );
    expect(tabs?.rows.find((row) => row.label === "Close Tab")?.keys).toEqual([
      "⌘W",
    ]);
  });

  test("the group for where focus is comes first", () => {
    const first = (areas: CommandArea[]) =>
      orderSheetSections(sections, areas)
        .slice(0, 2)
        .map((section) => section.title);
    expect(first(["editor", "tabs", "center"])).toEqual(["Tabs", "Tab strip"]);
    expect(first(["sidebar"])).toEqual(["Go", "Sidebar tree"]);
    expect(first(["terminal", "terminal-panel"])).toEqual([
      "Terminal",
      "Terminal",
    ]);
    // Nowhere in particular: the table's own order.
    expect(orderSheetSections(sections, []).map((s) => s.title)).toEqual(
      sections.map((s) => s.title),
    );
  });

  test("lists the keys elements answer to themselves", () => {
    const titles = ELEMENT_KEY_SECTIONS.map((section) => section.title);
    expect(titles).toEqual(
      expect.arrayContaining([
        "Sidebar tree",
        "Board",
        "File tree",
        "Terminal",
        "Task page",
      ]),
    );
    const rows = ELEMENT_KEY_SECTIONS.flatMap((section) => section.rows);
    expect(rows.find((row) => row.label === "Reorder")?.keys).toEqual([
      "⌥↑",
      "⌥↓",
    ]);
    expect(rows.find((row) => row.label === "Save the brief")?.keys).toEqual([
      "⌘↩",
    ]);
    expect(
      rows.find((row) => row.label === "New line without sending")?.keys,
    ).toEqual(["⇧↩"]);
  });

  test("search keeps the rows every word finds, by name, group or key", () => {
    const labels = (query: string) =>
      filterSheetSections(sections, query).flatMap((section) =>
        section.rows.map((row) => row.label),
      );
    expect(labels("close tab")).toContain("Close Tab");
    expect(labels("⌘[")).toEqual(expect.arrayContaining(["Back"]));
    expect(labels("no such key")).toEqual([]);
    expect(filterSheetSections(sections, "  ")).toHaveLength(sections.length);
  });
});
