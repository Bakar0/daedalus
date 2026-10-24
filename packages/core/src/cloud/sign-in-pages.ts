import { AUTH_CALLBACK_PATHS } from "@daedalus/remote-protocol";

/**
 * Sign-in pages a cloud session asks this Mac to open (`daedal open-url`,
 * run by the pod's `BROWSER`). The pod runs code this Mac does not trust, so
 * a URL is offered only when it is https on a host and path below, and it
 * opens only when the user clicks. See artifacts/cloud-sessions/auth-spike.md.
 */

const MAX_URL = 4096;
/** How long an offer waits for its click. */
export const SIGN_IN_OFFER_MS = 10 * 60_000;

/** Claude's own sign-in pages, by host. */
const CLAUDE_PAGES: Record<string, string> = {
  "claude.com": "/cai/oauth/authorize",
  "platform.claude.com": "/oauth/authorize",
  "claude.ai": "/oauth/authorize",
};
/** Codex's ChatGPT sign-in page, by host. */
const CODEX_PAGES: Record<string, string> = {
  "auth.openai.com": "/oauth/authorize",
};
/** An AWS access portal's start page; the device page is its fragment. */
const AWS_START_PATHS = new Set(["/start", "/start/"]);
/** Where Claude's paste-code flow sends the browser. */
export const CLAUDE_PASTE_REDIRECT =
  "https://platform.claude.com/oauth/code/callback";

export type SignInKind = "claude" | "codex" | "aws";

/** Where the browser comes back to, on a tool's listener in the pod. */
export interface SignInCallback {
  port: number;
  path: (typeof AUTH_CALLBACK_PATHS)[number];
  /** The page's `state`, which the browser's request must carry back. */
  state: string;
}

export interface CheckedSignInUrl {
  url: string;
  kind: SignInKind;
  host: string;
  /** Set when the page redirects to a listener in the pod. */
  callback?: SignInCallback;
}

/** The redirect a page may name, or a reason it may not. */
function checkRedirect(
  value: string,
  state: string | null,
  kind: SignInKind,
): SignInCallback | undefined | string {
  if (kind === "claude" && value === CLAUDE_PASTE_REDIRECT) return undefined;
  let redirect: URL;
  try {
    redirect = new URL(value);
  } catch {
    return "a redirect that is not a URL";
  }
  // Each tool's own listener: Claude's on localhost, the AWS CLI's and
  // Codex's on 127.0.0.1.
  const local =
    redirect.protocol === "http:" &&
    !redirect.username &&
    !redirect.password &&
    !redirect.search &&
    !redirect.hash &&
    (kind === "codex"
      ? redirect.hostname === "127.0.0.1" &&
        redirect.pathname === "/auth/callback"
      : (redirect.hostname === "localhost" &&
          redirect.pathname === "/callback") ||
        (redirect.hostname === "127.0.0.1" &&
          redirect.pathname === "/oauth/callback"));
  const port = Number(redirect.port);
  if (!local || !Number.isInteger(port) || port < 1024 || port > 65535)
    return "a redirect to somewhere other than a sign-in listener";
  if (!state) return "a redirect without a state";
  return {
    port,
    path: redirect.pathname as SignInCallback["path"],
    state,
  };
}

/**
 * Checks a URL a pod asked to open. `ssoHosts` are the AWS access portal
 * hosts this Mac copied into that workspace; no other portal is allowed.
 */
export function checkSignInUrl(
  raw: string,
  ssoHosts: readonly string[],
): CheckedSignInUrl | string {
  if (typeof raw !== "string" || raw.length > MAX_URL) return "the URL";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "the URL";
  }
  if (url.protocol !== "https:") return "a URL that is not https";
  if (url.username || url.password) return "a URL with a user name";
  if (url.port) return "a URL with a port";
  const host = url.hostname.toLowerCase();
  let kind: SignInKind;
  if (CLAUDE_PAGES[host] === url.pathname) kind = "claude";
  else if (CODEX_PAGES[host] === url.pathname) kind = "codex";
  else if (ssoHosts.includes(host) && AWS_START_PATHS.has(url.pathname))
    kind = "aws";
  else return `a page on ${host} that is not a sign-in page`;
  // A server may honour the last copy of a parameter, and only the first
  // is checked here, so no parameter may come twice.
  const keys = [...url.searchParams.keys()];
  if (new Set(keys).size !== keys.length)
    return "a URL that repeats a parameter";
  // Claude's and Codex's pages always name where the browser comes back
  // to, and the state the listener checks.
  if (
    (kind === "claude" || kind === "codex") &&
    (!url.searchParams.has("redirect_uri") || !url.searchParams.has("state"))
  )
    return "a sign-in page without a redirect_uri and a state";
  const redirect = url.searchParams.get("redirect_uri");
  let callback: SignInCallback | undefined;
  if (redirect !== null) {
    const checked = checkRedirect(
      redirect,
      url.searchParams.get("state"),
      kind,
    );
    if (typeof checked === "string") return checked;
    callback = checked;
  }
  return {
    url: url.toString(),
    kind,
    host,
    ...(callback ? { callback } : {}),
  };
}

/**
 * The same page with Claude's paste-code redirect, for when this Mac cannot
 * listen on the pod's port. Both share the state and the PKCE verifier, so
 * the code the page shows redeems in the pod.
 */
export function pasteCodeUrl(url: string): string {
  const pasted = new URL(url);
  pasted.searchParams.set("redirect_uri", CLAUDE_PASTE_REDIRECT);
  return pasted.toString();
}

/**
 * Where a cloud session's sign-in stands.
 * - `starting`: Daedalus typed /login in the session and waits for its page.
 * - `waiting`: the page is offered and waits for the user's click.
 * - `browser`: the page is open; the user finishes in the browser, and the
 *   session carries on by itself.
 * - `pasting`: the page opened in its paste-code form; the user pastes the
 *   code into the session.
 * - `failed`: it stopped; `message` says why.
 */
export type SignInPhase =
  "starting" | "waiting" | "browser" | "pasting" | "failed";

/** What a window sees of a sign-in: never the URL, its state or a code. */
export interface SignInOffer {
  sessionId: string;
  kind: SignInKind;
  phase: SignInPhase;
  /** Set while `waiting`: what the click opens. */
  requestId?: string;
  /** The page's host, once there is a page. */
  host?: string;
  message?: string;
  expiresAt: number;
}

interface StoredOffer extends SignInOffer {
  hostId: string;
  checked?: CheckedSignInUrl;
}

/** How long the steps around a page may take. */
const STARTING_MS = 90_000;
const FAILED_MS = 60_000;

/**
 * Each cloud session's sign-in, one per session: a newer page replaces the
 * older. Kept in memory only.
 */
export class SignInOffers {
  readonly #bySession = new Map<string, StoredOffer>();
  readonly #listeners = new Set<() => void>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Daedalus started a sign-in in the session itself. */
  begin(hostId: string, sessionId: string, kind: SignInKind): void {
    this.#set({
      sessionId,
      hostId,
      kind,
      phase: "starting",
      expiresAt: this.now() + STARTING_MS,
    });
  }

  offer(
    hostId: string,
    sessionId: string,
    checked: CheckedSignInUrl,
  ): SignInOffer {
    return this.#view(
      this.#set({
        sessionId,
        hostId,
        kind: checked.kind,
        phase: "waiting",
        requestId: crypto.randomUUID(),
        host: checked.host,
        expiresAt: this.now() + SIGN_IN_OFFER_MS,
        checked,
      }),
    );
  }

  list(): SignInOffer[] {
    this.#expire();
    return [...this.#bySession.values()].map((offer) => this.#view(offer));
  }

  /** The sign-in of one session, as a window sees it. */
  get(sessionId: string): SignInOffer | undefined {
    this.#expire();
    const offer = this.#bySession.get(sessionId);
    return offer && this.#view(offer);
  }

  /**
   * The page for the click that opens it, once: the offer moves on to
   * `browser` or `pasting` and can be opened no more.
   */
  open(
    requestId: string,
    paste: (offer: StoredOffer) => boolean,
  ): (SignInOffer & { hostId: string; checked: CheckedSignInUrl }) | undefined {
    this.#expire();
    const offer = [...this.#bySession.values()].find(
      (item) => item.requestId === requestId && item.phase === "waiting",
    );
    if (!offer?.checked) return undefined;
    const checked = offer.checked;
    const pasting = paste(offer);
    this.#set({
      sessionId: offer.sessionId,
      hostId: offer.hostId,
      kind: offer.kind,
      phase: pasting ? "pasting" : "browser",
      ...(offer.host ? { host: offer.host } : {}),
      expiresAt: this.now() + SIGN_IN_OFFER_MS,
    });
    return { ...offer, checked };
  }

  /** The sign-in finished: nothing more to show. */
  finish(sessionId: string): void {
    if (this.#bySession.delete(sessionId)) this.#changed();
  }

  fail(sessionId: string, message: string): void {
    const offer = this.#bySession.get(sessionId);
    if (!offer) return;
    this.#set({
      sessionId,
      hostId: offer.hostId,
      kind: offer.kind,
      phase: "failed",
      ...(offer.host ? { host: offer.host } : {}),
      message,
      expiresAt: this.now() + FAILED_MS,
    });
  }

  /** By session, or by the page's request id. */
  dismiss(reference: { sessionId?: string; requestId?: string }): void {
    for (const [sessionId, offer] of this.#bySession)
      if (
        sessionId === reference.sessionId ||
        (reference.requestId && offer.requestId === reference.requestId)
      ) {
        this.#bySession.delete(sessionId);
        this.#changed();
      }
  }

  /** Drops every sign-in from a host, when its account or workspace goes. */
  dropHost(hostId: string): void {
    let dropped = false;
    for (const [sessionId, offer] of this.#bySession)
      if (offer.hostId === hostId) dropped = this.#bySession.delete(sessionId);
    if (dropped) this.#changed();
  }

  clear(): void {
    if (!this.#bySession.size) return;
    this.#bySession.clear();
    this.#changed();
  }

  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #set(offer: StoredOffer): StoredOffer {
    this.#bySession.set(offer.sessionId, offer);
    this.#changed();
    return offer;
  }

  #view(offer: StoredOffer): SignInOffer {
    return {
      sessionId: offer.sessionId,
      kind: offer.kind,
      phase: offer.phase,
      ...(offer.requestId ? { requestId: offer.requestId } : {}),
      ...(offer.host ? { host: offer.host } : {}),
      ...(offer.message ? { message: offer.message } : {}),
      expiresAt: offer.expiresAt,
    };
  }

  #expire(): void {
    const now = this.now();
    for (const [sessionId, offer] of this.#bySession)
      if (offer.expiresAt <= now) this.#bySession.delete(sessionId);
  }

  #changed(): void {
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch {
        // A listener's failure is its own.
      }
    }
  }
}
