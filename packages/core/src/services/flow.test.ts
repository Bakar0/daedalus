import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { TmuxClient, TmuxLaunch } from "@daedalus/platform";
import { withTemporaryDaedalusHome } from "@daedalus/test-utils";
import {
  createApplicationContext,
  parseStageSpecs,
  type AgentSession,
  type ApplicationContext,
  type FlowActor,
} from "../index";

class FakeTmux implements TmuxClient {
  readonly sessions = new Set<string>();
  readonly launches: TmuxLaunch[] = [];
  async probe() {
    return "tmux 3.7c";
  }
  async createSession(launch: TmuxLaunch) {
    this.launches.push(launch);
    this.sessions.add(launch.session);
  }
  async hasSession(session: string) {
    return this.sessions.has(session);
  }
  async listSessions() {
    return [...this.sessions];
  }
  async attach() {
    return 0;
  }
  async capture() {
    return "❯ \n  ⏵⏵ auto mode on (shift+tab to cycle)";
  }
  async sendKeys() {}
  async send() {}
  async stop(session: string) {
    this.sessions.delete(session);
  }
  async killServer() {
    this.sessions.clear();
    return true;
  }
}

interface Harness {
  context: ApplicationContext;
  tmux: FakeTmux;
  workspaceId: string;
}

async function withFlow(run: (harness: Harness) => Promise<void>) {
  await withTemporaryDaedalusHome(async (home) => {
    await Bun.write(
      join(home, "config.json"),
      JSON.stringify({
        agents: {
          claude: { executable: process.execPath, args: ["run"] },
          codex: { executable: process.execPath, args: ["run"] },
        },
      }),
    );
    const tmux = new FakeTmux();
    const context = await createApplicationContext({
      env: {
        DAEDALUS_HOME: home,
        CODEX_HOME: join(home, "codex"),
        CLAUDE_CONFIG_DIR: join(home, "claude"),
        DAEDALUS_AGENTS_HOME: join(home, "agents"),
        DAEDALUS_CURSOR_HOME: join(home, "cursor"),
      },
      tmux,
      sendNativeNotification: async () => ({
        delivered: true,
        backend: "app" as const,
        degraded: false,
      }),
    });
    try {
      const workspace = await context.workspaces.create({
        name: "Shop",
        slug: "shop",
      });
      await run({ context, tmux, workspaceId: workspace.id });
    } finally {
      context.close();
    }
  });
}

const user: FlowActor = { kind: "user" };
const as = (session: AgentSession): FlowActor => ({ kind: "session", session });

async function agent(context: ApplicationContext, name: string, flow = true) {
  return context.agents.spawn({
    workspace: "shop",
    provider: "claude",
    name,
    ...(flow ? { abilities: ["flow"] } : {}),
  });
}

/**
 * Checkout, owned by a session called Mapper, with an API server holding
 * Orders and Payments, and a web client. The user builds it.
 */
async function checkout(context: ApplicationContext, _workspaceId: string) {
  const owner = await agent(context, "Mapper");
  const detail = context.flow.createMap(user, {
    ownerSessionId: owner.id,
    name: "Checkout",
    deliverable: "A customer pays for an order",
  });
  const root = detail.components[0]!;
  const add = (parentId: string, name: string, stages?: string) =>
    context.flow.addComponent(user, detail.map.id, {
      parentId,
      name,
      deliverable: `${name} works`,
      ...(stages ? { stages: parseStageSpecs(stages) } : {}),
    });
  const api = add(
    root.id,
    "API server",
    "rollup:implement,after:validate=integration",
  );
  const orders = add(api.id, "Orders API", "plan,implement,validate");
  const payments = add(api.id, "Payments", "plan,implement,validate");
  const web = add(root.id, "Web client", "implement");
  return { map: detail.map, owner, root, api, orders, payments, web };
}

const shownOf = (
  context: ApplicationContext,
  mapId: string,
  componentId: string,
) =>
  context.flow
    .detail(mapId)
    .stages.filter(
      (stage) => stage.componentId === componentId && !stage.droppedReason,
    )
    .map((stage) => `${stage.label ?? stage.kind}:${stage.shown}`);

describe("flow maps", () => {
  test("the flow ability is told at launch, and changes need it", async () => {
    await withFlow(async ({ context, tmux, workspaceId }) => {
      const mapper = await agent(context, "Mapper");
      expect(tmux.launches.at(-1)!.args.at(-1)).toContain("flow ability");
      const plain = await agent(context, "Plain", false);
      expect(() =>
        context.flow.createMap(as(plain), {
          name: "Checkout",
          deliverable: "Pay",
        }),
      ).toThrow("does not hold the flow map ability");
      expect(() =>
        context.flow.createMap(user, { name: "Checkout", deliverable: "Pay" }),
      ).toThrow("pass --session");
      const detail = context.flow.createMap(as(mapper), {
        name: "Checkout",
        deliverable: "Pay",
      });
      expect(detail.map).toMatchObject({ number: 1, name: "Checkout" });
      expect(detail.components).toHaveLength(1);
      expect(context.flow.history(detail.map.id)[0]).toMatchObject({
        author: "Mapper",
        text: "Started the map 'Checkout'",
      });
      // Reading is open to every session; the CLI does not ask.
      expect(context.flow.listMaps(workspaceId)).toHaveLength(1);
    });
  });

  test("components nest in one parent and are found by number, path or name", async () => {
    await withFlow(async ({ context, workspaceId }) => {
      const { map, api, orders } = await checkout(context, workspaceId);
      expect(
        context.flow.resolveComponent(map.id, `#${orders.number}`).id,
      ).toBe(orders.id);
      expect(
        context.flow.resolveComponent(map.id, "Checkout/API server/Orders API")
          .id,
      ).toBe(orders.id);
      expect(
        context.flow.resolveComponent(map.id, "api server/orders api").id,
      ).toBe(orders.id);
      expect(context.flow.resolveComponent(map.id, "Orders API").id).toBe(
        orders.id,
      );
      expect(() =>
        context.flow.addComponent(user, map.id, {
          parentId: api.id,
          name: "orders api",
          deliverable: "again",
        }),
      ).toThrow("already in that component");
      expect(() =>
        context.flow.editComponent(user, api.id, { parentId: orders.id }),
      ).toThrow("cannot move into itself");
      expect(() =>
        context.flow.addComponent(user, map.id, {
          parentId: api.id,
          name: "Empty",
          deliverable: " ",
        }),
      ).toThrow("The deliverable is required");
    });
  });

  test("a dropped component stays with its reason; a deleted one leaves no trace", async () => {
    await withFlow(async ({ context, workspaceId }) => {
      const { map, root, api, web } = await checkout(context, workspaceId);
      const fraud = context.flow.addComponent(user, map.id, {
        parentId: root.id,
        name: "Fraud service",
        deliverable: "Scores orders",
      });
      const typo = context.flow.addComponent(user, map.id, {
        parentId: root.id,
        name: "Wbe client",
        deliverable: "typo",
      });
      context.flow.relate(user, map.id, {
        fromId: web.id,
        toId: typo.id,
        type: "calls",
      });
      context.flow.dropComponent(
        user,
        fraud.id,
        "Stripe Radar scores orders already",
      );
      context.flow.deleteComponent(user, typo.id);

      const detail = context.flow.detail(map.id);
      expect(detail.components.find((c) => c.id === fraud.id)).toMatchObject({
        droppedReason: "Stripe Radar scores orders already",
      });
      expect(detail.components.some((c) => c.id === typo.id)).toBe(false);
      expect(detail.relations).toHaveLength(0);
      const lines = context.flow.history(map.id).map((entry) => entry.text);
      expect(lines).toContain(
        "Dropped 'Fraud service': Stripe Radar scores orders already",
      );
      expect(lines.some((line) => line.includes("Wbe client"))).toBe(false);

      expect(() => context.flow.deleteComponent(user, api.id)).toThrow(
        "--with-contents",
      );
      context.flow.deleteComponent(user, api.id, { withContents: true });
      expect(context.flow.detail(map.id).components.map((c) => c.name)).toEqual(
        ["Checkout", "Web client", "Fraud service"],
      );
      context.flow.restoreComponent(user, fraud.id);
      expect(
        context.flow.detail(map.id).components.at(-1)?.droppedReason,
      ).toBeNull();
    });
  });

  test("relations are typed, within one map, never to themselves or twice", async () => {
    await withFlow(async ({ context, workspaceId }) => {
      const { map, web, orders } = await checkout(context, workspaceId);
      const relation = context.flow.relate(user, map.id, {
        fromId: web.id,
        toId: orders.id,
        type: "calls",
        note: "REST /orders",
      });
      expect(relation).toMatchObject({
        number: 1,
        type: "calls",
        note: "REST /orders",
      });
      expect(() =>
        context.flow.relate(user, map.id, {
          fromId: web.id,
          toId: orders.id,
          type: "calls",
        }),
      ).toThrow("already calls");
      expect(() =>
        context.flow.relate(user, map.id, {
          fromId: web.id,
          toId: web.id,
          type: "depends on",
        }),
      ).toThrow("two different components");
      const other = context.flow.createMap(user, {
        ownerSessionId: (await agent(context, "Biller")).id,
        name: "Billing",
        deliverable: "Invoices",
      });
      expect(() =>
        context.flow.relate(user, other.map.id, {
          fromId: other.components[0]!.id,
          toId: web.id,
          type: "calls",
        }),
      ).toThrow("on another map");
      context.flow.dropRelation(
        user,
        relation.id,
        "The client reads a cache instead",
      );
      expect(context.flow.resolveRelation(map.id, "r1").droppedReason).toBe(
        "The client reads a cache instead",
      );
    });
  });

  test("a container's stages follow its components and its own wait for them", async () => {
    await withFlow(async ({ context, workspaceId }) => {
      const { map, api, orders, payments } = await checkout(
        context,
        workspaceId,
      );
      expect(shownOf(context, map.id, api.id)).toEqual([
        "implement:todo",
        "integration:waiting",
      ]);
      context.flow.moveStage(user, orders.id, "implement", "start");
      expect(shownOf(context, map.id, api.id)).toEqual([
        "implement:running",
        "integration:waiting",
      ]);
      expect(() =>
        context.flow.moveStage(user, api.id, "implement", "finish"),
      ).toThrow("worked out from the components inside");
      expect(() =>
        context.flow.moveStage(user, api.id, "validate", "start"),
      ).toThrow("waits for the components inside");
      for (const component of [orders, payments]) {
        context.flow.moveStage(user, component.id, "implement", "finish");
        context.flow.moveStage(user, component.id, "validate", "finish");
      }
      expect(shownOf(context, map.id, api.id)).toEqual([
        "implement:done",
        "integration:todo",
      ]);
      context.flow.moveStage(user, api.id, "validate", "start");
      expect(shownOf(context, map.id, api.id)).toEqual([
        "implement:done",
        "integration:running",
      ]);
    });
  });

  test("a stage is claimed by one live session at a time", async () => {
    await withFlow(async ({ context, workspaceId }) => {
      const { map, orders } = await checkout(context, workspaceId);
      const first = await agent(context, "First");
      const second = await agent(context, "Second");
      const started = context.flow.moveStage(
        as(first),
        orders.id,
        "implement",
        "start",
      );
      expect(started).toMatchObject({ shown: "running", sessionId: first.id });
      expect(() =>
        context.flow.moveStage(as(second), orders.id, "implement", "start"),
      ).toThrow("held by 'First'");
      expect(() =>
        context.flow.moveStage(as(second), orders.id, "implement", "finish"),
      ).toThrow("held by 'First'");
      // Once the holder is gone the stage is free to take.
      await context.agents.archive(first.id);
      expect(
        context.flow.moveStage(as(second), orders.id, "implement", "start")
          .sessionId,
      ).toBe(second.id);
      // The user can always move a stage, and finishing keeps who did it.
      expect(
        context.flow.moveStage(user, orders.id, "implement", "finish"),
      ).toMatchObject({
        shown: "done",
        sessionId: second.id,
      });
      expect(() =>
        context.flow.moveStage(user, orders.id, "validate", "block"),
      ).toThrow("The reason is required");
      expect(context.flow.history(map.id)[0]?.text).toBe(
        "Finished implement on 'Orders API'",
      );
    });
  });

  test("only the owner changes a map's shape; any session works its stages", async () => {
    await withFlow(async ({ context, workspaceId }) => {
      const { map, owner, root, orders } = await checkout(context, workspaceId);
      const rival = await agent(context, "Rival");
      const worker = await agent(context, "Worker", false);
      expect(() =>
        context.flow.addComponent(as(rival), map.id, {
          parentId: root.id,
          name: "Docs",
          deliverable: "A guide",
        }),
      ).toThrow("belongs to 'Mapper'");
      expect(() =>
        context.flow.addComponent(as(worker), map.id, {
          parentId: root.id,
          name: "Docs",
          deliverable: "A guide",
        }),
      ).toThrow("does not hold the flow map ability");
      context.flow.addComponent(as(owner), map.id, {
        parentId: root.id,
        name: "Docs",
        deliverable: "A guide",
      });
      // A session without the ability claims and finishes a stage.
      expect(
        context.flow.moveStage(as(worker), orders.id, "plan", "start"),
      ).toMatchObject({ shown: "running", sessionId: worker.id });
      expect(() =>
        context.flow.moveStage(as(worker), orders.id, "plan", "reset"),
      ).toThrow("does not hold the flow map ability");
      context.flow.moveStage(as(worker), orders.id, "plan", "finish");
      // A revoke freezes the map; a grant brings the owner back.
      context.abilities.revoke(owner.id, "flow");
      expect(() => context.flow.decide(as(owner), orders.id, "x")).toThrow(
        "does not hold",
      );
      context.abilities.grant(owner.id, "flow", { live: true });
      context.flow.decide(as(owner), orders.id, "Keep it small.");
      expect(context.flow.mapsOwnedBy(owner.id).map((m) => m.id)).toEqual([
        map.id,
      ]);
      // The map follows the ability row, as a team follows its lead.
      context.repositories.abilities.moveToSession(owner.id, worker.id);
      expect(() => context.flow.decide(as(owner), orders.id, "x")).toThrow();
      expect(context.flow.ownerOf(context.flow.getMap(map.id))?.id).toBe(
        worker.id,
      );
      context.flow.decide(as(worker), orders.id, "The successor decides.");
    });
  });

  test("a rebirth hands unfinished stages to the successor", async () => {
    await withFlow(async ({ context, workspaceId }) => {
      const { map, orders } = await checkout(context, workspaceId);
      const first = await agent(context, "First");
      const second = await agent(context, "Second");
      context.flow.moveStage(as(first), orders.id, "plan", "start");
      context.flow.moveStage(as(first), orders.id, "plan", "finish");
      context.flow.moveStage(as(first), orders.id, "implement", "start");
      context.repositories.flow.moveHeldStages(
        first.id,
        second.id,
        new Date().toISOString(),
      );
      const stages = context.flow
        .detail(map.id)
        .stages.filter((stage) => stage.componentId === orders.id);
      expect(stages.find((s) => s.kind === "plan")?.sessionId).toBe(first.id);
      expect(stages.find((s) => s.kind === "implement")?.sessionId).toBe(
        second.id,
      );
    });
  });

  test("changing a flow keeps state; started stages leave only when dropped or deleted", async () => {
    await withFlow(async ({ context, workspaceId }) => {
      const { map, orders } = await checkout(context, workspaceId);
      context.flow.moveStage(user, orders.id, "plan", "finish");
      expect(() =>
        context.flow.setStages(
          user,
          orders.id,
          parseStageSpecs("prototype,implement,validate"),
        ),
      ).toThrow("--drop");
      context.flow.setStages(
        user,
        orders.id,
        parseStageSpecs("prototype,implement,validate"),
        { kind: "drop", reason: "The shape came out of a prototype instead" },
      );
      const all = context.flow
        .detail(map.id)
        .stages.filter((s) => s.componentId === orders.id);
      expect(
        all.map(
          (s) => `${s.kind}:${s.state}:${s.droppedReason ? "dropped" : "live"}`,
        ),
      ).toEqual([
        "prototype:todo:live",
        "implement:todo:live",
        "validate:todo:live",
        "plan:done:dropped",
      ]);
      // Putting the kind back restores it with its state.
      context.flow.setStages(
        user,
        orders.id,
        parseStageSpecs("plan,implement,validate"),
        {
          kind: "delete",
        },
      );
      expect(shownOf(context, map.id, orders.id)).toEqual([
        "plan:done",
        "implement:todo",
        "validate:todo",
      ]);
      expect(() => parseStageSpecs("plan,plan")).toThrow("appears twice");
      expect(() => parseStageSpecs("review")).toThrow("Unknown stage");
      expect(parseStageSpecs("after:validate=integration")).toEqual([
        { kind: "validate", mode: "after", label: "integration" },
      ]);
    });
  });

  test("decisions and task links sit on their component", async () => {
    await withFlow(async ({ context, workspaceId }) => {
      const { map, orders } = await checkout(context, workspaceId);
      const task = await context.tasks.create({
        workspace: "shop",
        title: "Orders API",
      });
      context.flow.linkTask(user, orders.id, task.id);
      context.flow.decide(user, orders.id, "Idempotency keys on POST /orders.");
      const detail = context.flow.detail(map.id);
      expect(detail.decisions).toMatchObject([
        {
          componentId: orders.id,
          text: "Idempotency keys on POST /orders.",
          author: "user",
        },
      ]);
      expect(context.flow.linksForTask(task.id)).toMatchObject([
        { map: { id: map.id }, component: { id: orders.id } },
      ]);
    });
  });

  test("every change moves the map's updated time, which the app watches", async () => {
    await withFlow(async ({ context, workspaceId }) => {
      const { map, orders } = await checkout(context, workspaceId);
      const before = context.repositories.flow.fingerprint();
      await Bun.sleep(5);
      context.flow.decide(user, orders.id, "Something");
      expect(context.repositories.flow.fingerprint()).not.toEqual(before);
      context.flow.deleteMap(user, map.id);
      expect(context.repositories.flow.fingerprint()).toEqual([]);
    });
  });
});
