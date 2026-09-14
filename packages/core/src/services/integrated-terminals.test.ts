import { describe, expect, test } from "vitest";
import type { TmuxClient, TmuxLaunch } from "@daedalus/platform";
import { withTemporaryDaedalusHome } from "@daedalus/test-utils";
import { createApplicationContext } from "../index";

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
    return "";
  }
  async sendKeys() {}
  async send() {}
  async stop(session: string) {
    this.sessions.delete(session);
  }
}

describe("IntegratedTerminalService", () => {
  test("opens home and workspace terminals with persistent distinct tabs", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const tmux = new FakeTmux();
      const context = await createApplicationContext({
        env: { ...process.env, DAEDALUS_HOME: home },
        tmux,
      });
      try {
        const workspace = await context.workspaces.create({ name: "Demo" });
        const homeTerminal = await context.terminals.create({});
        const workspaceTerminal = await context.terminals.create({
          workspace: workspace.id,
          name: workspace.name,
        });
        const duplicate = await context.terminals.create({
          workspace: workspace.id,
          name: workspace.name,
        });
        expect(homeTerminal).toMatchObject({
          name: "Terminal",
          workingDirectory: home,
          status: "running",
        });
        expect(workspaceTerminal).toMatchObject({
          name: "Demo",
          workingDirectory: workspace.path,
          status: "running",
        });
        expect(duplicate.name).toBe("Demo 2");
        expect(tmux.launches.map((launch) => launch.cwd)).toEqual([
          home,
          workspace.path,
          workspace.path,
        ]);
        expect(await context.terminals.list()).toHaveLength(3);
        await context.terminals.close(homeTerminal.id);
        expect(
          (await context.terminals.list())
            .map((terminal) => terminal.name)
            .sort(),
        ).toEqual(["Demo", "Demo 2"]);
      } finally {
        context.close();
      }
    });
  });
});
