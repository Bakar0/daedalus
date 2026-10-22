# Releasing

A release is a git tag. Pushing `v<version>` runs `.github/workflows/release.yml`, which builds the stable app on an Apple silicon runner, publishes a GitHub release, and updates the Homebrew cask. A tag with a prerelease suffix, such as `v0.32.0-beta.1`, publishes a beta instead; see [Betas](#betas).

## Cutting a release

1. Set `version` in `package.json` to the new version, for example `0.9.0`, and merge that to `main`. The app offers an update only when the released version is higher than the running one, so every release needs a new version.
2. Tag the merge commit and push the tag:

   ```sh
   git tag v0.9.0 && git push origin v0.9.0
   ```

The workflow refuses a tag that does not match `package.json`.

## Betas

A beta is the same app as a stable release: the stable channel, identifier `dev.daedalus.app` and home `~/.daedalus`. Only its version carries a suffix, and only the users who turn on "Get beta updates" are offered it.

### Cutting a beta

1. Set `version` in `package.json` to the next version with a `-beta.N` suffix, for example `0.32.0-beta.1`, and merge that to `main`.
2. Tag the merge commit and push the tag:

   ```sh
   git tag v0.32.0-beta.1 && git push origin v0.32.0-beta.1
   ```

The workflow builds and checks the app as for a stable release, then:

- publishes a GitHub release `v0.32.0-beta.1` marked as a prerelease and never as latest, so `releases/latest`, the stable feed and the README badge stay on the last stable release;
- skips the Homebrew cask, which `scripts/homebrew-cask.ts` refuses for a prerelease version anyway;
- runs the `beta-feed` job, which copies the DMGs, tarballs, patches and `update.json` files of the highest beta published to the rolling `beta` release, creating that release the first time.

The next beta of the same version is `-beta.2`. Versions compare by semver precedence, so `0.31.0 < 0.32.0-beta.1 < 0.32.0-beta.2 < 0.32.0-beta.10 < 0.32.0`.

### Promoting a beta to stable

Cut a normal release of the same version without the suffix: set `version` to `0.32.0`, merge, tag `v0.32.0` and push. Nothing about the beta needs to change. The new release becomes latest, stable users get it through the stable feed and the cask, and beta users get it too, because `0.32.0` is higher than any `0.32.0-beta.N` and they read both feeds. The `beta` release keeps the last beta until the next one replaces it; that does no harm, since the app never offers a version lower than the one it runs.

### The beta feed

`releases/latest/download/` skips prereleases, so betas need a URL of their own that does not change between versions. The workflow keeps one prerelease tagged `beta`, and each beta replaces its assets, so the feed is `https://github.com/Bakar0/daedalus/releases/download/beta/` (`BETA_FEED_URL` in `packages/core/src/services/app-updates.ts`). The job deletes the old `update.json` files first, uploads the bundles and patches, then uploads the new `update.json`, and finally removes assets an older beta left behind. An app that checks during the upload gets a 404, which it treats as no beta, rather than an old manifest naming a bundle that was already replaced. The job copies the highest beta by version (`scripts/beta-feed.ts`), not the tag that started it. GitHub keeps only the newest queued run of the job's concurrency group and cancels the others, and tags can finish out of order, but whichever run comes last still leaves the highest beta in place. To repair the feed by hand, re-run the `beta-feed` job of any beta's workflow run. A rolling release was chosen over the alternatives because it needs nothing outside this repository: a branch or Pages site would put build output in git, and a bucket would need credentials the workflow does not have. Testers who want a DMG can also download it from the `beta` release.

Every build, beta or stable, bakes the stable feed into its `version.json`. The beta feed is chosen at run time:

- "Get beta updates" is off by default. It is in Settings › About and in the CLI as `daedal update beta on|off`; both write `betaUpdatesEnabled` in `~/.daedalus/config.json`, and the app reads it again before each check.
- On, each check reads the stable feed and then the beta feed and offers the highest version newer than the running one. Stable wins a tie. A beta feed that does not exist yet, or fails, leaves the stable answer standing.
- Off, the app reads only the stable feed. A beta already installed stays until a stable release passes it; turning the setting off never installs an older version.

Electrobun 2 reads the feed URL from the `version.json` object it caches, on every check and download, so the app points that object's `baseUrl` at the chosen feed (`apps/desktop/src/bun/index.ts`). Checks and installs run one at a time (`UpdateController`), so an install clicked during a check waits for it, and a download reads its feed again first, because the last check may have been the other feed's.

Apple defines `CFBundleShortVersionString` and `CFBundleVersion` as period-separated integers, and Electrobun copies the whole version into `CFBundleVersion`. `scripts/electrobun-post-build.ts` therefore writes the numeric part, `0.32.0` for `0.32.0-beta.1`, to both keys before the bundle is signed (`scripts/bundle-version.ts`). The full version stays in `Resources/version.json`, which the updater compares and Settings › About shows.

A beta's `.patch` is a delta from the latest stable release, since that is the feed the build reads. A beta user moving to the next beta has no patch for their version and downloads the whole tarball.

## What a release contains

A release has an Apple silicon (`arm64`) build only. 0.31.0 was the last release with an Intel (`x64`) build; the workflow re-attaches 0.31.0's `stable-macos-x64-update.json` to every release so Intel installs of 0.31.0 find no update instead of a 404:

| Asset                                     | Read by                                   |
| ----------------------------------------- | ----------------------------------------- |
| `stable-macos-arm64-Daedalus.dmg`         | people downloading by hand, and the cask  |
| `stable-macos-arm64-update.json`          | the app's update check                    |
| `stable-macos-arm64-Daedalus.app.tar.zst` | the app's update download                 |
| `stable-macos-arm64-<hash>.patch`         | the app's update download, when it exists |

and `daedalus.rb`, the cask as written for this release.

The app reads its feed from `https://github.com/Bakar0/daedalus/releases/latest/download/` (`RELEASE_BASE_URL` in `electrobun.config.ts`). GitHub serves that path from the newest published release, so the URL is the same for every version, and a draft or prerelease is not offered through it. Betas have their own feed; see [The beta feed](#the-beta-feed).

The `.patch` is a delta from the previous release. Electrobun builds it by downloading the previous release's tarball during `build:stable`, so it exists from the second release on. An app more than one release behind finds no patch for its version and downloads the whole tarball instead.

Before uploading, the build job checks that the bundle's tmux links only system libraries and that the bundled CLI passes `daedal doctor` with `PATH=/usr/bin:/bin`.

## What the app bundles

| Path in `Daedalus.app/Contents`   | Why                                                              |
| --------------------------------- | ---------------------------------------------------------------- |
| `MacOS/bun` (1.4.0, Electrobun's) | the app's runtime, and the one the `daedal` shim runs the CLI on |
| `MacOS/tmux` (3.7c)               | every session; built by `scripts/build-tmux.ts`                  |
| `Resources/app/cli/daedal.js`     | the CLI; the app writes a shim to `~/.daedalus/bin/daedal`       |
| `Resources/bin/daedal`            | the launcher the cask links onto PATH; runs the CLI above        |

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

`scripts/homebrew-cask.ts` writes the cask from the DMG. Its `binary` line links `daedal` from `Contents/Resources/bin/daedal` into Homebrew's `bin`, so the command is on PATH right after `brew install`. The launcher is in both the self-unpacking wrapper Homebrew installs (added by `scripts/electrobun-post-wrap.ts`) and the unpacked app (added by `scripts/electrobun-post-build.ts`); before the first launch it says to open the app once. The cask sets `auto_updates true`, because the app replaces itself, and its `zap` never touches `~/.daedalus`, which holds the user's workspaces and database.
