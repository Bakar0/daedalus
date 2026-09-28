// Builds the tmux that ships inside Daedalus.app.
//
// Every agent runs in tmux, and a Mac has no tmux until someone installs one.
// The Homebrew build links Homebrew's libevent, utf8proc and ncurses by
// absolute path, so it cannot be copied into a bundle either. This one links
// libevent and utf8proc statically and takes curses from the system, so the
// binary loads on any Mac with nothing installed: `otool -L` lists only
// /usr/lib. macOS ships the `tmux-256color` terminfo entry tmux asks for.
//
// The result lands at build/tmux/<arch>/tmux, and the Electrobun config copies
// it into the bundle when it exists. Sources are pinned by SHA-256 and cached
// under build/tmux/src, so a second run only relinks nothing and exits.
//
// `bun run scripts/build-tmux.ts [--arch arm64|x64]`
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

export const TMUX_VERSION = "3.7c";

const SOURCES = {
  tmux: {
    url: `https://github.com/tmux/tmux/releases/download/${TMUX_VERSION}/tmux-${TMUX_VERSION}.tar.gz`,
    sha256: "7c60cae9a0e25288e2e24750aafc9e8800fc7fd4555e447e1b29ee4201cfb3bf",
    directory: `tmux-${TMUX_VERSION}`,
  },
  libevent: {
    url: "https://github.com/libevent/libevent/releases/download/release-2.1.13-stable/libevent-2.1.13-stable.tar.gz",
    sha256: "f7e9383b8c0baa81b687e5b5eecc01beefaf1b19b64151d95ed61647fe7a315c",
    directory: "libevent-2.1.13-stable",
  },
  utf8proc: {
    url: "https://github.com/JuliaStrings/utf8proc/archive/refs/tags/v2.12.0.tar.gz",
    sha256: "f564011d38b2888d583d510b08e69ffa15aa117155db1b9b49ef1dfe1fa25111",
    directory: "utf8proc-2.12.0",
  },
} as const;

// The Electrobun launcher targets macOS 11, so the bundled tmux does too.
const MINIMUM_MACOS = "11.0";

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
const clangArch = arch === "x64" ? "x86_64" : "arm64";
// autoconf predates the name `arm64`; its triple for Apple silicon is aarch64.
const host = `${arch === "x64" ? "x86_64" : "aarch64"}-apple-darwin`;

const root = resolve(import.meta.dir, "..", "build", "tmux");
const cache = join(root, "src");
const work = join(root, `work-${arch}`);
const prefix = join(work, "prefix");
const output = join(root, arch, "tmux");

const flags = `-arch ${clangArch} -mmacosx-version-min=${MINIMUM_MACOS} -O2`;
const environment = {
  ...process.env,
  CFLAGS: flags,
  LDFLAGS: `-arch ${clangArch} -mmacosx-version-min=${MINIMUM_MACOS}`,
  MACOSX_DEPLOYMENT_TARGET: MINIMUM_MACOS,
  // Nothing from Homebrew may be found by configure, or the binary would link
  // it again. pkg-config sees only the prefix built here.
  PKG_CONFIG_LIBDIR: join(prefix, "lib", "pkgconfig"),
  PKG_CONFIG_PATH: "",
};

async function run(command: string[], cwd: string) {
  const child = Bun.spawn(command, {
    cwd,
    env: environment,
    stdout: "inherit",
    stderr: "inherit",
  });
  if ((await child.exited) !== 0)
    throw new Error(`${command.join(" ")} failed in ${cwd}`);
}

async function fetchSource(source: (typeof SOURCES)[keyof typeof SOURCES]) {
  const archive = join(cache, `${source.directory}.tar.gz`);
  if (!(await Bun.file(archive).exists())) {
    const response = await fetch(source.url);
    if (!response.ok) throw new Error(`${source.url}: HTTP ${response.status}`);
    await Bun.write(archive, await response.arrayBuffer());
  }
  const digest = new Bun.CryptoHasher("sha256")
    .update(await Bun.file(archive).arrayBuffer())
    .digest("hex");
  if (digest !== source.sha256) {
    await rm(archive, { force: true });
    throw new Error(
      `${source.url}: SHA-256 ${digest} does not match the pinned ${source.sha256}`,
    );
  }
  await run(["tar", "-xzf", archive, "-C", work], work);
  return join(work, source.directory);
}

async function version(executable: string) {
  if (!(await Bun.file(executable).exists())) return undefined;
  const result = Bun.spawnSync([executable, "-V"]);
  return result.exitCode === 0 ? result.stdout.toString().trim() : undefined;
}

if ((await version(output)) === `tmux ${TMUX_VERSION}`) {
  console.log(`${output} is already tmux ${TMUX_VERSION}`);
  process.exit(0);
}

await rm(work, { recursive: true, force: true });
await mkdir(cache, { recursive: true });
await mkdir(prefix, { recursive: true });
const jobs = String(navigator.hardwareConcurrency || 4);

const libevent = await fetchSource(SOURCES.libevent);
await run(
  [
    "./configure",
    `--prefix=${prefix}`,
    `--host=${host}`,
    "--disable-shared",
    "--enable-static",
    "--disable-openssl",
    "--disable-samples",
    "--disable-libevent-regress",
    "--disable-debug-mode",
  ],
  libevent,
);
await run(["make", `-j${jobs}`, "install"], libevent);

const utf8proc = await fetchSource(SOURCES.utf8proc);
await run(["make", `-j${jobs}`, "libutf8proc.a", `CFLAGS=${flags}`], utf8proc);
await mkdir(join(prefix, "include"), { recursive: true });
await run(["cp", "utf8proc.h", join(prefix, "include")], utf8proc);
await run(["cp", "libutf8proc.a", join(prefix, "lib")], utf8proc);

const tmux = await fetchSource(SOURCES.tmux);
const include = join(prefix, "include");
const lib = join(prefix, "lib");
await run(
  [
    "./configure",
    `--host=${host}`,
    "--enable-utf8proc",
    // Homebrew links jemalloc; the system allocator needs nothing bundled.
    "--disable-jemalloc",
    // The static archives are named outright: with only a prefix on the
    // search path, the linker would still prefer any libevent dylib it finds.
    `LIBEVENT_CORE_CFLAGS=-I${include}`,
    `LIBEVENT_CORE_LIBS=${join(lib, "libevent_core.a")}`,
    `LIBEVENT_CFLAGS=-I${include}`,
    `LIBEVENT_LIBS=${join(lib, "libevent_core.a")}`,
    `LIBUTF8PROC_CFLAGS=-I${include}`,
    `LIBUTF8PROC_LIBS=${join(lib, "libutf8proc.a")}`,
    `CPPFLAGS=-I${include} -DUTF8PROC_STATIC`,
  ],
  tmux,
);
await run(["make", `-j${jobs}`], tmux);

// A bundle must not load anything from outside the system, so the check is
// the whole point of the script rather than a courtesy.
const linked = Bun.spawnSync(["otool", "-L", join(tmux, "tmux")])
  .stdout.toString()
  .split("\n")
  .slice(1)
  .map((line) => line.trim().split(" ")[0])
  .filter((path): path is string => Boolean(path));
const foreign = linked.filter((path) => !path.startsWith("/usr/lib/"));
if (foreign.length) {
  console.error(`tmux links libraries outside /usr/lib: ${foreign.join(", ")}`);
  process.exit(1);
}

await mkdir(join(root, arch), { recursive: true });
await run(["cp", join(tmux, "tmux"), output], root);
await run(["strip", "-x", output], root);
await rm(work, { recursive: true, force: true });
console.log(
  `Built ${output} (${await version(output)}), linking ${linked.join(", ")}`,
);
