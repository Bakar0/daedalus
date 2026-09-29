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
import { layoutFor } from "./themes/labyrinth-rooms";
import { createDispatch } from "./themes/labyrinth-dispatch";
import { skyAt } from "./themes/labyrinth-sky";
import { Container } from "pixi.js";
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
    // Waiting to push is not pushing: the tube stays empty until approved.
    expect(model.zones[0]?.shipping).toBe(0);
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

  test("counts the agents shipping right now, for the tube", () => {
    const model = buildWorldModel(
      input({
        sessions: [session("a"), session("b")],
        activity: new Map([
          ["a", activity("a", "working", "Bash(git push)")],
          ["b", activity("b", "working", "Edit(x.ts)")],
        ]),
      }),
    );
    expect(model.zones[0]).toMatchObject({ busy: 2, shipping: 1 });
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
          theme.spot(place, slot, { index: 0, id: "w0" }),
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
      shipping: 0,
    }));
  const { width: W, height: H } = LABYRINTH_ROOM;
  const inRoom = (
    point: { x: number; y: number },
    origin: { x: number; y: number },
  ) =>
    Math.abs(point.x - origin.x) <= W / 2 &&
    Math.abs(point.y - origin.y) <= H / 2;

  test.each([0, 1, 2, 3, 8, 21])(
    "%i rooms sit two to a floor, both sides of the shaft, never overlapping",
    (count) => {
      const { origins, bounds } = labyrinthTheme.arrange(zones(count));
      expect(origins).toHaveLength(count);
      origins.forEach((origin, index) => {
        // The Observatory holds the top left, so the first workspace is on
        // the right and they alternate from there.
        expect(Math.sign(origin.x)).toBe(index % 2 === 0 ? 1 : -1);
        if (index > 0)
          expect(origin.y).toBeGreaterThanOrEqual(origins[index - 1]!.y);
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

  test("the labyrinth grows a floor for every two rooms", () => {
    const height = (count: number) =>
      labyrinthTheme.arrange(zones(count)).bounds.height;
    // The Observatory shares the top floor with the first workspace.
    expect(height(1)).toBe(height(0));
    expect(height(2)).toBeGreaterThan(height(1));
    expect(height(3)).toBe(height(2));
    expect(height(10)).toBeGreaterThan(height(9));
  });

  test("shipping is at the back of the room, away from the shaft", () => {
    const arrangement = labyrinthTheme.arrange(zones(4));
    arrangement.origins.forEach((origin, index) => {
      const ship = labyrinthTheme.spot("ship", 0, { index, id: `w${index}` });
      expect(Math.sign(ship.x)).toBe(Math.sign(origin.x));
      expect(Math.abs(ship.x)).toBeGreaterThan(W / 4);
    });
  });

  test("every room's door faces the shaft, on either side", () => {
    const arrangement = labyrinthTheme.arrange(zones(4));
    arrangement.origins.forEach((origin, index) => {
      const door = labyrinthTheme.spot("door", 0, { index, id: `w${index}` });
      // The door spot is on the shaft's side of the room's centre.
      expect(Math.sign(door.x)).toBe(-Math.sign(origin.x));
    });
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

  test("the shaft leg is ridden, the walk to and from the doors is not", () => {
    const arrangement = labyrinthTheme.arrange(zones(3));
    const [a, , c] = arrangement.origins as [
      { x: number; y: number },
      unknown,
      { x: number; y: number },
    ];
    const path = arrangement.route!(
      { x: a.x, y: a.y + 90 },
      { x: c.x, y: c.y + 90 },
    );
    const ridden = path.filter((point) => point.ride);
    expect(ridden).toHaveLength(1);
    expect(ridden[0]!.x).toBe(0);
    expect(path.at(-1)!.ride).toBeUndefined();
  });

  test("web work is shared: every zone's bots go to the one Observatory", () => {
    const arrangement = labyrinthTheme.arrange(zones(3));
    const shared = labyrinthTheme.shared!;
    expect(shared.places).toEqual(["web"]);
    const first = shared.spot("web", 0);
    // On the top floor, left of the shaft, above or level with every room.
    expect(first.x).toBeLessThan(0);
    for (const origin of arrangement.origins)
      expect(first.y).toBeLessThanOrEqual(origin.y + H / 2);
    const spots = Array.from({ length: 12 }, (_, slot) =>
      shared.spot("web", slot),
    );
    expect(new Set(spots.map((point) => `${point.x},${point.y}`)).size).toBe(
      12,
    );
    const origin = arrangement.origins[2]!;
    const path = arrangement.route!({ x: origin.x, y: origin.y + 90 }, first);
    expect(path.filter((point) => point.ride)).toHaveLength(1);
    expect(path.at(-1)).toEqual(first);
  });

  const ids = Array.from({ length: 30 }, (_, index) => `workspace-${index}`);

  test("every room gives every place its own spots, inside the room", () => {
    for (const id of ids)
      for (const place of WORLD_PLACES) {
        const points = Array.from({ length: 8 }, (_, slot) =>
          labyrinthTheme.spot(place, slot, { index: 0, id }),
        );
        for (const point of points) {
          expect(Math.abs(point.x)).toBeLessThanOrEqual(W / 2);
          expect(Math.abs(point.y)).toBeLessThanOrEqual(H / 2);
        }
        if (place !== "door")
          expect(
            new Set(points.slice(0, 2).map((point) => `${point.x},${point.y}`))
              .size,
          ).toBe(2);
      }
    // The shaft is to the left of every room.
    expect(
      labyrinthTheme.spot("door", 0, { index: 0, id: "w0" }).x,
    ).toBeLessThan(0);
  });

  test("a workspace keeps its room, and rooms differ between workspaces", () => {
    const order = (id: string) =>
      layoutFor(id)
        .blocks.map(({ block }) => block.id)
        .join(",");
    expect(order("workspace-1")).toBe(order("workspace-1"));
    expect(new Set(ids.map(order)).size).toBeGreaterThan(20);
    const looks = new Set(
      ids.map((id) => {
        const layout = layoutFor(id);
        return `${layout.wallStyle}-${layout.floorStyle}-${layout.wallColor}`;
      }),
    );
    expect(looks.size).toBeGreaterThan(10);
  });

  test("the shipping bench is always against the back wall", () => {
    for (const id of ids) {
      const blocks = layoutFor(id).blocks;
      expect(blocks[0]!.block.id).toBe("ship");
      expect(blocks.filter(({ block }) => block.id === "ship")).toHaveLength(1);
    }
  });

  test("stations never overlap in a room", () => {
    for (const id of ids) {
      const xs = layoutFor(id).blocks.map(({ x }) => x);
      for (let index = 1; index < xs.length; index += 1)
        expect(xs[index]! - xs[index - 1]!).toBeGreaterThanOrEqual(110);
    }
  });
});

describe("dispatch", () => {
  const geometry = {
    lanes: [
      { pipeX: -1300, bottom: 760, post: { x: -1300, y: 0 } },
      { pipeX: 1300, bottom: 760, post: { x: 1300, y: 0 } },
    ],
    routes: [
      {
        lane: 1,
        path: [
          { x: 1000, y: 700 },
          { x: 1100, y: 740 },
          { x: 1260, y: 740 },
        ],
      },
    ],
  };
  const zone = (shipping: number) => ({
    id: "w0",
    name: "w0",
    attention: 0,
    busy: 1,
    shipping,
  });

  test("a crate leaves when a bot starts shipping, and repeats while it does", () => {
    const layer = new Container();
    const step = createDispatch(layer, geometry);
    step(0, [zone(0)]);
    expect(layer.children).toHaveLength(0);
    step(0.1, [zone(1)]);
    // The bot needs a moment to reach the bench.
    step(1, [zone(1)]);
    expect(layer.children).toHaveLength(0);
    step(1.4, [zone(1)]);
    expect(layer.children).toHaveLength(1);
    let time = 1.4;
    while (time < 7) step((time += 0.05), [zone(1)]);
    expect(layer.children.length).toBeGreaterThanOrEqual(2);
  });

  test("a crate flies off from the post and is gone after its flight", () => {
    const layer = new Container();
    const step = createDispatch(layer, geometry);
    step(0, [zone(1)]);
    let time = 0;
    while (time < 1.3) step((time += 0.05), [zone(1)]);
    step(time, [zone(0)]);
    const crate = layer.children[0]!;
    let highest = Infinity;
    while (time < 20 && layer.children.length) {
      step((time += 0.05), [zone(0)]);
      if (!crate.destroyed) highest = Math.min(highest, crate.y);
    }
    expect(layer.children).toHaveLength(0);
    // It rose above its post before it went.
    expect(highest).toBeLessThan(geometry.lanes[1]!.post.y - 100);
  });

  test("a crate flies away from the workshop, outward", () => {
    const layer = new Container();
    const step = createDispatch(layer, geometry);
    step(0, [zone(1)]);
    let time = 0;
    while (time < 1.3) step((time += 0.05), [zone(1)]);
    const crate = layer.children[0]!;
    let farthest = -Infinity;
    while (time < 20 && layer.children.length) {
      step((time += 0.05), [zone(0)]);
      if (!crate.destroyed) farthest = Math.max(farthest, crate.x);
    }
    expect(farthest).toBeGreaterThan(geometry.lanes[1]!.post.x + 100);
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

describe("labyrinth sky", () => {
  test("follows the clock: sun by day, stars and moon by night", () => {
    const noon = skyAt(12);
    expect(noon.body?.kind).toBe("sun");
    expect(noon.stars).toBe(0);
    expect(noon.body!.progress).toBeGreaterThan(0.4);
    expect(noon.body!.progress).toBeLessThan(0.5);
    const midnight = skyAt(0);
    expect(midnight.body?.kind).toBe("moon");
    expect(midnight.stars).toBe(1);
    // Stars fade in over the hour after sunset rather than switching on.
    expect(skyAt(20).stars).toBeCloseTo(0.5);
    expect(skyAt(24).top).toBe(skyAt(0).top);
    expect(skyAt(-1).top).toBe(skyAt(23).top);
  });
});
