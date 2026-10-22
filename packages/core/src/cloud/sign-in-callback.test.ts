import { describe, expect, test } from "vitest";
import { listenForSignIn } from "./sign-in-callback";

/** A port that was free a moment ago. */
function freePort(): number {
  const probe = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(),
  });
  const port = probe.port!;
  void probe.stop(true);
  return port;
}

describe("listenForSignIn", () => {
  test("forwards the one request with the page's state, then stops", async () => {
    const port = freePort();
    const forwarded: string[] = [];
    const listener = listenForSignIn(
      { port, path: "/callback", state: "st8" },
      async (query) => {
        forwarded.push(query);
        return {
          status: 302,
          location:
            "https://platform.claude.com/oauth/code/success?app=claude-code",
        };
      },
      { timeoutMs: 10_000 },
    )!;
    expect(listener).toBeDefined();
    const base = `http://127.0.0.1:${port}`;
    // Wrong path, wrong state: not forwarded.
    expect((await fetch(`${base}/favicon.ico`)).status).toBe(404);
    expect((await fetch(`${base}/callback?code=c&state=nope`)).status).toBe(
      404,
    );
    const reply = await fetch(`${base}/callback?code=secret&state=st8`, {
      redirect: "manual",
    });
    expect(reply.status).toBe(302);
    expect(reply.headers.get("location")).toBe(
      "https://platform.claude.com/oauth/code/success?app=claude-code",
    );
    expect(forwarded).toEqual(["code=secret&state=st8"]);
    expect(await listener.done).toBe("forwarded");
    await expect(fetch(`${base}/callback?code=x&state=st8`)).rejects.toThrow();
  });

  test("a redirect from the pod to anywhere else is not followed", async () => {
    const port = freePort();
    const listener = listenForSignIn(
      { port, path: "/callback", state: "s" },
      async () => ({ status: 302, location: "https://evil.test/phish" }),
      { timeoutMs: 10_000 },
    )!;
    const reply = await fetch(
      `http://127.0.0.1:${port}/callback?code=c&state=s`,
      { redirect: "manual" },
    );
    expect(reply.status).toBe(200);
    expect(await reply.text()).toContain("Signed in");
    expect(await listener.done).toBe("forwarded");
  });

  test("a pod that cannot be reached gets an error page", async () => {
    const port = freePort();
    const listener = listenForSignIn(
      { port, path: "/callback", state: "s" },
      async () => {
        throw new Error("FAILED");
      },
      { timeoutMs: 10_000 },
    )!;
    const reply = await fetch(
      `http://127.0.0.1:${port}/callback?code=c&state=s`,
    );
    expect(reply.status).toBe(502);
    expect(await listener.done).toBe("failed");
  });

  test("a port this Mac cannot take means pasting instead", () => {
    const taken = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(),
    });
    try {
      expect(
        listenForSignIn(
          { port: taken.port!, path: "/callback", state: "s" },
          async () => ({ status: 200 }),
          { timeoutMs: 10_000 },
        ),
      ).toBeUndefined();
    } finally {
      void taken.stop(true);
    }
  });

  test("a port held on [::1] means pasting, and frees 127.0.0.1 (S-3)", () => {
    const taken = Bun.serve({
      hostname: "::1",
      port: 0,
      fetch: () => new Response(),
    });
    try {
      expect(
        listenForSignIn(
          { port: taken.port!, path: "/callback", state: "s" },
          async () => ({ status: 200 }),
          { timeoutMs: 10_000 },
        ),
      ).toBeUndefined();
      // The 127.0.0.1 half it had taken is free again.
      const again = Bun.serve({
        hostname: "127.0.0.1",
        port: taken.port!,
        fetch: () => new Response(),
      });
      void again.stop(true);
    } finally {
      void taken.stop(true);
    }
  });

  test("stops by itself after its time", async () => {
    const listener = listenForSignIn(
      { port: freePort(), path: "/callback", state: "s" },
      async () => ({ status: 200 }),
      { timeoutMs: 50 },
    )!;
    expect(await listener.done).toBe("stopped");
  });
});
