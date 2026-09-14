import { chmod, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { ensureDirectory } from "@daedalus/platform";

const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

export function cliShimContents(
  bunExecutable: string,
  cliEntrypoint: string,
): string {
  return `#!/bin/sh\nexec ${shellQuote(bunExecutable)} ${shellQuote(cliEntrypoint)} "$@"\n`;
}

export async function installCliShim(input: {
  path: string;
  bunExecutable: string;
  cliEntrypoint: string;
}): Promise<void> {
  await ensureDirectory(dirname(input.path));
  await writeFile(
    input.path,
    cliShimContents(input.bunExecutable, input.cliEntrypoint),
    "utf8",
  );
  await chmod(input.path, 0o755);
}
