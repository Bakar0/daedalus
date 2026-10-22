import type { SignInCallback } from "./sign-in-pages";

/**
 * The browser's way back into the pod after a sign-in page
 * (artifacts/cloud-sessions/auth-spike.md, section 1). The page redirects to
 * `localhost:<port>`, where a tool in the pod listens; the browser runs on
 * this Mac, so this Mac listens on that port for one request and sends it
 * over the runner link (`auth.callback`).
 *
 * Only the first request on the redirect's path with the page's `state` is
 * forwarded, once; anything else gets a 404 and is not forwarded. The query
 * carries the authorization code: it is never logged or kept.
 */

/** Hosts the pod's redirect may send the browser on to. */
const ONWARD_HOSTS = new Set([
  "platform.claude.com",
  "claude.com",
  "claude.ai",
]);

export type ForwardCallback = (
  query: string,
) => Promise<{ status: number; location?: string }>;

const page = (status: number, text: string) =>
  new Response(
    `<!doctype html><meta charset="utf-8"><title>Daedalus</title><body style="font:15px -apple-system,sans-serif;margin:3em">${text}</body>`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } },
  );

/** Where the browser may go on to: Claude's own success page, https only. */
function onward(location: string | undefined): string | undefined {
  if (!location) return undefined;
  try {
    const url = new URL(location);
    return url.protocol === "https:" &&
      !url.username &&
      !url.port &&
      ONWARD_HOSTS.has(url.hostname)
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

export interface SignInListener {
  stop(): void;
  /** Settles when the one request was answered, or the listener stopped. */
  readonly done: Promise<"forwarded" | "failed" | "stopped">;
}

/**
 * Listens on the callback's port on 127.0.0.1 and [::1], the two places a
 * browser may go for `localhost`, until the one request comes or `timeoutMs`
 * passes. Undefined when this Mac cannot take the port on either; the
 * caller falls back to pasting.
 */
export function listenForSignIn(
  callback: SignInCallback,
  forward: ForwardCallback,
  options: { timeoutMs: number },
): SignInListener | undefined {
  const servers: ReturnType<typeof Bun.serve>[] = [];
  let finish: (result: "forwarded" | "failed" | "stopped") => void = () => {};
  const done = new Promise<"forwarded" | "failed" | "stopped">((resolve) => {
    finish = resolve;
  });
  let used = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = (result: "forwarded" | "failed" | "stopped") => {
    clearTimeout(timer);
    // Not forced: the one answer is still on its way to the browser.
    for (const server of servers.splice(0)) void server.stop();
    finish(result);
  };

  const fetch = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (
      used ||
      request.method !== "GET" ||
      url.pathname !== callback.path ||
      url.searchParams.get("state") !== callback.state
    )
      return page(404, "Not found.");
    used = true;
    try {
      const reply = await forward(url.search.slice(1));
      const next = onward(reply.location);
      // Answered before the listener goes, so the browser gets the page.
      setTimeout(() => stop("forwarded"), 0);
      if (next && reply.status >= 300 && reply.status < 400)
        return Response.redirect(next, 302);
      return reply.status < 400
        ? page(200, "Signed in. You can close this tab and return to Daedalus.")
        : page(
            502,
            "The session did not accept the sign-in. Return to Daedalus and sign in again in the session.",
          );
    } catch {
      setTimeout(() => stop("failed"), 0);
      return page(
        502,
        "The sign-in could not reach the cloud session. Return to Daedalus and sign in again in the session.",
      );
    }
  };

  try {
    servers.push(
      Bun.serve({ hostname: "127.0.0.1", port: callback.port, fetch }),
    );
  } catch {
    return undefined;
  }
  try {
    servers.push(Bun.serve({ hostname: "::1", port: callback.port, fetch }));
  } catch {
    // The browser may try [::1] first for `localhost`, so another process
    // holding it there could take the code: listen on both or on neither.
    for (const server of servers.splice(0)) void server.stop(true);
    return undefined;
  }
  timer = setTimeout(() => stop("stopped"), options.timeoutMs);
  return { stop: () => stop("stopped"), done };
}
