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
  daedal account add <claude|codex> <name>
  daedal account rename <claude|codex> <account> <name>
  daedal account remove <claude|codex> <account> --force
  daedal account login <claude|codex> [<account>]
  daedal account logout <claude|codex> [<account>]

An account is a provider configuration folder of its own, so sessions can run
on more than one Claude or Codex account. Each provider has a Default account,
which is whatever it uses with nothing set (~/.claude, ~/.codex). An added
account is an empty folder under the Daedalus home that shares no settings,
plugins or memory with the default one; Daedalus links its own skills into it.

<account> is the name or id; 'default' is the default account. Daedalus never
stores credentials: 'account login' runs the provider's own sign-in in this
terminal (claude auth login, codex login) pointed at that folder.

A session runs on the account it was spawned on for its whole life, through
restore, revive and handoff. 'agent spawn --account' picks one; without it a
session uses the workspace's default for that provider
('workspace update --default-claude-account', '--default-codex-account'),
else the Default account. Spawning on an account its provider reports as
signed out is refused.

'account remove' signs the account out and deletes its folder. It is refused
while a session that is not archived runs on it.`;

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
    const parsed = parseArguments(args, []);
    expectPositionals(
      parsed.positionals,
      2,
      "daedal account add <claude|codex> <name>",
    );
    const result = await context.accounts.add(
      parsed.positionals[0]!,
      parsed.positionals[1]!,
    );
    printResult(result, json, () =>
      console.log(
        `Added ${result.provider} account ${result.name} (${result.id}). Sign it in with: daedal account login ${result.provider} ${JSON.stringify(result.name)}`,
      ),
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
    const parsed = parseArguments(args, [], ["force"]);
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
    );
    printResult(result, json, () =>
      console.log(`Removed ${result.provider} account ${result.name}`),
    );
    return 0;
  }
  if (action === "login" || action === "logout") {
    const parsed = parseArguments(args, []);
    if (parsed.positionals.length < 1 || parsed.positionals.length > 2)
      throw new DaedalusError(
        "VALIDATION",
        `Usage: daedal account ${action} <claude|codex> [<account>]`,
      );
    const [provider, account] = parsed.positionals;
    const command =
      action === "login"
        ? context.accounts.signInCommand(provider!, account)
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
