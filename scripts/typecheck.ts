// Type-checks the repository and reports only the repository's own errors.
//
// Electrobun publishes raw `.ts` sources rather than declarations, so importing
// `electrobun/bun` pulls its implementation into the program. `skipLibCheck`
// does not reach it — that option only skips `.d.ts` — so the package gets
// compiled under this repository's settings instead of its own, and TypeScript
// 7 with `strict` and `@types/bun` 1.4.2 reports errors inside a dependency
// nobody here can fix. Those are the dependency's diagnostics, not a signal
// about this codebase, and letting them fail CI hides the diagnostics that are.
//
// Misuse of a dependency still fails: TypeScript reports that at the call site,
// which lives in this repository and is never suppressed here. The suppressed
// count is printed so the filter stays visible rather than silent.
import { dirname, resolve } from "node:path";

const projectRoot = resolve(import.meta.dir, "..");
const tsc = Bun.spawn(
  [process.execPath, "x", "tsc", "--noEmit", "--pretty", "false"],
  { cwd: projectRoot, stdout: "pipe", stderr: "pipe" },
);
const [stdout, stderr, exitCode] = await Promise.all([
  new Response(tsc.stdout).text(),
  new Response(tsc.stderr).text(),
  tsc.exited,
]);

const DIAGNOSTIC = /^(?<file>\S.*?)\((?<line>\d+),\d+\): (?:error|warning) TS/;

// A diagnostic is one unindented header line followed by its indented detail
// lines, so groups are formed by header and carried along with their detail.
const groups: Array<{ file?: string; lines: string[] }> = [];
for (const line of `${stdout}${stderr}`.split("\n")) {
  if (!line.trim()) continue;
  if (/^\s/.test(line) && groups.length) {
    groups[groups.length - 1]!.lines.push(line);
    continue;
  }
  const file = DIAGNOSTIC.exec(line)?.groups?.file;
  groups.push({ ...(file ? { file } : {}), lines: [line] });
}

const isDependency = (file?: string): boolean =>
  file !== undefined && `${dirname(file)}/`.includes("node_modules/");
const reported = groups.filter((group) => !isDependency(group.file));
const suppressed = groups.length - reported.length;

for (const group of reported)
  for (const line of group.lines) console.error(line);

// tsc failed but produced nothing this script could read: report that rather
// than mistaking an unparsed failure for a clean run.
if (exitCode !== 0 && groups.length === 0) {
  console.error(`tsc exited ${exitCode} without any parsable diagnostic.`);
  process.exit(1);
}
if (reported.length > 0) process.exit(1);
console.log(
  suppressed === 0
    ? "Type-checked with no errors."
    : `Type-checked with no errors (${suppressed} diagnostic${suppressed === 1 ? "" : "s"} inside node_modules ignored).`,
);
