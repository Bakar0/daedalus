import { afterEach, expect, test } from "bun:test";
import { authCallback } from "./auth-callback";
import { RunnerError } from "./errors";

let server: ReturnType<typeof Bun.serve> | undefined;
afterEach(() => {
  server?.stop(true);
  server = undefined;
});

const listen = (
  handler: (request: Request) => Response | Promise<Response>,
) => {
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  return server.port!;
};

const failure = async (promise: Promise<unknown>) => {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(RunnerError);
  return error as RunnerError;
};

test("delivers the query to the listener and returns status and Location", async () => {
  const seen: string[] = [];
  const port = listen((request) => {
    seen.push(new URL(request.url).pathname + new URL(request.url).search);
    return new Response("signed in, secret body", {
      status: 302,
      headers: {
        location:
          "https://platform.claude.com/oauth/code/success?app=claude-code",
      },
    });
  });
  const result = await authCallback({
    port,
    path: "/callback",
    query: "code=abc%2Fdef&state=xyz",
  });
  expect(seen).toEqual(["/callback?code=abc%2Fdef&state=xyz"]);
  expect(result).toEqual({
    status: 302,
    location: "https://platform.claude.com/oauth/code/success?app=claude-code",
  });
  expect(JSON.stringify(result)).not.toContain("secret body");
});

test("serves the AWS CLI's path too, and leaves out a long Location", async () => {
  const port = listen(
    () =>
      new Response(null, {
        status: 200,
        headers: { location: `https://x.test/${"a".repeat(5000)}` },
      }),
  );
  expect(
    await authCallback({
      port,
      path: "/oauth/callback",
      query: "code=1&state=2",
    }),
  ).toEqual({ status: 200 });
});

test("refuses other paths, ports and queries before connecting", async () => {
  let hits = 0;
  const port = listen(() => {
    hits++;
    return new Response(null);
  });
  const bad = [
    null,
    { port, path: "/admin", query: "" },
    { port, path: "/callback/../admin", query: "" },
    { port: 80, path: "/callback", query: "" },
    { port: 70000, path: "/callback", query: "" },
    { port: "8080", path: "/callback", query: "" },
    { port, path: "/callback", query: "a=1#frag" },
    { port, path: "/callback", query: "a=1\r\nHost: evil" },
    { port, path: "/callback", query: "a b" },
    { port, path: "/callback", query: "x".repeat(9000) },
    { port, path: "/callback" },
  ];
  for (const params of bad) {
    const error = await failure(authCallback(params));
    expect(error.code).toBe("VALIDATION");
  }
  expect(hits).toBe(0);
});

test("a dead listener fails without naming the query", async () => {
  const port = listen(() => new Response(null));
  server!.stop(true);
  server = undefined;
  const error = await failure(
    authCallback({ port, path: "/callback", query: "code=SECRETCODE" }),
  );
  expect(error.code).toBe("FAILED");
  expect(error.message).not.toContain("SECRETCODE");
});

test("a listener that never answers times out", async () => {
  const port = listen(() => new Promise<Response>(() => {}));
  const started = Date.now();
  const error = await failure(
    authCallback({ port, path: "/callback", query: "code=1" }, fetch, 200),
  );
  expect(error.code).toBe("FAILED");
  expect(Date.now() - started).toBeLessThan(5000);
});

test("only ever connects to 127.0.0.1, without following redirects", async () => {
  const calls: { url: string; redirect?: RequestRedirect }[] = [];
  const fake = (async (url: string, init: RequestInit) => {
    calls.push({ url, redirect: init.redirect });
    return new Response(null, { status: 302 });
  }) as unknown as typeof fetch;
  await authCallback({ port: 4000, path: "/callback", query: "code=1" }, fake);
  expect(calls).toEqual([
    { url: "http://127.0.0.1:4000/callback?code=1", redirect: "manual" },
  ]);
});
