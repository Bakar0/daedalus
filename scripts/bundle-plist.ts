// Electrobun's `postBuild` script: adds the Info.plist keys its template has
// no slot for.
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
// It has to run here and not after the build. A stable build is a
// self-extracting wrapper: the real bundle is archived into
// `Resources/<hash>.tar.zst`, and the launcher unpacks it over the wrapper on
// first run, Info.plist included. Patching the wrapper's plist after the build
// therefore lasted exactly until the first launch. `postBuild` runs after
// Electrobun writes the real bundle and before it archives it, so the key
// ships inside the archive. Electrobun passes the build folder and app name in
// the environment.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

// As `postWrap` it receives the wrapper's path and patches that instead, so a
// stable bundle reads the same before and after its first launch.
const wrapper = process.env.ELECTROBUN_WRAPPER_BUNDLE_PATH;
const buildDir = process.env.ELECTROBUN_BUILD_DIR;
const appName = process.env.ELECTROBUN_APP_NAME;
if (!wrapper && (!buildDir || !appName)) {
  console.error(
    "bundle-plist runs as Electrobun's postBuild or postWrap script; ELECTROBUN_BUILD_DIR and ELECTROBUN_APP_NAME are missing.",
  );
  process.exit(1);
}

// The app name Electrobun exports is sanitised for file names, which for
// "Daedalus" and "Daedalus-dev" is the bundle name itself. Should they ever
// differ, a build folder holds exactly one bundle at this point.
const candidates = wrapper
  ? [wrapper]
  : [
      join(buildDir!, `${appName}.app`),
      ...readdirSync(buildDir!)
        .filter((entry) => entry.endsWith(".app"))
        .map((entry) => join(buildDir!, entry)),
    ];
const bundle = candidates.find((path) =>
  existsSync(join(path, "Contents", "Info.plist")),
);
if (!bundle) {
  console.error(
    `No app bundle with an Info.plist under ${wrapper ?? buildDir}.`,
  );
  process.exit(1);
}
const plist = join(bundle, "Contents", "Info.plist");

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

console.log(`Patched ${plist}: ${keys.map((it) => it.key).join(", ")}`);
