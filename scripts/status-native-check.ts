import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

interface NativeStatusProbe {
  error?: string;
  url?: string;
  selectedSessionId?: string | null;
  heading?: string;
  headingModel?: string;
  status?: string;
  statusModel?: string;
  context?: string;
  usage?: string;
  codexUsage?: string;
  claudeUsage?: string;
}

const projectRoot = resolve(import.meta.dir, "..");
const artifactsDirectory = join(projectRoot, "artifacts");
const resultPath = join(
  artifactsDirectory,
  `status-native-check-${Date.now()}.json`,
);
const launcher = join(
  projectRoot,
  "build/stable-macos-arm64/Daedalus.app/Contents/MacOS/launcher",
);
await mkdir(artifactsDirectory, { recursive: true });

const processHandle = Bun.spawn([launcher], {
  cwd: projectRoot,
  env: { ...process.env, DAEDALUS_STATUS_PROBE_PATH: resultPath },
  stdout: "ignore",
  stderr: "ignore",
});

let result: NativeStatusProbe | undefined;
for (let attempt = 0; attempt < 600; attempt += 1) {
  try {
    result = JSON.parse(await readFile(resultPath, "utf8"));
    break;
  } catch {
    await Bun.sleep(100);
  }
}
if (!result) {
  processHandle.kill();
  throw new Error(`Packaged WKWebView probe timed out; expected ${resultPath}`);
}
if (result.error)
  throw new Error(`Packaged WKWebView probe failed: ${result.error}`);
if (!result.selectedSessionId)
  throw new Error("Packaged app has no visible Claude session to inspect");
if (!result.headingModel)
  throw new Error(`Claude heading model is missing: ${result.heading ?? ""}`);
if (!result.statusModel)
  throw new Error(
    `Claude status-line model is missing: ${result.status ?? ""}`,
  );
if (!result.context?.startsWith("Context ") || !result.context.includes("/"))
  throw new Error(
    `Claude context is missing or incomplete: ${result.context ?? ""}`,
  );

console.log(
  `Packaged WKWebView status check passed (${result.selectedSessionId})`,
);
console.log(`Model: ${result.statusModel}`);
console.log(`Context: ${result.context}`);
console.log(`Codex usage: ${result.codexUsage || "not reported by provider"}`);
console.log(
  `Claude usage: ${result.claudeUsage || "not reported by provider"}`,
);
console.log(`Probe: ${resultPath}`);
