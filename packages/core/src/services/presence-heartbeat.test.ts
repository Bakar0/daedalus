import { describe, expect, test } from "vitest";
import { withTemporaryDaedalusHome } from "@daedalus/test-utils";
import { loadConfig } from "../config";
import { PresenceService } from "./presence";
import {
  cachedIdleSampler,
  parsePresenceReport,
  readLines,
  runPresenceHeartbeat,
} from "./presence-heartbeat";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function* lines(
  items: string[],
  hold: Promise<void>,
): AsyncIterable<string> {
  for (const item of items) yield item;
  await hold;
}

describe("presence heartbeat sidecar", () => {
  test("publishes forwarded reports and stands in once the window goes quiet", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const presence = new PresenceService(
        await loadConfig({ DAEDALUS_HOME: home }),
        { idleSeconds: async () => 0 },
      );
      let alive = true;
      let release: () => void = () => undefined;
      const hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      // A clock the test can move: the window's report ages past the grace
      // period without waiting for it.
      let clock = 1_000_000;
      const run = runPresenceHeartbeat({
        presence,
        hostPid: 1,
        reports: lines(
          [
            JSON.stringify({
              appForeground: true,
              workspaceId: "w",
              sessionId: "s",
            }),
            "not json",
          ],
          hold,
        ),
        intervalMs: 10,
        isAlive: () => alive,
        now: () => clock,
      });
      await sleep(40);
      let state = await presence.read(clock);
      expect(state.appRunning).toBe(true);
      expect(state.appForeground).toBe(true);
      expect(state.sessionId).toBe("s");
      clock += 6_000;
      await sleep(40);
      state = await presence.read(clock);
      expect(state.appRunning).toBe(true);
      expect(state.appForeground).toBe(false);
      expect(state.workspaceId).toBe("w");
      alive = false;
      await Promise.race([run, sleep(500).then(() => "timeout")]).then(
        (outcome) => expect(outcome).toBeUndefined(),
      );
      release();
    });
  });

  test("stops when the host closes the pipe", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const presence = new PresenceService(
        await loadConfig({ DAEDALUS_HOME: home }),
        { idleSeconds: async () => 0 },
      );
      const run = runPresenceHeartbeat({
        presence,
        hostPid: 1,
        reports: lines([], Promise.resolve()),
        intervalMs: 10,
        isAlive: () => true,
      });
      await Promise.race([run, sleep(500).then(() => "timeout")]).then(
        (outcome) => expect(outcome).toBeUndefined(),
      );
    });
  });

  test("parses a report and rejects everything else", () => {
    expect(
      parsePresenceReport(
        '{"appForeground":false,"workspaceId":null,"sessionId":"x"}',
      ),
    ).toEqual({ appForeground: false, workspaceId: null, sessionId: "x" });
    expect(parsePresenceReport('{"workspaceId":"w"}')).toBeNull();
    expect(parsePresenceReport("garbage")).toBeNull();
    expect(parsePresenceReport("[]")).toBeNull();
  });

  test("splits a byte stream into lines", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"a":1}\n{"b"'));
        controller.enqueue(encoder.encode(":2}\ntail"));
        controller.close();
      },
    });
    const out: string[] = [];
    for await (const line of readLines(stream)) out.push(line);
    expect(out).toEqual(['{"a":1}', '{"b":2}', "tail"]);
  });

  test("the cached idle sampler answers at once and refreshes in the background", async () => {
    let calls = 0;
    let clock = 0;
    const sampler = cachedIdleSampler(
      async () => {
        calls += 1;
        return 42;
      },
      1_000,
      () => clock,
    );
    expect(await sampler()).toBe(0);
    await sleep(5);
    expect(await sampler()).toBe(42);
    expect(calls).toBe(1);
    clock = 999;
    await sampler();
    expect(calls).toBe(1);
    clock = 1_000;
    await sampler();
    await sleep(5);
    expect(calls).toBe(2);
  });
});
