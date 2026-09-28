// Puts the `daedal` launcher (apps/desktop/launcher/daedal) into a bundle at
// Contents/Resources/bin/daedal, where the Homebrew cask links it onto PATH.
//
// It goes in Resources, not MacOS: Electrobun signs everything in
// Contents/MacOS as code, and a shell script signed that way carries its
// signature in extended attributes, which notarization rejects. Resources is
// sealed as data by the bundle's own signature.
import { chmod, copyFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

export const LAUNCHER_SOURCE = resolve(
  import.meta.dir,
  "..",
  "apps",
  "desktop",
  "launcher",
  "daedal",
);

export const LAUNCHER_PATH_IN_BUNDLE = join(
  "Contents",
  "Resources",
  "bin",
  "daedal",
);

export async function installLauncher(bundle: string): Promise<string> {
  const destination = join(bundle, LAUNCHER_PATH_IN_BUNDLE);
  await mkdir(join(destination, ".."), { recursive: true });
  await copyFile(LAUNCHER_SOURCE, destination);
  await chmod(destination, 0o755);
  return destination;
}
