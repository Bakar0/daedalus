import { join } from "node:path";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import type { TmuxClient, TmuxLaunch } from "@daedalus/platform";
import {
  withoutProviderClis,
  withTemporaryDaedalusHome,
} from "@daedalus/test-utils";
import {
  createApplicationContext,
  ReadModel,
  WorkflowService,
  type AgentSession,
  type ApplicationContext,
} from "../index";
import { workflowsHomePath } from "./workflow-files";

/**
 * A fixed set of workflows for these tests, apart from the starters, which
 * change as the user's needs do.
 */
const FIXTURE_STEPS: Record<string, string> = {
  do: "Do what the session was asked.",
  check: "Prove the result works.",
  research: "Learn what exists.",
  grounding: "Agree the plan with the user.",
  prototype: "Build the smallest version.",
  review: "Find the bugs.",
  test: "Run the tests.",
  deploy: "Ship the change.",
  "validate-on-prod": "Check it where users get it.",
  feedback: "Check it in the wild.",
};
const FIXTURE_FLOWS: Record<string, string> = {
  quick: "steps: [do, check]",
  feature:
    "steps: [research, grounding, prototype, review, test, deploy, validate-on-prod, feedback]",
  iterate:
    "steps: [prototype, review, feedback]\nloop: prototype\nuntil: The user says it is good enough.",
  todo: "steps: dynamic",
};

const GATES: Record<string, string> = { deploy: "user", test: "before" };

async function writeFixtureWorkflows(home: string): Promise<void> {
  const root = workflowsHomePath(home);
  await rm(join(root, "flows"), { recursive: true, force: true });
  await rm(join(root, "steps"), { recursive: true, force: true });
  await mkdir(join(root, "flows"), { recursive: true });
  await mkdir(join(root, "steps"), { recursive: true });
  for (const [name, description] of Object.entries(FIXTURE_STEPS))
    await writeFile(
      join(root, "steps", `${name}.md`),
      `---\nname: ${name}\ndescription: ${description}\n${GATES[name] ? `gate: ${GATES[name]}\n` : ""}---\n\n${description}\n`,
    );
  for (const [name, fields] of Object.entries(FIXTURE_FLOWS))
    await writeFile(
      join(root, "flows", `${name}.md`),
      `---\nname: ${name}\nwhen: Tests.\n${fields}\n---\n`,
    );
}

class FakeTmux implements TmuxClient {
  openPty() {
    return {
      start: async () => {},
      write() {},
      resize() {},
      close() {},
    };
  }
  async pinWindowSize() {}
  async unpinWindowSize() {}
  readonly sessions = new Set<string>();
  async probe() {
    return "tmux 3.7c";
  }
  async createSession(launch: TmuxLaunch) {
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
    return "";
  }
  async sendKeys() {}
  async send() {}
  async stop(session: string) {
    this.sessions.delete(session);
  }
  async killServer() {
    this.sessions.clear();
    return false;
  }
}

interface Setup {
  context: ApplicationContext;
  workflows: WorkflowService;
  raised: Array<{ sessionId: string; reason: string }>;
  cleared: string[];
  workspaceId: string;
  session(taskId?: string | null): AgentSession;
}

const withWorkflows = (run: (setup: Setup) => Promise<void>) =>
  withTemporaryDaedalusHome(async (home) => {
    await withoutProviderClis(home);
    const context = await createApplicationContext({
      env: { ...process.env, DAEDALUS_HOME: home },
      tmux: new FakeTmux(),
    });
    try {
      // Creating a workspace writes the custom instructions folder and the
      // starter workflows, as the app does.
      const workspace = await context.workspaces.create({ name: "Flow" });
      await writeFixtureWorkflows(home);
      const raised: Setup["raised"] = [];
      const cleared: string[] = [];
      const workflows = new WorkflowService(
        context.repositories,
        context.config.home,
        {
          raise: async (input) => {
            raised.push(input);
            return {};
          },
          clear: (sessionId) => {
            cleared.push(sessionId);
            return { cleared: 1 };
          },
        },
        () => true,
      );
      const session = (taskId: string | null = null): AgentSession => {
        const id = crypto.randomUUID();
        const agent: AgentSession = {
          id,
          workspaceId: workspace.id,
          taskId,
          name: "Agent",
          provider: "claude",
          kind: "agent",
          tmuxSession: `daedalus_${id.replaceAll("-", "")}`,
          command: "/bin/sh",
          args: [],
          workingDirectory: workspace.path,
          status: "running",
          exitCode: null,
          startedAt: new Date().toISOString(),
          endedAt: null,
          providerSessionId: null,
          archivedAt: null,
          resumeCount: 0,
          lostReason: null,
          rebirthRequestedAt: null,
          resumeOnStart: false,
          position: context.repositories.nextAgentPosition(workspace.id),
          pinnedAt: null,
          color: null,
          account: null,
          teamId: null,
          teamHandle: null,
          spawnedBy: null,
          hostId: null,
          autoRebirthPercent: null,
        };
        context.repositories.createAgent(agent);
        return agent;
      };
      await run({
        context,
        workflows,
        raised,
        cleared,
        workspaceId: workspace.id,
        session,
      });
    } finally {
      context.close();
    }
  });

const states = (run: { steps: Array<{ name: string; state: string }> }) =>
  Object.fromEntries(run.steps.map((step) => [step.name, step.state]));

describe("WorkflowService", () => {
  test("a run is the session's own, even on a shared task; a step start finishes the one before; a rebirth carries it", async () => {
    await withWorkflows(
      async ({ context, workflows, session, workspaceId }) => {
        const task = await context.tasks.create({
          workspace: workspaceId,
          title: "Ship search",
        });
        const first = session(task.id);
        const second = session(task.id);

        const run = await workflows.start({
          sessionId: first.id,
          workflow: "feature",
        });
        expect(run.sessionId).toBe(first.id);
        expect(run.steps.map((step) => step.name)).toEqual([
          "research",
          "grounding",
          "prototype",
          "review",
          "test",
          "deploy",
          "validate-on-prod",
          "feedback",
        ]);
        await workflows.step({
          note: "n",
          sessionId: first.id,
          step: "research",
          action: "start",
        });
        const moved = await workflows.step({
          sessionId: first.id,
          step: "grounding",
          action: "start",
          note: "Plan agreed",
        });
        expect(states(moved.run)).toMatchObject({
          research: "done",
          grounding: "active",
          prototype: "pending",
        });
        // The other session on the task has nothing until it starts its own.
        expect(workflows.current(second.id)).toBeUndefined();
        await workflows.start({
          sessionId: second.id,
          workflow: "quick",
        });
        expect(
          workflows
            .list()
            .map((item) => item.sessionId)
            .sort(),
        ).toEqual([first.id, second.id].sort());
        // Nothing about the task changed.
        expect(context.tasks.get(task.id).status).toBe("todo");

        await expect(
          workflows.start({
            sessionId: first.id,
            workflow: "quick",
          }),
        ).rejects.toThrow(
          "This session already runs workflow 'feature' at step 'grounding' (2 of 8)",
        );

        const successor = session(task.id);
        context.repositories.workflows.moveToSession(first.id, successor.id);
        expect(workflows.current(successor.id)?.id).toBe(run.id);
        expect(workflows.current(first.id)).toBeUndefined();

        const replaced = await workflows.start({
          sessionId: successor.id,
          workflow: "quick",
          replace: true,
        });
        expect(context.repositories.workflows.find(run.id)?.endedAt).not.toBe(
          null,
        );
        expect(workflows.current(successor.id)?.id).toBe(replaced.id);
      },
    );
  });

  test("a 'user' gate waits on done until the user approves what came out", async () => {
    await withWorkflows(async ({ workflows, session, raised, cleared }) => {
      const agent = session();
      await workflows.start({ sessionId: agent.id, workflow: "feature" });
      await workflows.step({
        sessionId: agent.id,
        step: "deploy",
        action: "start",
        note: "Release 1.2",
      });
      // The agent cannot move on before the user saw the result.
      await expect(
        workflows.step({
          note: "n",
          sessionId: agent.id,
          step: "validate-on-prod",
          action: "start",
        }),
      ).rejects.toThrow("needs the user's approval when it is done");
      const done = await workflows.step({
        sessionId: agent.id,
        step: "deploy",
        action: "done",
        note: "1.2 is on the beta feed",
      });
      expect(done.waiting).toBe(true);
      expect(states(done.run).deploy).toBe("waiting");
      expect(done.run.steps.find((step) => step.name === "deploy")?.note).toBe(
        "1.2 is on the beta feed",
      );
      expect(raised).toEqual([
        {
          sessionId: agent.id,
          reason:
            "Approve the result of step 'deploy' of workflow 'feature': 1.2 is on the beta feed",
        },
      ]);
      await expect(
        workflows.step({
          note: "n",
          sessionId: agent.id,
          step: "validate-on-prod",
          action: "start",
        }),
      ).rejects.toThrow("waits for the user to approve what came out");

      const approved = workflows.approve(agent.id);
      expect(states(approved).deploy).toBe("done");
      expect(states(approved)["validate-on-prod"]).toBe("pending");
      expect(cleared).toEqual([agent.id]);
      expect(() => workflows.approve(agent.id)).toThrow(
        "is not waiting for an approval",
      );
    });
  });

  test("going back into a step that waits on its result takes the question away", async () => {
    await withWorkflows(async ({ workflows, session, cleared }) => {
      const agent = session();
      await workflows.start({ sessionId: agent.id, workflow: "feature" });
      await workflows.step({
        sessionId: agent.id,
        step: "deploy",
        action: "start",
        note: "n",
      });
      await workflows.step({
        sessionId: agent.id,
        step: "deploy",
        action: "done",
        note: "n",
      });
      const back = await workflows.step({
        sessionId: agent.id,
        step: "deploy",
        action: "start",
        note: "Change it first",
      });
      expect(back.waiting).toBe(false);
      expect(states(back.run).deploy).toBe("active");
      expect(cleared).toEqual([agent.id]);
    });
  });

  test("a 'before' gate waits on start; approval starts the step", async () => {
    await withWorkflows(async ({ workflows, session, raised, cleared }) => {
      const agent = session();
      await workflows.start({ sessionId: agent.id, workflow: "feature" });
      const gated = await workflows.step({
        sessionId: agent.id,
        step: "test",
        action: "start",
        note: "Run the suite",
      });
      expect(gated.waiting).toBe(true);
      expect(states(gated.run).test).toBe("waiting");
      expect(raised[0]?.reason).toBe(
        "Approve starting step 'test' of workflow 'feature': Run the suite",
      );
      await expect(
        workflows.step({
          note: "n",
          sessionId: agent.id,
          step: "test",
          action: "done",
        }),
      ).rejects.toThrow("waits for the user's approval to start");

      expect(states(workflows.approve(agent.id)).test).toBe("active");
      expect(cleared).toEqual([agent.id]);

      // Going back to it needs another approval.
      await workflows.step({
        note: "n",
        sessionId: agent.id,
        step: "test",
        action: "done",
      });
      const again = await workflows.step({
        note: "n",
        sessionId: agent.id,
        step: "test",
        action: "start",
      });
      expect(again.waiting).toBe(true);
    });
  });

  test("a skip needs a reason, and the run ends when every step is finished", async () => {
    await withWorkflows(async ({ workflows, session }) => {
      const agent = session();
      await workflows.start({
        sessionId: agent.id,
        workflow: "quick",
      });
      await expect(
        workflows.step({ sessionId: agent.id, step: "check", action: "skip" }),
      ).rejects.toThrow("--note");
      await workflows.step({
        note: "n",
        sessionId: agent.id,
        step: "do",
        action: "done",
      });
      const last = await workflows.step({
        sessionId: agent.id,
        step: "check",
        action: "skip",
        note: "Nothing to run",
      });
      expect(last.run.endedAt).not.toBe(null);
      await expect(
        workflows.step({
          note: "n",
          sessionId: agent.id,
          step: "do",
          action: "start",
        }),
      ).rejects.toThrow("no open workflow run");
      // A new run can start once the last one ended.
      await workflows.start({
        sessionId: agent.id,
        workflow: "quick",
      });
    });
  });

  test("an unknown workflow or step names what exists", async () => {
    await withWorkflows(async ({ workflows, session }) => {
      const agent = session();
      await expect(
        workflows.start({
          sessionId: agent.id,
          workflow: "nope",
        }),
      ).rejects.toThrow("Workflows: feature, iterate, quick");
      await workflows.start({
        sessionId: agent.id,
        workflow: "quick",
      });
      await expect(
        workflows.step({
          note: "n",
          sessionId: agent.id,
          step: "deploy",
          action: "start",
        }),
      ).rejects.toThrow("Steps: do, check");
    });
  });

  test("the read model carries each run, and a step moves its version", async () => {
    await withWorkflows(async ({ context, session }) => {
      const agent = session();
      const model = new ReadModel(context);
      await context.skills.setEnabled("daedalus-workflows", true);
      await context.workflows.start({
        sessionId: agent.id,
        workflow: "quick",
      });
      const before = await model.versions();
      await context.workflows.step({
        note: "n",
        sessionId: agent.id,
        step: "do",
        action: "start",
      });
      const after = await model.versions();
      expect(after.workflowRuns).not.toBe(before.workflowRuns);
      const view = await model.snapshot();
      expect(view.workflowRuns.map((run) => states(run))).toEqual([
        { do: "active", check: "pending" },
      ]);
    });
  });

  test("a dynamic run is built from existing and dynamic steps and changes no file", async () => {
    await withWorkflows(async ({ context, workflows, session }) => {
      const agent = session();
      const catalogBefore = await workflows.catalog();
      await expect(
        workflows.start({
          sessionId: agent.id,
          steps: ["research", "research"],
        }),
      ).rejects.toThrow("listed twice");
      const run = await workflows.start({
        sessionId: agent.id,
        steps: ["research", "check"],
        name: "cache-spike",
      });
      expect(run).toMatchObject({ dynamic: true, workflow: "cache-spike" });
      const added = await workflows.add({
        sessionId: agent.id,
        step: "spike",
        after: "research",
        description: "Try the cache in one module",
      });
      expect(added.steps.map((step) => [step.name, step.dynamic])).toEqual([
        ["research", false],
        ["spike", true],
        ["check", false],
      ]);
      expect(added.modified).toBe(false);
      expect(await workflows.catalog()).toEqual(catalogBefore);

      const saved = await workflows.saveAs({
        sessionId: agent.id,
        name: "spike",
        when: "Trying one idea before committing to it",
      });
      expect(
        saved.written.map((path) => path.split("/").slice(-2).join("/")),
      ).toEqual(["steps/spike.md", "flows/spike.md"]);
      const after = await workflows.catalog();
      expect(after.problems).toEqual([]);
      expect(
        after.workflows.find((item) => item.name === "spike"),
      ).toMatchObject({
        steps: ["research", "spike", "check"],
        when: "Trying one idea before committing to it",
      });
      await expect(
        workflows.saveAs({ sessionId: agent.id, name: "spike" }),
      ).rejects.toThrow("exists");
      void context;
    });
  });

  test("adding or removing a step marks a maintained workflow's run changed, not its file", async () => {
    await withWorkflows(async ({ workflows, session }) => {
      const agent = session();
      await workflows.start({
        sessionId: agent.id,
        workflow: "quick",
      });
      const added = await workflows.add({
        sessionId: agent.id,
        step: "review",
      });
      expect(added.modified).toBe(true);
      expect(added.steps.map((step) => step.name)).toEqual([
        "do",
        "check",
        "review",
      ]);
      await workflows.step({
        note: "n",
        sessionId: agent.id,
        step: "do",
        action: "start",
      });
      expect(() =>
        workflows.remove({ sessionId: agent.id, step: "do" }),
      ).toThrow("only a step not yet started");
      const removed = workflows.remove({ sessionId: agent.id, step: "review" });
      expect(removed.steps.map((step) => step.name)).toEqual(["do", "check"]);
      const quick = (await workflows.catalog()).workflows.find(
        (item) => item.name === "quick",
      );
      expect(quick?.steps).toEqual(["do", "check"]);

      // Removing a circular run's loop step, with the rest finished, ends it.
      const looping = session();
      await workflows.start({ sessionId: looping.id, workflow: "iterate" });
      for (const step of ["review", "feedback"])
        await workflows.step({
          note: "n",
          sessionId: looping.id,
          step,
          action: "done",
        });
      const ended = workflows.remove({
        sessionId: looping.id,
        step: "prototype",
      });
      expect(ended.loopTo).toBeNull();
      expect(ended.endedAt).not.toBeNull();
    });
  });

  test("a circular run goes round from its loop step, keeps each iteration, and runs until ended", async () => {
    await withWorkflows(async ({ workflows, session }) => {
      const agent = session();
      const run = await workflows.start({
        sessionId: agent.id,
        workflow: "iterate",
      });
      expect(run).toMatchObject({ loopTo: "prototype", iteration: 1 });
      for (const step of ["prototype", "review"])
        await workflows.step({
          note: "n",
          sessionId: agent.id,
          step,
          action: "done",
        });
      const round = await workflows.step({
        sessionId: agent.id,
        step: "feedback",
        action: "done",
        note: "Make the header smaller",
      });
      expect(round.looped).toBe(true);
      expect(round.run.endedAt).toBe(null);
      expect(round.run.iteration).toBe(2);
      expect(states(round.run)).toEqual({
        prototype: "pending",
        review: "pending",
        feedback: "pending",
      });
      expect(
        round.run.history.map((record) => [
          record.iteration,
          record.name,
          record.note,
        ]),
      ).toEqual([
        [1, "prototype", "n"],
        [1, "review", "n"],
        [1, "feedback", "Make the header smaller"],
      ]);

      await workflows.step({
        note: "n",
        sessionId: agent.id,
        step: "prototype",
        action: "start",
      });
      // Ending mid-step makes the note that step's outcome.
      const ended = workflows.end({ sessionId: agent.id, note: "Good enough" });
      expect(ended.endedAt).not.toBe(null);
      expect(ended.endNote).toBe(null);
      expect(states(ended).prototype).toBe("done");
      expect(ended.steps[0]).toMatchObject({ plan: "n", note: "Good enough" });

      // Between steps, the run keeps the note itself.
      await workflows.start({ sessionId: agent.id, workflow: "quick" });
      const stopped = workflows.end({
        sessionId: agent.id,
        note: "Not needed",
      });
      expect(stopped.endNote).toBe("Not needed");
    });
  });

  test("a dynamic run can loop to one of its steps", async () => {
    await withWorkflows(async ({ workflows, session }) => {
      const agent = session();
      await expect(
        workflows.start({
          sessionId: agent.id,
          steps: ["do"],
          loop: "check",
        }),
      ).rejects.toThrow("--loop must name one of the run's steps");
      await workflows.start({
        sessionId: agent.id,
        steps: ["do", "check"],
        loop: "do",
        until: "All tests pass",
      });
      await workflows.step({
        note: "n",
        sessionId: agent.id,
        step: "do",
        action: "done",
      });
      const round = await workflows.step({
        note: "n",
        sessionId: agent.id,
        step: "check",
        action: "done",
      });
      expect(round.run).toMatchObject({
        iteration: 2,
        until: "All tests pass",
      });
    });
  });

  test("every step change takes a line: the plan on start, what came out on done", async () => {
    await withWorkflows(async ({ workflows, session }) => {
      const agent = session();
      await workflows.start({ sessionId: agent.id, workflow: "quick" });
      await expect(
        workflows.step({ sessionId: agent.id, step: "do", action: "start" }),
      ).rejects.toThrow("what you will do");
      const started = await workflows.step({
        sessionId: agent.id,
        step: "do",
        action: "start",
        note: "Change the print in apps/cli/src/index.ts",
      });
      expect(started.run.steps[0]).toMatchObject({
        plan: "Change the print in apps/cli/src/index.ts",
        note: null,
      });
      await expect(
        workflows.step({ sessionId: agent.id, step: "do", action: "done" }),
      ).rejects.toThrow("what came out");
      const done = await workflows.step({
        sessionId: agent.id,
        step: "do",
        action: "done",
        note: "Prints daedal 0.32.0-beta.6",
      });
      expect(done.run.steps[0]).toMatchObject({
        plan: "Change the print in apps/cli/src/index.ts",
        note: "Prints daedal 0.32.0-beta.6",
      });
    });
  });

  test("a session can start in a workflow: one launch line and the run open", async () => {
    await withWorkflows(async ({ context, workflows, session }) => {
      await expect(
        workflows.spawnWith({
          workflow: "nope",
          spawn: async () => session(),
        }),
      ).rejects.toThrow("Workflows: feature, iterate, quick");

      // A workflow that cannot run is refused before any session exists.
      await writeFile(
        join(workflowsHomePath(context.config.home), "flows", "broken.md"),
        "---\nname: broken\nwhen: Tests.\nsteps: [do, missing]\n---\n",
      );
      let spawned = 0;
      await expect(
        workflows.spawnWith({
          workflow: "broken",
          spawn: async () => {
            spawned += 1;
            return session();
          },
        }),
      ).rejects.toThrow("broken");
      expect(spawned).toBe(0);

      let message = "";
      const { session: agent, run } = await workflows.spawnWith({
        workflow: "quick",
        message: "Fix the typo in README\nIt says teh.",
        spawn: async (line) => {
          message = line;
          return session();
        },
      });
      expect(message.startsWith("Fix the typo in README")).toBe(true);
      expect(message).toContain("started workflow 'quick'");
      expect(run.workflow).toBe("quick");
      expect(workflows.current(agent.id)?.workflow).toBe("quick");
    });
  });

  test("a dynamic workflow takes the steps the agent names, with or without a file", async () => {
    await withWorkflows(async ({ workflows, session }) => {
      const agent = session();
      await expect(
        workflows.start({
          sessionId: agent.id,
          workflow: "quick",
          steps: ["do"],
        }),
      ).rejects.toThrow("has its own steps");
      const run = await workflows.start({
        sessionId: agent.id,
        workflow: "todo",
        steps: ["find-print", "check"],
      });
      expect(run).toMatchObject({ workflow: "todo", dynamic: true });
      expect(run.steps.map((step) => [step.name, step.dynamic])).toEqual([
        ["find-print", true],
        ["check", false],
      ]);
      const added = await workflows.add({ sessionId: agent.id, step: "tidy" });
      expect(added.steps.at(-1)).toMatchObject({
        name: "tidy",
        dynamic: true,
        description: "",
      });

      let message = "";
      const { run: empty } = await workflows.spawnWith({
        workflow: "todo",
        spawn: async (line) => {
          message = line;
          return session();
        },
      });
      expect(empty).toMatchObject({ workflow: "todo", steps: [] });
      expect(message).toContain("no steps yet");
    });
  });

  test("with workflows off, no run starts and the agent is told why", async () => {
    await withWorkflows(async ({ context, session }) => {
      let on = false;
      const workflows = new WorkflowService(
        context.repositories,
        context.config.home,
        { raise: async () => ({}), clear: () => ({ cleared: 0 }) },
        () => on,
      );
      const agent = session();
      await expect(
        workflows.start({ sessionId: agent.id, workflow: "quick" }),
      ).rejects.toThrow("Workflows are off");
      await expect(
        workflows.spawnWith({ workflow: "quick", spawn: async () => agent }),
      ).rejects.toThrow("Workflows are off");
      on = true;
      expect(
        (await workflows.start({ sessionId: agent.id, workflow: "quick" }))
          .workflow,
      ).toBe("quick");
      // The app's own service reads the user's switch, which starts off.
      expect(context.skills.settingFor("daedalus-workflows").enabled).toBe(
        false,
      );
    });
  });
});
