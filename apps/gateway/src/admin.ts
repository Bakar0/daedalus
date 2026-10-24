import { readFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import type { Server } from "bun";
import type { AdminConfig, GatewayConfig } from "./config";
import {
  workspaceStatus,
  type Controller,
  type WorkspaceUsage,
} from "./controller";
import { parseQuantity } from "./quantity";
import { runnerDevice, type Relay } from "./relay";
import { HttpError, readJson, type createGateway } from "./server";
import {
  randomToken,
  sha256,
  type AuditEntry,
  type Store,
  type WorkspaceRow,
} from "./store";
import { adminClient } from "./admin/client";
import pageCss from "./admin/admin.css" with { type: "text" };

/**
 * The admin page and its API, on a listener of its own that is off unless
 * DAEDALUS_GATEWAY_ADMIN_PORT is set (artifacts/cloud-sessions/admin-design.md).
 * The public and runner listeners have no admin routes at all.
 *
 * Sign-in is separate from user tokens. Stage 0 takes bootstrap tokens from
 * a mounted Secret; `AdminAuth` is the seam OIDC replaces in 1b. A session
 * is a cookie plus a CSRF token the page sends as a header on every write.
 * A viewer reads; only an admin sleeps, wakes, deletes or sets limits. Every
 * action is audited, in SQLite and as a JSON line on stdout.
 */

export type AdminRole = "viewer" | "admin";

export interface AdminPrincipal {
  subject: string;
  role: AdminRole;
  via: "bootstrap" | "oidc";
}

export interface AdminAuth {
  /** The principal for a sign-in request's body, or null. */
  signIn(body: Record<string, unknown>): AdminPrincipal | null;
}

/** The page: everything else comes from admin.js and admin.css. */
const PAGE_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Daedalus admin</title>
    <link rel="stylesheet" href="/admin/admin.css" />
    <script src="/admin/admin.js" defer></script>
  </head>
  <body>
    <div id="app"><p class="hint">Loading…</p></div>
  </body>
</html>
`;

/** Bootstrap tokens shorter than this are refused at start. */
export const MIN_TOKEN_LENGTH = 32;

const sameHash = (a: string, b: string) =>
  timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));

/**
 * Stage 0 sign-in: the `admin-token` and optional `viewer-token` of the
 * chart's Secret. Only their hashes are kept, compared in constant time.
 */
export class BootstrapAuth implements AdminAuth {
  readonly #hashes: { hash: string; principal: AdminPrincipal }[] = [];

  constructor(tokens: { admin: string; viewer?: string }) {
    for (const [role, token] of [
      ["admin", tokens.admin],
      ["viewer", tokens.viewer],
    ] as const) {
      if (token === undefined) continue;
      if (token.length < MIN_TOKEN_LENGTH)
        throw new Error(
          `The admin ${role} token must be at least ${MIN_TOKEN_LENGTH} characters`,
        );
      this.#hashes.push({
        hash: sha256(token),
        principal: { subject: `bootstrap-${role}`, role, via: "bootstrap" },
      });
    }
    if (tokens.viewer !== undefined && tokens.viewer === tokens.admin)
      throw new Error("The admin and viewer tokens must differ");
  }

  /** Reads the tokens from the mounted Secret. */
  static fromDir(dir: string): BootstrapAuth {
    const read = (name: string) => {
      try {
        return readFileSync(join(dir, name), "utf8").trim();
      } catch {
        return undefined;
      }
    };
    const admin = read("admin-token");
    if (!admin) throw new Error(`No admin-token in ${dir}`);
    const viewer = read("viewer-token");
    return new BootstrapAuth({ admin, ...(viewer ? { viewer } : {}) });
  }

  signIn(body: Record<string, unknown>): AdminPrincipal | null {
    const { token } = body;
    if (typeof token !== "string" || token.length > 1024) return null;
    const hash = sha256(token.trim());
    let found: AdminPrincipal | null = null;
    // Every hash is compared, so the time does not tell which one matched.
    for (const entry of this.#hashes)
      if (sameHash(hash, entry.hash)) found = entry.principal;
    return found;
  }
}

/** Failed sign-ins allowed per minute across the listener. */
export const SIGN_IN_FAILURES_PER_MINUTE = 10;
const COOKIE = "daedalus_admin";
const CSRF_HEADER = "X-Daedalus-CSRF";
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
const USER_ID = /^[a-z0-9]{1,20}$/;
const WORKSPACE_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** The most a limit override may be. */
export const MAX_LIMIT = 100;

const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
  "X-Frame-Options": "DENY",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
};

class AdminError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const STATUS_FOR_CODE: Record<string, number> = {
  VALIDATION: 400,
  UNAUTHORIZED: 401,
  NOT_FOUND: 404,
  CONFLICT: 409,
  QUOTA: 429,
  INTERNAL: 500,
};

interface Session {
  principal: AdminPrincipal;
  csrf: string;
  expires: number;
  /** The first 8 hex characters of the session's hash, for the audit. */
  short: string;
}

/** Who did something, for the audit. */
interface Actor {
  subject: string;
  session: string;
  address: string;
}

export type AdminWorkspaceStatus =
  "running" | "sleeping" | "starting" | "failed" | "unknown";

/** A workspace on the admin page. Built field by field: no key or token. */
export interface AdminWorkspace {
  workspaceId: string;
  name: string;
  status: AdminWorkspaceStatus;
  reason: string | null;
  runnerOnline: boolean;
  createdAt: string;
  lastActiveAt: string | null;
  sleptAt: string | null;
  /** When collection deletes it; null while awake or with retention off. */
  collectAt: string | null;
  daysUntilCollection: number | null;
  disk: { name: string; size: string }[];
  diskBytes: number;
  /** The session container's CPU and memory; null while asleep. */
  resources: {
    cpu: { request: string; limit: string };
    memory: { request: string; limit: string };
  } | null;
}

export interface AdminUser {
  id: string;
  email: string;
  createdAt: string;
  limit: number;
  limitOverride: number | null;
  /** Set when the cluster could not be read for this user. */
  error: string | null;
  workspaces: AdminWorkspace[];
}

export interface AdminOverview {
  generatedAt: string;
  settings: {
    asleepDays: number;
    defaultLimit: number;
    idleMinutes: string;
    collectMinutes: number;
  };
  opencostUrl: string | null;
  summary: {
    users: number;
    workspaces: number;
    byStatus: Record<AdminWorkspaceStatus, number>;
    diskBytes: number;
    cpuRequested: number;
    memoryRequestedBytes: number;
  };
  users: AdminUser[];
}

export interface AdminDeps {
  config: GatewayConfig & { admin: AdminConfig };
  store: Store;
  controller: Controller;
  relay: Relay;
  workspaces: ReturnType<typeof createGateway>["workspaces"];
  auth: AdminAuth;
  log?: (message: string) => void;
  /** Where audit lines go; stdout by default. */
  print?: (line: string) => void;
  now?: () => number;
}

function cookieValue(request: Request, name: string): string | undefined {
  for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index > 0 && part.slice(0, index).trim() === name)
      return part.slice(index + 1).trim();
  }
  return undefined;
}

const sameText = (a: string, b: string) => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

/** The hostname of a Host header, keeping IPv6 brackets. */
const hostname = (host: string) =>
  host.startsWith("[")
    ? host.slice(0, host.indexOf("]") + 1)
    : host.split(":")[0]!;

const DAY_MS = 86_400_000;

export function createAdmin(deps: AdminDeps) {
  const { config, store, controller, relay, workspaces, auth } = deps;
  const admin = config.admin;
  const log = deps.log ?? ((message: string) => console.error(message));
  const print = deps.print ?? ((line: string) => console.log(line));
  const now = deps.now ?? Date.now;
  const sessions = new Map<string, Session>();
  let failures: number[] = [];
  const clientScript = `(${adminClient.toString()})();\n`;

  function audit(
    actor: Actor,
    action: string,
    target: string,
    result: string,
    detail = "",
  ) {
    const entry: AuditEntry = {
      at: new Date(now()).toISOString(),
      ...actor,
      action,
      target,
      result,
      detail,
    };
    try {
      store.audit(entry);
    } catch (error) {
      log(`Writing the admin audit failed: ${String(error)}`);
    }
    print(JSON.stringify({ audit: "admin", ...entry }));
  }

  function respond(body: unknown, status = 200, headers: HeadersInit = {}) {
    return Response.json(body, {
      status,
      headers: { ...SECURITY_HEADERS, ...headers },
    });
  }

  const asset = (body: string, type: string) =>
    new Response(body, {
      headers: { ...SECURITY_HEADERS, "Content-Type": type },
    });

  /** Whether the Host header names this listener: loopback, or configured. */
  function allowedHost(host: string): boolean {
    const name = hostname(host);
    if (LOOPBACK.has(name)) return true;
    return admin.hosts.includes(host) || admin.hosts.includes(name);
  }

  const isLoopback = (host: string) => LOOPBACK.has(hostname(host));

  /** Whether the browser reached us over https (or a TLS proxy said so). */
  const isHttps = (request: Request, url: URL) =>
    url.protocol === "https:" ||
    request.headers.get("X-Forwarded-Proto")?.toLowerCase() === "https";

  function session(request: Request): Session | null {
    const id = cookieValue(request, COOKIE);
    if (!id) return null;
    const hash = sha256(id);
    const found = sessions.get(hash);
    if (!found) return null;
    if (found.expires <= now()) {
      sessions.delete(hash);
      return null;
    }
    return found;
  }

  function actorFor(
    found: Session | null,
    address: string,
    subject = found?.principal.subject ?? "anonymous",
  ): Actor {
    return { subject, session: found?.short ?? "", address };
  }

  /** The checks every write needs: same origin, JSON, the CSRF header. */
  function checkWrite(request: Request, url: URL, found: Session | null) {
    const origin = request.headers.get("Origin");
    const expected = `${isHttps(request, url) ? "https" : "http"}://${request.headers.get("Host")}`;
    if (origin !== null && origin !== expected)
      throw new AdminError(403, "FORBIDDEN", "Cross-origin request");
    const site = request.headers.get("Sec-Fetch-Site");
    if (site !== null && site !== "same-origin" && site !== "none")
      throw new AdminError(403, "FORBIDDEN", "Cross-site request");
    const type = request.headers.get("Content-Type") ?? "";
    if (!type.toLowerCase().startsWith("application/json"))
      throw new AdminError(415, "VALIDATION", "Send JSON");
    if (!found) return;
    const csrf = request.headers.get(CSRF_HEADER) ?? "";
    if (!sameText(csrf, found.csrf))
      throw new AdminError(403, "FORBIDDEN", "Missing or wrong CSRF token");
  }

  async function signIn(request: Request, url: URL, address: string) {
    const host = request.headers.get("Host") ?? "";
    if (!isLoopback(host) && !isHttps(request, url))
      throw new AdminError(
        403,
        "FORBIDDEN",
        "Sign in over https, or through kubectl port-forward on localhost",
      );
    const at = now();
    failures = failures.filter((time) => at - time < 60_000);
    if (failures.length >= SIGN_IN_FAILURES_PER_MINUTE)
      throw new AdminError(
        429,
        "RATE_LIMITED",
        "Too many failed sign-ins; try again in a minute",
      );
    const body = await readJson(request);
    const principal = auth.signIn(body);
    if (!principal) {
      failures.push(at);
      audit(actorFor(null, address), "sign-in", "", "refused");
      throw new AdminError(401, "UNAUTHORIZED", "That token is not right");
    }
    const id = randomToken();
    const hash = sha256(id);
    const created: Session = {
      principal,
      csrf: randomToken(),
      expires: at + admin.sessionMs,
      short: hash.slice(0, 8),
    };
    // Expired sessions go whenever someone signs in.
    for (const [key, value] of sessions)
      if (value.expires <= at) sessions.delete(key);
    sessions.set(hash, created);
    audit(actorFor(created, address), "sign-in", principal.role, "ok");
    const cookie = [
      `${COOKIE}=${id}`,
      "HttpOnly",
      "SameSite=Strict",
      "Path=/admin",
      `Max-Age=${Math.floor(admin.sessionMs / 1000)}`,
      ...(isLoopback(host) ? [] : ["Secure"]),
    ].join("; ");
    return respond(sessionBody(created), 200, { "Set-Cookie": cookie });
  }

  const sessionBody = (found: Session) => ({
    subject: found.principal.subject,
    role: found.principal.role,
    csrf: found.csrf,
  });

  function row(userId: string, workspaceId: string): WorkspaceRow {
    const lower = workspaceId.toLowerCase();
    if (!USER_ID.test(userId) || !WORKSPACE_ID.test(lower))
      throw new AdminError(404, "NOT_FOUND", "No such workspace");
    const found = store.workspace(userId, lower);
    if (!found) throw new AdminError(404, "NOT_FOUND", "No such workspace");
    return found;
  }

  function adminWorkspace(
    found: WorkspaceRow,
    usage: WorkspaceUsage | undefined,
    readFailed: boolean,
  ): AdminWorkspace {
    const runnerOnline = relay.isOnline(
      found.userId,
      runnerDevice(found.workspaceId),
    );
    let status: AdminWorkspaceStatus;
    let reason: string | null;
    if (readFailed && !found.sleeping) {
      status = "unknown";
      reason = "The cluster could not be read";
    } else
      ({ status, reason } = workspaceStatus(
        found,
        found.sleeping ? null : (usage?.pod ?? null),
        runnerOnline,
      ));
    const { asleepMs } = config.retention;
    let collectAt: string | null = null;
    let daysUntilCollection: number | null = null;
    if (found.sleeping && found.sleptAt && asleepMs > 0) {
      const at = Date.parse(found.sleptAt) + asleepMs;
      collectAt = new Date(at).toISOString();
      daysUntilCollection = Math.max(0, Math.floor((at - now()) / DAY_MS));
    }
    const disk = usage?.disk ?? [];
    return {
      workspaceId: found.workspaceId,
      name: found.name,
      status,
      reason,
      runnerOnline,
      createdAt: found.createdAt,
      lastActiveAt: found.lastActiveAt,
      sleptAt: found.sleptAt,
      collectAt,
      daysUntilCollection,
      disk: disk.map(({ name, size }) => ({ name, size })),
      diskBytes: disk.reduce(
        (sum, volume) => sum + (parseQuantity(volume.size) ?? 0),
        0,
      ),
      resources: found.sleeping ? null : controller.resources(found),
    };
  }

  async function overview(): Promise<AdminOverview> {
    const byStatus: Record<AdminWorkspaceStatus, number> = {
      running: 0,
      sleeping: 0,
      starting: 0,
      failed: 0,
      unknown: 0,
    };
    let diskBytes = 0;
    let cpuRequested = 0;
    let memoryRequestedBytes = 0;
    const users = await Promise.all(
      store.allUsers().map(async (user): Promise<AdminUser> => {
        const rows = store.workspaces(user.id);
        let usage = new Map<string, WorkspaceUsage>();
        let error: string | null = null;
        if (rows.length)
          try {
            usage = await controller.usage(user.id);
          } catch (failure) {
            log(
              `Reading ${user.id}'s pods and volumes failed: ${String(failure)}`,
            );
            error = "The cluster could not be read for this user";
          }
        return {
          id: user.id,
          email: user.email,
          createdAt: user.createdAt,
          limit: workspaces.limitFor(user.id),
          limitOverride: user.maxWorkspaces,
          error,
          workspaces: rows.map((found) =>
            adminWorkspace(found, usage.get(found.workspaceId), error !== null),
          ),
        };
      }),
    );
    for (const user of users)
      for (const workspace of user.workspaces) {
        byStatus[workspace.status] += 1;
        diskBytes += workspace.diskBytes;
        if (workspace.resources) {
          cpuRequested += parseQuantity(workspace.resources.cpu.request) ?? 0;
          memoryRequestedBytes +=
            parseQuantity(workspace.resources.memory.request) ?? 0;
        }
      }
    return {
      generatedAt: new Date(now()).toISOString(),
      settings: {
        asleepDays: config.retention.asleepMs / DAY_MS,
        defaultLimit: config.maxWorkspaces,
        idleMinutes: config.workspace.idleMinutes,
        collectMinutes: config.collectMs / 60_000,
      },
      opencostUrl: admin.opencostUrl || null,
      summary: {
        users: users.length,
        workspaces: users.reduce(
          (sum, user) => sum + user.workspaces.length,
          0,
        ),
        byStatus,
        diskBytes,
        cpuRequested,
        memoryRequestedBytes,
      },
      users,
    };
  }

  /**
   * Runs a workspace action and audits it. The answer is only `ok`: the
   * user routes' views carry the runner key, which the page never gets.
   */
  async function act(
    actor: Actor,
    action: string,
    target: string,
    run: () => Promise<Response>,
  ): Promise<Response> {
    try {
      await run();
    } catch (error) {
      const failure =
        error instanceof AdminError ? error : workspaces.kubeFailure(error);
      audit(actor, action, target, "failed", failure.code);
      throw failure;
    }
    audit(actor, action, target, "ok");
    return respond({ ok: true });
  }

  async function route(
    request: Request,
    server: Server<unknown>,
  ): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    const host = request.headers.get("Host") ?? "";
    if (!allowedHost(host))
      throw new AdminError(421, "MISDIRECTED", "Unknown host");
    const address = server.requestIP(request)?.address ?? "";

    if (method === "GET") {
      if (path === "/favicon.ico")
        return new Response(null, { status: 204, headers: SECURITY_HEADERS });
      if (path === "/admin") return Response.redirect("/admin/", 302);
      if (path === "/admin/")
        return asset(PAGE_HTML, "text/html; charset=utf-8");
      if (path === "/admin/admin.js")
        return asset(clientScript, "text/javascript; charset=utf-8");
      if (path === "/admin/admin.css")
        return asset(pageCss, "text/css; charset=utf-8");
    }
    if (!path.startsWith("/admin/api/"))
      throw new AdminError(404, "NOT_FOUND", "No such route");

    if (path === "/admin/api/login" && method === "POST") {
      checkWrite(request, url, null);
      return signIn(request, url, address);
    }

    const found = session(request);
    if (!found) throw new AdminError(401, "UNAUTHORIZED", "Sign in");
    const actor = actorFor(found, address);
    if (method !== "GET") checkWrite(request, url, found);

    if (path === "/admin/api/session" && method === "GET")
      return respond(sessionBody(found));
    if (path === "/admin/api/logout" && method === "POST") {
      sessions.delete(sha256(cookieValue(request, COOKIE) ?? ""));
      audit(actor, "sign-out", "", "ok");
      return respond({ ok: true }, 200, {
        "Set-Cookie": `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=0`,
      });
    }
    if (path === "/admin/api/overview" && method === "GET")
      return respond(await overview());
    if (path === "/admin/api/audit" && method === "GET") {
      const limit = Number(url.searchParams.get("limit") ?? "100");
      const count = Number.isInteger(limit)
        ? Math.min(Math.max(limit, 1), 1000)
        : 100;
      return respond({ entries: store.auditLog(count) });
    }

    const workspaceMatch =
      /^\/admin\/api\/users\/([^/]+)\/workspaces\/([^/]+)(?:\/(sleep|wake))?$/.exec(
        path,
      );
    const limitMatch = /^\/admin\/api\/users\/([^/]+)\/limit$/.exec(path);
    const writes =
      (workspaceMatch &&
        ((workspaceMatch[3] && method === "POST") ||
          (!workspaceMatch[3] && method === "DELETE"))) ||
      (limitMatch && method === "PUT");
    if (!writes) throw new AdminError(404, "NOT_FOUND", "No such route");

    const target = workspaceMatch
      ? `${workspaceMatch[1]}/${workspaceMatch[2]}`
      : `${limitMatch![1]}`;
    const action = workspaceMatch
      ? (workspaceMatch[3] ?? "delete")
      : "set-limit";
    if (found.principal.role !== "admin") {
      audit(actor, action, target, "forbidden");
      throw new AdminError(403, "FORBIDDEN", "Your role may only read");
    }

    if (workspaceMatch) {
      const userId = workspaceMatch[1]!;
      const workspaceId = workspaceMatch[2]!;
      if (action === "delete") {
        const { confirm } = await readJson(request);
        const confirmed =
          typeof confirm === "string" &&
          confirm.trim().toLowerCase() === workspaceId.toLowerCase();
        if (!confirmed) {
          audit(actor, action, target, "failed", "not confirmed");
          throw new AdminError(
            400,
            "VALIDATION",
            "Type the workspace id to confirm the delete",
          );
        }
      }
      return act(actor, action, target, async () => {
        const current = row(userId, workspaceId);
        if (action === "sleep") {
          // Sleeping again would restart the collection clock.
          if (current.sleeping)
            throw new AdminError(
              409,
              "CONFLICT",
              "The workspace is asleep already",
            );
          return workspaces.sleep(current);
        }
        if (action === "wake") return workspaces.wake(current);
        return workspaces.remove(current);
      });
    }

    const userId = limitMatch![1]!;
    const { maxWorkspaces } = await readJson(request);
    if (
      maxWorkspaces !== null &&
      !(
        typeof maxWorkspaces === "number" &&
        Number.isInteger(maxWorkspaces) &&
        maxWorkspaces >= 0 &&
        maxWorkspaces <= MAX_LIMIT
      )
    )
      throw new AdminError(
        400,
        "VALIDATION",
        `maxWorkspaces must be a whole number from 0 to ${MAX_LIMIT}, or null`,
      );
    const before = USER_ID.test(userId) ? store.maxWorkspaces(userId) : null;
    if (
      !USER_ID.test(userId) ||
      !store.setMaxWorkspaces(userId, maxWorkspaces)
    ) {
      audit(actor, action, target, "failed", "NOT_FOUND");
      throw new AdminError(404, "NOT_FOUND", "No such user");
    }
    audit(
      actor,
      action,
      target,
      "ok",
      `${before ?? "default"} -> ${maxWorkspaces ?? "default"}`,
    );
    return respond({
      limit: workspaces.limitFor(userId),
      limitOverride: maxWorkspaces,
    });
  }

  return {
    maxRequestBodySize: 16 * 1024,
    async fetch(request: Request, server: Server<unknown>) {
      try {
        return await route(request, server);
      } catch (error) {
        let status: number;
        let code: string;
        let message: string;
        if (error instanceof AdminError) ({ status, code, message } = error);
        else if (error instanceof HttpError) {
          code = error.code;
          status = STATUS_FOR_CODE[code] ?? 500;
          message = error.message;
        } else {
          log(`Admin request failed: ${String(error)}`);
          status = 500;
          code = "INTERNAL";
          message = "The gateway failed";
        }
        return respond({ error: { code, message } }, status);
      }
    },
  };
}
