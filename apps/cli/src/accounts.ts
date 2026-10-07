import {
  accountProvider,
  DaedalusError,
  INSTALL_COMMANDS,
  type AccountStatus,
  type ApplicationContext,
} from "@daedalus/core";
import { runCommand } from "@daedalus/platform";
import type { DoctorCheck } from "@daedalus/protocol";
import { expectPositionals, parseArguments, printResult } from "./arguments";

export const accountHelp = `Account commands:
  daedal account list
  daedal account status [<claude|codex> [<account>]]
  daedal account add <claude|codex> <name> [--api-key | --sso | --console]
  daedal account method claude <account> <subscription|sso|console>
  daedal account key claude <account>          (reads the key from stdin)
  daedal account rename <claude|codex> <account> <name>
  daedal account remove <claude|codex> <account> --force [--archive-sessions]
  daedal account login <claude|codex> [<account>] [--sso | --console]
  daedal account logout <claude|codex> [<account>]

An account is a provider configuration folder of its own, so sessions can run
on more than one Claude or Codex account. Each provider has a Default account,
which is whatever it uses with nothing set (~/.claude, ~/.codex). An added
account is an empty folder under the Daedalus home that shares no settings,
plugins or memory with the default one; Daedalus links its own skills into it.

<account> is the name or id; 'default' is the default account. 'account login'
runs the provider's own sign-in in this terminal (claude auth login, codex
login) pointed at that folder. A Claude account remembers which of its
logins it uses (a Claude subscription, SSO or the Anthropic Console): set it
when adding with --sso or --console, or later with 'account method'; --sso or
--console on 'account login' overrides it once.

'account add claude <name> --api-key' makes an account that uses an Anthropic
API key instead of a login. 'account key' reads the key from standard input,
never from an argument, and stores it in the macOS login Keychain; the
account's settings.json gets an apiKeyHelper that reads it from there, so no
file holds the key. 'account logout' on such an account removes the key.

A session runs on the account it was spawned on for its whole life, through
restore, revive and handoff. 'agent spawn --account' picks one; without it a
session uses the workspace's default for that provider
('workspace update --default-claude-account', '--default-codex-account'),
else the Default account. Spawning on an account its provider reports as
signed out is refused.

'account remove' signs the account out and deletes its folder. It is refused
while a session is running on it, unless --archive-sessions archives those
sessions first. Settings → Agents' Remove does that.`;

function stateLine(status: AccountStatus): string {
  if (status.state === "missing") return "not installed";
  if (status.state === "signed-out") return "signed out";
  if (status.state === "unknown")
    return `status unknown${status.detail ? ` (${status.detail})` : ""}`;
  return [
    "signed in",
    status.email,
    status.method,
    status.plan,
    status.organization,
  ]
    .filter(Boolean)
    .join(" · ");
}

function printStatuses(statuses: AccountStatus[]): void {
  for (const status of statuses) {
    console.log(
      `${status.provider}\t${status.name}\t${stateLine(status)}\t${status.directory}`,
    );
    if (status.state === "missing")
      for (const install of INSTALL_COMMANDS[status.provider])
        console.log(`  install (${install.label}): ${install.command}`);
  }
}

export async function accountCommand(
  context: ApplicationContext,
  args: string[],
  json: boolean,
): Promise<number> {
  const action = args.shift();
  if (!action || action === "help" || action === "--help") {
    console.log(accountHelp);
    return 0;
  }
  if (action === "list") {
    const parsed = parseArguments(args, []);
    expectPositionals(parsed.positionals, 0, "daedal account list");
    const result = context.accounts.list();
    printResult(result, json, () => {
      for (const item of result)
        console.log(
          `${item.provider}\t${item.account}\t${item.name}\t${item.directory}`,
        );
    });
    return 0;
  }
  if (action === "status") {
    const parsed = parseArguments(args, []);
    if (parsed.positionals.length > 2)
      throw new DaedalusError(
        "VALIDATION",
        "Usage: daedal account status [<claude|codex> [<account>]]",
      );
    const [provider, account] = parsed.positionals;
    const result = await context.accounts.status({
      ...(provider ? { provider } : {}),
      ...(account ? { account } : {}),
    });
    printResult(result, json, () => printStatuses(result));
    return 0;
  }
  if (action === "add") {
    const parsed = parseArguments(args, [], ["api-key", "sso", "console"]);
    expectPositionals(
      parsed.positionals,
      2,
      "daedal account add <claude|codex> <name> [--api-key | --sso | --console]",
    );
    if (
      [...parsed.flags].filter((flag) =>
        ["api-key", "sso", "console"].includes(flag),
      ).length > 1
    )
      throw new DaedalusError(
        "VALIDATION",
        "Choose one of --api-key, --sso and --console",
      );
    const result = await context.accounts.add(
      parsed.positionals[0]!,
      parsed.positionals[1]!,
      parsed.flags.has("api-key") ? "api-key" : "login",
      parsed.flags.has("sso")
        ? "sso"
        : parsed.flags.has("console")
          ? "console"
          : undefined,
    );
    printResult(result, json, () =>
      console.log(
        result.kind === "api-key"
          ? `Added ${result.provider} account ${result.name} (${result.id}). Give it its key with: daedal account key ${result.provider} ${JSON.stringify(result.name)}`
          : `Added ${result.provider} account ${result.name} (${result.id}). Sign it in with: daedal account login ${result.provider} ${JSON.stringify(result.name)}`,
      ),
    );
    return 0;
  }
  if (action === "method") {
    const parsed = parseArguments(args, []);
    expectPositionals(
      parsed.positionals,
      3,
      "daedal account method claude <account> <subscription|sso|console>",
    );
    const [provider, account, login] = parsed.positionals;
    if (login !== "subscription" && login !== "sso" && login !== "console")
      throw new DaedalusError(
        "VALIDATION",
        "The method must be subscription, sso or console",
      );
    const result = await context.accounts.setLogin(provider!, account, login);
    printResult(result, json, () =>
      console.log(`${account} now signs in with ${login}`),
    );
    return 0;
  }
  if (action === "key") {
    const parsed = parseArguments(args, []);
    expectPositionals(
      parsed.positionals,
      2,
      "daedal account key claude <account>  (the key on standard input)",
    );
    if (process.stdin.isTTY)
      console.error("Paste the API key, then press Return and Ctrl-D:");
    const key = (await Bun.stdin.text()).trim();
    if (!key)
      throw new DaedalusError(
        "VALIDATION",
        "No key on standard input. Pipe it in, for example from a password manager",
      );
    const result = await context.accounts.setApiKey(
      parsed.positionals[0]!,
      parsed.positionals[1]!,
      key,
    );
    printResult(result, json, () =>
      console.log(`Stored the key for ${result.name} in the Keychain`),
    );
    return 0;
  }
  if (action === "rename") {
    const parsed = parseArguments(args, []);
    expectPositionals(
      parsed.positionals,
      3,
      "daedal account rename <claude|codex> <account> <name>",
    );
    const result = await context.accounts.rename(
      parsed.positionals[0]!,
      parsed.positionals[1]!,
      parsed.positionals[2]!,
    );
    printResult(result, json, () =>
      console.log(
        `Renamed ${result.provider} account ${result.id} to ${result.name}`,
      ),
    );
    return 0;
  }
  if (action === "remove") {
    const parsed = parseArguments(args, [], ["force", "archive-sessions"]);
    expectPositionals(
      parsed.positionals,
      2,
      "daedal account remove <claude|codex> <account> --force",
    );
    if (!parsed.flags.has("force"))
      throw new DaedalusError(
        "VALIDATION",
        "Removing an account signs it out and deletes its folder; pass --force",
      );
    const result = await context.accounts.remove(
      parsed.positionals[0]!,
      parsed.positionals[1]!,
      { archiveSessions: parsed.flags.has("archive-sessions") },
    );
    printResult(result, json, () =>
      console.log(`Removed ${result.provider} account ${result.name}`),
    );
    return 0;
  }
  if (action === "logout") {
    const parsed = parseArguments(args, []);
    if (parsed.positionals.length < 1 || parsed.positionals.length > 2)
      throw new DaedalusError(
        "VALIDATION",
        "Usage: daedal account logout <claude|codex> [<account>]",
      );
    const [provider, account] = parsed.positionals;
    // An API-key account has no login to end; its key is what goes.
    if (
      provider === "claude" &&
      account &&
      context.accounts
        .list()
        .some(
          (item) =>
            item.provider === "claude" &&
            item.kind === "api-key" &&
            (item.account === account ||
              item.name.toLowerCase() === account.toLowerCase()),
        )
    ) {
      const result = await context.accounts.signOut(provider, account);
      printResult(result, json, () =>
        console.log(`Removed the API key from ${account}`),
      );
      return 0;
    }
  }
  if (action === "login" || action === "logout") {
    const parsed = parseArguments(args, [], ["sso", "console"]);
    if (parsed.flags.has("sso") && parsed.flags.has("console"))
      throw new DaedalusError(
        "VALIDATION",
        "Choose --sso or --console, not both",
      );
    // No flag: the method the account was set to sign in with.
    const variant = parsed.flags.has("sso")
      ? ("sso" as const)
      : parsed.flags.has("console")
        ? ("console" as const)
        : undefined;
    if (parsed.positionals.length < 1 || parsed.positionals.length > 2)
      throw new DaedalusError(
        "VALIDATION",
        `Usage: daedal account ${action} <claude|codex> [<account>]`,
      );
    const [provider, account] = parsed.positionals;
    const command =
      action === "login"
        ? context.accounts.signInCommand(provider!, account, variant)
        : context.accounts.signOutCommand(provider!, account);
    // The provider's own command, in this terminal, so it can open the
    // browser and ask what it needs to.
    const result = await runCommand(command.executable, command.args, {
      env: command.env,
      stdin: "inherit",
      stdout: json ? "pipe" : "inherit",
      stderr: json ? "pipe" : "inherit",
    });
    const [status] = await context.accounts.status({
      provider: accountProvider(provider!),
      ...(account ? { account } : {}),
    });
    if (json)
      console.log(
        JSON.stringify(
          result.exitCode === 0
            ? { ok: true, data: status }
            : {
                ok: false,
                error: {
                  code: "DEPENDENCY",
                  message:
                    result.stderr.trim() ||
                    result.stdout.trim() ||
                    `${command.title} failed`,
                },
              },
        ),
      );
    else if (status) printStatuses([status]);
    return result.exitCode === 0 ? 0 : 5;
  }
  throw new DaedalusError("VALIDATION", `Unknown account command '${action}'`);
}

/**
 * One check per account for `daedal doctor`. A provider that is not
 * installed passes, because nobody has to use both; an installed one that
 * is signed out fails, because every session started on it would.
 */
export async function accountChecks(
  context: ApplicationContext,
): Promise<DoctorCheck[]> {
  const statuses = await context.accounts.status();
  return statuses.map((status) => ({
    name: `${status.provider} account ${status.name}`,
    ok: status.state !== "signed-out",
    detail:
      status.state === "signed-out"
        ? `signed out; run 'daedal account login ${status.provider}${status.account === "default" ? "" : ` ${JSON.stringify(status.name)}`}'`
        : status.state === "missing"
          ? `not installed; ${INSTALL_COMMANDS[status.provider][0]!.command}`
          : stateLine(status),
  }));
}
