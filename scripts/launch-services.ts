// Launch Services keeps every Daedalus.app it has ever seen: each worktree's
// `build/stable-macos-*` output, and copies whose folder is long deleted. They
// all carry the stable identifier, and macOS picks among them for anything it
// resolves by identifier, including the icon on a notification. A stale build
// from before the app had an icon made every alert show a blank one, so an
// install leaves the installed bundle as the only registration.
export const LSREGISTER =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";

export interface Registration {
  path: string;
  identifier: string;
}

/**
 * Reads the bundle records out of `lsregister -dump`. The dump is a sequence of
 * records separated by lines of dashes; a bundle record has one `path:` and one
 * `identifier:` field, and the path ends in the record's hex id, `(0x5aa4)`.
 */
export function parseRegistrations(dump: string): Registration[] {
  const registrations: Registration[] = [];
  for (const record of dump.split(/^-{20,}$/m)) {
    const path = /^path:\s+(.+?)(?:\s+\(0x[0-9a-f]+\))?\s*$/m.exec(record)?.[1];
    const identifier = /^identifier:\s+(\S+)\s*$/m.exec(record)?.[1];
    if (path && identifier) registrations.push({ path, identifier });
  }
  return registrations;
}

/** Every registered bundle for `identifier` other than the one being kept. */
export function staleRegistrations(
  dump: string,
  identifier: string,
  keep: string,
): string[] {
  const paths = parseRegistrations(dump)
    .filter((it) => it.identifier === identifier && it.path !== keep)
    .map((it) => it.path);
  return [...new Set(paths)];
}
