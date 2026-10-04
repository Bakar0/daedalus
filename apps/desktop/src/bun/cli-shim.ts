import { chmod, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { ensureDirectory } from "@daedalus/platform";

const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/**
 * The shim names its home. It lives inside one channel's home, and the
 * `DAEDALUS_HOME` it would otherwise inherit can belong to another channel:
 * a Claude session moved into the background runs its commands with another
 * session's environment, and the CLI would then open that channel's database.
 */
export function cliShimContents(
  bunExecutable: string,
  cliEntrypoint: string,
  home?: string,
): string {
  const env = home ? `DAEDALUS_HOME=${shellQuote(home)} ` : "";
  return `#!/bin/sh\n${env}exec ${shellQuote(bunExecutable)} ${shellQuote(cliEntrypoint)} "$@"\n`;
}

export async function installCliShim(input: {
  path: string;
  bunExecutable: string;
  cliEntrypoint: string;
  home?: string;
}): Promise<void> {
  await ensureDirectory(dirname(input.path));
  await writeFile(
    input.path,
    cliShimContents(input.bunExecutable, input.cliEntrypoint, input.home),
    "utf8",
  );
  await chmod(input.path, 0o755);
}
