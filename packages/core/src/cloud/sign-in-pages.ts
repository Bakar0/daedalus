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
/** An AWS access portal's start page; the device page is its fragment. */
const AWS_START_PATHS = new Set(["/start", "/start/"]);
/** Where Claude's paste-code flow sends the browser. */
export const CLAUDE_PASTE_REDIRECT =
  "https://platform.claude.com/oauth/code/callback";

export type SignInKind = "claude" | "aws";

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
): SignInCallback | undefined | string {
  if (value === CLAUDE_PASTE_REDIRECT) return undefined;
  let redirect: URL;
  try {
    redirect = new URL(value);
  } catch {
    return "a redirect that is not a URL";
  }
  const local =
    redirect.protocol === "http:" &&
    !redirect.username &&
    !redirect.password &&
    !redirect.search &&
    !redirect.hash &&
    ((redirect.hostname === "localhost" && redirect.pathname === "/callback") ||
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
  else if (ssoHosts.includes(host) && AWS_START_PATHS.has(url.pathname))
    kind = "aws";
  else return `a page on ${host} that is not a sign-in page`;
  // A server may honour the last copy of a parameter, and only the first
  // is checked here, so no parameter may come twice.
  const keys = [...url.searchParams.keys()];
  if (new Set(keys).size !== keys.length)
    return "a URL that repeats a parameter";
  // Claude's pages always name where the browser comes back to, and the
  // state the listener checks.
  if (
    kind === "claude" &&
    (!url.searchParams.has("redirect_uri") || !url.searchParams.has("state"))
  )
    return "a sign-in page without a redirect_uri and a state";
  const redirect = url.searchParams.get("redirect_uri");
  let callback: SignInCallback | undefined;
  if (redirect !== null) {
    const checked = checkRedirect(redirect, url.searchParams.get("state"));
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

/** What a window sees of an offer: never the URL, its state or a code. */
export interface SignInOffer {
  requestId: string;
  sessionId: string;
  host: string;
  kind: SignInKind;
  expiresAt: number;
}

interface StoredOffer extends SignInOffer {
  hostId: string;
  checked: CheckedSignInUrl;
}

/**
 * The sign-in pages waiting for a click, one per session: a newer one
 * replaces the older. Kept in memory only.
 */
export class SignInOffers {
  readonly #offers = new Map<string, StoredOffer>();
  readonly #listeners = new Set<() => void>();

  constructor(private readonly now: () => number = Date.now) {}

  offer(
    hostId: string,
    sessionId: string,
    checked: CheckedSignInUrl,
  ): SignInOffer {
    for (const [id, offer] of this.#offers)
      if (offer.sessionId === sessionId) this.#offers.delete(id);
    const stored: StoredOffer = {
      requestId: crypto.randomUUID(),
      sessionId,
      host: checked.host,
      kind: checked.kind,
      expiresAt: this.now() + SIGN_IN_OFFER_MS,
      hostId,
      checked,
    };
    this.#offers.set(stored.requestId, stored);
    this.#changed();
    return this.#view(stored);
  }

  list(): SignInOffer[] {
    this.#expire();
    return [...this.#offers.values()].map((offer) => this.#view(offer));
  }

  /** Removes an offer and returns it whole, for the click that opens it. */
  take(
    requestId: string,
  ): (SignInOffer & { hostId: string; checked: CheckedSignInUrl }) | undefined {
    this.#expire();
    const offer = this.#offers.get(requestId);
    if (!offer) return undefined;
    this.#offers.delete(requestId);
    this.#changed();
    return offer;
  }

  dismiss(requestId: string): void {
    if (this.#offers.delete(requestId)) this.#changed();
  }

  /** Drops every offer from a host, when its account or workspace goes. */
  dropHost(hostId: string): void {
    let dropped = false;
    for (const [id, offer] of this.#offers)
      if (offer.hostId === hostId) dropped = this.#offers.delete(id);
    if (dropped) this.#changed();
  }

  clear(): void {
    if (!this.#offers.size) return;
    this.#offers.clear();
    this.#changed();
  }

  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #view(offer: StoredOffer): SignInOffer {
    return {
      requestId: offer.requestId,
      sessionId: offer.sessionId,
      host: offer.host,
      kind: offer.kind,
      expiresAt: offer.expiresAt,
    };
  }

  #expire(): void {
    const now = this.now();
    for (const [id, offer] of this.#offers)
      if (offer.expiresAt <= now) this.#offers.delete(id);
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
