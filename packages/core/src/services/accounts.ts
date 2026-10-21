import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  deleteKeychainPassword,
  editJson,
  ensureDirectory,
  findExecutable,
  keychainReadCommand,
  loginShellPath,
  runCommand,
  standardExecutableFallbacks,
  writeKeychainPassword,
} from "@daedalus/platform";
import {
  updateSettings,
  isAwsTarget,
  type AccountKind,
  type AwsTarget,
  type ClaudeLogin,
  type AccountProfile,
  type AccountProvider,
  type DaedalusConfig,
} from "../config";
import { DaedalusError } from "../errors";
import type {
  AgentProviderName,
  AgentSession,
  IntegratedTerminal,
  Workspace,
} from "../domain";
import type { SqliteRepositories } from "../repositories";
import type { IntegratedTerminalService } from "./integrated-terminals";
import {
  accountConfig,
  accountDirectory,
  accountEnvironment,
  accountName,
  accountProfile,
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
  kind: AccountKind;
  login?: ClaudeLogin;
  aws?: AwsTarget;
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
  api_key_helper: "API key",
};

/** How a login-based account signs in: Claude's three login flows. */
export type SignInVariant = ClaudeLogin;

/**
 * The AWS CLI, which a Bedrock account checks its credentials with and signs
 * in through. Claude itself needs no CLI to call Bedrock, only the
 * credentials the CLI's SSO login leaves behind.
 */
export const awsExecutable = (config: DaedalusConfig): string | undefined =>
  findExecutable(
    config.awsExecutable ?? "aws",
    config.awsExecutable ? [] : standardExecutableFallbacks("aws"),
  );

const AWS_INSTALL = "brew install awscli";

/**
 * Reads `aws sts get-caller-identity`, the cheapest call that proves a
 * profile's credentials work. A failure that names the SSO login or an
 * expired token means signed out: `aws sso login` fixes it. Anything else
 * (no network, a profile that does not exist) is unknown, with AWS's own
 * words, so it is shown but does not stop a session from starting.
 */
export function parseAwsCallerIdentity(result: {
  exitCode: number;
  stdout: string;
  stderr: string;
}): SignIn {
  if (result.exitCode === 0) {
    let arn: string | undefined;
    let account: string | undefined;
    try {
      const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
      arn = text(parsed.Arn);
      account = text(parsed.Account);
    } catch {
      // Signed in all the same; only the detail is missing.
    }
    // An SSO role's ARN ends in the user's name: …/AWSReservedSSO_Role_x/me@co
    const user = arn?.split("/").at(-1);
    return {
      state: "signed-in",
      method: "Amazon Bedrock",
      ...(user ? { email: user } : {}),
      ...(account ? { organization: `AWS ${account}` } : {}),
    };
  }
  const output = (text(result.stderr) ?? text(result.stdout) ?? "").trim();
  if (
    /sso|token.*(expired|invalid)|expired.*token|refresh failed|aws sso login/i.test(
      output,
    )
  )
    return { state: "signed-out", method: "Amazon Bedrock" };
  return {
    state: "unknown",
    method: "Amazon Bedrock",
    detail: output || "AWS did not say whether the profile is signed in",
  };
}

/** The Keychain item an API-key account's key lives in. */
export const API_KEY_SERVICE = "Daedalus Claude API key";

/**
 * An Anthropic API key, as far as it can be checked without using it. Kept
 * to the characters keys are made of, which is also what lets it travel
 * safely through `security -i`.
 */
const API_KEY = /^sk-ant-[A-Za-z0-9_-]{16,}$/;

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
  const profile = accountProfile(config, provider, accountId);
  if (profile?.kind === "bedrock" && profile.aws)
    return checkAwsSignIn(config, profile.aws, run);
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

/** Whether a Bedrock account's AWS profile has working credentials now. */
async function checkAwsSignIn(
  config: DaedalusConfig,
  aws: AwsTarget,
  run: typeof runCommand,
): Promise<SignIn> {
  const executable = awsExecutable(config);
  if (!executable)
    return {
      state: "unknown",
      method: "Amazon Bedrock",
      detail: `The AWS CLI is not installed, so the login cannot be checked. Install it with: ${AWS_INSTALL}`,
    };
  try {
    const result = await run(
      executable,
      ["sts", "get-caller-identity", "--output", "json", ...awsArguments(aws)],
      { timeoutMs: STATUS_TIMEOUT_MS },
    );
    if (result.timedOut)
      return {
        state: "unknown",
        method: "Amazon Bedrock",
        detail: "AWS took too long to report the profile's sign-in status",
      };
    return parseAwsCallerIdentity(result);
  } catch (error) {
    return {
      state: "unknown",
      method: "Amazon Bedrock",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

const awsArguments = (aws: AwsTarget): string[] => [
  "--profile",
  aws.profile,
  "--region",
  aws.region,
];

/**
 * What a Bedrock account's `settings.json` holds: the variables that send
 * Claude to Bedrock, and the command Claude runs on its own when the SSO
 * token has expired, which opens the browser to sign in again.
 */
export const bedrockSettings = (aws: AwsTarget) => ({
  env: {
    CLAUDE_CODE_USE_BEDROCK: "1",
    AWS_PROFILE: aws.profile,
    AWS_REGION: aws.region,
  },
  awsAuthRefresh: `aws sso login --profile ${aws.profile}`,
});

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

/** What `AccountService.forLaunch` chooses an account from. */
export interface LaunchAccountInput {
  /** An account by id or name; `default` or null for the provider's own. */
  requested?: string | null;
  /** The session this launch carries on, or the session itself on a resume. */
  previous?: Pick<AgentSession, "provider" | "account">;
  workspace: Pick<Workspace, "defaultClaudeAccount" | "defaultCodexAccount">;
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
    /** The login Keychain; replaceable so tests never touch the real one. */
    private readonly keychain: {
      write: (
        service: string,
        account: string,
        secret: string,
      ) => Promise<void>;
      remove: (service: string, account: string) => Promise<void>;
    } = { write: writeKeychainPassword, remove: deleteKeychainPassword },
    /** Archives a session; how Remove clears the sessions running on it. */
    private readonly archiveSession?: (sessionId: string) => Promise<unknown>,
  ) {}

  /** Every account, the default ones first. */
  list(): Array<{
    provider: AccountProvider;
    account: string;
    name: string;
    directory: string;
    createdAt: string | null;
    kind: AccountKind;
    /** Claude only: which login Sign in runs. */
    login?: ClaudeLogin;
    /** Bedrock accounts: the AWS profile and region. */
    aws?: AwsTarget;
  }> {
    const defaults = (["claude", "codex"] as const).map((provider) => ({
      ...(provider === "claude"
        ? { login: this.config.defaultLogins.claude ?? "subscription" }
        : {}),
      provider,
      account: DEFAULT_ACCOUNT,
      name: "Default",
      directory:
        provider === "claude" ? this.config.claudeHome : this.config.codexHome,
      createdAt: null,
      kind: "login" as const,
    }));
    const profiles = this.config.accounts.map((profile) => ({
      kind: profile.kind ?? ("login" as const),
      ...(profile.provider === "claude" && (profile.kind ?? "login") === "login"
        ? { login: profile.login ?? ("subscription" as const) }
        : {}),
      ...(profile.aws ? { aws: { ...profile.aws } } : {}),
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
   * The account a session launches on: the one asked for, else its
   * predecessor's when it carries on one on the same provider, else the
   * workspace's default for that provider, else the provider's own. Null is
   * the provider's own account.
   *
   * A workspace default whose profile was removed falls back to the default
   * account, because removing a profile already clears those. A predecessor's
   * account that is gone is refused instead: the conversation the session is
   * meant to carry on lived in that folder.
   *
   * Then refuses an account its provider says is signed out, which would
   * otherwise open a terminal that fails on its first turn. Only a definite
   * "signed out" stops it: a provider too old to say, or one that did not
   * answer, gets the benefit of the doubt.
   */
  async forLaunch(
    provider: AgentProviderName,
    input: LaunchAccountInput,
  ): Promise<string | null> {
    if (provider !== "claude" && provider !== "codex") {
      if (input.requested && input.requested !== DEFAULT_ACCOUNT)
        throw new DaedalusError(
          "VALIDATION",
          "A custom command has no accounts; choose --provider to pick one",
        );
      return null;
    }
    const account = this.pickAccount(provider, input);
    await this.requireSignedIn(provider, account);
    return account;
  }

  private pickAccount(
    provider: AccountProvider,
    input: LaunchAccountInput,
  ): string | null {
    if (input.requested !== undefined)
      return findAccount(this.config, provider, input.requested)?.id ?? null;
    const previous = input.previous;
    if (previous && previous.provider === provider) {
      if (
        previous.account &&
        !accountProfile(this.config, provider, previous.account)
      )
        throw new DaedalusError(
          "CONFLICT",
          `This session ran on the ${providerLabel(provider)} account '${previous.account}', which was removed`,
        );
      return previous.account;
    }
    const preferred =
      provider === "claude"
        ? input.workspace.defaultClaudeAccount
        : input.workspace.defaultCodexAccount;
    return accountProfile(this.config, provider, preferred) ? preferred : null;
  }

  private async requireSignedIn(
    provider: AccountProvider,
    account: string | null,
  ): Promise<void> {
    const signIn = await checkSignIn(this.config, provider, account);
    if (signIn.state !== "signed-out") return;
    const name = accountName(this.config, provider, account);
    if (accountProfile(this.config, provider, account)?.kind === "api-key")
      throw new DaedalusError(
        "DEPENDENCY",
        `The ${name} account has no API key. Set it in Settings → Agents, or pipe it to 'daedal account key claude ${JSON.stringify(name)}'.`,
        { provider, account, reason: "signed-out" },
      );
    const reference = account
      ? ` ${JSON.stringify(accountProfile(this.config, provider, account)?.name ?? account)}`
      : "";
    throw new DaedalusError(
      "DEPENDENCY",
      `${providerLabel(provider)} is not signed in on the ${name} account. Sign in from Settings → Agents, or run 'daedal account login ${provider}${reference}'.`,
      { provider, account: account ?? DEFAULT_ACCOUNT, reason: "signed-out" },
    );
  }

  /**
   * Creates a profile and its folder, and puts Daedalus's skills and writing
   * style where that folder's sessions will look for them. The folder starts
   * empty otherwise: a profile shares no settings with the default account.
   */
  async add(
    provider: string,
    name: string,
    kind: AccountKind = "login",
    login?: ClaudeLogin,
    aws?: AwsTarget,
  ): Promise<AccountProfile> {
    const owner = accountProvider(provider);
    const trimmed = this.validName(owner, name);
    if (kind === "bedrock" && owner !== "claude")
      throw new DaedalusError("VALIDATION", "Bedrock accounts are for Claude");
    if (kind === "bedrock") aws = validAws(aws);
    else if (aws)
      throw new DaedalusError(
        "VALIDATION",
        "An AWS profile is for Bedrock accounts",
      );
    if (login && (owner !== "claude" || kind !== "login"))
      throw new DaedalusError(
        "VALIDATION",
        "A choice of login is for Claude accounts that sign in",
      );
    if (kind === "api-key" && owner !== "claude")
      throw new DaedalusError(
        "VALIDATION",
        "API-key accounts are for Claude; sign Codex in with its own login",
      );
    const profile: AccountProfile = {
      id: profileId(trimmed, new Set(this.config.accounts.map((a) => a.id))),
      provider: owner,
      name: trimmed,
      createdAt: new Date().toISOString(),
      ...(kind !== "login" ? { kind } : {}),
      ...(login ? { login } : {}),
      ...(aws ? { aws } : {}),
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
    if (aws)
      await this.writeClaudeSettings(directory, (settings) =>
        withBedrock(settings, aws),
      );
    await updateSettings(this.config, (config) => ({
      accounts: [...config.accounts, profile],
    }));
    await new SkillService(
      accountConfig(this.config, owner, profile.id),
    ).syncArtifacts();
    return profile;
  }

  /**
   * Changes which of Claude's logins an account's Sign in runs. The default
   * account has one too, kept apart from the profiles.
   */
  async setLogin(
    provider: string,
    reference: string | null | undefined,
    login: ClaudeLogin,
  ): Promise<{
    provider: AccountProvider;
    account: string;
    login: ClaudeLogin;
  }> {
    const owner = accountProvider(provider);
    if (owner !== "claude")
      throw new DaedalusError(
        "VALIDATION",
        "Only Claude has more than one login",
      );
    const profile = findAccount(this.config, owner, reference);
    if (!profile) {
      await updateSettings(this.config, (config) => ({
        defaultLogins: { ...config.defaultLogins, claude: login },
      }));
      return { provider: owner, account: DEFAULT_ACCOUNT, login };
    }
    if (profile.kind === "api-key" || profile.kind === "bedrock")
      throw new DaedalusError(
        "VALIDATION",
        `'${profile.name}' uses ${profile.kind === "bedrock" ? "Bedrock" : "an API key"}, not a Claude login`,
      );
    await updateSettings(this.config, (config) => ({
      accounts: config.accounts.map((entry) =>
        entry.id === profile.id ? { ...entry, login } : entry,
      ),
    }));
    return { provider: owner, account: profile.id, login };
  }

  /**
   * Points a Bedrock account at another AWS profile or region, in Daedalus's
   * record and in the account's `settings.json`. Sessions already running
   * keep the old one until they restart.
   */
  async setAws(
    provider: string,
    reference: string,
    aws: AwsTarget,
  ): Promise<AccountProfile> {
    const owner = accountProvider(provider);
    const profile = this.requireProfile(owner, reference);
    if (profile.kind !== "bedrock")
      throw new DaedalusError(
        "VALIDATION",
        `'${profile.name}' does not use Bedrock`,
      );
    const target = validAws(aws);
    await this.writeClaudeSettings(
      accountDirectory(this.config, profile),
      (settings) => withBedrock(settings, target),
    );
    const changed = { ...profile, aws: target };
    await updateSettings(this.config, (config) => ({
      accounts: config.accounts.map((entry) =>
        entry.id === profile.id ? changed : entry,
      ),
    }));
    return changed;
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
    await updateSettings(this.config, (config) => ({
      accounts: config.accounts.map((entry) =>
        entry.id === profile.id ? renamed : entry,
      ),
    }));
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
  async remove(
    provider: string,
    reference: string,
    options: {
      /** Archive the sessions running on it first, instead of refusing. */
      archiveSessions?: boolean;
    } = {},
  ): Promise<AccountProfile> {
    const owner = accountProvider(provider);
    const profile = this.requireProfile(owner, reference);
    // Only a session that is running holds the account: it would lose its
    // login mid-turn. One that stopped or failed has nothing to lose, and
    // afterwards it says the account was removed if anyone restores it.
    const live = this.repositories
      .listAgents()
      .filter(
        (session) =>
          session.provider === owner &&
          session.account === profile.id &&
          !session.archivedAt &&
          (session.status === "running" || session.status === "starting"),
      );
    // Asked for: the running sessions are archived, so their conversations
    // stop cleanly before the login they run on goes.
    if (live.length && options.archiveSessions && this.archiveSession)
      for (const session of live) await this.archiveSession(session.id);
    else if (live.length)
      throw new DaedalusError(
        "CONFLICT",
        `${live.map((session) => `'${session.name}'`).join(", ")} ${live.length === 1 ? "is" : "are"} running on '${profile.name}'. Stop or archive ${live.length === 1 ? "it" : "them"} before removing the account.`,
        { sessions: live.map((session) => session.id) },
      );
    // Claude keeps the login in the Keychain under a name made from the
    // folder path, so deleting the folder alone would leave it there. An
    // API-key account's key is a Keychain item of Daedalus's own.
    // A Bedrock account holds no login of its own: its AWS SSO session is
    // the whole Mac's, and other tools may be using it.
    const executable = providerExecutable(this.config, owner);
    if (profile.kind === "api-key") await this.clearApiKey(profile);
    else if (executable && profile.kind !== "bedrock") {
      const logout = this.signOutCommand(owner, profile.id);
      await runCommand(logout.executable, logout.args, {
        env: logout.env,
        timeoutMs: STATUS_TIMEOUT_MS,
      }).catch(() => undefined);
    }
    this.repositories.clearWorkspaceDefaultAccount(owner, profile.id);
    await updateSettings(this.config, (config) => ({
      accounts: config.accounts.filter((entry) => entry.id !== profile.id),
    }));
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
    // So a provider installed only on the login shell's PATH (npm under nvm,
    // say) reads as installed rather than missing. Asked only then, because
    // an interactive shell takes a second or more to answer.
    if (
      accounts.some((entry) => !providerExecutable(this.config, entry.provider))
    )
      await loginShellPath();
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
          kind: entry.kind,
          ...(entry.login ? { login: entry.login } : {}),
          ...(entry.aws ? { aws: entry.aws } : {}),
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
  signInCommand(
    provider: string,
    reference?: string | null,
    variant?: SignInVariant,
  ): AccountCommand {
    return this.command(
      provider,
      reference,
      "in",
      variant ?? this.storedLogin(provider, reference),
    );
  }

  /** The login an account was set to sign in with; subscription if none. */
  private storedLogin(
    provider: string,
    reference: string | null | undefined,
  ): SignInVariant {
    if (provider !== "claude") return "subscription";
    const profile = findAccount(this.config, "claude", reference);
    return (
      (profile ? profile.login : this.config.defaultLogins.claude) ??
      "subscription"
    );
  }

  signOutCommand(provider: string, reference?: string | null): AccountCommand {
    return this.command(provider, reference, "out");
  }

  private command(
    provider: string,
    reference: string | null | undefined,
    direction: "in" | "out",
    variant: SignInVariant = "subscription",
  ): AccountCommand {
    const owner = accountProvider(provider);
    const profile = findAccount(this.config, owner, reference);
    if (direction === "in" && profile?.kind === "api-key")
      throw new DaedalusError(
        "VALIDATION",
        `'${profile.name}' uses an API key, not a login; set its key instead`,
      );
    if (profile?.kind === "bedrock" && profile.aws)
      return this.awsCommand(profile, profile.aws, direction);
    if (owner === "codex" && variant !== "subscription")
      throw new DaedalusError(
        "VALIDATION",
        "SSO and Console sign-in are Claude's; Codex has one login",
      );
    const executable = providerExecutable(this.config, owner);
    if (!executable)
      throw new DaedalusError(
        "DEPENDENCY",
        `${providerLabel(owner)} is not installed. Install it with: ${INSTALL_COMMANDS[owner][0]!.command}`,
        { provider: owner },
      );
    const args =
      owner === "claude"
        ? [
            "auth",
            direction === "in" ? "login" : "logout",
            ...(direction === "in" && variant === "sso" ? ["--sso"] : []),
            ...(direction === "in" && variant === "console"
              ? ["--console"]
              : []),
          ]
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
   * A Bedrock account signs in through AWS: `aws sso login` opens the browser
   * for the profile's IAM Identity Center. Signing out is refused, because
   * `aws sso logout` ends every SSO session on the Mac, not this account's.
   */
  private awsCommand(
    profile: AccountProfile,
    aws: AwsTarget,
    direction: "in" | "out",
  ): AccountCommand {
    if (direction === "out")
      throw new DaedalusError(
        "VALIDATION",
        `'${profile.name}' uses the AWS profile '${aws.profile}'. Signing out of AWS SSO ends every SSO session on this Mac; run 'aws sso logout' yourself if that is what you want`,
      );
    const executable = awsExecutable(this.config);
    if (!executable)
      throw new DaedalusError(
        "DEPENDENCY",
        `The AWS CLI is not installed. Install it with: ${AWS_INSTALL}`,
        { provider: "claude" },
      );
    return {
      executable,
      args: ["sso", "login", "--profile", aws.profile],
      env: {},
      title: `AWS sign in · ${profile.name}`,
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
    variant?: SignInVariant,
  ): Promise<IntegratedTerminal> {
    const command = this.signInCommand(provider, reference, variant);
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
    const profile = findAccount(this.config, owner, reference);
    if (profile?.kind === "api-key") {
      await this.clearApiKey(profile);
      return { provider: owner, account: profile.id };
    }
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

  /**
   * Puts an API key on a Claude account made for one. The key goes to the
   * login Keychain, and the account's `settings.json` gets an `apiKeyHelper`
   * that reads it back, so no file Daedalus writes ever holds the key.
   */
  async setApiKey(
    provider: string,
    reference: string,
    key: string,
  ): Promise<AccountProfile> {
    const owner = accountProvider(provider);
    const profile = this.requireProfile(owner, reference);
    if (profile.kind !== "api-key")
      throw new DaedalusError(
        "VALIDATION",
        `'${profile.name}' signs in with a login; add an API-key account to use a key`,
      );
    const trimmed = key.trim();
    if (!API_KEY.test(trimmed))
      throw new DaedalusError(
        "VALIDATION",
        "That does not look like an Anthropic API key (sk-ant-…)",
      );
    const directory = accountDirectory(this.config, profile);
    try {
      await this.keychain.write(API_KEY_SERVICE, directory, trimmed);
    } catch (error) {
      throw new DaedalusError(
        "DEPENDENCY",
        `The Keychain did not take the key: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    await this.writeClaudeSettings(directory, (settings) => ({
      ...settings,
      apiKeyHelper: keychainReadCommand(API_KEY_SERVICE, directory),
    }));
    return profile;
  }

  /** Takes an API-key account's key out of the Keychain and its settings. */
  private async clearApiKey(profile: AccountProfile): Promise<void> {
    const directory = accountDirectory(this.config, profile);
    await this.keychain
      .remove(API_KEY_SERVICE, directory)
      .catch(() => undefined);
    await this.writeClaudeSettings(directory, (settings) => {
      const { apiKeyHelper: _removed, ...rest } = settings;
      return rest;
    });
  }

  /** Rewrites one profile's Claude `settings.json` through `change`. */
  private async writeClaudeSettings(
    directory: string,
    change: (settings: Record<string, unknown>) => Record<string, unknown>,
  ): Promise<void> {
    const path = join(directory, "settings.json");
    const result = await editJson(path, change, { mode: 0o600 });
    if (result.status === "invalid")
      throw new DaedalusError(
        "CONFLICT",
        `${path} is not valid JSON; fix or delete it first`,
      );
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

/** An AWS target as typed, trimmed and checked; refused if malformed. */
function validAws(aws: AwsTarget | undefined): AwsTarget {
  const target = aws && {
    profile: aws.profile?.trim(),
    region: aws.region?.trim(),
  };
  if (!target?.profile)
    throw new DaedalusError(
      "VALIDATION",
      "A Bedrock account needs the AWS profile it signs in with",
    );
  if (!target.region)
    throw new DaedalusError(
      "VALIDATION",
      "A Bedrock account needs the AWS region to call Bedrock in",
    );
  if (!isAwsTarget(target))
    throw new DaedalusError(
      "VALIDATION",
      "That AWS profile or region has characters AWS does not use in them",
    );
  return target;
}

/** Settings with the Bedrock block set, and any other `env` entry kept. */
function withBedrock(
  settings: Record<string, unknown>,
  aws: AwsTarget,
): Record<string, unknown> {
  const block = bedrockSettings(aws);
  const env =
    settings.env && typeof settings.env === "object"
      ? (settings.env as Record<string, unknown>)
      : {};
  return { ...settings, ...block, env: { ...env, ...block.env } };
}
