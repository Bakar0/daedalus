// Electrobun's postBuild hook: puts the tmux from scripts/build-tmux.ts into
// the bundle.
//
// It goes in Contents/MacOS rather than through `build.copy`, which writes
// under Resources/app. Electrobun signs every executable in Contents/MacOS and
// nothing else it did not put there itself, and notarization rejects a bundle
// that holds an unsigned binary. The hook runs before the bundle is hashed
// and signed, so the copy is part of both.
//
// A stable or canary build without tmux fails here: that build is the one
// users download, and without tmux it would start no agents on a Mac that
// lacks one. A dev build without it only warns and searches PATH as before.
import { chmod, copyFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const environment = process.env;
const buildDirectory = environment["ELECTROBUN_BUILD_DIR"];
const appName = environment["ELECTROBUN_APP_NAME"];
const arch = environment["ELECTROBUN_ARCH"];
const channel = environment["ELECTROBUN_BUILD_ENV"];
if (
  !buildDirectory ||
  !appName ||
  !arch ||
  environment["ELECTROBUN_OS"] !== "macos"
) {
  console.log("postBuild: not a macOS build; nothing to add");
  process.exit(0);
}

const source = resolve(import.meta.dir, "..", "build", "tmux", arch, "tmux");
if (!(await Bun.file(source).exists())) {
  const message = `postBuild: no bundled tmux at ${source}. Run \`bun run scripts/build-tmux.ts --arch ${arch}\` first.`;
  if (channel === "dev") {
    console.warn(`${message} This dev build will use tmux from PATH.`);
    process.exit(0);
  }
  console.error(message);
  process.exit(1);
}

const destination = join(
  buildDirectory,
  `${appName}.app`,
  "Contents",
  "MacOS",
  "tmux",
);
await copyFile(source, destination);
await chmod(destination, 0o755);
console.log(`postBuild: bundled ${source} as ${destination}`);
