import type { Server, WebSocketHandler } from "bun";
import type {
  CloudWorkspace,
  CreateWorkspaceRequest,
  GatewayErrorCode,
  GatewayUser,
} from "@daedalus/remote-protocol";
import type { GatewayConfig } from "./config";
import { Controller, namespaceFor, workspaceStatus } from "./controller";
import { KubeError } from "./kube";
import { parseQuantity } from "./quantity";
import {
  MAX_FRAME_BYTES,
  macDevice,
  runnerDevice,
  type Peer,
  type Relay,
} from "./relay";
import {
  randomToken,
  type Store,
  type TokenOwner,
  type WorkspaceRow,
} from "./store";

/**
 * The gateway's HTTP and WebSocket routes, as
 * packages/remote-protocol/src/gateway.ts lays them out. Every route works
 * on the caller's own rows only; another user's workspace is looked up with
 * the caller's id and so is simply not found.
 */

/** What one collection pass deleted. */
export interface CollectResult {
  workspaces: string[];
  namespaces: string[];
}

/** The last collection pass, for the admin page. */
export interface CollectionRecord {
  at: string;
  workspaces: number;
  namespaces: number;
  failures: number;
}

/** How often relay traffic may update a workspace's last active time. */
export const ACTIVITY_WRITE_MS = 60_000;

export interface GatewayDeps {
  config: GatewayConfig;
  store: Store;
  controller: Controller;
  relay: Relay;
  log?: (message: string) => void;
}

export class HttpError extends Error {
  constructor(
    readonly code: GatewayErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const STATUS: Record<GatewayErrorCode, number> = {
  VALIDATION: 400,
  UNAUTHORIZED: 401,
  NOT_FOUND: 404,
  CONFLICT: 409,
  QUOTA: 429,
  INTERNAL: 500,
};

export const errorResponse = (code: GatewayErrorCode, message: string) =>
  Response.json({ error: { code, message } }, { status: STATUS[code] });

export const notFound = () => new HttpError("NOT_FOUND", "No such workspace");
const unauthorized = () =>
  new HttpError("UNAUTHORIZED", "Sign in to the gateway");

const WORKSPACE_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Device ids: 16 random bytes in base64url, as apps/relay's. */
const MAC_ID = /^[A-Za-z0-9_-]{8,64}$/;
/** A 32-byte public key in base64, either alphabet, padded or not. */
const KEY = /^[A-Za-z0-9+/_-]{43}=?$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Macs one user may have connected at once. */
const MAX_MACS = 10;

const isKey = (value: unknown): value is string =>
  typeof value === "string" &&
  KEY.test(value) &&
  Buffer.from(value, "base64").length === 32;

function bearer(request: Request): string | undefined {
  const header = request.headers.get("Authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : undefined;
}

export async function readJson(
  request: Request,
): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new HttpError("VALIDATION", "The body is not JSON");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body))
    throw new HttpError("VALIDATION", "The body must be a JSON object");
  return body as Record<string, unknown>;
}

function parseCreate(
  body: Record<string, unknown>,
  max: GatewayConfig["workspace"]["max"],
): CreateWorkspaceRequest {
  const { workspaceId, name, macId, macKey, resources } = body;
  if (
    typeof workspaceId !== "string" ||
    !WORKSPACE_ID.test(workspaceId.toLowerCase())
  )
    throw new HttpError("VALIDATION", "workspaceId must be a UUID");
  if (typeof name !== "string" || !name.trim() || name.length > 200)
    throw new HttpError("VALIDATION", "name must be 1 to 200 characters");
  if (typeof macId !== "string" || !MAC_ID.test(macId))
    throw new HttpError("VALIDATION", "macId is not a device id");
  if (!isKey(macKey))
    throw new HttpError("VALIDATION", "macKey must be a 32-byte key in base64");
  const parsed: CreateWorkspaceRequest = {
    workspaceId: workspaceId.toLowerCase(),
    name: name.trim(),
    macId,
    macKey,
  };
  if (resources !== undefined) {
    if (typeof resources !== "object" || resources === null)
      throw new HttpError("VALIDATION", "resources must be an object");
    const { cpu, memory } = resources as Record<string, unknown>;
    // Zero would be read as no limit at all, so it is refused too.
    for (const [label, value, most] of [
      ["cpu", cpu, max.cpu],
      ["memory", memory, max.memory],
    ] as const) {
      if (value === undefined) continue;
      const amount = typeof value === "string" ? parseQuantity(value) : null;
      if (amount === null || amount <= 0 || amount > most)
        throw new HttpError(
          "VALIDATION",
          `resources.${label} must be a quantity above 0 and at most the cluster's maximum`,
        );
    }
    parsed.resources = {
      ...(typeof cpu === "string" ? { cpu } : {}),
      ...(typeof memory === "string" ? { memory } : {}),
    };
  }
  return parsed;
}

export function createGateway(deps: GatewayDeps) {
  const { config, store, controller, relay } = deps;
  const log = deps.log ?? ((message: string) => console.error(message));

  // Relay traffic marks the workspace in use, written at most once a minute.
  const lastWrite = new Map<string, number>();
  relay.onActivity = (userId, workspaceId) => {
    const key = `${userId}/${workspaceId}`;
    const now = Date.now();
    if (now - (lastWrite.get(key) ?? 0) < ACTIVITY_WRITE_MS) return;
    lastWrite.set(key, now);
    store.touch(userId, workspaceId, new Date(now));
  };

  /**
   * The user's workspace limit: the admin's override, else the default. An
   * override can only lower it: the chart sizes the tenant's volume quota
   * for the default, so a higher one could not be used.
   */
  const limitFor = (userId: string) =>
    Math.min(
      store.maxWorkspaces(userId) ?? config.maxWorkspaces,
      config.maxWorkspaces,
    );

  /** Turns a Kubernetes failure into the contract's error codes. */
  function kubeFailure(error: unknown): HttpError {
    if (error instanceof HttpError) return error;
    if (error instanceof KubeError) {
      if (error.isQuota) return new HttpError("QUOTA", error.message);
      if (error.isTerminating)
        return new HttpError(
          "CONFLICT",
          "Your previous workspaces are still being removed; try again shortly",
        );
      if (error.status === 409)
        return new HttpError(
          "CONFLICT",
          "The workspace is still stopping; try again shortly",
        );
    }
    const message = error instanceof Error ? error.message : String(error);
    log(`Request failed: ${message}`);
    return new HttpError(
      "INTERNAL",
      error instanceof KubeError
        ? "The cluster refused the request"
        : "The gateway failed",
    );
  }

  async function view(row: WorkspaceRow): Promise<CloudWorkspace> {
    const runnerOnline = relay.isOnline(
      row.userId,
      runnerDevice(row.workspaceId),
    );
    const pod = row.sleeping ? null : await controller.pod(row);
    const { status, reason } = workspaceStatus(row, pod, runnerOnline);
    return {
      workspaceId: row.workspaceId,
      name: row.name,
      status,
      reason,
      runnerOnline,
      runnerKey: row.runnerKey,
      createdAt: row.createdAt,
      sleptAt: row.sleptAt,
    };
  }

  function own(userId: string, workspaceId: string): WorkspaceRow {
    const row = store.workspace(userId, workspaceId.toLowerCase());
    if (!row) throw notFound();
    return row;
  }

  async function create(userId: string, request: CreateWorkspaceRequest) {
    const row: WorkspaceRow = {
      userId,
      workspaceId: request.workspaceId,
      name: request.name,
      macId: request.macId,
      macKey: request.macKey,
      cpu: request.resources?.cpu ?? null,
      memory: request.resources?.memory ?? null,
      runnerKey: null,
      sleeping: false,
      sleptAt: null,
      lastActiveAt: null,
      createdAt: new Date().toISOString(),
    };
    const limit = limitFor(userId);
    if (store.workspaces(userId).length >= limit)
      throw new HttpError("QUOTA", `You may have at most ${limit} workspaces`);
    const token = randomToken();
    if (!store.insertWorkspace(row, token))
      throw new HttpError(
        "CONFLICT",
        "You already have a workspace with this id",
      );
    try {
      await controller.ensureTenant(userId);
      await controller.createVolumes(row);
      await controller.writeToken(row, token);
      await controller.startPod(row);
    } catch (error) {
      await controller
        .deleteWorkspace(row)
        .catch((cleanup: unknown) =>
          log(`Cleaning up a failed create: ${String(cleanup)}`),
        );
      store.deleteWorkspace(userId, row.workspaceId);
      throw kubeFailure(error);
    }
    return Response.json(await view(row), { status: 201 });
  }

  async function wake(row: WorkspaceRow) {
    const pod = row.sleeping ? null : await controller.pod(row);
    if (pod && !pod.failure) return Response.json(await view(row));
    // A pod that cannot recover is replaced; a missing one is recreated.
    if (pod) await controller.stopPod(row);
    // Every pod start gets a new runner token, so a token copied out of an
    // earlier pod is useless from here on.
    relay.kick(row.userId, runnerDevice(row.workspaceId), "Token replaced");
    const token = randomToken();
    store.replaceRunnerToken(row.userId, row.workspaceId, token);
    await controller.writeToken(row, token);
    await controller.startPod(row);
    store.setSleeping(row.userId, row.workspaceId, false);
    store.touch(row.userId, row.workspaceId);
    return Response.json(await view({ ...row, sleeping: false }));
  }

  async function sleep(row: WorkspaceRow) {
    store.setSleeping(row.userId, row.workspaceId, true);
    await controller.stopPod(row);
    // No runner token exists while the workspace sleeps.
    store.revokeRunnerToken(row.userId, row.workspaceId);
    await controller.deleteToken(row);
    relay.kick(row.userId, runnerDevice(row.workspaceId), "Workspace asleep");
    return Response.json(await view({ ...row, sleeping: true }));
  }

  async function remove(row: WorkspaceRow) {
    await controller.deleteWorkspace(row);
    store.deleteWorkspace(row.userId, row.workspaceId);
    relay.kick(row.userId, runnerDevice(row.workspaceId), "Workspace deleted");
    if (store.workspaces(row.userId).length === 0)
      await controller.deleteTenant(row.userId);
    return new Response(null, { status: 204 });
  }

  function connect(
    request: Request,
    url: URL,
    owner: TokenOwner,
    server: Server<Peer>,
  ): Response | undefined {
    let peer: Peer;
    if (owner.kind === "user") {
      const macId = url.searchParams.get("macId") ?? "";
      if (!MAC_ID.test(macId))
        throw new HttpError("VALIDATION", "macId is not a device id");
      peer = { role: "mac", userId: owner.userId, deviceId: macDevice(macId) };
      if (
        !relay.isOnline(owner.userId, peer.deviceId) &&
        relay.macCount(owner.userId) >= MAX_MACS
      )
        throw new HttpError(
          "QUOTA",
          `At most ${MAX_MACS} Macs may be connected at once`,
        );
    } else {
      const runnerKey = url.searchParams.get("runnerKey") ?? "";
      if (!isKey(runnerKey))
        throw new HttpError(
          "VALIDATION",
          "runnerKey must be a 32-byte key in base64",
        );
      const row = own(owner.userId, owner.workspaceId);
      if (!store.pinRunnerKey(owner.userId, owner.workspaceId, runnerKey))
        throw new HttpError(
          "CONFLICT",
          "This workspace's runner connected with a different key before",
        );
      peer = {
        role: "runner",
        userId: owner.userId,
        deviceId: runnerDevice(owner.workspaceId),
        workspaceId: owner.workspaceId,
        macDeviceId: macDevice(row.macId),
      };
    }
    const offered = (request.headers.get("Sec-WebSocket-Protocol") ?? "")
      .split(",")
      .map((value) => value.trim());
    const upgraded = server.upgrade(request, {
      data: peer,
      ...(offered.includes("daedalus.v1")
        ? { headers: { "Sec-WebSocket-Protocol": "daedalus.v1" } }
        : {}),
    });
    if (!upgraded)
      throw new HttpError("VALIDATION", "Expected a WebSocket upgrade");
    return undefined;
  }

  /**
   * `listener` is which port the request came in on. The public one serves
   * users only; the runner one, which only the in-cluster Service exposes,
   * serves runner tokens only, so a runner token taken out of a pod is
   * useless outside the cluster.
   */
  async function route(
    request: Request,
    server: Server<Peer>,
    listener: "public" | "runner",
  ): Promise<Response | undefined> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (path === "/health" && method === "GET") return new Response("ok");

    if (
      path === "/v1/dev/login" &&
      method === "POST" &&
      listener === "public"
    ) {
      if (!config.devLogin) throw new HttpError("NOT_FOUND", "No such route");
      const { email } = await readJson(request);
      if (typeof email !== "string" || email.length > 254 || !EMAIL.test(email))
        throw new HttpError("VALIDATION", "email is not an email address");
      const user = store.userForEmail(email.trim().toLowerCase());
      const token = store.issueUserToken(user.id);
      return Response.json({ user, token });
    }

    const token = bearer(request);
    const owner = token ? store.tokenOwner(token) : null;
    if (!owner) throw unauthorized();
    if ((owner.kind === "runner") !== (listener === "runner"))
      throw unauthorized();

    if (path === "/v1/connect" && method === "GET")
      return connect(request, url, owner, server);

    const match = /^\/v1\/workspaces\/([^/]+)(?:\/(wake|sleep))?$/.exec(path);

    // A runner may only put its own workspace to sleep (when idle).
    if (owner.kind === "runner") {
      if (match?.[2] !== "sleep" || method !== "POST") throw unauthorized();
      if (match[1]!.toLowerCase() !== owner.workspaceId) throw notFound();
      return sleep(own(owner.userId, owner.workspaceId));
    }
    const userId = owner.userId;

    if (path === "/v1/me" && method === "GET") {
      const user = store.user(userId);
      if (!user) throw unauthorized();
      return Response.json({
        id: user.id,
        email: user.email,
      } satisfies GatewayUser);
    }
    if (path === "/v1/workspaces") {
      if (method === "POST")
        return create(
          userId,
          parseCreate(await readJson(request), config.workspace.max),
        );
      if (method === "GET")
        return Response.json({
          workspaces: await Promise.all(store.workspaces(userId).map(view)),
        });
    }
    if (match) {
      const row = own(userId, match[1]!);
      if (match[2] === "wake" && method === "POST") return wake(row);
      if (match[2] === "sleep" && method === "POST") return sleep(row);
      if (!match[2] && method === "GET") return Response.json(await view(row));
      if (!match[2] && method === "DELETE") return remove(row);
    }
    throw new HttpError("NOT_FOUND", "No such route");
  }

  const websocket: WebSocketHandler<Peer> = {
    maxPayloadLength: MAX_FRAME_BYTES,
    open: (socket) => relay.open(socket),
    message: (socket, message) => relay.message(socket, message),
    close: (socket) => relay.close(socket),
  };

  const listen = (listener: "public" | "runner") => ({
    maxRequestBodySize: 64 * 1024,
    async fetch(request: Request, server: Server<Peer>) {
      try {
        return await route(request, server, listener);
      } catch (error) {
        const failure = kubeFailure(error);
        return errorResponse(failure.code, failure.message);
      }
    },
    websocket,
  });

  /** One set of options per port, sharing the one relay. */
  /**
   * One collection pass. A workspace asleep past its retention is deleted
   * as DELETE does, and the namespace of a user with no workspace left
   * goes too. One that fails is logged and tried again next pass.
   */
  let lastCollection: CollectionRecord | null = null;
  async function collect(now = new Date()): Promise<CollectResult> {
    let failures = 0;
    const result = await collectPass(now, () => (failures += 1));
    lastCollection = {
      at: new Date().toISOString(),
      workspaces: result.workspaces.length,
      namespaces: result.namespaces.length,
      failures,
    };
    return result;
  }

  async function collectPass(
    now: Date,
    failed: () => void,
  ): Promise<CollectResult> {
    const { asleepMs } = config.retention;
    const result: CollectResult = { workspaces: [], namespaces: [] };
    for (const row of store.allWorkspaces()) {
      if (!row.sleeping || !row.sleptAt) continue;
      const asleep = now.getTime() - Date.parse(row.sleptAt);
      if (asleepMs <= 0 || asleep < asleepMs) continue;
      try {
        await remove(row);
        result.workspaces.push(row.workspaceId);
        log(
          `Collected workspace ${row.workspaceId}, asleep since ${row.sleptAt}`,
        );
      } catch (error) {
        failed();
        log(`Collecting workspace ${row.workspaceId} failed: ${String(error)}`);
      }
    }
    let tenants: string[];
    try {
      tenants = await controller.tenants();
    } catch (error) {
      failed();
      log(`Listing namespaces to collect failed: ${String(error)}`);
      return result;
    }
    for (const userId of tenants) {
      // Read now, not before the list: a user making a workspace has its
      // record before its namespace.
      if (store.workspaces(userId).length) continue;
      try {
        await controller.deleteTenant(userId);
        result.namespaces.push(namespaceFor(userId));
        log(`Collected namespace ${namespaceFor(userId)}, with no workspace`);
      } catch (error) {
        failed();
        log(`Collecting ${namespaceFor(userId)} failed: ${String(error)}`);
      }
    }
    return result;
  }

  return {
    public: listen("public"),
    runner: listen("runner"),
    collect,
    /** When collection last ran and what it did; null before the first. */
    lastCollection: () => lastCollection,
    /** What the admin page acts with: the same paths the user's routes use. */
    workspaces: { view, wake, sleep, remove, limitFor, kubeFailure },
  };
}
