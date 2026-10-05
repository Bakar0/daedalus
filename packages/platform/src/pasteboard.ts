import { runCommand } from "./process";

const OSASCRIPT = "/usr/bin/osascript";

// JavaScript for Automation, because the system pasteboard's file URLs are an
// AppKit type that no command-line tool reads or writes. Paths travel as
// `argv`, never spliced into the script.
const READ_FILES = `
ObjC.import("AppKit");
function run() {
  const urls = $.NSPasteboard.generalPasteboard.readObjectsForClassesOptions(
    $([$.NSURL]),
    $(),
  );
  const paths = [];
  if (urls && !urls.isNil())
    for (let index = 0; index < urls.count; index += 1) {
      const url = urls.objectAtIndex(index);
      if (url.isFileURL) paths.push(url.path.js);
    }
  return JSON.stringify(paths);
}`;

const WRITE_FILES = `
ObjC.import("AppKit");
function run(argv) {
  const pasteboard = $.NSPasteboard.generalPasteboard;
  pasteboard.clearContents;
  // Built item by item: bridging a JavaScript array of NSURLs keeps only one.
  const urls = $.NSMutableArray.array;
  for (const path of argv) urls.addObject($.NSURL.fileURLWithPath(path));
  pasteboard.writeObjects(urls);
  return String(argv.length);
}`;

const TIMEOUT_MS = 5_000;

/** The files on the macOS pasteboard, as absolute paths; empty when it holds none. */
export async function readPasteboardFiles(): Promise<string[]> {
  const result = await runCommand(
    OSASCRIPT,
    ["-l", "JavaScript", "-e", READ_FILES],
    { timeoutMs: TIMEOUT_MS },
  );
  if (result.exitCode !== 0)
    throw new Error(result.stderr.trim() || "Could not read the pasteboard");
  const parsed: unknown = JSON.parse(result.stdout.trim() || "[]");
  return Array.isArray(parsed)
    ? parsed.filter((path): path is string => typeof path === "string")
    : [];
}

/** Puts files on the macOS pasteboard, as Finder's Copy does. */
export async function writePasteboardFiles(
  paths: readonly string[],
): Promise<void> {
  const result = await runCommand(
    OSASCRIPT,
    ["-l", "JavaScript", "-e", WRITE_FILES, ...paths],
    { timeoutMs: TIMEOUT_MS },
  );
  if (result.exitCode !== 0)
    throw new Error(result.stderr.trim() || "Could not write the pasteboard");
}
