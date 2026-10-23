import type {
  CloudWorkspace,
  CloudWorkspaceStatus,
  CommandResult,
  DeviceIdentity,
  GatewayUser,
  RunnerMethod,
  RunnerMethods,
} from "@daedalus/remote-protocol";
import type { DaedalusConfig } from "../config";
import { DaedalusError } from "../errors";
import type { CloudOwner, SqliteRepositories } from "../repositories";
import {
  CloudCalls,
  cloudDaedal,
  REFUSED_EXIT_CODE,
  REFUSED_MESSAGE,
} from "../services/cloud-calls";
import { listenForSignIn, type SignInListener } from "./sign-in-callback";
import {
  checkSignInUrl,
  pasteCodeUrl,
  SIGN_IN_OFFER_MS,
  SignInOffers,
} from "./sign-in-pages";
import {
  CLOUD_COLLECTED_REASON,
  CLOUD_SLEEP_REASON,
  cloudHostId,
  cloudHostWorkspace,
} from "../services/cloud-launch";
import { defaultVault, RemoteStore } from "../services/remote-store";
import type { SessionHosts } from "../services/session-hosts";
import type { WorkspaceService } from "../services/workspaces";
import { BrokerTransport, brokerAvailable, serveBroker } from "./broker";
import type { AgentSession } from "../domain";
import type { CloudLaunchExtras } from "../services/agents";
import { CloudAccount, type CloudSignIn } from "./cloud-account";
import { homedir } from "node:os";
import { join } from "node:path";
import { readKeychainPassword } from "@daedalus/platform";
import type { AccountProfile } from "../config";
import {
  accountConfig,
  accountDirectory,
  accountProfile,
} from "../services/account-homes";
import { API_KEY_SERVICE } from "../services/accounts";
import {
  awsSsoCopy,
  CLAUDE_CONSENT_FILE,
  CLOUD_SEED_PATHS,
  seedClaudeConsent,
  mergeAwsConfig,
  seedClaudeSettings,
  seedClaudeState,
  type AwsSsoCopy,
} from "./cloud-seed";
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

/** Claude's footer, and its /login screens, as the pod shows them. */
const LOGIN_METHODS = /Select login method|Claude account with subscription/i;
const CLAUDE_SIGNED_IN = /Login successful|Logged in as/i;
const AWS_SIGNED_IN = /Successfully logged into Start URL/i;
/** How long Claude has to ask for its page after /login. */
const SIGN_IN_START_MS = 45_000;

/** How long a wake for a session waits for the new pod's runner. */
const WAKE_RUNNER_MS = 180_000;

export type CloudConnection = "signed-out" | "connecting" | "online" | "error";

/**
 * Where a workspace's cloud copy stands while a session waits for it:
 * `creating` (the first time), `waking` (it slept), `starting` (its pod is
 * starting and its runner connecting).
 */
export type CloudPreparePhase = "creating" | "waking" | "starting";

export interface CloudPreparing {
  /** The local workspace. */
  workspaceId: string;
  phase: CloudPreparePhase;
}

/** What a launch seeder gets: the pod to write to, and whose launch it is. */
export interface CloudLaunchSeedContext {
  host: RemoteSessionHost;
  session: AgentSession;
  /** The session's Claude account, or undefined for the default one. */
  profile: AccountProfile | undefined;
}

export type CloudLaunchSeeder = (
  context: CloudLaunchSeedContext,
) => Promise<void>;

/** A cloud workspace made from a local one, without its runner key. */
export interface LinkedCloudWorkspace {
  /** The local workspace. */
  workspaceId: string;
  cloudId: string;
  status: CloudWorkspaceStatus;
  runnerOnline: boolean;
  reason: string | null;
  createdAt: string;
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
  /** Injected so tests read no real AWS config or Keychain. */
  awsConfig?: () => Promise<string | undefined>;
  apiKey?: (profile: AccountProfile) => Promise<string | undefined>;
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
  /** Sign-in pages cloud sessions asked to open, waiting for a click. */
  readonly signIns = new SignInOffers();
  readonly #signInListeners = new Set<SignInListener>();
  readonly #preparing = new Map<string, CloudPreparing>();
  readonly #preparingListeners = new Set<() => void>();
  readonly #preparations = new Map<string, Promise<string>>();
  readonly #seeders: CloudLaunchSeeder[] = [];
  #link: CloudLink | undefined;
  #transport: Promise<RunnerTransport> | undefined;
  #stopBroker: (() => Promise<void>) | undefined;
  #identity: Promise<DeviceIdentity> | undefined;
  /** Set once `hold` was called: this process is the app. */
  #holder = false;
  /**
   * Sign-in, sign-out and holding the link run one at a time, so a link one
   * of them opens cannot outlive a sign-out that ran alongside it.
   */
  #queue: Promise<unknown> = Promise.resolve();

  #serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(run, run);
    this.#queue = next.catch(() => undefined);
    return next;
  }

  constructor(private readonly options: CloudServiceOptions) {
    this.account = options.account ?? new CloudAccount(options.config.home);
    options.hosts.resolveWith((hostId) => {
      const workspaceId = cloudHostWorkspace(hostId);
      // Only the signed-in account's workspaces: a session left from another
      // account must not start in this account's pod.
      return workspaceId && options.repositories.workspaceForCloud(workspaceId)
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
    this.#own({ gatewayUrl: signIn.gatewayUrl, userId: signIn.user.id }, true);
    return new GatewayClient(
      signIn.gatewayUrl,
      signIn.token,
      this.options.fetch,
    );
  }

  /** Signs in with the gateway's dev login, which only a dev chart enables. */
  devLogin(gatewayUrl: string, email: string): Promise<GatewayUser> {
    return this.#serial(() => this.#devLogin(gatewayUrl, email));
  }

  async #devLogin(gatewayUrl: string, email: string): Promise<GatewayUser> {
    const client = new GatewayClient(gatewayUrl, undefined, this.options.fetch);
    const { user, token } = await client.devLogin(email);
    // The old link goes before the new account is saved: until then it
    // would read the new account's pins and token.
    await this.#closeLink();
    const previous = await this.account.signIn();
    await this.account.save({ gatewayUrl: client.url, user, token });
    this.#own(
      { gatewayUrl: client.url, userId: user.id },
      previous?.gatewayUrl === client.url && previous.user.id === user.id,
    );
    return user;
  }

  /**
   * Makes an account the one whose cloud links count. Another account's
   * links stay in the database, unused, and come back when it signs in
   * again. Links from before links had an account go to the account this Mac
   * was already signed in to.
   */
  #own(owner: CloudOwner, sameAccount: boolean): void {
    const { repositories, hosts } = this.options;
    const current = repositories.cloudOwner();
    if (
      current?.gatewayUrl === owner.gatewayUrl &&
      current.userId === owner.userId
    )
      return;
    for (const host of hosts.cloud()) hosts.unregister(host.id);
    this.signIns.clear();
    repositories.setCloudOwner(owner);
    if (!current && sameAccount) repositories.claimUnownedCloudLinks();
  }

  /**
   * The app's sign-in: the dev login, then the link opened again for the
   * new account, which the app holds for every process.
   */
  signIn(gatewayUrl: string, email: string): Promise<GatewayUser> {
    return this.#serial(async () => {
      const user = await this.#devLogin(gatewayUrl, email);
      if (this.#holder) await this.#hold();
      return user;
    });
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
    // Read before the list: a link made while it is on its way is not one
    // the gateway forgot.
    const linked = this.options.repositories.cloudWorkspaceLinks();
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
    await this.#forgetCollected(linked, listed);
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
        createdAt: item.createdAt,
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
    await this.#waitForRunner(woken.workspaceId);
    return woken;
  }

  /**
   * Until a cloud workspace's runner can take sessions: linked to this Mac
   * when this process holds the link, else online at the gateway. A pod that
   * fails says why at once rather than at the deadline.
   */
  async #waitForRunner(cloudId: string): Promise<void> {
    const client = await this.#client();
    const deadline = Date.now() + WAKE_RUNNER_MS;
    for (;;) {
      if (this.#link?.linked(cloudId)) return;
      const current = await client.getWorkspace(cloudId).catch(() => undefined);
      if (current?.status === "failed")
        throw new DaedalusError(
          "DEPENDENCY",
          current.reason ?? "The cloud workspace failed to start",
        );
      if (!this.#link && current?.runnerOnline) return;
      if (Date.now() > deadline)
        throw new DaedalusError(
          "DEPENDENCY",
          "The cloud workspace started, but its runner did not connect in time; try again in a minute",
        );
      await Bun.sleep(1_000);
    }
  }

  /** Workspaces whose cloud copy is being made or woken for a session. */
  preparing(): CloudPreparing[] {
    return [...this.#preparing.values()].map((item) => ({ ...item }));
  }

  /** Told when a workspace's preparation moves on, so a window can redraw. */
  onPreparingChange(listener: () => void): () => void {
    this.#preparingListeners.add(listener);
    return () => this.#preparingListeners.delete(listener);
  }

  #setPreparing(workspaceId: string, phase: CloudPreparePhase | undefined) {
    if (phase) this.#preparing.set(workspaceId, { workspaceId, phase });
    else this.#preparing.delete(workspaceId);
    for (const listener of this.#preparingListeners) {
      try {
        listener();
      } catch {
        // A listener's failure is its own.
      }
    }
  }

  /**
   * Readies a local workspace's cloud copy for a new session and returns the
   * host to start it on: made the first time, woken when asleep, and waited
   * for until its runner can take the session. There is no separate step to
   * enable the cloud. Two sessions asking at once share one preparation.
   */
  prepareForSession(workspaceReference: string): Promise<string> {
    return (async () => {
      if (!(await this.account.signIn()))
        throw new DaedalusError(
          "DEPENDENCY",
          "Sign in to a cloud gateway in Settings › Cloud to run sessions in the cloud",
        );
      const workspace =
        await this.options.workspaces.getActive(workspaceReference);
      const pending = this.#preparations.get(workspace.id);
      if (pending) return pending;
      const preparation = this.#prepare(workspace.id).finally(() =>
        this.#preparations.delete(workspace.id),
      );
      this.#preparations.set(workspace.id, preparation);
      return preparation;
    })();
  }

  async #prepare(workspaceId: string): Promise<string> {
    try {
      let cloudId = this.options.repositories.cloudWorkspaceId(workspaceId);
      if (!cloudId) {
        this.#setPreparing(workspaceId, "creating");
        cloudId = (await this.create(workspaceId)).workspaceId;
      } else {
        const current = await this.get(cloudId);
        if (current.status === "sleeping") {
          this.#setPreparing(workspaceId, "waking");
          await this.wake(cloudId);
        } else if (current.status === "failed")
          throw new DaedalusError(
            "DEPENDENCY",
            current.reason ?? "The cloud workspace failed to start",
          );
      }
      this.#setPreparing(workspaceId, "starting");
      await this.#waitForRunner(cloudId);
      return cloudHostId(cloudId);
    } finally {
      this.#setPreparing(workspaceId, undefined);
    }
  }

  logout(): Promise<void> {
    return this.#serial(() => this.#logout());
  }

  async #logout(): Promise<void> {
    // The token goes first: if the Keychain keeps it, the Mac stays signed
    // in, link and all, rather than reading as signed out.
    await this.account.forget();
    await this.#closeLink();
    this.options.repositories.setCloudOwner(undefined);
    this.signIns.clear();
    for (const host of this.options.hosts.cloud())
      this.options.hosts.unregister(host.id);
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
    this.#endSessions(workspaceId, "lost", CLOUD_SLEEP_REASON);
    return result;
  }

  /**
   * The gateway's word that a copy holds nothing this Mac needs: asleep a
   * day, the gateway deletes it. Waking it clears the mark.
   */
  async markDisposable(workspaceReference: string): Promise<void> {
    const workspaceId = await this.#workspaceId(workspaceReference);
    await (await this.#client()).setDisposable(workspaceId, true);
  }

  /**
   * Links whose copy the gateway no longer has, its collection having
   * deleted it after a long sleep: forgotten, so the next cloud session
   * makes a new copy. A session still in one stays lost and says why.
   */
  async #forgetCollected(
    linked: string[],
    listed: CloudWorkspace[],
  ): Promise<void> {
    const present = new Set(listed.map((item) => item.workspaceId));
    for (const cloudId of linked) {
      if (present.has(cloudId)) continue;
      // Asked on its own, so a list that left one out cannot drop its link.
      const gone = await this.#client()
        .then((client) => client.getWorkspace(cloudId))
        .then(
          () => false,
          (error: unknown) =>
            error instanceof DaedalusError &&
            error.details?.gatewayCode === "NOT_FOUND",
        );
      if (!gone) continue;
      this.#endSessions(cloudId, "lost", CLOUD_COLLECTED_REASON);
      for (const session of this.options.repositories.listAgents({
        status: "lost",
      }))
        if (
          session.hostId === cloudHostId(cloudId) &&
          session.lostReason === CLOUD_SLEEP_REASON
        )
          this.options.repositories.updateAgent({
            ...session,
            lostReason: CLOUD_COLLECTED_REASON,
          });
      await this.account.unpin(cloudId).catch(() => undefined);
      this.options.repositories.unlinkCloudWorkspace(cloudId);
      this.options.hosts.unregister(cloudHostId(cloudId));
      this.options.log?.("cloud_workspace_collected", { workspaceId: cloudId });
    }
  }

  /** Deletes the pod, its volume and its token; the local workspace stays. */
  async delete(workspaceReference: string): Promise<void> {
    const workspaceId = await this.#workspaceId(workspaceReference);
    try {
      await (await this.#client()).deleteWorkspace(workspaceId);
    } catch (error) {
      // Gone already, from the gateway or another Mac: only the link is left.
      if (
        !(error instanceof DaedalusError) ||
        error.details?.gatewayCode !== "NOT_FOUND"
      )
        throw error;
    }
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

  /**
   * Readies the pod for a cloud Claude launch: the files that skip Claude's
   * first-run screens, merged into what the pod already has. A pod that
   * cannot be read or written still gets the launch, with those screens.
   */
  async prepareLaunch(session: AgentSession): Promise<CloudLaunchExtras> {
    const extras = await this.#accountLaunch(session);
    await this.#runSeeders(session);
    return extras;
  }

  /**
   * Adds a step to every cloud Claude launch, after the files above: the
   * way to bring more of the user's setup into the pod (skills, commands).
   * Steps run in the order added; one that fails is logged and the launch
   * goes on.
   */
  addLaunchSeeder(seeder: CloudLaunchSeeder): void {
    this.#seeders.push(seeder);
  }

  async #runSeeders(session: AgentSession): Promise<void> {
    const host = this.options.hosts.find(session.hostId);
    // A host of another kind (a test's) has no files to seed.
    if (!(host instanceof RemoteSessionHost)) return;
    const profile = accountProfile(
      this.options.config,
      "claude",
      session.account,
    );
    for (const seeder of this.#seeders)
      await seeder({ host, session, profile }).catch((error: unknown) =>
        this.options.log?.("cloud_seed_failed", {
          hostId: session.hostId,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
  }

  /** The files and launch values a session's account needs in the pod. */
  async #accountLaunch(session: AgentSession): Promise<CloudLaunchExtras> {
    const host = this.options.hosts.find(session.hostId);
    const profile = accountProfile(
      this.options.config,
      "claude",
      session.account,
    );
    const seed = (options: Parameters<CloudService["seed"]>[1]) =>
      // A host of another kind (a test's) has no files to seed.
      host instanceof RemoteSessionHost
        ? this.seed(host, options)
        : Promise.resolve();
    if (profile?.kind === "bedrock") {
      if (!profile.aws)
        throw new DaedalusError(
          "VALIDATION",
          `The Bedrock account '${profile.name}' has no AWS profile`,
        );
      const copy = awsSsoCopy(
        (await this.#awsConfig()) ?? "",
        profile.aws.profile,
      );
      const cloudId = session.hostId && cloudHostWorkspace(session.hostId);
      if (cloudId)
        this.options.repositories.addCloudSsoHost(cloudId, copy.startUrlHost);
      // Without the profile in the pod, Bedrock cannot sign in at all.
      await seed({
        bedrockProfile: profile.aws.profile,
        awsSections: copy.sections,
      });
      return {
        env: {
          CLAUDE_CODE_USE_BEDROCK: "1",
          AWS_PROFILE: profile.aws.profile,
          AWS_REGION: profile.aws.region,
        },
        secrets: {},
      };
    }
    await seed({ consent: await this.#claudeConsent(session.account) }).catch(
      (error: unknown) =>
        this.options.log?.("cloud_seed_failed", {
          hostId: session.hostId,
          message: error instanceof Error ? error.message : String(error),
        }),
    );
    if (profile?.kind === "api-key") {
      const key = await this.#apiKey(profile);
      if (!key)
        throw new DaedalusError(
          "DEPENDENCY",
          `The ${profile.name} account has no API key. Set it in Settings → Agents.`,
        );
      return { secrets: { ANTHROPIC_API_KEY: key } };
    }
    // A login account signs in in the pod; the workspace's API key secret
    // would take its place.
    if (profile) return { secrets: {} };
    return {};
  }

  /**
   * The approvals this Mac's Claude recorded for the account's organization
   * settings, from the account's own Claude folder.
   */
  async #claudeConsent(account: string | null): Promise<string | undefined> {
    const file = Bun.file(
      join(
        accountConfig(this.options.config, "claude", account).claudeHome,
        CLAUDE_CONSENT_FILE,
      ),
    );
    return (await file.exists())
      ? file.text().catch(() => undefined)
      : undefined;
  }

  /** This Mac's AWS config, where the AWS CLI reads it. */
  async #awsConfig(): Promise<string | undefined> {
    if (this.options.awsConfig) return this.options.awsConfig();
    const file = Bun.file(
      process.env.AWS_CONFIG_FILE ?? join(homedir(), ".aws", "config"),
    );
    return (await file.exists()) ? file.text() : undefined;
  }

  /** An API-key account's key, from the Keychain entry its settings read. */
  async #apiKey(profile: AccountProfile): Promise<string | undefined> {
    if (this.options.apiKey) return this.options.apiKey(profile);
    return readKeychainPassword(
      API_KEY_SERVICE,
      accountDirectory(this.options.config, profile),
    );
  }

  private async seed(
    host: RemoteSessionHost,
    options: {
      bedrockProfile?: string;
      awsSections?: AwsSsoCopy["sections"];
      /** This Mac's approvals of the organization's managed settings. */
      consent?: string;
    },
  ): Promise<void> {
    const files: { path: string; text: string }[] = [];
    const put = (path: string, text: string | undefined) => {
      if (text !== undefined) files.push({ path, text });
    };
    put(
      CLOUD_SEED_PATHS.claudeState,
      seedClaudeState(await host.readText(CLOUD_SEED_PATHS.claudeState)),
    );
    put(
      CLOUD_SEED_PATHS.claudeSettings,
      seedClaudeSettings(
        await host.readText(CLOUD_SEED_PATHS.claudeSettings),
        options,
      ),
    );
    if (options.consent)
      put(
        CLOUD_SEED_PATHS.claudeConsent,
        seedClaudeConsent(
          await host.readText(CLOUD_SEED_PATHS.claudeConsent),
          options.consent,
        ),
      );
    if (options.awsSections)
      put(
        CLOUD_SEED_PATHS.awsConfig,
        mergeAwsConfig(
          await host.readText(CLOUD_SEED_PATHS.awsConfig),
          options.awsSections,
        ),
      );
    await host.writeText(files);
  }

  /**
   * `daedal open-url` from a cloud session: a page on the allowlist waits for
   * the user's click; anything else is refused. Exit 0 lets the tool go on
   * at once, while the page waits.
   */
  offerSignIn(hostId: string, sessionId: string, url: string): CommandResult {
    const cloudId = cloudHostWorkspace(hostId);
    const checked =
      cloudId && this.options.repositories.workspaceForCloud(cloudId)
        ? checkSignInUrl(url, this.options.repositories.cloudSsoHosts(cloudId))
        : "an unknown host";
    if (typeof checked === "string")
      return {
        exitCode: REFUSED_EXIT_CODE,
        stdout: "",
        stderr: `daedal: ${REFUSED_MESSAGE}: ${checked}\n`,
      };
    this.signIns.offer(hostId, sessionId, checked);
    return {
      exitCode: 0,
      stdout: `Daedalus offers this sign-in page on ${checked.host}; open it from the session on the Mac.\n`,
      stderr: "",
    };
  }

  /**
   * The page to open for an offer the user clicked, once. A page whose
   * redirect goes to a listener in the pod gets a listener on this Mac's
   * port first; when the port cannot be had, it opens in its paste-code
   * form, where Claude shows the code to paste into the session. Either way
   * the session's sign-in is followed until it finishes.
   */
  async openSignIn(
    requestId: string,
  ): Promise<{ url: string; host: string; paste: boolean }> {
    let listener: SignInListener | undefined;
    const offer = this.signIns.open(requestId, (stored) => {
      const callback = stored.checked?.callback;
      if (!callback) return false;
      const host = this.options.hosts.find(stored.hostId);
      // The browser comes back to this Mac's localhost; this listener takes
      // that one request to the tool in the pod.
      listener =
        host instanceof RemoteSessionHost
          ? listenForSignIn(
              callback,
              (query) =>
                host.authCallback({
                  port: callback.port,
                  path: callback.path,
                  query,
                }),
              { timeoutMs: SIGN_IN_OFFER_MS },
            )
          : undefined;
      return !listener;
    });
    if (!offer)
      throw new DaedalusError(
        "NOT_FOUND",
        "This sign-in page expired or was already opened; ask again in the session",
      );
    const session = this.options.repositories.findAgent(offer.sessionId);
    if (!session || session.hostId !== offer.hostId) {
      (listener as SignInListener | undefined)?.stop();
      this.signIns.finish(offer.sessionId);
      throw new DaedalusError(
        "NOT_FOUND",
        "The session that asked for this sign-in page is gone",
      );
    }
    const opened = listener as SignInListener | undefined;
    const paste = Boolean(offer.checked.callback) && !opened;
    if (opened) {
      this.#signInListeners.add(opened);
      void opened.done.then((result) => {
        this.#signInListeners.delete(opened);
        if (result === "forwarded") void this.#followSignIn(session, "claude");
        else
          this.signIns.fail(
            session.id,
            result === "failed"
              ? "The sign-in could not reach the session. Type /login in it to try again."
              : "The sign-in page was not finished in time. Type /login in the session to try again.",
          );
      });
    } else void this.#followSignIn(session, offer.kind);
    const url = paste ? pasteCodeUrl(offer.checked.url) : offer.checked.url;
    return { url, host: offer.host ?? offer.checked.host, paste };
  }

  /**
   * Starts Claude's sign-in in a cloud session that came up signed out, so
   * the user only has to open the page: /login, then the method its account
   * signs in with. API-key and Bedrock accounts need none of it.
   */
  async autoSignIn(
    session: AgentSession,
    launch: { apiKey: boolean } = { apiKey: false },
  ): Promise<void> {
    const profile = accountProfile(
      this.options.config,
      "claude",
      session.account,
    );
    if (launch.apiKey || (profile && (profile.kind ?? "login") !== "login"))
      return;
    const host = this.options.hosts.find(session.hostId);
    if (!(host instanceof RemoteSessionHost)) return;
    // Claude in the pod keeps its sign-in in this file (the pod is Linux).
    // Its screen is no guide: the fullscreen renderer shows no footer.
    const signedIn = await host
      .exists(CLOUD_SEED_PATHS.claudeCredentials)
      .catch(() => true);
    if (signedIn) return;
    this.signIns.begin(host.id, session.id, "claude");
    try {
      await host.send(session.tmuxSession, "/login");
      // The subscription is the first method; the Console the second.
      let chosen = false;
      for (let tries = 0; tries < 20 && !chosen; tries++) {
        await Bun.sleep(500);
        const now = await host.capture(session.tmuxSession).catch(() => "");
        if (!LOGIN_METHODS.test(now)) continue;
        await host.sendKeys(
          session.tmuxSession,
          profile?.login === "console" ? ["Down", "Enter"] : ["Enter"],
        );
        chosen = true;
      }
      // A method screen the capture cannot read still takes the first one.
      if (!chosen && profile?.login !== "console")
        await host.sendKeys(session.tmuxSession, ["Enter"]);
    } catch (error) {
      this.signIns.fail(
        session.id,
        `Daedalus could not start the sign-in: ${error instanceof Error ? error.message : String(error)}. Type /login in the session.`,
      );
      return;
    }
    // The page arrives through open-url, which moves the sign-in on.
    const deadline = Date.now() + SIGN_IN_START_MS;
    while (
      Date.now() < deadline &&
      this.signIns.get(session.id)?.phase === "starting"
    )
      await Bun.sleep(500);
    if (this.signIns.get(session.id)?.phase === "starting")
      this.signIns.fail(
        session.id,
        "Claude did not ask to open a sign-in page. Type /login in the session.",
      );
  }

  /**
   * Watches a session whose sign-in page was opened, until the tool says it
   * is signed in, then clears it. Claude waits for Enter after a sign-in.
   */
  async #followSignIn(session: AgentSession, kind: "claude" | "aws") {
    const host = this.options.hosts.find(session.hostId);
    if (!(host instanceof RemoteSessionHost)) return;
    const done = kind === "claude" ? CLAUDE_SIGNED_IN : AWS_SIGNED_IN;
    const deadline = Date.now() + SIGN_IN_OFFER_MS;
    while (Date.now() < deadline) {
      const phase = this.signIns.get(session.id)?.phase;
      if (phase !== "browser" && phase !== "pasting") return;
      const screen = await host.capture(session.tmuxSession).catch(() => "");
      if (done.test(screen)) {
        if (kind === "claude")
          await host.sendKeys(session.tmuxSession, ["Enter"]).catch(() => {});
        this.signIns.finish(session.id);
        return;
      }
      await Bun.sleep(1_500);
    }
  }

  /** The host a local workspace's cloud sessions run on. */
  async hostId(workspaceReference: string): Promise<string> {
    const workspace =
      await this.options.workspaces.getActive(workspaceReference);
    return cloudHostId(await this.linkedCloudId(workspace.id));
  }

  /**
   * The cloud id linked to a local workspace for the signed-in account. Unlike
   * the commands, a cloud id is not taken as it is: the app acts only on
   * workspaces this Mac links.
   */
  async linkedCloudId(workspaceReference: string): Promise<string> {
    const workspace = await this.options.workspaces.get(workspaceReference);
    const cloudId = this.options.repositories.cloudWorkspaceId(workspace.id);
    if (!cloudId)
      throw new DaedalusError(
        "NOT_FOUND",
        `Workspace '${workspace.name}' has no cloud workspace; run 'daedal cloud create'`,
      );
    return cloudId;
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
    return this.linkedCloudId(reference);
  }

  /**
   * The runner key this Mac accepts a workspace's runner with: the pinned
   * one, else the one the gateway reports, which is pinned from then on.
   */
  async #runnerKey(
    workspaceId: string,
    signIn: CloudSignIn,
  ): Promise<string | undefined> {
    // A link answers for the account it was opened with, and pins nothing
    // once another account (or none) is signed in.
    const current = await this.account.signIn();
    if (current?.token !== signIn.token) return undefined;
    const pinned = await this.account.pinned(workspaceId);
    if (pinned) return pinned;
    const workspace = await new GatewayClient(
      signIn.gatewayUrl,
      signIn.token,
      this.options.fetch,
    )
      .getWorkspace(workspaceId)
      .catch(() => undefined);
    if (!workspace?.runnerKey) return undefined;
    await this.account.pin(workspaceId, workspace.runnerKey);
    return workspace.runnerKey;
  }

  async #openLink(): Promise<CloudLink> {
    const before = this.#link;
    const signIn = await this.account.requireSignIn();
    const calls = new CloudCalls({
      repositories: this.options.repositories,
      home: this.options.config.home,
      daedal: this.options.daedal ?? cloudDaedal(this.options.config.home),
      openUrl: (hostId, sessionId, url) =>
        this.offerSignIn(hostId, sessionId, url),
    });
    const link = new CloudLink({
      gatewayUrl: signIn.gatewayUrl,
      token: signIn.token,
      identity: await this.identity(),
      runnerKey: (workspaceId) => this.#runnerKey(workspaceId, signIn),
      answer: (hostId, call) => calls.answer(hostId, call),
      // Its sessions end with the pod; opening one wakes and resumes it.
      onWorkspaceSleeping: (workspaceId) =>
        this.#endSessions(workspaceId, "lost", CLOUD_SLEEP_REASON),
      // The gateway drops a runner as it sleeps the pod, often before the
      // runner can say so: a runner gone from an asleep workspace took its
      // sessions with it.
      onRunner: (workspaceId, linked) => {
        if (linked) return;
        void (async () => {
          const current = await (
            await this.#client()
          ).getWorkspace(workspaceId);
          if (current.status === "sleeping")
            this.#endSessions(workspaceId, "lost", CLOUD_SLEEP_REASON);
        })().catch(() => undefined);
      },
      ...(this.options.connect ? { connect: this.options.connect } : {}),
      ...(this.options.log ? { log: this.options.log } : {}),
    });
    await link.start();
    // A sign-out, another sign-in or the app's hold may have run during the
    // awaits above. This link is then the wrong one, and must not stay up.
    const current = await this.account.signIn();
    if (current?.token !== signIn.token || this.#link !== before) {
      link.stop();
      if (current?.token === signIn.token && this.#link) return this.#link;
      throw new DaedalusError(
        "DEPENDENCY",
        "The cloud sign-in changed while connecting; try again",
      );
    }
    this.#link = link;
    return link;
  }

  /**
   * Holds the link for every process on this Mac: the app's job. Registers a
   * host for each cloud workspace so reconcile and revive cover them.
   */
  hold(): Promise<boolean> {
    this.#holder = true;
    return this.#serial(() => this.#hold());
  }

  async #hold(): Promise<boolean> {
    const signIn = await this.account.signIn();
    if (!signIn) return false;
    // A sign-in from before links had an account, or from a CLI that
    // predates it, names the account here.
    this.#own({ gatewayUrl: signIn.gatewayUrl, userId: signIn.user.id }, true);
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
    const transport = async (): Promise<RunnerTransport> => {
      // In the app, the link is the one hold opens: wait for that rather
      // than open a second one beside it.
      if (this.#holder) {
        await this.#queue;
        if (this.#link) return this.#link;
        throw new DaedalusError(
          "DEPENDENCY",
          "This Mac is not connected to a cloud gateway; sign in in Settings › Cloud",
        );
      }
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
      // A link a command just opened needs a moment for the runner to answer
      // the Mac coming online. The app's link has been up all along, so a
      // runner that is not linked is asleep or gone, and waiting for it
      // would hold up every snapshot (each reconciles every cloud host).
      // Steps that need a runner wait for it themselves (prepareForSession,
      // wakeForSessions).
      if (chosen instanceof CloudLink && !this.#holder)
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

  /** Stops the link and waits for the broker's socket to go. */
  async #closeLink(): Promise<void> {
    const stopBroker = this.#stopBroker;
    this.#stopBroker = undefined;
    this.close();
    await stopBroker?.();
  }

  close(): void {
    for (const listener of this.#signInListeners) listener.stop();
    this.#link?.stop();
    this.#link = undefined;
    this.#transport = undefined;
    void this.#stopBroker?.();
    this.#stopBroker = undefined;
  }
}
