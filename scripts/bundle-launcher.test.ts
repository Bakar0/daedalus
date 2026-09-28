import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { installLauncher } from "./bundle-launcher";

let root: string | undefined;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

/**
 * A bundle laid out like Daedalus.app, in a folder with a space in its name,
 * with `daedal` linked from elsewhere the way Homebrew links it. Its "bun"
 * echoes what it was asked to run.
 */
async function fakeInstall(options: { unpacked: boolean }) {
  // Resolved, as the launcher resolves its own path: /var is /private/var.
  root = await realpath(await mkdtemp(join(tmpdir(), "daedal launcher ")));
  const bundle = join(root, "Apps", "Daedalus.app");
  await installLauncher(bundle);
  if (options.unpacked) {
    await mkdir(join(bundle, "Contents", "MacOS"), { recursive: true });
    await mkdir(join(bundle, "Contents", "Resources", "app", "cli"), {
      recursive: true,
    });
    const bun = join(bundle, "Contents", "MacOS", "bun");
    await writeFile(bun, '#!/bin/sh\nprintf "%s|" "$@"\n');
    await chmod(bun, 0o755);
    await writeFile(
      join(bundle, "Contents", "Resources", "app", "cli", "daedal.js"),
      "",
    );
  }
  const link = join(root, "bin", "daedal");
  await mkdir(join(root, "bin"));
  await symlink(join(bundle, "Contents", "Resources", "bin", "daedal"), link);
  return { bundle, link };
}

describe("daedal launcher", () => {
  test("runs the app's CLI on the app's bun, through a link", async () => {
    const { bundle, link } = await fakeInstall({ unpacked: true });
    const run = Bun.spawnSync([link, "agent", "list", "--json"]);
    expect(run.exitCode).toBe(0);
    expect(run.stdout.toString()).toBe(
      `${join(bundle, "Contents", "Resources", "app", "cli", "daedal.js")}|agent|list|--json|`,
    );
  });

  test("before the first launch, says to open the app", async () => {
    // What Homebrew installs is a wrapper that unpacks the app on first
    // open, so there is no bun or CLI yet.
    const { link } = await fakeInstall({ unpacked: false });
    const run = Bun.spawnSync([link, "doctor"]);
    expect(run.exitCode).toBe(69);
    expect(run.stderr.toString()).toContain(
      "open Daedalus once to finish installing it",
    );
  });
});
