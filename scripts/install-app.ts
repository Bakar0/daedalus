// Installs the stable build as the machine's Daedalus.
//
// The app that gets installed is deliberately the stable channel only. A dev or
// canary build carries a different bundle identifier and its own home, so it is
// meant to sit alongside this one rather than replace it, and installing one
// over the other would defeat the point of having channels at all.
import { cp, mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { STABLE_IDENTIFIER } from "../electrobun.config";
import { LSREGISTER, staleRegistrations } from "./launch-services";

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

// `pgrep -f` is the obvious check here and the wrong one: it was observed
// matching a long-running `npm exec` process whose argv contained no such path,
// on strings that existed only in that process's environment (COLORTERM,
// DAEDALUS_WORKSPACE_ID). Every agent session Daedalus spawns exports
// COTTONTAIL_ELECTROBUN_DIST, which carries a .../Daedalus.app/Contents/MacOS
// path, so a descendant process can read as a running app long after the app
// has quit — blocking installs with the app closed. `ps` reports argv alone,
// and matching the install destination rather than any bundle keeps the check
// to what actually matters: is the bundle we are about to overwrite executing.
const processes = Bun.spawnSync(["ps", "-Ao", "command="]);
const bundleExecutables = join(DESTINATION, "Contents", "MacOS");
const running = processes.stdout
  .toString()
  .split("\n")
  .some((line) => line.includes(bundleExecutables));
if (running) {
  console.error(
    "Daedalus is running. Quit it first — replacing a running bundle leaves it in a half-updated state.",
  );
  process.exit(4);
}

await mkdir(join(homedir(), "Applications"), { recursive: true });
await rm(DESTINATION, { recursive: true, force: true });
await cp(SOURCE, DESTINATION, { recursive: true });
console.log(`Installed ${DESTINATION}`);

// Unregistering only forgets a path; no file is touched, and opening one of
// those builds again registers it again. A failure here leaves the install
// good and the alerts possibly wrong, so it warns instead of failing.
const dump = Bun.spawnSync([LSREGISTER, "-dump"]);
if (dump.exitCode === 0) {
  const stale = staleRegistrations(
    dump.stdout.toString(),
    STABLE_IDENTIFIER,
    DESTINATION,
  );
  for (const path of stale) Bun.spawnSync([LSREGISTER, "-u", path]);
  Bun.spawnSync([LSREGISTER, "-f", DESTINATION]);
  if (stale.length)
    console.log(
      `Unregistered ${stale.length} other ${STABLE_IDENTIFIER} bundle(s) from Launch Services`,
    );
} else {
  console.warn(
    "Could not read Launch Services; older builds may still be registered.",
  );
}
