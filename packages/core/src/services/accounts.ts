import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ensureDirectory, runCommand } from "@daedalus/platform";
import {
  saveAccounts,
  type AccountProfile,
  type AccountProvider,
  type DaedalusConfig,
} from "../config";
import { DaedalusError } from "../errors";
import type { IntegratedTerminal } from "../domain";
import type { SqliteRepositories } from "../repositories";
import type { IntegratedTerminalService } from "./integrated-terminals";
import {
  accountConfig,
  accountDirectory,
  accountEnvironment,
  DEFAULT_ACCOUNT,
  findAccount,
  providerLabel,
} from "./account-homes";
import { resolveAgentExecutable } from "./providers";
import { SkillService } from "./skills";

export type SignInState = "missing" | "signed-out" | "signed-in" | "unknown";

/** What a provider says about one account's login. */
export interface SignIn {
  state: SignInState;
  /** How it is signed in: "Claude subscription", "ChatGPT", "API key", … */
  method?: string;
  email?: string;
  organization?: string;
  plan?: string;
  /** Why the state is `unknown`, in the provider's words where it gave any. */
  detail?: string;
}

export interface AccountStatus extends SignIn {
  provider: AccountProvider;
  /** `default`, or a profile id. */
  account: string;
  name: string;
  /** The configuration folder the provider reads for this account. */
  directory: string;
  createdAt: string | null;
  executable: string;
  checkedAt: string;
}

/** How to install a provider that is missing. Shown, never run. */
export interface InstallCommand {
  label: string;
  command: string;
}

export const INSTALL_COMMANDS: Record<AccountProvider, InstallCommand[]> = {
  claude: [
    {
      label: "Install script",
      command: "curl -fsSL https://claude.ai/install.sh | bash",
    },
    { label: "Homebrew", command: "brew install --cask claude-code" },
  ],
  codex: [
    { label: "Homebrew", command: "brew install --cask codex" },
    { label: "npm", command: "npm install -g @openai/codex" },
  ],
};

/** A status call that takes longer than this is reported as unknown. */
const STATUS_TIMEOUT_MS = 10_000;
/** The Codex app server is slower to start; it only adds detail. */
const ACCOUNT_DETAIL_TIMEOUT_MS = 5_000;

const CLAUDE_METHODS: Record<string, string> = {
  "claude.ai": "Claude subscription",
  console: "Anthropic Console",
  api_key: "API key",
  apiKey: "API key",
};

const CLAUDE_API_PROVIDERS: Record<string, string> = {
  bedrock: "Amazon Bedrock",
  vertex: "Google Vertex AI",
  foundry: "Microsoft Foundry",
};

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

/**
 * Reads `claude auth status --json`.
 *
 * Signed out is only claimed when Claude says so in its own structured form:
 * `loggedIn: false` with no other API provider configured. A Bedrock or
 * Vertex setup reports `loggedIn: false` and still works, and an older build
 * that has no `auth status` prints something that is not JSON. Both are
 * reported as what they are rather than as signed out, because signed out is
 * the one answer that stops a session from starting.
 */
export function parseClaudeAuthStatus(result: {
  exitCode: number;
  stdout: string;
  stderr: string;
}): SignIn {
  let parsed: Record<string, unknown>;
  try {
    const value = JSON.parse(result.stdout) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("not an object");
    parsed = value as Record<string, unknown>;
  } catch {
    return {
      state: "unknown",
      detail:
        text(result.stderr) ??
        text(result.stdout) ??
        "Claude did not report its sign-in status",
    };
  }
  const apiProvider = text(parsed.apiProvider);
  if (apiProvider && apiProvider !== "firstParty")
    return {
      state: "signed-in",
      method: CLAUDE_API_PROVIDERS[apiProvider] ?? apiProvider,
    };
  if (parsed.loggedIn === false) return { state: "signed-out" };
  if (parsed.loggedIn !== true)
    return {
      state: "unknown",
      detail: "Claude did not say whether it is signed in",
    };
  const method = text(parsed.authMethod);
  const email = text(parsed.email);
  const organization = text(parsed.orgName);
  const plan = text(parsed.subscriptionType);
  return {
    state: "signed-in",
    ...(method ? { method: CLAUDE_METHODS[method] ?? method } : {}),
    ...(email ? { email } : {}),
    ...(organization ? { organization } : {}),
    ...(plan ? { plan } : {}),
  };
}

/**
 * Reads `codex login status`, which has no structured form: it exits 0 with
 * "Logged in using …" or 1 with "Not logged in". Anything else is unknown.
 * An API key login prints the start of the key, which is never kept.
 */
export function parseCodexLoginStatus(result: {
  exitCode: number;
  stdout: string;
  stderr: string;
}): SignIn {
  const output = `${result.stdout}\n${result.stderr}`.trim();
  if (result.exitCode === 0 && /Logged in/i.test(output)) {
    const method = /Logged in using (ChatGPT|an API key|.+?)(?:\s+-|$)/im.exec(
      output,
    )?.[1];
    return {
      state: "signed-in",
      ...(method
        ? { method: /api key/i.test(method) ? "API key" : method.trim() }
        : {}),
    };
  }
  if (/Not logged in/i.test(output)) return { state: "signed-out" };
  return {
    state: "unknown",
    detail: output || "Codex did not report its sign-in status",
  };
}

/**
 * The account detail the Codex app server gives through `account/read`:
 * email and plan, which `codex login status` leaves out.
 */
export function parseCodexAccount(
  result: unknown,
): Pick<SignIn, "method" | "email" | "plan"> | undefined {
  const account = (result as { account?: unknown } | undefined)?.account as
    { type?: unknown; email?: unknown; planType?: unknown } | null | undefined;
  if (!account) return undefined;
  const type = text(account.type);
  const email = text(account.email);
  const plan = text(account.planType);
  return {
    ...(type
      ? {
          method:
            type === "chatgpt"
              ? "ChatGPT"
              : type === "apiKey"
                ? "API key"
                : type,
        }
      : {}),
    ...(email ? { email } : {}),
    ...(plan ? { plan } : {}),
  };
}

const providerExecutable = (
  config: DaedalusConfig,
  provider: AccountProvider,
): string | undefined => {
  const definition = config.agents[provider];
  return definition
    ? resolveAgentExecutable(provider, definition.executable)
    : undefined;
};

/**
 * One quick question to the provider: is this account signed in? Fast enough
 * (about a tenth of a second) to ask before every launch.
 */
export async function checkSignIn(
  config: DaedalusConfig,
  provider: AccountProvider,
  accountId: string | null | undefined,
  run: typeof runCommand = runCommand,
): Promise<SignIn> {
  const executable = providerExecutable(config, provider);
  if (!executable) return { state: "missing" };
  const env = accountEnvironment(config, provider, accountId);
  try {
    const result = await run(
      executable,
      provider === "claude"
        ? ["auth", "status", "--json"]
        : ["login", "status"],
      { env, timeoutMs: STATUS_TIMEOUT_MS },
    );
    if (result.timedOut)
      return {
        state: "unknown",
        detail: `${providerLabel(provider)} took too long to report its sign-in status`,
      };
    return provider === "claude"
      ? parseClaudeAuthStatus(result)
      : parseCodexLoginStatus(result);
  } catch (error) {
    return {
      state: "unknown",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Email and plan for a Codex account, or undefined if the server is silent. */
async function readCodexAccount(
  executable: string,
  env: Record<string, string>,
): Promise<Pick<SignIn, "method" | "email" | "plan"> | undefined> {
  try {
    const child = Bun.spawn([executable, "app-server", "--stdio"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
      env: { ...Bun.env, ...env },
    });
    try {
      child.stdin.write(
        `${JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "daedalus", title: "Daedalus", version: "0.2.0" }, capabilities: { experimentalApi: true } } })}\n`,
      );
      child.stdin.write(
        `${JSON.stringify({ id: 2, method: "account/read", params: { refreshToken: false } })}\n`,
      );
      const reader = child.stdout.getReader();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const answer = await Promise.race([
        (async () => {
          const decoder = new TextDecoder();
          let buffer = "";
          while (true) {
            const { done, value } = await reader.read();
            if (done) return undefined;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";
            for (const line of lines) {
              try {
                const message = JSON.parse(line) as {
                  id?: unknown;
                  result?: unknown;
                };
                if (message.id === 2) return parseCodexAccount(message.result);
              } catch {
                // Not a protocol line.
              }
            }
          }
        })(),
        // A timer that is cleared, not `Bun.sleep`: a pending sleep keeps a
        // CLI process alive for its whole length after the answer arrived.
        new Promise<undefined>((resolve) => {
          timer = setTimeout(
            () => resolve(undefined),
            ACCOUNT_DETAIL_TIMEOUT_MS,
          );
        }),
      ]);
      clearTimeout(timer);
      await reader.cancel().catch(() => undefined);
      return answer;
    } finally {
      child.kill();
    }
  } catch {
    return undefined;
  }
}

/** The command that signs one account in or out, for a terminal to run. */
export interface AccountCommand {
  executable: string;
  args: string[];
  env: Record<string, string>;
  /** What the terminal tab is called. */
  title: string;
}

const NAME_LIMIT = 60;

/** A folder name for a new profile: its name, made safe, plus a suffix. */
function profileId(name: string, taken: Set<string>): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "account";
  for (;;) {
    const id = `${base}-${crypto.randomUUID().slice(0, 4)}`;
    if (!taken.has(id)) return id;
  }
}

/**
 * Account profiles: a provider's CLI pointed at a configuration folder of its
 * own, so one machine can run sessions on more than one account.
 *
 * Daedalus holds no credentials. Signing in and out is the provider's own
 * command, run in a terminal the user can see and answer.
 */
export class AccountService {
  constructor(
    private readonly config: DaedalusConfig,
    private readonly repositories: SqliteRepositories,
  ) {}

  /** Every account, the default ones first. */
  list(): Array<{
    provider: AccountProvider;
    account: string;
    name: string;
    directory: string;
    createdAt: string | null;
  }> {
    const defaults = (["claude", "codex"] as const).map((provider) => ({
      provider,
      account: DEFAULT_ACCOUNT,
      name: "Default",
      directory:
        provider === "claude" ? this.config.claudeHome : this.config.codexHome,
      createdAt: null,
    }));
    const profiles = this.config.accounts.map((profile) => ({
      provider: profile.provider,
      account: profile.id,
      name: profile.name,
      directory: accountDirectory(this.config, profile),
      createdAt: profile.createdAt,
    }));
    return [...defaults, ...profiles];
  }

  private validName(provider: AccountProvider, name: string, except?: string) {
    const trimmed = name.trim();
    if (!trimmed)
      throw new DaedalusError("VALIDATION", "An account needs a name");
    if (trimmed.length > NAME_LIMIT)
      throw new DaedalusError(
        "VALIDATION",
        `Account name must contain at most ${NAME_LIMIT} characters`,
      );
    if (trimmed.toLowerCase() === DEFAULT_ACCOUNT)
      throw new DaedalusError(
        "VALIDATION",
        "'Default' is the name of the account the provider uses on its own",
      );
    if (
      this.config.accounts.some(
        (entry) =>
          entry.provider === provider &&
          entry.id !== except &&
          entry.name.toLowerCase() === trimmed.toLowerCase(),
      )
    )
      throw new DaedalusError(
        "CONFLICT",
        `There is already a ${providerLabel(provider)} account named '${trimmed}'`,
      );
    return trimmed;
  }

  /**
   * Creates a profile and its folder, and puts Daedalus's skills and writing
   * style where that folder's sessions will look for them. The folder starts
   * empty otherwise: a profile shares no settings with the default account.
   */
  async add(provider: string, name: string): Promise<AccountProfile> {
    const owner = accountProvider(provider);
    const trimmed = this.validName(owner, name);
    const profile: AccountProfile = {
      id: profileId(trimmed, new Set(this.config.accounts.map((a) => a.id))),
      provider: owner,
      name: trimmed,
      createdAt: new Date().toISOString(),
    };
    const directory = accountDirectory(this.config, profile);
    await ensureDirectory(directory);
    // A Claude folder with no record of onboarding opens on the theme picker,
    // and a session waiting there never reaches the prompt Daedalus watches
    // for. This one flag is the whole record; no setting of the default
    // account's is copied.
    if (owner === "claude")
      await writeFile(
        join(directory, ".claude.json"),
        `${JSON.stringify({ hasCompletedOnboarding: true }, null, 2)}\n`,
        { flag: "wx", mode: 0o600 },
      ).catch(() => undefined);
    await saveAccounts(this.config, [...this.config.accounts, profile]);
    await new SkillService(
      accountConfig(this.config, owner, profile.id),
    ).syncArtifacts();
    return profile;
  }

  async rename(
    provider: string,
    reference: string,
    name: string,
  ): Promise<AccountProfile> {
    const owner = accountProvider(provider);
    const profile = this.requireProfile(owner, reference);
    const renamed = {
      ...profile,
      name: this.validName(owner, name, profile.id),
    };
    await saveAccounts(
      this.config,
      this.config.accounts.map((entry) =>
        entry.id === profile.id ? renamed : entry,
      ),
    );
    return renamed;
  }

  /**
   * Signs the profile out, then deletes it and its folder.
   *
   * Refused while a session that is not archived runs on it, because that
   * session would lose its login mid-turn. Archived sessions on it stay
   * archived, and say why when someone tries to restore them. Workspaces that
   * started sessions on it by default go back to the default account.
   */
  async remove(provider: string, reference: string): Promise<AccountProfile> {
    const owner = accountProvider(provider);
    const profile = this.requireProfile(owner, reference);
    const live = this.repositories
      .listAgents()
      .filter(
        (session) =>
          session.provider === owner &&
          session.account === profile.id &&
          !session.archivedAt,
      );
    if (live.length)
      throw new DaedalusError(
        "CONFLICT",
        `${live.length === 1 ? "A session runs" : `${live.length} sessions run`} on '${profile.name}'. Archive ${live.length === 1 ? "it" : "them"} before removing the account.`,
        { sessions: live.map((session) => session.id) },
      );
    // Claude keeps the login in the Keychain under a name made from the
    // folder path, so deleting the folder alone would leave it there.
    const executable = providerExecutable(this.config, owner);
    if (executable) {
      const logout = this.signOutCommand(owner, profile.id);
      await runCommand(logout.executable, logout.args, {
        env: logout.env,
        timeoutMs: STATUS_TIMEOUT_MS,
      }).catch(() => undefined);
    }
    this.repositories.clearWorkspaceDefaultAccount(owner, profile.id);
    await saveAccounts(
      this.config,
      this.config.accounts.filter((entry) => entry.id !== profile.id),
    );
    await rm(accountDirectory(this.config, profile), {
      recursive: true,
      force: true,
    });
    return profile;
  }

  /** Each account's login, asked of the provider now. */
  async status(
    filter: { provider?: string; account?: string } = {},
  ): Promise<AccountStatus[]> {
    const provider = filter.provider
      ? accountProvider(filter.provider)
      : undefined;
    if (filter.account && !provider)
      throw new DaedalusError(
        "VALIDATION",
        "Name the provider of the account to check",
      );
    const wanted = filter.account
      ? (findAccount(this.config, provider!, filter.account)?.id ??
        DEFAULT_ACCOUNT)
      : undefined;
    const accounts = this.list().filter(
      (entry) =>
        (!provider || entry.provider === provider) &&
        (!wanted || entry.account === wanted),
    );
    return Promise.all(
      accounts.map(async (entry): Promise<AccountStatus> => {
        const executable = providerExecutable(this.config, entry.provider);
        const signIn = await checkSignIn(
          this.config,
          entry.provider,
          entry.account,
        );
        const detail =
          entry.provider === "codex" &&
          executable &&
          signIn.state === "signed-in"
            ? await readCodexAccount(
                executable,
                accountEnvironment(this.config, "codex", entry.account),
              )
            : undefined;
        return {
          provider: entry.provider,
          account: entry.account,
          name: entry.name,
          directory: entry.directory,
          createdAt: entry.createdAt,
          executable:
            executable ??
            this.config.agents[entry.provider]?.executable ??
            entry.provider,
          checkedAt: new Date().toISOString(),
          ...signIn,
          ...detail,
        };
      }),
    );
  }

  /**
   * The provider's own sign-in command for one account. A terminal runs it,
   * because both providers open a browser and may ask a question or two.
   */
  signInCommand(provider: string, reference?: string | null): AccountCommand {
    return this.command(provider, reference, "in");
  }

  signOutCommand(provider: string, reference?: string | null): AccountCommand {
    return this.command(provider, reference, "out");
  }

  private command(
    provider: string,
    reference: string | null | undefined,
    direction: "in" | "out",
  ): AccountCommand {
    const owner = accountProvider(provider);
    const profile = findAccount(this.config, owner, reference);
    const executable = providerExecutable(this.config, owner);
    if (!executable)
      throw new DaedalusError(
        "DEPENDENCY",
        `${providerLabel(owner)} is not installed. Install it with: ${INSTALL_COMMANDS[owner][0]!.command}`,
        { provider: owner },
      );
    const args =
      owner === "claude"
        ? ["auth", direction === "in" ? "login" : "logout"]
        : [direction === "in" ? "login" : "logout"];
    const name = profile?.name ?? "Default";
    return {
      executable,
      args,
      env: accountEnvironment(this.config, owner, profile?.id),
      title: `${providerLabel(owner)} sign ${direction} · ${name}`,
    };
  }

  /**
   * Opens the sign-in in an integrated terminal: the provider opens a
   * browser, and the terminal shows what it asks and how it ended.
   */
  async openSignIn(
    terminals: IntegratedTerminalService,
    provider: string,
    reference?: string | null,
  ): Promise<IntegratedTerminal> {
    const command = this.signInCommand(provider, reference);
    return terminals.createCommand({
      name: command.title,
      executable: command.executable,
      args: command.args,
      env: command.env,
    });
  }

  /** Runs the sign-out command where nothing needs answering. */
  async signOut(
    provider: string,
    reference?: string | null,
  ): Promise<{ provider: AccountProvider; account: string }> {
    const owner = accountProvider(provider);
    const command = this.signOutCommand(owner, reference);
    const result = await runCommand(command.executable, command.args, {
      env: command.env,
      timeoutMs: STATUS_TIMEOUT_MS,
    });
    if (result.exitCode !== 0)
      throw new DaedalusError(
        "DEPENDENCY",
        result.stderr.trim() ||
          result.stdout.trim() ||
          `${providerLabel(owner)} could not sign out`,
      );
    return {
      provider: owner,
      account:
        findAccount(this.config, owner, reference)?.id ?? DEFAULT_ACCOUNT,
    };
  }

  private requireProfile(
    provider: AccountProvider,
    reference: string,
  ): AccountProfile {
    const profile = findAccount(this.config, provider, reference);
    if (!profile)
      throw new DaedalusError(
        "VALIDATION",
        "The default account cannot be renamed or removed",
      );
    return profile;
  }
}

export function accountProvider(value: string): AccountProvider {
  if (value === "claude" || value === "codex") return value;
  throw new DaedalusError("VALIDATION", "Provider must be 'claude' or 'codex'");
}
