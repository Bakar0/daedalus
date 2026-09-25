// Adds the Info.plist keys Electrobun's template has no slot for.
//
// The one that matters is `LSAppNapIsDisabled`. Without it macOS puts the host
// into App Nap once its window is hidden, occluded or behind a sleeping display:
// timers that ran every 1.2 s were observed firing once every one to two
// minutes. The host's presence heartbeat is one of those timers, and a `daedal`
// hook that reads a heartbeat older than eight seconds concludes there is no
// app, sends its alert through AppleScript, and macOS labels it Script Editor.
// A napping Daedalus therefore produced Script Editor notifications for every
// permission prompt while it sat right there in the Dock.
//
// Electrobun writes Info.plist from a fixed template with no hook for extra
// keys, so this runs after `electrobun build` and edits the bundle in place.
// It takes the same `--env=<channel>` flag as the build.
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const channel = (() => {
  const flag = process.argv
    .find((argument) => argument.startsWith("--env="))
    ?.slice("--env=".length);
  return flag === "stable" || flag === "canary" ? flag : "dev";
})();

const arch = process.arch === "x64" ? "x64" : "arm64";
const bundleName =
  channel === "stable" ? "Daedalus.app" : `Daedalus-${channel}.app`;
const plist = resolve(
  import.meta.dir,
  "..",
  "build",
  `${channel}-macos-${arch}`,
  bundleName,
  "Contents",
  "Info.plist",
);

if (!existsSync(plist)) {
  console.error(`No Info.plist at ${plist}. Run the ${channel} build first.`);
  process.exit(1);
}

const PLIST_BUDDY = "/usr/libexec/PlistBuddy";
const keys: Array<{ key: string; type: "bool"; value: string }> = [
  { key: "LSAppNapIsDisabled", type: "bool", value: "true" },
];

for (const { key, type, value } of keys) {
  // `Add` fails when the key exists and `Set` fails when it does not, so the
  // key is removed first; a missing key makes `Delete` fail, which is fine.
  Bun.spawnSync([PLIST_BUDDY, "-c", `Delete :${key}`, plist]);
  const result = Bun.spawnSync([
    PLIST_BUDDY,
    "-c",
    `Add :${key} ${type} ${value}`,
    plist,
  ]);
  if (result.exitCode !== 0) {
    console.error(
      `PlistBuddy failed to add ${key}: ${result.stderr.toString().trim()}`,
    );
    process.exit(result.exitCode);
  }
}

console.log(
  `Patched ${join(bundleName, "Contents", "Info.plist")}: ${keys.map((it) => it.key).join(", ")}`,
);
