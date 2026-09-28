# Releasing

A release is a git tag. Pushing `v<version>` runs `.github/workflows/release.yml`, which builds the stable app on an Apple silicon runner and an Intel runner, publishes a GitHub release, and updates the Homebrew cask.

## Cutting a release

1. Set `version` in `package.json` to the new version, for example `0.9.0`, and merge that to `main`. The app offers an update only when the released version is higher than the running one, so every release needs a new version.
2. Tag the merge commit and push the tag:

   ```sh
   git tag v0.9.0 && git push origin v0.9.0
   ```

The workflow refuses a tag that does not match `package.json`.

## What a release contains

For each architecture (`arm64`, `x64`):

| Asset                                      | Read by                                   |
| ------------------------------------------ | ----------------------------------------- |
| `stable-macos-<arch>-Daedalus.dmg`         | people downloading by hand, and the cask  |
| `stable-macos-<arch>-update.json`          | the app's update check                    |
| `stable-macos-<arch>-Daedalus.app.tar.zst` | the app's update download                 |
| `stable-macos-<arch>-<hash>.patch`         | the app's update download, when it exists |

and `daedalus.rb`, the cask as written for this release.

The app reads its feed from `https://github.com/Bakar0/daedalus/releases/latest/download/` (`RELEASE_BASE_URL` in `electrobun.config.ts`). GitHub serves that path from the newest published release, so the URL is the same for every version, and a draft or prerelease is not offered to anyone.

The `.patch` is a delta from the previous release. Electrobun builds it by downloading the previous release's tarball during `build:stable`, so it exists from the second release on. An app more than one release behind finds no patch for its version and downloads the whole tarball instead.

Before uploading, the build job checks that the bundle's tmux links only system libraries and that the bundled CLI passes `daedal doctor` with `PATH=/usr/bin:/bin`.

## What the app bundles

| Path in `Daedalus.app/Contents`    | Why                                                              |
| ---------------------------------- | ---------------------------------------------------------------- |
| `MacOS/bun` (1.3.13, Electrobun's) | the app's runtime, and the one the `daedal` shim runs the CLI on |
| `MacOS/tmux` (3.7c)                | every session; built by `scripts/build-tmux.ts`                  |
| `Resources/app/cli/daedal.js`      | the CLI; the app writes a shim to `~/.daedalus/bin/daedal`       |
| `Resources/bin/daedal`             | the launcher the cask links onto PATH; runs the CLI above        |

`scripts/build-tmux.ts` builds tmux from pinned, checksummed sources with libevent and utf8proc linked in, so the binary needs only `/usr/lib`. `scripts/electrobun-post-build.ts` copies it into `Contents/MacOS`, where Electrobun signs it with everything else. The app exports its path as `DAEDALUS_TMUX` and the bundled CLI sets the same variable, so the app, the CLI and every session use the same tmux. A Mac that also has Homebrew's tmux keeps it; the two talk to each other's servers.

## Signing and notarization

Without an Apple Developer ID the release is ad-hoc signed. Gatekeeper then refuses to open the DMG build from a browser download until the user clears the quarantine flag, and the Homebrew cask clears it on install. The updater never meets this, because files it downloads are not quarantined.

To sign and notarize, add these repository secrets:

| Secret                       | Value                                                            |
| ---------------------------- | ---------------------------------------------------------------- |
| `MACOS_CERTIFICATE_P12`      | a "Developer ID Application" certificate with its key, as base64 |
| `MACOS_CERTIFICATE_PASSWORD` | the password of that `.p12`                                      |
| `MACOS_DEVELOPER_ID`         | its name, e.g. `Developer ID Application: Name (TEAMID)`         |
| `APPLE_API_KEY_P8`           | an App Store Connect API key, as base64                          |
| `APPLE_API_KEY_ID`           | that key's ID                                                    |
| `APPLE_API_ISSUER`           | the issuer ID shown with it                                      |

With the certificate the build is signed; with the key as well it is notarized and stapled, and the cask drops its quarantine step. `electrobun.config.ts` switches each on from the environment, so a local `build:stable` with the same variables set does the same.

## Homebrew

The cask lives in [Bakar0/homebrew-tap](https://github.com/Bakar0/homebrew-tap) as `Casks/daedalus.rb`, beside the `servant` formula, and installs with `brew install --cask bakar0/tap/daedalus`. The publish job pushes it with the same GitHub App the servant release uses: set `APP_ID` and `APP_PRIVATE_KEY` in this repository's secrets. Without them the cask is still attached to the release and can be copied into the tap by hand.

`scripts/homebrew-cask.ts` writes the cask from the two DMGs. Its `binary` line links `daedal` from `Contents/Resources/bin/daedal` into Homebrew's `bin`, so the command is on PATH right after `brew install`. The launcher is in both the self-unpacking wrapper Homebrew installs (added by `scripts/electrobun-post-wrap.ts`) and the unpacked app (added by `scripts/electrobun-post-build.ts`); before the first launch it says to open the app once. The cask sets `auto_updates true`, because the app replaces itself, and its `zap` never touches `~/.daedalus`, which holds the user's workspaces and database.
