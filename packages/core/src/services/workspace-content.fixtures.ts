// Fixtures shared by the workspace content tests, one file per module.
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { expect } from "vitest";
import {
  runCommand,
  type TmuxClient,
  type TmuxLaunch,
} from "@daedalus/platform";
import { createApplicationContext } from "../index";

export async function createRepository(
  path: string,
  branch = "main",
): Promise<void> {
  await mkdir(path, { recursive: true });
  expect(
    (await runCommand("git", ["init", "-q", "-b", branch, path])).exitCode,
  ).toBe(0);
  await Bun.write(join(path, "README.md"), "# Source\n");
  expect(
    (await runCommand("git", ["-C", path, "add", "README.md"])).exitCode,
  ).toBe(0);
  expect(
    (
      await runCommand("git", [
        "-C",
        path,
        "-c",
        "user.name=Daedalus Test",
        "-c",
        "user.email=test@daedalus.local",
        "commit",
        "-qm",
        "initial",
      ])
    ).exitCode,
  ).toBe(0);
}

/**
 * A context whose agent provider is stubbed, following `agents.test.ts`.
 *
 * Spawning `claude` for real needs the binary on PATH — which CI does not have
 * — waits up to thirty seconds for it to report ready, and leaves a live agent
 * behind, all to obtain a session row that a working tree can hang from.
 * Pointing the provider at a harmless executable and faking tmux gives the same
 * session with none of that, and keeps it archivable, which a `command`
 * session is not: those are provider `custom` and deliberately cannot be.
 */
export async function contextWithStubbedAgent(home: string) {
  await Bun.write(
    join(home, "config.json"),
    JSON.stringify({
      agents: { claude: { executable: process.execPath, args: ["run"] } },
    }),
  );
  return createApplicationContext({
    env: { DAEDALUS_HOME: home },
    tmux: new FakeTmux(),
    reconcile: false,
  });
}

export class FakeTmux implements TmuxClient {
  sessions = new Set<string>();
  launches: TmuxLaunch[] = [];
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
    // A screen that looks like a started provider. Spawning a Claude session
    // polls the pane until it recognises one, so an empty capture makes every
    // spawn wait out the full startup timeout instead of returning.
    return "Ask Codex to do anything\nClaude Code v2.1.251\nshift+tab to cycle";
  }
  async sendKeys() {}
  async send() {}
  async stop(session: string) {
    this.sessions.delete(session);
  }
  async killServer() {
    const running = this.sessions.size > 0;
    this.sessions.clear();
    return running;
  }
}
