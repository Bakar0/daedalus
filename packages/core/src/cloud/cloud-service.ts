import type {
  CloudWorkspace,
  CloudWorkspaceStatus,
  DeviceIdentity,
  GatewayUser,
  RunnerMethod,
  RunnerMethods,
} from "@daedalus/remote-protocol";
import type { DaedalusConfig } from "../config";
import { DaedalusError } from "../errors";
import type { SqliteRepositories } from "../repositories";
import { CloudCalls, cloudDaedal } from "../services/cloud-calls";
import { cloudHostId, cloudHostWorkspace } from "../services/cloud-launch";
import { defaultVault, RemoteStore } from "../services/remote-store";
import type { SessionHosts } from "../services/session-hosts";
import type { WorkspaceService } from "../services/workspaces";
import { BrokerTransport, brokerAvailable, serveBroker } from "./broker";
import { CloudAccount } from "./cloud-account";
import { GatewayClient } from "./gateway-client";
import {
  CloudLink,
  type ConnectRelay,
  type RunnerTerminalChannel,
  type RunnerTerminalEvents,
  type RunnerTransport,
} from "./link";
import { RemoteSessionHost } from "./remote-session-host";

/** How long a command that opened its own link waits for a runner. */
const RUNNER_WAIT_MS = 20_000;
/** How long a wake keeps trying while the old pod is still going. */
const WAKE_RETRY_MS = 30_000;

/** How long a wake for a session waits for the new pod's runner. */
const WAKE_RUNNER_MS = 180_000;

export type CloudConnection = "signed-out" | "connecting" | "online" | "error";

/** A cloud workspace made from a local one, without its runner key. */
export interface LinkedCloudWorkspace {
  /** The local workspace. */
  workspaceId: string;
  cloudId: string;
  status: CloudWorkspaceStatus;
  runnerOnline: boolean;
  reason: string | null;
}

/**
 * What a window shows of the sign-in: never the token, the runner keys or
 * the pins.
 */
export interface CloudOverview {
  gatewayUrl: string | null;
  email: string | null;
  connection: CloudConnection;
  /** Why the gateway could not be read, in words for the user. */
  error: string | null;
  workspaces: LinkedCloudWorkspace[];
}

export interface CloudServiceOptions {
  config: DaedalusConfig;
  repositories: SqliteRepositories;
  workspaces: WorkspaceService;
  hosts: SessionHosts;
  /** The Mac's own `daedal`, for answering calls from pods. */
  daedal?: string[];
  connect?: ConnectRelay;
  fetch?: typeof fetch;
  account?: CloudAccount;
  identity?: () => Promise<DeviceIdentity>;
  log?: (event: string, fields?: Record<string, unknown>) => void;
}

/**
 * Cloud workspaces on this Mac: the gateway sign-in, the workspaces made
 * from local ones, and the hosts their sessions run on.
 *
 * Exactly one process holds the relay link. The app calls `hold` at launch
 * and serves the others through the broker; a command run while the app is
 * closed opens a link of its own for as long as it runs.
 */
export class CloudService {
  readonly account: CloudAccount;
  #link: CloudLink | undefined;
  #transport: Promise<RunnerTransport> | undefined;
  #stopBroker: (() => Promise<void>) | undefined;
  #identity: Promise<DeviceIdentity> | undefined;
  /** Set once `hold` was called: this process is the app. */
  #holder = false;

  constructor(private readonly options: CloudServiceOptions) {
    this.account = options.account ?? new CloudAccount(options.config.home);
    options.hosts.resolveWith((hostId) => {
      const workspaceId = cloudHostWorkspace(hostId);
      return workspaceId
        ? new RemoteSessionHost(workspaceId, this.#lazyTransport())
        : undefined;
    });
  }

  /** The Mac's device identity, the one the phone pairs with. */
  identity(): Promise<DeviceIdentity> {
    this.#identity ??= this.options.identity
      ? this.options.identity()
      : RemoteStore.open(
          this.options.config.home,
          defaultVault(this.options.config.home) ?? null,
        ).then((store) => store.identity);
    return this.#identity;
  }

  async #client(): Promise<GatewayClient> {
    const signIn = await this.account.requireSignIn();
    return new GatewayClient(
      signIn.gatewayUrl,
      signIn.token,
      this.options.fetch,
    );
  }

  /** Signs in with the gateway's dev login, which only a dev chart enables. */
  async devLogin(gatewayUrl: string, email: string): Promise<GatewayUser> {
    const client = new GatewayClient(gatewayUrl, undefined, this.options.fetch);
    const { user, token } = await client.devLogin(email);
    await this.account.save({ gatewayUrl: client.url, user, token });
    return user;
  }

  /**
   * The app's sign-in: the dev login, then the link opened again for the
   * new account, which the app holds for every process.
   */
  async signIn(gatewayUrl: string, email: string): Promise<GatewayUser> {
    const user = await this.devLogin(gatewayUrl, email);
    if (this.#holder) {
      this.close();
      await this.hold();
    }
    return user;
  }

  /**
   * The sign-in, the link's state and the cloud workspaces made from local
   * ones. One gateway request; a failed one is reported, not thrown.
   */
  async overview(): Promise<CloudOverview> {
    const signIn = await this.account.signIn();
    if (!signIn)
      return {
        gatewayUrl: null,
        email: null,
        connection: "signed-out",
        error: null,
        workspaces: [],
      };
    const base = { gatewayUrl: signIn.gatewayUrl, email: signIn.user.email };
    let listed: CloudWorkspace[];
    try {
      listed = await this.list();
    } catch (error) {
      return {
        ...base,
        connection: "error",
        error: error instanceof Error ? error.message : String(error),
        workspaces: [],
      };
    }
    const workspaces: LinkedCloudWorkspace[] = [];
    for (const item of listed) {
      const workspaceId = this.options.repositories.workspaceForCloud(
        item.workspaceId,
      );
      if (!workspaceId) continue;
      workspaces.push({
        workspaceId,
        cloudId: item.workspaceId,
        status: item.status,
        runnerOnline: item.runnerOnline,
        reason: item.reason,
      });
    }
    return {
      ...base,
      // Without a link of its own (the CLI), an answer is as online as it gets.
      connection: this.#link && !this.#link.connected ? "connecting" : "online",
      error: null,
      workspaces,
    };
  }

  /**
   * Wakes a workspace and waits until its runner is linked to this Mac, so a
   * session can be revived in it right away.
   */
  async wakeForSessions(workspaceReference: string): Promise<CloudWorkspace> {
    const woken = await this.wake(workspaceReference);
    const workspaceId = woken.workspaceId;
    if (this.#link) {
      if (!(await this.#link.waitForRunner(workspaceId, WAKE_RUNNER_MS)))
        throw new DaedalusError(
          "DEPENDENCY",
          "The cloud workspace woke, but its runner did not connect in time; try again in a minute",
        );
      return woken;
    }
    const client = await this.#client();
    const deadline = Date.now() + WAKE_RUNNER_MS;
    for (let current = woken; ;) {
      if (current.runnerOnline) return current;
      if (current.status === "failed")
        throw new DaedalusError(
          "DEPENDENCY",
          current.reason ?? "The cloud workspace failed to start",
        );
      if (Date.now() > deadline)
        throw new DaedalusError(
          "DEPENDENCY",
          "The cloud workspace woke, but its runner did not connect in time; try again in a minute",
        );
      await Bun.sleep(1_000);
      current = await client.getWorkspace(workspaceId);
    }
  }

  async logout(): Promise<void> {
    this.close();
    await this.account.forget();
  }

  async status(): Promise<{ gatewayUrl: string; user: GatewayUser } | null> {
    const signIn = await this.account.signIn();
    if (!signIn) return null;
    const user = await new GatewayClient(
      signIn.gatewayUrl,
      signIn.token,
      this.options.fetch,
    ).me();
    return { gatewayUrl: signIn.gatewayUrl, user };
  }

  /**
   * Makes a cloud workspace of a local one, with a pod of its own. The gateway
   * names it by a UUID of its own, which this Mac links to the local one.
   */
  async create(
    workspaceReference: string,
    resources?: { cpu?: string; memory?: string },
  ): Promise<CloudWorkspace> {
    const workspace =
      await this.options.workspaces.getActive(workspaceReference);
    const identity = await this.identity();
    const { repositories } = this.options;
    const cloudId =
      repositories.cloudWorkspaceId(workspace.id) ?? crypto.randomUUID();
    const created = await (
      await this.#client()
    ).createWorkspace({
      workspaceId: cloudId,
      name: workspace.name,
      macId: identity.id,
      macKey: identity.publicKey,
      ...(resources ? { resources } : {}),
    });
    if (!repositories.cloudWorkspaceId(workspace.id))
      repositories.linkCloudWorkspace(workspace.id, cloudId);
    return created;
  }

  async list(): Promise<CloudWorkspace[]> {
    return (await this.#client()).listWorkspaces();
  }

  async get(workspaceReference: string): Promise<CloudWorkspace> {
    return (await this.#client()).getWorkspace(
      await this.#workspaceId(workspaceReference),
    );
  }

  /**
   * Wakes a workspace. Right after a sleep the gateway answers CONFLICT until
   * the old pod is gone, so that is retried with backoff for up to 30 seconds.
   */
  async wake(workspaceReference: string): Promise<CloudWorkspace> {
    const client = await this.#client();
    const workspaceId = await this.#workspaceId(workspaceReference);
    const deadline = Date.now() + WAKE_RETRY_MS;
    for (let delay = 250; ; delay = Math.min(delay * 2, 4_000)) {
      try {
        return await client.wakeWorkspace(workspaceId);
      } catch (error) {
        if (
          !(error instanceof DaedalusError) ||
          error.details?.gatewayCode !== "CONFLICT" ||
          Date.now() + delay > deadline
        )
          throw error;
        await Bun.sleep(delay);
      }
    }
  }

  /**
   * Puts a workspace to sleep. Its pod goes, and every session running in it
   * with it; their conversations stay on the volume, and a revive after the
   * workspace wakes resumes them.
   */
  async sleep(workspaceReference: string): Promise<CloudWorkspace> {
    const workspaceId = await this.#workspaceId(workspaceReference);
    const result = await (await this.#client()).sleepWorkspace(workspaceId);
    this.#endSessions(workspaceId, "lost", "The cloud workspace went to sleep");
    return result;
  }

  /** Deletes the pod, its volume and its token; the local workspace stays. */
  async delete(workspaceReference: string): Promise<void> {
    const workspaceId = await this.#workspaceId(workspaceReference);
    await (await this.#client()).deleteWorkspace(workspaceId);
    this.#endSessions(workspaceId, "exited");
    await this.account.unpin(workspaceId);
    this.options.repositories.unlinkCloudWorkspace(workspaceId);
    this.options.hosts.unregister(cloudHostId(workspaceId));
  }

  #endSessions(
    cloudId: string,
    status: "lost" | "exited",
    lostReason?: string,
  ): void {
    const hostId = cloudHostId(cloudId);
    const workspaceId = this.options.repositories.workspaceForCloud(cloudId);
    if (!workspaceId) return;
    const now = new Date().toISOString();
    this.options.repositories.transaction(() => {
      for (const session of this.options.repositories.listAgents({
        workspaceId,
      }))
        if (
          session.hostId === hostId &&
          (session.status === "running" || session.status === "starting")
        )
          this.options.repositories.updateAgent({
            ...session,
            status,
            endedAt: now,
            lostReason: lostReason ?? null,
          });
    });
  }

  /** The host a local workspace's cloud sessions run on. */
  async hostId(workspaceReference: string): Promise<string> {
    const workspace =
      await this.options.workspaces.getActive(workspaceReference);
    return cloudHostId(await this.#workspaceId(workspace.id));
  }

  /** The cloud id of a local workspace, or a cloud id given as it is. */
  async #workspaceId(reference: string): Promise<string> {
    // A workspace removed on this Mac can still be deleted in the cloud.
    if (
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        reference,
      )
    )
      return reference.toLowerCase();
    const workspace = await this.options.workspaces.get(reference);
    const cloudId = this.options.repositories.cloudWorkspaceId(workspace.id);
    if (!cloudId)
      throw new DaedalusError(
        "NOT_FOUND",
        `Workspace '${workspace.name}' has no cloud workspace; run 'daedal cloud create'`,
      );
    return cloudId;
  }

  /**
   * The runner key this Mac accepts a workspace's runner with: the pinned
   * one, else the one the gateway reports, which is pinned from then on.
   */
  async #runnerKey(workspaceId: string): Promise<string | undefined> {
    const pinned = await this.account.pinned(workspaceId);
    if (pinned) return pinned;
    const workspace = await (
      await this.#client()
    )
      .getWorkspace(workspaceId)
      .catch(() => undefined);
    if (!workspace?.runnerKey) return undefined;
    await this.account.pin(workspaceId, workspace.runnerKey);
    return workspace.runnerKey;
  }

  async #openLink(): Promise<CloudLink> {
    const signIn = await this.account.requireSignIn();
    const calls = new CloudCalls({
      repositories: this.options.repositories,
      home: this.options.config.home,
      daedal: this.options.daedal ?? cloudDaedal(this.options.config.home),
    });
    const link = new CloudLink({
      gatewayUrl: signIn.gatewayUrl,
      token: signIn.token,
      identity: await this.identity(),
      runnerKey: (workspaceId) => this.#runnerKey(workspaceId),
      answer: (hostId, call) => calls.answer(hostId, call),
      ...(this.options.connect ? { connect: this.options.connect } : {}),
      ...(this.options.log ? { log: this.options.log } : {}),
    });
    await link.start();
    this.#link = link;
    return link;
  }

  /**
   * Holds the link for every process on this Mac: the app's job. Registers a
   * host for each cloud workspace so reconcile and revive cover them.
   */
  async hold(): Promise<boolean> {
    this.#holder = true;
    if (!(await this.account.signIn())) return false;
    const link = this.#link ?? (await this.#openLink());
    this.#transport = Promise.resolve(link);
    this.#stopBroker ??= await serveBroker(this.options.config.home, link);
    for (const workspace of await this.list().catch(() => []))
      this.options.hosts.find(cloudHostId(workspace.workspaceId));
    return true;
  }

  /** Whether this process holds the link and can open terminals. */
  get holding(): boolean {
    return this.#link !== undefined;
  }

  #lazyTransport(): RunnerTransport {
    const transport = () => {
      this.#transport ??= (async () =>
        (await brokerAvailable(this.options.config.home))
          ? new BrokerTransport(this.options.config.home)
          : await this.#openLink())().catch((error: unknown) => {
        this.#transport = undefined;
        throw error;
      });
      return this.#transport;
    };
    const ready = async (workspaceId: string) => {
      const chosen = await transport();
      // A link this process just opened needs a moment for the runner to
      // answer the Mac coming online.
      if (chosen instanceof CloudLink)
        await chosen.waitForRunner(workspaceId, RUNNER_WAIT_MS);
      return chosen;
    };
    return {
      unavailable: async (workspaceId) => {
        try {
          return await (await ready(workspaceId)).unavailable(workspaceId);
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      },
      request: async <M extends RunnerMethod>(
        workspaceId: string,
        method: M,
        params: RunnerMethods[M]["params"],
        timeoutMs?: number,
      ) =>
        (await ready(workspaceId)).request(
          workspaceId,
          method,
          params,
          timeoutMs,
        ),
      openTerminal: (
        workspaceId: string,
        session: string,
        size: { cols: number; rows: number },
        events: RunnerTerminalEvents,
      ): RunnerTerminalChannel => {
        if (!this.#link)
          throw new DaedalusError(
            "DEPENDENCY",
            "Cloud terminals open in the Daedalus app",
          );
        return this.#link.openTerminal(workspaceId, session, size, events);
      },
    };
  }

  close(): void {
    this.#link?.stop();
    this.#link = undefined;
    this.#transport = undefined;
    void this.#stopBroker?.();
    this.#stopBroker = undefined;
  }
}
