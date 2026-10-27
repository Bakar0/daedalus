import { describe, expect, test } from "vitest";
import { COMMAND_SPECS, type CommandArea } from "@daedalus/protocol";
import {
  filterActions,
  flattenGroups,
  fuzzyScore,
  loadRecent,
  type PaletteEntry,
  rankPalette,
  recordRecent,
  RECENT_SHOWN,
  RESULT_LIMIT,
  saveRecent,
} from "./palette-model";
import { isActionsKey, panelActions, type PaletteRow } from "./CommandPalette";
import {
  commandSheetSections,
  elementKeySections,
  filterSheetSections,
  orderSheetSections,
} from "./shortcut-sheet";
import {
  type ItemActionResolver,
  itemActionsById,
  itemActionsFor,
  registerItemActionsById,
} from "../item-actions";
import {
  sessionItemActions,
  sessionMenuEntries,
  type SessionMenuModel,
  workspaceItemActions,
} from "../SessionMenu";

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
  kind: PaletteEntry["kind"],
  title: string,
  subtitle?: string,
): PaletteEntry => ({ key, kind, title, ...(subtitle ? { subtitle } : {}) });

const entries: PaletteEntry[] = [
  entry("command:tab.close", "action", "Close Tab"),
  entry("command:session.new", "action", "New Session"),
  entry("command:task.new", "action", "New Task"),
  entry("command:view.board", "view", "Board"),
  entry("session:a", "session", "api refactor", "daedalus · Working"),
  entry("session:b", "session", "billing", "shop · Idle"),
  entry("task:1", "task", "#12 Fix the close button", "daedalus · To do"),
  entry("workspace:w", "workspace", "daedalus"),
  entry("setting:keyboard", "setting", "Keyboard Settings"),
];

const keys = (query: string, options = {}) =>
  rankPalette(entries, query, options).map((group) => [
    group.id,
    group.entries.map((row) => row.key),
  ]);

describe("rankPalette", () => {
  test("there are no prefixes: > @ # are searched like any text", () => {
    expect(keys(">")).toEqual([]);
    expect(keys("#12")).toEqual([["results", ["task:1"]]]);
  });

  test("with nothing typed: the focused item, Recent, then Suggestions", () => {
    expect(
      keys("", {
        selected: "session:a",
        recent: ["task:1", "session:a", "gone"],
        suggestions: ["command:session.new", "task:1", "command:task.new"],
      }),
    ).toEqual([
      ["selected", ["session:a"]],
      ["recent", ["task:1"]],
      ["suggestions", ["command:session.new", "command:task.new"]],
    ]);
    expect(keys("")).toEqual([]);
  });

  test("Recent shows only the latest few", () => {
    const many = entries.map((row) => row.key);
    const recent = rankPalette(entries, "", { recent: many })[0];
    expect(recent?.entries).toHaveLength(RECENT_SHOWN);
  });

  test("typing mixes every kind in one list, best match first", () => {
    expect(keys("billing")).toEqual([["results", ["session:b"]]]);
    expect(keys("close")[0]?.[1]).toEqual(["command:tab.close", "task:1"]);
    expect(keys("keyboard")).toEqual([["results", ["setting:keyboard"]]]);
  });

  test("a title match beats a match on the subtitle", () => {
    // "daedalus" is the workspace's name, and the subtitle of a session
    // and a task in it.
    expect(keys("daedalus")[0]?.[1]).toEqual([
      "workspace:w",
      "session:a",
      "task:1",
    ]);
  });

  test("a search matches the kind too", () => {
    expect(keys("session api")[0]?.[1]).toContain("session:a");
  });

  test("recent use lifts a close match, but not past a much better one", () => {
    const rows = flattenGroups(
      rankPalette(
        [
          entry("command:a", "action", "Close Tab"),
          entry("command:b", "action", "Close Panel"),
        ],
        "close",
        { recent: ["command:b"] },
      ),
    );
    expect(rows.map((row) => row.key)).toEqual(["command:b", "command:a"]);
    expect(
      flattenGroups(
        rankPalette(entries, "billing", { recent: ["session:a"] }),
      ).map((row) => row.key),
    ).toEqual(["session:b"]);
  });

  test("the sessions used lately are lifted", () => {
    const two = [
      entry("session:x", "session", "api one"),
      entry("session:y", "session", "api two"),
    ];
    expect(
      flattenGroups(rankPalette(two, "api", { boost: ["session:y"] }))[0]?.key,
    ).toBe("session:y");
  });

  test("a search shows at most its limit", () => {
    const many = Array.from({ length: RESULT_LIMIT + 10 }, (_, index) =>
      entry(`task:${index}`, "task", `#${index} task`),
    );
    expect(rankPalette(many, "task")[0]?.entries).toHaveLength(RESULT_LIMIT);
  });
});

describe("the Actions panel", () => {
  const row = (actions?: PaletteRow["actions"]): PaletteRow => ({
    key: "session:a",
    kind: "session",
    title: "api",
    primary: "Open Session",
    run: () => {},
    ...(actions ? { actions } : {}),
  });

  test("lists the primary action first, then the item's own without its open", () => {
    const listed = panelActions(
      row(() => [
        { id: "open", label: "Open task", run: () => {} },
        { id: "rename", label: "Rename…", run: () => {} },
        {
          id: "archive",
          label: "Archive",
          confirm: "Stops it.",
          run: () => {},
        },
      ]),
    );
    expect(listed.map((action) => [action.id, action.label])).toEqual([
      ["primary", "Open Session"],
      ["rename", "Rename…"],
      ["archive", "Archive"],
    ]);
    expect(listed[2]).toMatchObject({ confirm: "Stops it." });
    expect(panelActions(row()).map((action) => action.id)).toEqual(["primary"]);
  });

  test("the palette's own key opens the actions, rebound too", () => {
    const event = (
      key: string,
      code: string,
      metaKey = true,
      shiftKey = false,
    ) => ({
      key,
      code,
      metaKey,
      shiftKey,
      ctrlKey: false,
      altKey: false,
    });
    expect(isActionsKey(event("k", "KeyK"))).toBe(true);
    expect(isActionsKey(event("k", "KeyK", false))).toBe(false);
    expect(isActionsKey(event("P", "KeyP", true, true), ["mod+shift+p"])).toBe(
      true,
    );
    expect(isActionsKey(event("k", "KeyK"), ["mod+shift+p"])).toBe(false);
    // A sequence cannot be one press; unbound, only → opens them.
    expect(isActionsKey(event("k", "KeyK"), ["mod+k mod+a"])).toBe(false);
    expect(isActionsKey(event("k", "KeyK"), [])).toBe(false);
  });

  test("its field filters the actions by label and description", () => {
    const actions = [
      { id: "rename", label: "Rename…" },
      { id: "routines", label: "Routines", description: "Grant routines." },
      { id: "archive", label: "Archive" },
    ];
    expect(filterActions(actions, "").map((action) => action.id)).toEqual([
      "rename",
      "routines",
      "archive",
    ]);
    expect(filterActions(actions, "arch").map((action) => action.id)).toEqual([
      "archive",
    ]);
    expect(filterActions(actions, "grant").map((action) => action.id)).toEqual([
      "routines",
    ]);
  });

  test("any session, task or workspace resolves its actions by id", () => {
    const dispose = registerItemActionsById("task", (id) =>
      id === "t1"
        ? {
            title: "#1",
            actions: [{ id: "start", label: "Start", run: () => {} }],
            ref: { kind: "task", id },
          }
        : undefined,
    );
    try {
      expect(itemActionsById({ kind: "task", id: "t1" })?.title).toBe("#1");
      expect(itemActionsById({ kind: "task", id: "t2" })).toBeUndefined();
      expect(itemActionsById({ kind: "session", id: "t1" })).toBeUndefined();
    } finally {
      dispose();
    }
    expect(itemActionsById({ kind: "task", id: "t1" })).toBeUndefined();
  });
});

describe("recent rows", () => {
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
    // Merely reading the window's storage can throw where it is denied.
    const descriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      "localStorage",
    );
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get: () => {
        throw new Error("SecurityError");
      },
    });
    try {
      expect(loadRecent()).toEqual([]);
      expect(() => saveRecent(["x"])).not.toThrow();
    } finally {
      if (descriptor)
        Object.defineProperty(globalThis, "localStorage", descriptor);
      else delete (globalThis as { localStorage?: unknown }).localStorage;
    }
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
    ...elementKeySections(),
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
    const titles = elementKeySections().map((section) => section.title);
    expect(titles).toEqual(
      expect.arrayContaining([
        "Sidebar tree",
        "Board",
        "File tree",
        "Terminal",
        "Task page",
      ]),
    );
    const rows = elementKeySections().flatMap((section) => section.rows);
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
    expect(labels("⇧⌘[")).toEqual(expect.arrayContaining(["Previous Tab"]));
    expect(labels("no such key")).toEqual([]);
    expect(filterSheetSections(sections, "  ")).toHaveLength(sections.length);
  });
});

describe("the sheet's palette and switcher rows", () => {
  const row = (
    sections: ReturnType<typeof elementKeySections>,
    label: string,
  ) =>
    sections
      .flatMap((section) => section.rows)
      .find((item) => item.label.startsWith(label))?.keys;

  test("name the command keys as they stand", () => {
    const defaults = elementKeySections();
    expect(row(defaults, "Show the result's actions")).toEqual(["⌘K", "→"]);
    expect(row(defaults, "Next / previous session, while ⌃")).toEqual([
      "⌃⇥",
      "⌃⇧⇥",
    ]);
    expect(row(defaults, "Open the highlighted session")).toEqual([
      "Release ⌃",
    ]);
    const rebound = elementKeySections({
      palette: ["mod+shift+p"],
      switchSession: ["alt+tab"],
      switchBack: [],
    });
    expect(row(rebound, "Show the result's actions")).toEqual(["⇧⌘P", "→"]);
    expect(row(rebound, "Next / previous session, while ⌥")).toEqual(["⌥⇥"]);
    expect(row(rebound, "Open the highlighted session")).toEqual(["Release ⌥"]);
    // With no modifier to hold, Enter opens.
    const plain = elementKeySections({
      palette: [],
      switchSession: ["f8"],
      switchBack: [],
    });
    expect(row(plain, "Open the highlighted session")).toEqual(["↩"]);
    expect(row(plain, "Show the result's actions")).toEqual(["→"]);
  });
});

describe("the shortcuts sheet with the person's keys", () => {
  test("shows a rebound key and marks it changed", async () => {
    const { allCommands, setKeyOverrides } = await import("../commands");
    setKeyOverrides({ "tab.close": ["mod+shift+w"], "tab.next": [] });
    try {
      const rows = commandSheetSections(allCommands()).flatMap(
        (section) => section.rows,
      );
      expect(rows.find((row) => row.label === "Close Tab")).toEqual({
        label: "Close Tab",
        keys: ["⇧⌘W"],
        changed: true,
      });
      // Unbound, it leaves the sheet; untouched, it is not marked.
      expect(rows.find((row) => row.label === "Next Tab")).toBeUndefined();
      expect(rows.find((row) => row.label === "Save")?.changed).toBeUndefined();
    } finally {
      setKeyOverrides({});
    }
  });
});

describe("Settings › Keyboard", () => {
  test("lists every command, unbound ones too, grouped and searchable", async () => {
    const { allCommands, setKeyOverrides } = await import("../commands");
    const { keyboardSettingsGroups } = await import("../KeyboardSettings");
    setKeyOverrides({ "view.board": [] });
    try {
      const all = keyboardSettingsGroups(allCommands(), "");
      expect(all.flatMap((group) => group.rows).length).toBe(
        COMMAND_SPECS.length,
      );
      expect(
        keyboardSettingsGroups(allCommands(), "board")
          .flatMap((group) => group.rows)
          .map((row) => row.id),
      ).toContain("view.board");
      expect(
        keyboardSettingsGroups(allCommands(), "⌘W").flatMap((group) =>
          group.rows.map((row) => row.id),
        ),
      ).toEqual(["tab.close"]);
    } finally {
      setKeyOverrides({});
    }
  });
});
