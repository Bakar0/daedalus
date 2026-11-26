import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AcpService } from "./acp";
import {
  AcpHost,
  acpPaths,
  parseAcpCommand,
  type AcpLaunch,
  type AcpLogEntry,
} from "./acp-host";

const FAKE = join(import.meta.dir, "acp-fake-adapter.fixtures.ts");
const SESSION = "0f3b0e9e-7c55-4d1c-9a43-2d1f3c5a7b91";

const homes: string[] = [];
const hosts: Array<{ service: AcpService; done: Promise<number | null> }> = [];

afterEach(async () => {
  for (const { service, done } of hosts.splice(0)) {
    await service.stop(SESSION).catch(() => undefined);
    await done;
  }
  for (const home of homes.splice(0))
    await rm(home, { recursive: true, force: true });
});

async function startHost(
  launch: Partial<AcpLaunch> = {},
  adapterArgs: string[] = [],
) {
  const home = await mkdtemp(join(tmpdir(), "daedalus-acp-"));
  homes.push(home);
  const service = new AcpService(home);
  const host = new AcpHost({
    home,
    sessionId: SESSION,
    cwd: home,
    provider: "claude",
    adapter: { executable: process.execPath, args: [FAKE, ...adapterArgs] },
    ...launch,
  });
  const done = host.run();
  hosts.push({ service, done });
  return { home, service, done };
}

/** Reads the log until `found` is true of it, and returns every entry. */
async function until(
  service: AcpService,
  found: (entries: AcpLogEntry[]) => boolean,
): Promise<AcpLogEntry[]> {
  const entries: AcpLogEntry[] = [];
  let offset = 0;
  const deadline = Date.now() + 5_000;
  for (;;) {
    const read = await service.events(SESSION, offset);
    offset = read.offset;
    entries.push(...read.entries);
    if (found(entries)) return entries;
    if (Date.now() > deadline)
      throw new Error(`Not seen in:\n${JSON.stringify(entries, null, 1)}`);
    await Bun.sleep(20);
  }
}

const hostEvents = (entries: AcpLogEntry[]) =>
  entries.flatMap((entry) => (entry.from === "host" ? [entry.event] : []));
const turnsEnded = (entries: AcpLogEntry[]) =>
  hostEvents(entries).filter((event) => event.type === "turn_end");
const agentText = (entries: AcpLogEntry[]) =>
  entries
    .flatMap((entry) => {
      if (entry.from !== "agent") return [];
      const update = entry.message.params?.update as
        { sessionUpdate?: string; content?: { text?: string } } | undefined;
      return update?.sessionUpdate === "agent_message_chunk"
        ? [update.content?.text ?? ""]
        : [];
    })
    .join("");

describe("AcpHost", () => {
  test("opens a session, runs the first prompt and logs both directions", async () => {
    const { service } = await startHost({
      prompt: "hello",
      meta: { claudeCode: { options: { model: "opus" } } },
      mode: "auto",
    });
    const ready = await service.waitReady(SESSION, 5_000);
    expect(ready.acpSessionId).toBe("fake-1");
    // The adapter's options reach `session/new` as its `_meta`.
    expect(ready.modes).toEqual({
      currentModeId: "default",
      meta: { claudeCode: { options: { model: "opus" } } },
    });
    const entries = await until(
      service,
      (seen) => turnsEnded(seen).length === 1,
    );
    expect(agentText(entries)).toBe("you said: hello");
    expect(turnsEnded(entries)).toEqual([
      { type: "turn_end", stopReason: "end_turn" },
    ]);
    const sent = entries.flatMap((entry) =>
      entry.from === "client" ? [entry.message.method] : [],
    );
    expect(sent).toEqual([
      "initialize",
      "session/new",
      "session/set_mode",
      "session/prompt",
    ]);
    expect(entries.map((entry) => entry.seq)).toEqual(
      entries.map((_, index) => index + 1),
    );
  });

  test("loads an earlier session instead of opening a new one", async () => {
    const { service } = await startHost({ load: "old-7" });
    expect((await service.waitReady(SESSION, 5_000)).acpSessionId).toBe(
      "old-7",
    );
    const entries = await until(service, () => true);
    const load = entries.find(
      (entry) =>
        entry.from === "client" && entry.message.method === "session/load",
    );
    expect(load?.from === "client" && load.message.params?.sessionId).toBe(
      "old-7",
    );
  });

  test("a prompt sent during a turn waits for that turn", async () => {
    const { service } = await startHost();
    await service.waitReady(SESSION, 5_000);
    await service.prompt(SESSION, "permission please");
    await service.prompt(SESSION, "second");
    const asked = await until(service, (seen) =>
      seen.some(
        (entry) =>
          entry.from === "agent" &&
          entry.message.method === "session/request_permission",
      ),
    );
    expect(hostEvents(asked)).toContainEqual({
      type: "queued",
      text: "second",
    });
    expect(turnsEnded(asked)).toEqual([]);
    await service.answerPermission(SESSION, 900, "yes");
    const entries = await until(
      service,
      (seen) => turnsEnded(seen).length === 2,
    );
    expect(agentText(entries)).toBe("writtenyou said: second");
  });

  test("a refused permission reaches the agent, and an unknown one is refused here", async () => {
    const { service } = await startHost({ prompt: "permission please" });
    await until(service, (seen) =>
      seen.some(
        (entry) =>
          entry.from === "agent" &&
          entry.message.method === "session/request_permission",
      ),
    );
    await expect(service.answerPermission(SESSION, 5, "yes")).rejects.toThrow(
      "not open",
    );
    await service.answerPermission(SESSION, 900, "no");
    const entries = await until(
      service,
      (seen) => turnsEnded(seen).length === 1,
    );
    expect(agentText(entries)).toBe("refused");
    // Answered once: the request is no longer open.
    await expect(service.answerPermission(SESSION, 900, "no")).rejects.toThrow(
      "not open",
    );
  });

  test("cancel ends the turn, answers an open permission and drops what waited", async () => {
    const { service } = await startHost({ prompt: "slow work" });
    await until(service, (seen) => agentText(seen) === "working");
    await service.prompt(SESSION, "never runs");
    await service.cancel(SESSION);
    const entries = await until(
      service,
      (seen) => turnsEnded(seen).length === 1,
    );
    expect(turnsEnded(entries)).toEqual([
      { type: "turn_end", stopReason: "cancelled" },
    ]);
    await Bun.sleep(100);
    const after = await until(service, () => true);
    expect(
      hostEvents(after).filter((event) => event.type === "turn_start"),
    ).toHaveLength(1);

    await service.prompt(SESSION, "permission please");
    await until(service, (seen) =>
      seen.some(
        (entry) =>
          entry.from === "agent" &&
          entry.message.method === "session/request_permission",
      ),
    );
    await service.cancel(SESSION);
    const last = await until(service, (seen) => turnsEnded(seen).length === 2);
    expect(
      last.some(
        (entry) =>
          entry.from === "client" &&
          entry.message.id === 900 &&
          JSON.stringify(entry.message.result).includes("cancelled"),
      ),
    ).toBe(true);
  });

  test("refuses a request it does not support, so the agent goes on", async () => {
    const { service } = await startHost({ prompt: "ask for a file" });
    const entries = await until(
      service,
      (seen) => turnsEnded(seen).length === 1,
    );
    expect(agentText(entries)).toBe("no file access");
  });

  test("a mode the agent does not have is reported and the session stays up", async () => {
    const { service } = await startHost();
    await service.waitReady(SESSION, 5_000);
    await service.setMode(SESSION, "nope");
    const entries = await until(service, (seen) =>
      hostEvents(seen).some((event) => event.type === "error"),
    );
    expect(hostEvents(entries)).toContainEqual({
      type: "error",
      message: "No such mode",
    });
    await service.prompt(SESSION, "still here");
    await until(service, (seen) => turnsEnded(seen).length === 1);
  });

  test("stop ends the adapter, logs the exit and removes the socket", async () => {
    const { home, service, done } = await startHost();
    await service.waitReady(SESSION, 5_000);
    await service.stop(SESSION);
    expect(await done).toBe(0);
    const entries = await until(service, () => true);
    expect(hostEvents(entries).at(-1)).toEqual({ type: "exit", code: 0 });
    expect(await Bun.file(acpPaths(home, SESSION).socket).exists()).toBe(false);
    await expect(service.prompt(SESSION, "anyone")).rejects.toThrow(
      "not reachable",
    );
  });

  test("an adapter that dies at start says why", async () => {
    const { service, done } = await startHost({}, ["--die"]);
    await expect(service.waitReady(SESSION, 5_000)).rejects.toThrow(
      "The agent did not start: not signed in",
    );
    expect(await done).toBe(3);
  });
});

describe("AcpService.events", () => {
  test("reads from an offset and leaves a half-written line for later", async () => {
    const home = await mkdtemp(join(tmpdir(), "daedalus-acp-"));
    homes.push(home);
    const service = new AcpService(home);
    expect(await service.events(SESSION)).toEqual({ entries: [], offset: 0 });
    const { log, directory } = acpPaths(home, SESSION);
    await Bun.write(join(directory, ".keep"), "");
    const line = (seq: number) =>
      JSON.stringify({
        seq,
        at: "2026-01-01T00:00:00.000Z",
        from: "host",
        event: { type: "stderr", text: `é${seq}` },
      });
    await Bun.write(log, `${line(1)}\n${line(2).slice(0, 20)}`);
    const first = await service.events(SESSION);
    expect(first.entries.map((entry) => entry.seq)).toEqual([1]);
    await Bun.write(log, `${line(1)}\n${line(2)}\n`);
    const second = await service.events(SESSION, first.offset);
    expect(second.entries.map((entry) => entry.seq)).toEqual([2]);
    expect(await service.events(SESSION, second.offset)).toEqual({
      entries: [],
      offset: second.offset,
    });
    // A shorter file is a new log.
    await Bun.write(log, `${line(9)}\n`);
    const again = await service.events(SESSION, second.offset);
    expect(again.entries.map((entry) => entry.seq)).toEqual([9]);
  });

  test("writes the launch file for the owner only", async () => {
    const home = await mkdtemp(join(tmpdir(), "daedalus-acp-"));
    homes.push(home);
    const service = new AcpService(home);
    const launch: AcpLaunch = {
      home,
      sessionId: SESSION,
      cwd: home,
      provider: "codex",
      prompt: "secret plan",
    };
    const path = await service.writeLaunch(launch);
    expect(await Bun.file(path).json()).toEqual(launch);
    expect((await Bun.file(path).stat()).mode & 0o777).toBe(0o600);
  });
});

describe("parseAcpCommand", () => {
  test("keeps well-formed commands and drops the rest", () => {
    expect(parseAcpCommand({ type: "prompt", text: "hi", extra: 1 })).toEqual({
      type: "prompt",
      text: "hi",
    });
    expect(
      parseAcpCommand({ type: "permission", requestId: 4, optionId: "a" }),
    ).toEqual({ type: "permission", requestId: 4, optionId: "a" });
    expect(parseAcpCommand({ type: "prompt" })).toBeUndefined();
    expect(
      parseAcpCommand({ type: "permission", requestId: 4 }),
    ).toBeUndefined();
    expect(parseAcpCommand({ type: "launch" })).toBeUndefined();
    expect(parseAcpCommand("stop")).toBeUndefined();
  });
});
