import {
  AUTH_CALLBACK_PATHS,
  type RunnerMethods,
} from "@daedalus/remote-protocol";
import { RunnerError } from "./errors";

type Params = RunnerMethods["auth.callback"]["params"];
type Result = RunnerMethods["auth.callback"]["result"];

export const AUTH_CALLBACK_TIMEOUT_MS = 10_000;
const MAX_QUERY = 8192;
const MAX_LOCATION = 4096;

/**
 * Only an https page goes back to the Mac. A tool's own success page is
 * `http://localhost`, and Codex's carries an ID token in its query.
 */
function onwardLocation(location: string | null): string | undefined {
  if (!location || location.length > MAX_LOCATION) return undefined;
  try {
    return new URL(location).protocol === "https:" ? location : undefined;
  } catch {
    return undefined;
  }
}
// Printable ASCII but `#`: a query as the browser sent it, still encoded.
const QUERY = /^[\x21\x22\x24-\x7e]*$/;

/**
 * `auth.callback`: hands a sign-in page's redirect, which the Mac caught in
 * the user's browser, to the tool waiting for it on `127.0.0.1` in this pod.
 * Pod containers share one network namespace, so the runner reaches a
 * listener the session container opened.
 *
 * The query holds an authorization code, so no error says anything about it.
 * The listener runs in the session container, which this runner does not
 * trust: only the status and a bounded https `Location` come back, the body
 * is dropped, and the Mac checks the `Location` again. Neither the query
 * nor the `Location` is logged.
 */
export async function authCallback(
  params: unknown,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = AUTH_CALLBACK_TIMEOUT_MS,
): Promise<Result> {
  const { port, path, query } = (params ?? {}) as Partial<Params>;
  if (
    !Number.isInteger(port) ||
    port! < 1024 ||
    port! > 65535 ||
    !(AUTH_CALLBACK_PATHS as readonly unknown[]).includes(path) ||
    typeof query !== "string" ||
    query.length > MAX_QUERY ||
    !QUERY.test(query)
  )
    throw new RunnerError("VALIDATION", "Invalid sign-in callback");
  let response: Response;
  try {
    response = await fetchImpl(`http://127.0.0.1:${port}${path}?${query}`, {
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new RunnerError("FAILED", "Nothing answered the sign-in callback");
  }
  await response.body?.cancel().catch(() => undefined);
  const location = onwardLocation(response.headers.get("location"));
  return { status: response.status, ...(location ? { location } : {}) };
}
