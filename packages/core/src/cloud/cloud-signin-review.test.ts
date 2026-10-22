import { expect, test } from "vitest";
import { listenForSignIn } from "./sign-in-callback";
import { checkSignInUrl } from "./sign-in-pages";

/**
 * Review findings S-1 and S-3 (artifacts/cloud-sessions/cloud-ui-review.md,
 * "Cloud sign-in"). Both fail on 67fc4b2.
 */

test("S-1: a page that repeats redirect_uri is refused", () => {
  // The check reads the first redirect_uri; a server may honour the last.
  const url =
    "https://claude.com/cai/oauth/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A5000%2Fcallback&state=s1&redirect_uri=https%3A%2F%2Fevil.example%2Fcb";
  expect(typeof checkSignInUrl(url, [])).toBe("string");
});

test("S-1: a page that repeats state is refused", () => {
  const url =
    "https://claude.com/cai/oauth/authorize?state=a&state=b&redirect_uri=http%3A%2F%2Flocalhost%3A5000%2Fcallback";
  expect(typeof checkSignInUrl(url, [])).toBe("string");
});

test("S-3: another process on [::1] at the port makes the Mac fall back to pasting", () => {
  let squatter: ReturnType<typeof Bun.serve>;
  try {
    squatter = Bun.serve({
      hostname: "::1",
      port: 0,
      fetch: () => new Response("caught"),
    });
  } catch {
    return; // No IPv6 loopback on this machine: nothing to prove.
  }
  try {
    const listener = listenForSignIn(
      { port: squatter.port!, path: "/callback", state: "s1" },
      async () => ({ status: 200 }),
      { timeoutMs: 1_000 },
    );
    try {
      // The browser resolves `localhost` to ::1 as well as 127.0.0.1, so
      // the code could go to the squatter; the Mac should not listen here.
      expect(listener).toBeUndefined();
    } finally {
      listener?.stop();
    }
  } finally {
    void squatter.stop(true);
  }
});
