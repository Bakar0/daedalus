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
      // Workflows are the user's switch: the skill being on.
      await context.skills.setEnabled("daedalus-workflows", true);
      const workflows = new WorkflowService(context.config.home);
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
        workspaceId: workspace.id,
        session,
      });
    } finally {
      context.close();
    }
  });

describe("workflows as jobs", () => {
  test("a session starts a workflow, is handed each step, and a rebirth carries it on", async () => {
    await withWorkflows(async ({ context, session }) => {
      const agent = session();
      const started = await context.jobIntake.startWorkflow({
        sessionId: agent.id,
        workflow: "quick",
      });
      expect(started.brief).toContain("Do what the session was asked.");
      const handed = await context.jobs.done(agent.id, { result: "Did it" });
      expect(handed.next).toContain("Prove the result works.");
      expect(handed.next).toContain("result = Did it");

      const successor = session();
      context.jobs.moveSession(agent.id, successor.id);
      expect(context.jobs.brief(successor.id)).toContain(
        "Prove the result works.",
      );
      await context.jobs.done(successor.id, { result: "It works" });
      expect(context.jobIntake.workflowOf(successor.id)).toBeUndefined();
    });
  });

  test("a run is a frozen copy: editing a step file changes the next run only", async () => {
    await withWorkflows(async ({ context, session }) => {
      const agent = session();
      await context.jobIntake.startWorkflow({
        sessionId: agent.id,
        workflow: "quick",
      });
      await writeFile(
        join(workflowsHomePath(context.config.home), "steps", "check.md"),
        "---\nname: check\n---\nProve it twice.\n",
      );
      const handed = await context.jobs.done(agent.id, { result: "Did it" });
      expect(handed.next).toContain("Prove the result works.");
      await context.jobs.done(agent.id, { result: "It works" });
      await context.jobIntake.startWorkflow({
        sessionId: agent.id,
        workflow: "quick",
      });
      const again = await context.jobs.done(agent.id, { result: "Did it" });
      expect(again.next).toContain("Prove it twice.");
    });
  });

  test("a result gate blocks the next step, and an approval covers one pass", async () => {
    await withWorkflows(async ({ context, session }) => {
      const agent = session();
      await context.jobIntake.startWorkflow({
        sessionId: agent.id,
        steps: ["deploy", "feedback"],
      });
      const first = await context.jobs.done(agent.id, { result: "Shipped" });
      expect(first.job.state).toBe("held");
      expect(first.next).toBeNull();
      expect(
        JSON.stringify(context.activity.attentionFor(agent.id)?.reasons),
      ).toContain("Shipped");
      // Nothing else of the session moves while the approval is pending.
      await expect(
        context.jobs.done(agent.id, { result: "Too early" }),
      ).rejects.toMatchObject({ code: "CONFLICT" });

      const approved = await context.jobs.release(first.job.id, agent.id);
      expect(approved.next).toContain("Check it in the wild.");
      expect(context.activity.attentionFor(agent.id)).toBeUndefined();

      await context.jobs.redo(first.job.id, agent.id, "The fix was wrong");
      const second = await context.jobs.done(agent.id, { result: "Shipped 2" });
      expect(second.job.state).toBe("held");
    });
  });

  test("a start gate holds a step until the user gives the go-ahead", async () => {
    await withWorkflows(async ({ context, session }) => {
      const agent = session();
      await context.jobIntake.startWorkflow({
        sessionId: agent.id,
        steps: ["do", "test"],
      });
      const handed = await context.jobs.done(agent.id, { result: "Did it" });
      expect(handed.next).toBeNull();
      const held = context.jobs.held(agent.id);
      expect(held).toMatchObject({ name: "test", state: "held" });
      const released = await context.jobs.release(held!.id, agent.id);
      expect(released.next).toContain("Run the tests.");
    });
  });

  test("the read model carries each session's workflow, and a step moves its version", async () => {
    await withWorkflows(async ({ context, session }) => {
      const agent = session();
      const model = new ReadModel(context);
      await context.jobIntake.startWorkflow({
        sessionId: agent.id,
        workflow: "quick",
      });
      const before = await model.versions();
      const steps = async () =>
        (await model.snapshot()).workflowRuns.find(
          (run) => run.sessionId === agent.id,
        )?.steps;
      expect((await steps())?.map((step) => [step.name, step.state])).toEqual([
        ["do", "active"],
        ["check", "pending"],
      ]);
      await context.jobs.done(agent.id, { result: "Did it" });
      expect((await model.versions()).workflowRuns).not.toBe(
        before.workflowRuns,
      );
      expect((await steps())?.map((step) => step.state)).toEqual([
        "done",
        "active",
      ]);
      expect((await steps())?.[0]?.note).toBe("Did it");
    });
  });

  test("saving writes the steps a session named as a workflow file", async () => {
    await withWorkflows(async ({ context, workflows }) => {
      const saved = await workflows.saveAs({
        name: "probe",
        when: "A quick look",
        steps: [
          { entry: "do", gate: null, text: "" },
          { entry: "measure", gate: "result", text: "Measure it." },
          { entry: "@quick", gate: null, text: "" },
        ],
        loop: null,
        until: "",
      });
      expect(saved.written.map((path) => path.split("/").at(-1))).toEqual([
        "measure.md",
        "probe.md",
      ]);
      const catalog = await context.workflows.catalog();
      expect(
        catalog.workflows.find((item) => item.name === "probe")?.steps,
      ).toEqual(["do", "measure", "@quick"]);
      expect(
        catalog.steps.find((item) => item.name === "measure"),
      ).toMatchObject({ gate: "result", body: "Measure it." });
      await expect(
        workflows.saveAs({
          name: "probe",
          steps: [{ entry: "do", gate: null, text: "" }],
          loop: null,
          until: "",
        }),
      ).rejects.toThrow("exists");
    });
  });

  describe("step memory", () => {
    test("a proposed memory is not shown; an accepted one comes with the step's brief", async () => {
      await withWorkflows(async ({ workflows, context, session }) => {
        await workflows.rememberStep({
          step: "check",
          text: "Run the failing case first",
          why: "A fix passed the check and did not fix the case.",
          workflow: "quick",
        });
        const memory = await workflows.stepMemory("check");
        expect(memory.memories[0]).toMatchObject({
          status: "proposed",
          workflow: "quick",
          runs: 1,
        });
        const checkBrief = async () => {
          const agent = session();
          await context.jobIntake.startWorkflow({
            sessionId: agent.id,
            workflow: "quick",
          });
          return (await context.jobs.done(agent.id, { result: "Did it" })).next;
        };
        expect(await checkBrief()).not.toContain("failing case");
        await workflows.acceptStepMemory("check", "1");
        expect(await checkBrief()).toContain(
          "What earlier runs of this step learned:\n- Run the failing case first (A fix passed the check and did not fix the case.)",
        );
        // The memory file is not read as a step, and the catalog has no problem.
        const catalog = await workflows.catalog();
        expect(catalog.steps.map((step) => step.name)).not.toContain(
          "check.memory",
        );
        expect(catalog.problems).toEqual([]);
      });
    });
  });

  test("a step made for one run has no memory", async () => {
    await withWorkflows(async ({ workflows }) => {
      await expect(
        workflows.rememberStep({ step: "made-up", text: "x", why: "y" }),
      ).rejects.toThrow("saved step");
    });
  });

  test("promoting moves a memory into the step's instructions; forgetting the last removes the file", async () => {
    await withWorkflows(async ({ workflows, context }) => {
      const remember = (text: string) =>
        workflows.rememberStep({ step: "check", text, why: "Seen." });
      await remember("Check the delete path");
      await remember("Check the empty case");
      await workflows.promoteStepMemory("check", "Check the delete path");
      const step = (await workflows.catalog()).steps.find(
        (item) => item.name === "check",
      )!;
      expect(step.body).toContain("Check the delete path.");
      expect((await workflows.stepMemory("check")).memories).toHaveLength(1);
      await workflows.forgetStepMemory("check", "1");
      expect(
        await Bun.file(
          join(
            workflowsHomePath(context.config.home),
            "steps",
            "check.memory.md",
          ),
        ).exists(),
      ).toBe(false);
    });
  });

  test("the Workflows tab lists a step's memories and accepts, promotes and forgets them", async () => {
    await withWorkflows(async ({ workflows }) => {
      const memories = (files: Awaited<ReturnType<typeof workflows.files>>) =>
        files.steps.find((step) => step.name === "check")!.memories ?? [];
      await workflows.rememberStep({
        step: "check",
        text: "Check the delete path",
        why: "Seen.",
      });
      expect(memories(await workflows.files())[0]!.status).toBe("proposed");
      const change = (action: "accept" | "forget" | "promote") =>
        workflows.changeStepMemory({
          step: "check",
          text: "Check the delete path",
          action,
        });
      expect(memories(await change("accept"))[0]!.status).toBe("accepted");
      const promoted = await change("promote");
      expect(memories(promoted)).toHaveLength(0);
      expect(
        promoted.steps.find((step) => step.name === "check")!.body,
      ).toContain("Check the delete path.");
    });
  });

  test("a broken memory file shows on its step in the Workflows tab", async () => {
    await withWorkflows(async ({ workflows, context }) => {
      const steps = join(workflowsHomePath(context.config.home), "steps");
      await writeFile(join(steps, "check.memory.md"), "## No fields\n");
      const step = (await workflows.files()).steps.find(
        (item) => item.name === "check",
      )!;
      expect(step.memoryProblem).toContain("why");
      expect(step.problem).toBeNull();
    });
  });

  test("a broken memory file, or one for no step, is a problem in the list", async () => {
    await withWorkflows(async ({ workflows, context }) => {
      const steps = join(workflowsHomePath(context.config.home), "steps");
      await writeFile(join(steps, "check.memory.md"), "## No fields\n");
      await writeFile(join(steps, "ghost.memory.md"), "");
      const problems = (await workflows.catalog()).problems.map(
        (problem) => problem.message,
      );
      expect(problems.some((text) => text.includes("why"))).toBe(true);
      expect(problems.some((text) => text.includes("No step 'ghost'"))).toBe(
        true,
      );
    });
  });
});
