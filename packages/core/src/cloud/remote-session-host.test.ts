import { describe, expect, test } from "vitest";
import type { RunnerTransport } from "./link";
import { RemoteSessionHost } from "./remote-session-host";

const WS = "11111111-1111-4111-8111-111111111111";

/** A runner that answers every method with `reply`. */
const answering = (reply: unknown): RunnerTransport => ({
  unavailable: async () => undefined,
  request: async () => reply as never,
});

describe("remote session host replies", () => {
  test("a reply of the wrong shape reads as the host being unavailable", async () => {
    for (const reply of [{}, "s", [1], null]) {
      await expect(
        new RemoteSessionHost(WS, answering(reply)).listLive(),
      ).rejects.toMatchObject({ code: "DEPENDENCY" });
    }
    await expect(
      new RemoteSessionHost(WS, answering("yes")).isLive("s"),
    ).rejects.toMatchObject({ code: "DEPENDENCY" });
    await expect(
      new RemoteSessionHost(WS, answering({ text: "x" })).capture("s"),
    ).rejects.toMatchObject({ code: "DEPENDENCY" });
  });

  test("keeps good replies and cuts a huge capture to its end", async () => {
    expect(
      await new RemoteSessionHost(WS, answering(["a", "b"])).listLive(),
    ).toEqual(["a", "b"]);
    expect(await new RemoteSessionHost(WS, answering(true)).isLive("s")).toBe(
      true,
    );
    const screen = `${"x".repeat(2 * 1024 * 1024)}END`;
    const captured = await new RemoteSessionHost(WS, answering(screen)).capture(
      "s",
    );
    expect(captured.length).toBe(1024 * 1024);
    expect(captured.endsWith("END")).toBe(true);
  });
});
