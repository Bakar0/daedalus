import { describe, expect, test } from "vitest";
import type {
  AgentActivityDto,
  AgentSessionDto,
  GitStatusDto,
  PullRequestRefDto,
  SessionAttentionDto,
  SessionWorktreeDto,
  ShippedPullRequestDto,
  TaskDto,
  WorkspaceDto,
} from "@daedalus/protocol";
import {
  buildWorldModel,
  crateFor,
  roomTier,
  SHELF_SIZE,
  stationForDetail,
  WORLD_PLACES,
  type WorldCrate,
  type WorldModelInput,
} from "./world-model";
import { WORLD_THEMES } from "./themes";
import { LABYRINTH_ROOM, labyrinthTheme } from "./themes/labyrinth";
import { layoutFor } from "./themes/labyrinth-rooms";
import { createDispatch } from "./themes/labyrinth-dispatch";
import { skyAt } from "./themes/labyrinth-sky";
import { milestonesBetween } from "./world-milestones";
import { NO_PREVIEW, previewModel } from "./world-preview";
import { Container } from "pixi.js";
import { COSTUMES } from "./characters/costumes";
import { PERSONAS, personaFor } from "./characters/personas";
import { contextLevel } from "./characters/parts";

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
  defaultClaudeAccount: null,
  defaultCodexAccount: null,
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
  account: null,
  archivedAt: null,
  resumeCount: 0,
  lostReason: null,
  handoffRequestedAt: null,
  position: 0,
  pinnedAt: null,
  color: null,
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
  worktrees: [],
  shipped: [],
  now: Date.parse("2026-09-23T12:00:00.000Z"),
  ...overrides,
});

const worktree = (
  sessionId: string,
  path: string,
  git: Partial<GitStatusDto>,
  pullRequest?: Omit<PullRequestRefDto, "url">,
): SessionWorktreeDto => ({
  sessionId,
  repositoryId: "r",
  path,
  branchName: `daedalus/${sessionId}`,
  createdAt: "2026-09-23T10:00:00.000Z",
  gitStatus: {
    state: "ahead",
    changedFiles: 0,
    ahead: 0,
    behind: 0,
    ...git,
  },
  ...(pullRequest
    ? {
        pullRequest: {
          ...pullRequest,
          url: `https://github.com/o/r/pull/${pullRequest.number}`,
        },
      }
    : {}),
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

  test("an agent carries its session's color, or none", () => {
    const model = buildWorldModel(
      input({
        sessions: [session("a", { color: "teal" }), session("b")],
      }),
    );
    expect(model.actors.map((actor) => actor.color)).toEqual(["teal", null]);
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

  test("one crate per branch with work on it, by git and PR state", () => {
    const model = buildWorldModel(
      input({
        sessions: [
          session("a"),
          session("b", {
            status: "exited",
            archivedAt: "2026-09-23T12:00:00.000Z",
          }),
          session("c"),
        ],
        worktrees: [
          worktree("a", "/w/a", { ahead: 2, unpushed: 2 }),
          worktree(
            "b",
            "/w/b",
            { ahead: 1, unpushed: 0 },
            {
              number: 7,
              state: "OPEN",
              isDraft: false,
            },
          ),
          worktree("c", "/w/c", { ahead: 0 }),
        ],
      }),
    );
    // The archived session's branch still has an open pull request.
    expect(model.zones[0]?.crates).toEqual([
      {
        id: "/w/a",
        sessionId: "a",
        commits: 2,
        stage: "packing",
        label: "daedalus/a",
        url: null,
      },
      {
        id: "/w/b",
        sessionId: "b",
        commits: 1,
        stage: "open",
        label: "#7",
        url: "https://github.com/o/r/pull/7",
      },
    ]);
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
      crates: [],
      trophies: [],
      wins: 0,
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

  test("a bot handing off rides up into one of the Rebuilder's three bays", () => {
    const arrangement = labyrinthTheme.arrange(zones(3));
    const shared = labyrinthTheme.shared!;
    const { bays } = labyrinthTheme.handoff!;
    expect(bays).toHaveLength(3);
    // The first three stand in the intake bays; a fourth queues outside.
    const spots = Array.from({ length: 5 }, (_, slot) =>
      shared.spot("handoff", slot),
    );
    expect(spots.slice(0, 3)).toEqual(bays.map((bay) => bay.from));
    for (const point of spots.slice(3)) {
      expect(point.y).toBeLessThan(0);
      expect(point.x).toBeGreaterThan(240);
      expect(point.x).toBeLessThan(bays[0]!.from.x);
    }
    expect(new Set(spots.map((point) => point.x)).size).toBe(5);
    for (const bay of bays) {
      // Each bay sends to its own output bay, further along the surface.
      expect(bay.to.x).toBeGreaterThan(bay.from.x);
      expect(bay.to.y).toBe(bay.from.y);
    }
    const origin = arrangement.origins[2]!;
    const path = arrangement.route!(
      { x: origin.x, y: origin.y + 90 },
      spots[0]!,
    );
    expect(path.filter((point) => point.ride)).toHaveLength(1);
    expect(path.at(-1)).toEqual(spots[0]);
    // From the queue into a bay is a walk along the grass.
    expect(arrangement.route!(spots[3]!, bays[2]!.from)).toEqual([
      bays[2]!.from,
    ]);
  });

  test("web work is shared: every zone's bots go to the one Observatory", () => {
    const arrangement = labyrinthTheme.arrange(zones(3));
    const shared = labyrinthTheme.shared!;
    expect(shared.places).toEqual(["web", "handoff"]);
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
  const zone = (...crates: WorldCrate[]) => ({
    id: "w0",
    name: "w0",
    attention: 0,
    busy: 1,
    crates,
    trophies: [],
    wins: 0,
  });
  const crate = (stage: WorldCrate["stage"]): WorldCrate => ({
    id: "/w/a",
    sessionId: "a",
    commits: 2,
    stage,
    label: "#7",
    url: null,
  });
  /** Runs past the startup window, so later changes are seen happening. */
  const settle = (step: (time: number, zones: never[]) => void) => {
    let time = 0;
    while (time < 2) step((time += 0.05), []);
    return time;
  };

  test("a crate waits on the bench while its commits are local", () => {
    const layer = new Container();
    const step = createDispatch(layer, geometry);
    let time = settle(step);
    step(time, [zone(crate("packing"))]);
    expect(layer.children).toHaveLength(1);
    while (time < 10) step((time += 0.05), [zone(crate("packing"))]);
    expect(layer.children[0]!.position).toMatchObject({ x: 1000, y: 700 });
  });

  test("pushed, it rides out to the yard by its post and waits there", () => {
    const layer = new Container();
    const step = createDispatch(layer, geometry);
    let time = settle(step);
    step(time, [zone(crate("packing"))]);
    const view = layer.children[0]!;
    const pipe = geometry.lanes[1]!.pipeX;
    let inPipe = false;
    while (time < 20) {
      step((time += 0.05), [zone(crate("open"))]);
      // Up the pipe, not straight across from the room to the yard.
      if (Math.abs(view.x - pipe) < 1 && view.y > 100 && view.y < 700)
        inPipe = true;
    }
    expect(inPipe).toBe(true);
    // On the grass, inward of the right-hand post, and still there.
    expect(view.y).toBeLessThan(0);
    expect(view.y).toBeGreaterThan(-60);
    expect(view.x).toBeLessThan(geometry.lanes[1]!.post.x);
    expect(view.x).toBeGreaterThan(geometry.lanes[1]!.post.x - 400);
  });

  test("it flies off outward only when its pull request merges", () => {
    const layer = new Container();
    const step = createDispatch(layer, geometry);
    let time = settle(step);
    step(time, [zone(crate("packing"))]);
    while (time < 20) step((time += 0.05), [zone(crate("open"))]);
    const view = layer.children[0]!;
    let highest = Infinity;
    let farthest = -Infinity;
    while (time < 40 && layer.children.length) {
      step((time += 0.05), [zone(crate("merged"))]);
      if (!view.destroyed) {
        highest = Math.min(highest, view.y);
        farthest = Math.max(farthest, view.x);
      }
    }
    expect(layer.children).toHaveLength(0);
    expect(highest).toBeLessThan(geometry.lanes[1]!.post.y - 100);
    expect(farthest).toBeGreaterThan(geometry.lanes[1]!.post.x);
  });

  test("what is waiting as the World opens is placed, not replayed", () => {
    const layer = new Container();
    const step = createDispatch(layer, geometry);
    step(0, [zone(crate("open"))]);
    step(0.05, [zone(crate("open"))]);
    expect(layer.children[0]!.y).toBeLessThan(0);
    // A branch that merged before anyone looked shows nothing.
    const quiet = new Container();
    createDispatch(quiet, geometry)(0, [zone(crate("merged"))]);
    expect(quiet.children).toHaveLength(0);
  });

  test("a closed pull request takes its crate away without a flight", () => {
    const layer = new Container();
    const step = createDispatch(layer, geometry);
    let time = 0;
    step(time, [zone(crate("open"))]);
    while (time < 5) step((time += 0.05), [zone()]);
    expect(layer.children).toHaveLength(0);
  });
});

describe("trophies", () => {
  const done = (id: string, number: number, completedAt: string): TaskDto => ({
    ...task,
    id,
    number,
    title: `Task ${number}`,
    status: "done",
    completedAt,
  });
  const pull = (
    number: number,
    taskId: string | null,
    mergedAt: string,
  ): ShippedPullRequestDto => ({
    url: `https://github.com/o/r/pull/${number}`,
    workspaceId: "w",
    sessionId: null,
    taskId,
    repositoryId: null,
    number,
    title: `Change ${number}`,
    branchName: `b${number}`,
    mergedAt,
  });

  test("a task and its pull request are one win; strays count alone", () => {
    const model = buildWorldModel(
      input({
        tasks: [
          done("t1", 1, "2026-09-20T10:00:00.000Z"),
          done("t2", 2, "2026-09-22T10:00:00.000Z"),
          { ...task, id: "t3", number: 3, status: "cancelled" },
        ],
        shipped: [
          pull(10, "t2", "2026-09-22T09:00:00.000Z"),
          pull(11, null, "2026-09-21T10:00:00.000Z"),
          // Its task was reopened, so the pull request stands alone.
          pull(12, "t3", "2026-09-23T10:00:00.000Z"),
        ],
      }),
    );
    const zone = model.zones[0]!;
    expect(zone.wins).toBe(4);
    expect(zone.trophies.map((item) => [item.kind, item.label])).toEqual([
      ["task", "#1 Task 1"],
      ["pull-request", "PR #11 Change 11"],
      ["shipped-task", "#2 Task 2"],
      ["pull-request", "PR #12 Change 12"],
    ]);
    expect(zone.trophies[2]!.detail).toBe("PR #10 merged");
  });

  test("the week lists the last seven days, newest first, busiest first", () => {
    const model = buildWorldModel(
      input({
        workspaces: [workspace("w"), workspace("v"), workspace("quiet")],
        tasks: [
          done("t1", 1, "2026-09-10T10:00:00.000Z"),
          done("t2", 2, "2026-09-20T10:00:00.000Z"),
          done("t3", 3, "2026-09-22T10:00:00.000Z"),
          { ...done("t4", 4, "2026-09-21T10:00:00.000Z"), workspaceId: "v" },
        ],
      }),
    );
    expect(
      model.week.map((item) => [
        item.zoneId,
        item.trophies.map((trophy) => trophy.label),
      ]),
    ).toEqual([
      ["w", ["#3 Task 3", "#2 Task 2"]],
      ["v", ["#4 Task 4"]],
    ]);
  });

  test("the shelf holds the newest; the tier counts them all", () => {
    const tasks = Array.from({ length: 30 }, (_, index) =>
      done(
        `t${index}`,
        index,
        `2026-09-01T10:${String(index).padStart(2, "0")}:00.000Z`,
      ),
    );
    const zone = buildWorldModel(input({ tasks })).zones[0]!;
    expect(zone.wins).toBe(30);
    expect(zone.trophies).toHaveLength(SHELF_SIZE);
    expect(zone.trophies.at(-1)!.label).toBe("#29 Task 29");
    expect([0, 9, 10, 24, 25, 90].map(roomTier)).toEqual([0, 0, 1, 1, 2, 2]);
  });
});

describe("milestones", () => {
  const snapshot = (
    mood: "working" | "idle" | "attention",
    extra: Partial<WorldModelInput> = {},
    detail: string | null = null,
  ) =>
    buildWorldModel(
      input({
        sessions: [session("a", { taskId: "t" })],
        activity: new Map([
          [
            "a",
            activity(
              "a",
              mood === "attention" ? "needs_permission" : mood,
              detail,
            ),
          ],
        ]),
        ...extra,
      }),
    );

  test("a finished turn pops the agent's closing words; a question does not", () => {
    const before = snapshot("working", {}, "Edit(x.ts)");
    expect(
      milestonesBetween(
        before,
        snapshot("idle", {}, "Found 12 sources on reward prediction error."),
      ),
    ).toEqual([
      {
        sessionId: "a",
        text: "✓ Found 12 sources on reward prediction error.",
      },
    ]);
    expect(milestonesBetween(before, snapshot("attention"))).toEqual([]);
    expect(milestonesBetween(before, before)).toEqual([]);
  });

  test("commits, pushes, pull requests and a done task", () => {
    const git = (
      ahead: number,
      unpushed: number,
      pull?: Omit<PullRequestRefDto, "url">,
    ) => ({ worktrees: [worktree("a", "/w/a", { ahead, unpushed }, pull)] });
    const steps: Array<Partial<WorldModelInput>> = [
      git(0, 0),
      git(1, 1),
      git(1, 0),
      git(2, 0, { number: 9, state: "OPEN", isDraft: true }),
      git(2, 0, { number: 9, state: "OPEN", isDraft: false }),
      {
        ...git(0, 0, { number: 9, state: "MERGED", isDraft: false }),
        tasks: [
          {
            ...task,
            id: "t",
            status: "done",
            completedAt: "2026-09-23T11:00:00.000Z",
          },
        ],
      },
    ];
    const models = steps.map((step) => snapshot("working", step));
    const texts = models
      .slice(1)
      .map((model, index) =>
        milestonesBetween(models[index]!, model).map((item) => item.text),
      );
    expect(texts).toEqual([
      ["Committed"],
      ["Pushed"],
      ["Committed", "Opened PR #9"],
      ["PR #9 ready for review"],
      [`✓ #${task.number} ${task.title} done`, "PR #9 merged"],
    ]);
  });
});

describe("handoff", () => {
  test("a session asked to hand off goes to the machine; its successor names it", () => {
    const requested = "2026-09-23T11:00:00.000Z";
    const model = buildWorldModel(
      input({
        sessions: [
          session("old", {
            workingDirectory: "/w/tree",
            handoffRequestedAt: requested,
          }),
          session("new", {
            workingDirectory: "/w/tree",
            startedAt: "2026-09-23T11:02:00.000Z",
          }),
          // Same folder, but it started before the request: not a successor.
          session("earlier", {
            workingDirectory: "/w/tree",
            startedAt: "2026-09-23T10:30:00.000Z",
          }),
          session("elsewhere", { startedAt: "2026-09-23T11:05:00.000Z" }),
        ],
        activity: new Map([["old", activity("old", "working", "Edit(x.ts)")]]),
      }),
    );
    const byId = new Map(model.actors.map((actor) => [actor.sessionId, actor]));
    expect(byId.get("old")!.place).toBe("handoff");
    expect(byId.get("new")!.continuesFrom).toBe("old");
    expect(byId.get("earlier")!.continuesFrom).toBeNull();
    expect(byId.get("elsewhere")!.continuesFrom).toBeNull();
  });

  test("the successor still names an archived predecessor", () => {
    const model = buildWorldModel(
      input({
        sessions: [
          session("old", {
            workingDirectory: "/w/tree",
            handoffRequestedAt: "2026-09-23T11:00:00.000Z",
            status: "exited",
            archivedAt: "2026-09-23T11:02:00.000Z",
          }),
          session("new", {
            workingDirectory: "/w/tree",
            startedAt: "2026-09-23T11:02:00.000Z",
          }),
        ],
      }),
    );
    expect(model.actors.map((actor) => actor.sessionId)).toEqual(["new"]);
    expect(model.actors[0]!.continuesFrom).toBe("old");
  });
});

describe("preview", () => {
  const model = () =>
    buildWorldModel(
      input({
        sessions: ["a", "b", "c", "d", "e"].map((id) => session(id)),
      }),
    );

  test("off leaves the model alone", () => {
    const real = model();
    expect(previewModel(real, NO_PREVIEW)).toBe(real);
  });

  test("colors hands every agent a session color, one each", () => {
    const shown = previewModel(model(), {
      context: "off",
      crateStep: null,
      colors: true,
    });
    expect(shown.actors.map((actor) => actor.color)).toEqual([
      "red",
      "orange",
      "gold",
      "green",
      "teal",
    ]);
  });

  test("one level each puts an agent past every threshold", () => {
    const shown = previewModel(model(), { context: "spread", crateStep: null });
    expect(
      shown.actors.map((actor) => contextLevel(actor.contextPercent)),
    ).toEqual([0, 1, 2, 3, 0]);
    expect(
      previewModel(model(), { context: 90, crateStep: null }).actors.every(
        (actor) => actor.contextPercent === 90,
      ),
    ).toBe(true);
  });

  test("the pretend crate makes the same pops a real branch would", () => {
    const real = model();
    const steps = [null, 0, 1, 2, 3, 4, null].map((crateStep) =>
      previewModel(real, { context: "off", crateStep }),
    );
    const texts = steps
      .slice(1)
      .map((shown, index) =>
        milestonesBetween(steps[index]!, shown).map((item) => item.text),
      );
    expect(texts).toEqual([
      ["Committed"],
      ["Pushed"],
      ["Committed", "Opened PR #999"],
      ["PR #999 ready for review"],
      ["PR #999 merged"],
      [],
    ]);
  });
});

describe("context level", () => {
  test("steam at 30%, sweat at 50%, smoke at 80%; unknown shows nothing", () => {
    expect([null, 0, 29.9, 30, 49, 50, 79, 80, 100].map(contextLevel)).toEqual([
      0, 0, 0, 1, 1, 2, 2, 3, 3,
    ]);
  });
});

describe("crateFor", () => {
  test("follows the branch from local commits to a merged pull request", () => {
    const stage = (
      git: Partial<GitStatusDto>,
      pull?: Omit<PullRequestRefDto, "url">,
    ) => crateFor(worktree("a", "/w/a", git, pull))?.stage ?? null;
    expect(stage({ ahead: 0 })).toBeNull();
    expect(stage({ ahead: 3, unpushed: 3 })).toBe("packing");
    expect(stage({ ahead: 3, unpushed: 0 })).toBe("pushed");
    expect(
      stage({ ahead: 3 }, { number: 1, state: "OPEN", isDraft: true }),
    ).toBe("draft");
    expect(
      stage({ ahead: 3 }, { number: 1, state: "OPEN", isDraft: false }),
    ).toBe("open");
    expect(
      stage({ ahead: 0 }, { number: 1, state: "MERGED", isDraft: false }),
    ).toBe("merged");
    expect(
      stage({ ahead: 3 }, { number: 1, state: "CLOSED", isDraft: false }),
    ).toBeNull();
  });
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
