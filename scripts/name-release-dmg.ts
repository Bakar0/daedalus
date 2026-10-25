// Gives the DMG the name release assets and the Homebrew cask expect.
//
// Electrobun 1 wrote artifacts/stable-macos-<arch>-Daedalus.dmg, like the
// tarball, update.json and patch. Electrobun 2 drops the channel prefix from
// the DMG only (artifacts/macos-<arch>-Daedalus.dmg). The release workflow, the
// cask and the download links in the docs all use the prefixed name, so
// `build:stable` renames the DMG after the build.
import { existsSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";

const artifacts = resolve(import.meta.dir, "..", "artifacts");
const arch = process.arch === "x64" ? "x64" : "arm64";
const unprefixed = join(artifacts, `macos-${arch}-Daedalus.dmg`);
const expected = join(artifacts, `stable-macos-${arch}-Daedalus.dmg`);

if (existsSync(unprefixed)) {
  renameSync(unprefixed, expected);
  console.log(`Renamed ${unprefixed} to ${expected}`);
} else if (!existsSync(expected)) {
  console.error(`No DMG found at ${unprefixed} or ${expected}`);
  process.exit(1);
}
