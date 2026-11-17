// Fetches the ripgrep that ships inside Daedalus.app, for the ⌘K palette's
// content search.
//
// ripgrep's own release builds for macOS link only /usr/lib from 15.0 on
// (14.1.1's arm64 build linked Homebrew's pcre2, so it would not load on a
// clean Mac), and target macOS 11 like the Electrobun launcher. The archive
// is pinned by version and SHA-256; the binary lands at
// build/ripgrep/<arch>/rg, and scripts/electrobun-post-build.ts copies it
// into Contents/MacOS next to tmux. A second run finds it and exits.
//
// `bun run scripts/fetch-ripgrep.ts [--arch arm64|x64]`
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

export const RIPGREP_VERSION = "15.1.0";

const ARCHIVES = {
  arm64: {
    triple: "aarch64-apple-darwin",
    sha256: "378e973289176ca0c6054054ee7f631a065874a352bf43f0fa60ef079b6ba715",
  },
  x64: {
    triple: "x86_64-apple-darwin",
    sha256: "64811cb24e77cac3057d6c40b63ac9becf9082eedd54ca411b475b755d334882",
  },
} as const;

const archFlag = process.argv.indexOf("--arch");
const arch =
  archFlag >= 0
    ? process.argv[archFlag + 1]
    : process.arch === "x64"
      ? "x64"
      : "arm64";
if (arch !== "arm64" && arch !== "x64") {
  console.error(`Unknown --arch ${arch}; expected arm64 or x64.`);
  process.exit(2);
}
const { triple, sha256 } = ARCHIVES[arch];

const root = resolve(import.meta.dir, "..", "build", "ripgrep");
const output = join(root, arch, "rg");

function version(executable: string): string | undefined {
  const result = Bun.spawnSync([executable, "--version"]);
  return result.exitCode === 0
    ? result.stdout.toString().split("\n")[0]?.trim()
    : undefined;
}

if (
  (await Bun.file(output).exists()) &&
  version(output)?.startsWith(`ripgrep ${RIPGREP_VERSION} `)
) {
  console.log(`${output} is already ripgrep ${RIPGREP_VERSION}`);
  process.exit(0);
}

const name = `ripgrep-${RIPGREP_VERSION}-${triple}`;
const url = `https://github.com/BurntSushi/ripgrep/releases/download/${RIPGREP_VERSION}/${name}.tar.gz`;
const response = await fetch(url);
if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
const archive = new Uint8Array(await response.arrayBuffer());
const digest = new Bun.CryptoHasher("sha256").update(archive).digest("hex");
if (digest !== sha256)
  throw new Error(
    `${url}: SHA-256 ${digest} does not match the pinned ${sha256}`,
  );

await mkdir(root, { recursive: true });
const work = await mkdtemp(join(root, "work-"));
try {
  const tarball = join(work, `${name}.tar.gz`);
  await Bun.write(tarball, archive);
  const untar = Bun.spawnSync(
    ["tar", "-xzf", tarball, "-C", work, `${name}/rg`],
    { stderr: "inherit" },
  );
  if (untar.exitCode !== 0) throw new Error(`tar failed on ${tarball}`);
  const binary = join(work, name, "rg");

  // A bundle must not load anything from outside the system.
  const linked = Bun.spawnSync(["otool", "-L", binary])
    .stdout.toString()
    .split("\n")
    .slice(1)
    .map((line) => line.trim().split(" ")[0])
    .filter((path): path is string => Boolean(path));
  const foreign = linked.filter((path) => !path.startsWith("/usr/lib/"));
  if (foreign.length) {
    console.error(
      `ripgrep links libraries outside /usr/lib: ${foreign.join(", ")}`,
    );
    process.exit(1);
  }

  await mkdir(join(root, arch), { recursive: true });
  await Bun.write(output, Bun.file(binary));
  Bun.spawnSync(["chmod", "755", output]);
  console.log(`Fetched ${output} (${version(output)})`);
} finally {
  await rm(work, { recursive: true, force: true });
}
