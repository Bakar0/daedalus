// The versions written into Info.plist. Apple defines CFBundleShortVersionString
// and CFBundleVersion as period-separated integers, and Electrobun copies
// `app.version` into CFBundleVersion as is, so a beta would carry
// `0.32.0-beta.1` there. The plist gets the numeric part instead; the full
// version stays in Resources/version.json, which is what the updater compares
// and what Settings › About shows.

/** `0.32.0-beta.1` becomes `0.32.0`; a version without a suffix is kept. */
export function bundleVersion(version: string): string {
  const match = /^(\d+\.\d+\.\d+)(?:-[0-9A-Za-z.-]+)?$/.exec(version);
  if (!match) throw new Error(`Not a release version: ${version}`);
  return match[1]!;
}

/**
 * Sets both plist versions. `plutil -replace` adds a key that is missing,
 * which CFBundleShortVersionString is: Electrobun does not write it.
 */
export function writeBundleVersion(plist: string, version: string): string {
  const value = bundleVersion(version);
  for (const key of ["CFBundleShortVersionString", "CFBundleVersion"]) {
    const result = Bun.spawnSync([
      "plutil",
      "-replace",
      key,
      "-string",
      value,
      plist,
    ]);
    if (result.exitCode !== 0)
      throw new Error(
        `plutil could not set ${key} in ${plist}: ${result.stderr.toString()}`,
      );
  }
  return value;
}
