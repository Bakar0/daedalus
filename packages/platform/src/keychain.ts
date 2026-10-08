import { runCommand } from "./process";

const SECURITY = "/usr/bin/security";

/**
 * What can go inside one double-quoted word of a `security -i` command line.
 * The tool splits its input like a shell, so a quote, a backslash or a line
 * break would end the word early or start another command.
 */
const SAFE_WORD = /^[^"\\\r\n]+$/;

function assertSafe(label: string, value: string): void {
  if (!SAFE_WORD.test(value))
    throw new Error(`${label} cannot contain quotes, backslashes or newlines`);
}

/**
 * Stores a password in the login Keychain, replacing any item with the same
 * service and account.
 *
 * The secret goes to `security` on standard input, as a line of its
 * interactive mode, never as an argument: arguments are visible to every
 * process on the machine for as long as the command runs.
 */
export async function writeKeychainPassword(
  service: string,
  account: string,
  secret: string,
  run: typeof runCommand = runCommand,
): Promise<void> {
  assertSafe("A Keychain service", service);
  assertSafe("A Keychain account", account);
  assertSafe("A Keychain secret", secret);
  const result = await run(SECURITY, ["-i"], {
    stdin: `add-generic-password -U -s "${service}" -a "${account}" -w "${secret}"\n`,
    timeoutMs: 10_000,
  });
  // `security -i` exits 0 even when a command in it failed, and says so on
  // standard error.
  if (result.exitCode !== 0 || result.stderr.trim())
    throw new Error(
      result.stderr.trim() || "The Keychain did not accept the password",
    );
}

/** Removes a password from the login Keychain; a missing item is not an error. */
export async function deleteKeychainPassword(
  service: string,
  account: string,
  run: typeof runCommand = runCommand,
): Promise<void> {
  await run(
    SECURITY,
    ["delete-generic-password", "-s", service, "-a", account],
    {
      timeoutMs: 10_000,
    },
  );
}

/** Whether the login Keychain holds a password for this service and account. */
export async function hasKeychainPassword(
  service: string,
  account: string,
  run: typeof runCommand = runCommand,
): Promise<boolean> {
  const result = await run(
    SECURITY,
    ["find-generic-password", "-s", service, "-a", account],
    { timeoutMs: 10_000 },
  );
  return result.exitCode === 0;
}

/**
 * A shell command that prints the password, for a program that takes its
 * secret from a command, such as Claude Code's `apiKeyHelper`. Every value is
 * single-quoted, so a space or a dollar sign in a path stays literal.
 */
export function keychainReadCommand(service: string, account: string): string {
  const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
  return `${SECURITY} find-generic-password -s ${quote(service)} -a ${quote(account)} -w`;
}

/**
 * The password of a login Keychain item, or undefined when there is none.
 * `security` prints it on standard output with a newline after it, which is
 * dropped. A password that is not printable text comes back as hex, so a
 * caller storing arbitrary bytes encodes them itself.
 */
export async function readKeychainPassword(
  service: string,
  account: string,
  run: typeof runCommand = runCommand,
): Promise<string | undefined> {
  const result = await run(
    SECURITY,
    ["find-generic-password", "-s", service, "-a", account, "-w"],
    { timeoutMs: 10_000 },
  );
  if (result.exitCode !== 0) return undefined;
  return result.stdout.replace(/\n$/, "");
}
