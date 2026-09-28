// Electrobun's postWrap hook, for stable and canary builds: puts the `daedal`
// launcher into the self-unpacking wrapper as well.
//
// Homebrew installs the wrapper, which holds only a launcher and a tarball
// until the app is first opened, and the cask links `daedal` from the
// bundle straight away. Homebrew refuses to link a file that is not there,
// so the wrapper needs the launcher too. Run before the first launch, the
// launcher says to open Daedalus once; after it, the unpacked app has its
// own copy from postBuild at the same path.
import { installLauncher } from "./bundle-launcher";

const wrapper = process.env["ELECTROBUN_WRAPPER_BUNDLE_PATH"];
if (!wrapper || process.env["ELECTROBUN_OS"] !== "macos") {
  console.log("postWrap: not a macOS wrapper; nothing to add");
  process.exit(0);
}
console.log(`postWrap: added ${await installLauncher(wrapper)}`);
