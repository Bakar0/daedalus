import { describe, expect, test } from "vitest";
import type {
  AgentActivityDto,
  AgentSessionDto,
  SessionAttentionDto,
  TaskDto,
  WorkspaceDto,
} from "@daedalus/protocol";
import {
  buildWorldModel,
  stationForDetail,
  WORLD_PLACES,
  type WorldModelInput,
} from "./world-model";
import { WORLD_THEMES } from "./themes";
import { LABYRINTH_ROOM, labyrinthTheme } from "./themes/labyrinth";
import {
  DEFAULT_WORLD_CHARACTER_ID,
  WORLD_CHARACTERS,
  worldCharacterById,
} from "./characters";
import { SPRITE_CLASSES, SPRITE_SIZE, spriteRows } from "./characters/pixel";
import { COSTUMES } from "./characters/costumes";
import { PERSONAS, personaFor } from "./characters/personas";

const workspace = (id: string): WorkspaceDto => ({
  id,
  slug: id,
  name: `Workspace ${id}`,
  path: `/tmp/${id}`,
  createdAt: "2026-09-20T00:00:00.000Z",
  updatedAt: "2026-09-20T00:00:00.000Z",
  archivedAt: null,
  available: true,
  position: 0,
  startSetsInProgress: true,
  autoHandoffPercent: null,
  defaultProvider: null,
  defaultModel: null,
});

const session = (
  id: string,
  overrides: Partial<AgentSessionDto> = {},
): AgentSessionDto => ({
  id,
  workspaceId: "w",
  taskId: null,
  name: id,
  provider: "claude",
  kind: "agent",
  tmuxSession: `daedalus_${id}`,
  command: "claude",
  args: [],
  workingDirectory: "/tmp",
  status: "running",
  exitCode: null,
  startedAt: "2026-09-23T10:00:00.000Z",
  endedAt: null,
  providerSessionId: null,
  archivedAt: null,
  resumeCount: 0,
  lostReason: null,
  handoffRequestedAt: null,
  position: 0,
  ...overrides,
});

const activity = (
  sessionId: string,
  value: AgentActivityDto["activity"],
  detail: string | null = null,
): AgentActivityDto => ({
  sessionId,
  activity: value,
  detail,
  since: "2026-09-23T10:05:00.000Z",
  observedAt: "2026-09-23T10:05:00.000Z",
  source: "hook",
});

const task: TaskDto = {
  id: "t1",
  workspaceId: "w",
  number: 44,
  title: "Office view",
  description: "",
  status: "in_progress",
  priority: "normal",
  createdAt: "2026-09-20T00:00:00.000Z",
  updatedAt: "2026-09-20T00:00:00.000Z",
  completedAt: null,
  briefUpdatedAt: null,
};

const input = (overrides: Partial<WorldModelInput> = {}): WorldModelInput => ({
  workspaces: [workspace("w")],
  sessions: [],
  tasks: [task],
  activity: new Map(),
  attention: new Map(),
  telemetry: new Map(),
  ...overrides,
});

describe("stationForDetail", () => {
  test("reads the tool from summarizeTool's Name(argument) line", () => {
    expect(stationForDetail("Read(agents.ts)")).toBe("read");
    expect(stationForDetail("Grep(TODO)")).toBe("read");
    expect(stationForDetail("Edit(agents.ts)")).toBe("edit");
    expect(stationForDetail("apply_patch")).toBe("edit");
    expect(stationForDetail("Bash(bun test)")).toBe("run");
    expect(stationForDetail("exec_command(ls -la)")).toBe("run");
    expect(stationForDetail("WebFetch(https://pixijs.com)")).toBe("web");
    expect(stationForDetail("Task(Explore the renderer)")).toBe("delegate");
    expect(stationForDetail("TodoWrite")).toBe("plan");
  });

  test("sends commits, pushes and PRs to shipping, not the terminal", () => {
    expect(stationForDetail("Bash(git push)")).toBe("ship");
    expect(stationForDetail("Bash(git commit -m x)")).toBe("ship");
    expect(stationForDetail("Bash(gh pr create)")).toBe("ship");
    expect(stationForDetail("Bash(git status)")).toBe("run");
  });

  test("treats MCP tools as reaching outside", () => {
    expect(stationForDetail("mcp__github__search(issues)")).toBe("web");
  });

  test("places free-text details by their verb, and the rest at a desk", () => {
    expect(stationForDetail("Reading the config")).toBe("read");
    expect(stationForDetail("Compacting context")).toBe("think");
    expect(stationForDetail("SomeNewTool(x)")).toBe("think");
    expect(stationForDetail(null)).toBe("think");
    expect(stationForDetail("  ")).toBe("think");
  });
});

describe("buildWorldModel", () => {
  test("puts a working agent at its tool's station, with its task", () => {
    const model = buildWorldModel(
      input({
        sessions: [session("a", { taskId: "t1" })],
        activity: new Map([["a", activity("a", "working", "Edit(x.ts)")]]),
      }),
    );
    expect(model.actors).toHaveLength(1);
    expect(model.actors[0]).toMatchObject({
      sessionId: "a",
      zoneId: "w",
      mood: "working",
      place: "edit",
      taskLabel: "#44 Office view",
      detail: "Edit(x.ts)",
    });
  });

  test("a waiting agent stays at the station it asked from and is counted", () => {
    const attention: SessionAttentionDto = {
      sessionId: "a",
      workspaceId: "w",
      reasons: [
        {
          id: "r1",
          text: "Approve git push?",
          raisedAt: "2026-09-23T10:06:00.000Z",
          source: "hook",
        },
      ],
      raisedAt: "2026-09-23T10:06:00.000Z",
      updatedAt: "2026-09-23T10:06:00.000Z",
    };
    const model = buildWorldModel(
      input({
        sessions: [session("a")],
        activity: new Map([
          ["a", activity("a", "needs_permission", "Bash(git push)")],
        ]),
        attention: new Map([["a", attention]]),
      }),
    );
    expect(model.actors[0]).toMatchObject({
      mood: "attention",
      place: "ship",
      label: "needs permission",
      detail: "Approve git push?",
    });
    expect(model.zones[0]?.attention).toBe(1);
  });

  test("idle and done rest in the lounge; lost waits at the door", () => {
    const model = buildWorldModel(
      input({
        sessions: [
          session("idle"),
          session("done"),
          session("lost", { status: "lost" }),
        ],
        activity: new Map([
          ["idle", activity("idle", "idle")],
          ["done", activity("done", "done")],
        ]),
      }),
    );
    expect(
      Object.fromEntries(model.actors.map((a) => [a.sessionId, a.place])),
    ).toEqual({ idle: "lounge", done: "lounge", lost: "door" });
  });

  test("leaves out terminals, exited and archived sessions, and other scopes", () => {
    const model = buildWorldModel(
      input({
        sessions: [
          session("terminal", { kind: "terminal" }),
          session("exited", { status: "exited" }),
          session("archived", { archivedAt: "2026-09-23T11:00:00.000Z" }),
          session("elsewhere", { workspaceId: "other" }),
          session("here"),
        ],
      }),
    );
    expect(model.actors.map((actor) => actor.sessionId)).toEqual(["here"]);
  });

  test("reports context and model from telemetry", () => {
    const model = buildWorldModel(
      input({
        sessions: [session("a")],
        telemetry: new Map([
          [
            "a",
            {
              sessionId: "a",
              model: "claude-opus-5-5",
              context: { usedTokens: 50_000, usedPercent: 25 },
              observedAt: "2026-09-23T10:05:00.000Z",
            },
          ],
        ]),
      }),
    );
    expect(model.actors[0]).toMatchObject({
      model: "claude-opus-5-5",
      contextPercent: 25,
    });
  });
});

describe("themes", () => {
  // The engine asks for every place; a theme that forgets one would stack
  // agents at the origin, which no type catches.
  test.each(WORLD_THEMES.map((theme) => [theme.id, theme] as const))(
    "%s gives every place its own spots, and spreads a crowd",
    (_, theme) => {
      for (const place of WORLD_PLACES) {
        const crowd = Array.from({ length: 8 }, (_, slot) =>
          theme.spot(place, slot, 0),
        );
        for (const point of crowd) {
          expect(Number.isFinite(point.x)).toBe(true);
          expect(Number.isFinite(point.y)).toBe(true);
        }
        const distinct = new Set(
          crowd.slice(0, 3).map((point) => `${point.x},${point.y}`),
        );
        expect(distinct.size).toBe(3);
      }
    },
  );
});

describe("labyrinth", () => {
  const zones = (count: number) =>
    Array.from({ length: count }, (_, index) => ({
      id: `w${index}`,
      name: `Workspace ${index}`,
      attention: 0,
      busy: 0,
    }));
  const { width: W, height: H } = LABYRINTH_ROOM;
  const inRoom = (
    point: { x: number; y: number },
    origin: { x: number; y: number },
  ) =>
    Math.abs(point.x - origin.x) <= W / 2 &&
    Math.abs(point.y - origin.y) <= H / 2;

  test.each([0, 1, 2, 3, 8, 21])(
    "%i rooms sit two to a floor, either side of the shaft, never overlapping",
    (count) => {
      const { origins, bounds } = labyrinthTheme.arrange(zones(count));
      expect(origins).toHaveLength(count);
      origins.forEach((origin, index) => {
        expect(Math.sign(origin.x)).toBe(index % 2 === 0 ? -1 : 1);
        // Clear of the shaft, and inside the world.
        expect(Math.abs(origin.x) - W / 2).toBeGreaterThan(45);
        expect(origin.y + H / 2).toBeLessThanOrEqual(bounds.y + bounds.height);
        for (const other of origins.slice(index + 1))
          expect(
            Math.abs(origin.x - other.x) < W &&
              Math.abs(origin.y - other.y) < H,
          ).toBe(false);
      });
    },
  );

  test("the labyrinth grows a floor for every two workspaces", () => {
    const height = (count: number) =>
      labyrinthTheme.arrange(zones(count)).bounds.height;
    expect(height(2)).toBe(height(1));
    expect(height(3)).toBeGreaterThan(height(2));
    expect(height(9)).toBeGreaterThan(height(8));
  });

  test("between rooms a bot goes out the door, along the shaft and in", () => {
    const arrangement = labyrinthTheme.arrange(zones(4));
    const [a, , , d] = arrangement.origins as [
      { x: number; y: number },
      unknown,
      unknown,
      { x: number; y: number },
    ];
    const from = { x: a.x - 300, y: a.y + 90 };
    const to = { x: d.x + 200, y: d.y + 90 };
    const path = arrangement.route!(from, to);
    expect(path.at(-1)).toEqual(to);
    // Every leg outside a room runs in the shaft or along a corridor.
    let previous = from;
    for (const point of path) {
      const vertical = point.x === previous.x;
      if (vertical && !inRoom(point, a) && !inRoom(point, d))
        expect(point.x).toBe(0);
      previous = point;
    }
    expect(path.some((point) => point.x === 0)).toBe(true);
  });

  test("inside one room a bot flies straight to its station", () => {
    const arrangement = labyrinthTheme.arrange(zones(2));
    const origin = arrangement.origins[1]!;
    const to = { x: origin.x + 100, y: origin.y + 90 };
    expect(
      arrangement.route!({ x: origin.x - 200, y: origin.y + 90 }, to),
    ).toEqual([to]);
  });

  test("from the workshop a bot rides the shaft down to its room", () => {
    const arrangement = labyrinthTheme.arrange(zones(3));
    const origin = arrangement.origins[2]!;
    const to = { x: origin.x, y: origin.y + 90 };
    const path = arrangement.route!(labyrinthTheme.home, to);
    expect(path[0]!.x).toBe(0);
    expect(path.at(-1)).toEqual(to);
  });

  test("every spot stays inside the room, mirrored on the right", () => {
    for (const place of WORLD_PLACES)
      for (let slot = 0; slot < 10; slot += 1) {
        const left = labyrinthTheme.spot(place, slot, 0);
        const right = labyrinthTheme.spot(place, slot, 1);
        expect(Math.abs(left.x)).toBeLessThanOrEqual(W / 2);
        expect(Math.abs(left.y)).toBeLessThanOrEqual(H / 2);
        expect(right).toEqual({ x: -left.x, y: left.y });
      }
  });
});

describe("characters", () => {
  // A remembered choice that is missing or no longer exists falls back to
  // the default, and the default is Bots: the style the user picked.
  test("an unknown or missing choice falls back to Bots", () => {
    expect(DEFAULT_WORLD_CHARACTER_ID).toBe("bots");
    expect(worldCharacterById(null).id).toBe("bots");
    expect(worldCharacterById("retired-style").id).toBe("bots");
    expect(worldCharacterById("pixel").id).toBe("pixel");
  });

  test("every style has a unique id and a label", () => {
    const ids = WORLD_CHARACTERS.map((character) => character.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const character of WORLD_CHARACTERS)
      expect(character.label).toBeTruthy();
  });

  // A sprite row one character short shears everything under it sideways.
  test.each(Object.entries(SPRITE_CLASSES))(
    "the %s sprite is a full grid in every pose",
    (_, kind) => {
      for (const pose of [
        "stand",
        "stepA",
        "stepB",
        "wave",
        "cheer",
      ] as const) {
        const rows = spriteRows(kind, pose);
        expect(rows).toHaveLength(SPRITE_SIZE.rows);
        for (const row of rows) expect(row).toHaveLength(SPRITE_SIZE.columns);
      }
    },
  );
});

describe("personas", () => {
  test("every persona has a costume that draws something", () => {
    for (const persona of PERSONAS) {
      const costume = COSTUMES[persona.id];
      expect(Object.keys(costume).length).toBeGreaterThan(0);
    }
    expect(new Set(PERSONAS.map((persona) => persona.id)).size).toBe(
      PERSONAS.length,
    );
  });

  test("a session keeps its persona, and sessions spread across them", () => {
    expect(personaFor("session-a")).toBe(personaFor("session-a"));
    const seen = new Set(
      Array.from({ length: 200 }, (_, index) => personaFor(`s-${index}`).id),
    );
    expect(seen.size).toBe(PERSONAS.length);
  });
});
