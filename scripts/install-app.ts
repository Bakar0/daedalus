// Installs the stable build as the machine's Daedalus.
//
// The app that gets installed is deliberately the stable channel only. A dev or
// canary build carries a different bundle identifier and its own home, so it is
// meant to sit alongside this one rather than replace it, and installing one
// over the other would defeat the point of having channels at all.
import { cp, mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const SOURCE = resolve(
  import.meta.dir,
  "..",
  "build",
  `stable-macos-${process.arch === "x64" ? "x64" : "arm64"}`,
  "Daedalus.app",
);

// ~/Applications needs no administrator rights, which keeps `app:install`
// runnable without sudo. macOS treats it as a normal application folder.
const DESTINATION = join(homedir(), "Applications", "Daedalus.app");

if (!(await Bun.file(join(SOURCE, "Contents", "Info.plist")).exists())) {
  console.error(
    `No stable build at ${SOURCE}. Run \`bun run build:stable\` first.`,
  );
  process.exit(1);
}

const running = Bun.spawnSync(["pgrep", "-f", "Daedalus.app/Contents/MacOS"]);
if (running.exitCode === 0) {
  console.error(
    "Daedalus is running. Quit it first — replacing a running bundle leaves it in a half-updated state.",
  );
  process.exit(4);
}

await mkdir(join(homedir(), "Applications"), { recursive: true });
await rm(DESTINATION, { recursive: true, force: true });
await cp(SOURCE, DESTINATION, { recursive: true });
console.log(`Installed ${DESTINATION}`);
