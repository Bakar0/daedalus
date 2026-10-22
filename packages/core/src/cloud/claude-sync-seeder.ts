import { homedir } from "node:os";
import { join } from "node:path";
import type { DaedalusConfig } from "../config";
import { accountConfig } from "../services/account-homes";
import { CLOUD_DAEDAL } from "../services/cloud-launch";
import { claudeStatePath } from "../services/folder-trust";
import { SkillService } from "../services/skills";
import {
  collectClaudeSync,
  parseManifest,
  planSync,
  POD_INSTALLED_PLUGINS,
  POD_KNOWN_MARKETPLACES,
  seedInstalledPlugins,
  seedKnownMarketplaces,
  SYNC_MANIFEST_PATH,
  syncedSettings,
  syncedState,
  syncReport,
  type ClaudeSync,
} from "./claude-sync";
import { CLOUD_SEED_PATHS } from "./cloud-seed";
import type { CloudLaunchSeeder } from "./cloud-service";

/**
 * What a cloud Claude takes of this Mac's Claude setup, from the folder of
 * the account it launches with.
 */
export async function gatherClaudeSync(
  config: DaedalusConfig,
  account: string | null,
): Promise<ClaudeSync> {
  const claude = accountConfig(config, "claude", account);
  const read = async (path: string) => {
    const file = Bun.file(path);
    return (await file.exists())
      ? file.text().catch(() => undefined)
      : undefined;
  };
  const skills = new SkillService(config);
  return collectClaudeSync({
    claudeHome: claude.claudeHome,
    macHome: homedir(),
    stateText: await read(claudeStatePath(claude)),
    settingsText: await read(join(claude.claudeHome, "settings.json")),
    daedalusSkills: skills.cloudSkills(CLOUD_DAEDAL),
    daedalusStyle: skills.claudeSkillSettings().outputStyle,
    mcpOn: config.cloudMcpServers,
  });
}

/**
 * The launch step that copies the user's Claude setup into the pod
 * (claude-sync.ts): only what changed since the last launch, then one
 * `cloud_claude_sync` log line saying what was copied and what was not.
 */
export function claudeSyncSeeder(options: {
  config: DaedalusConfig;
  log?: (event: string, fields?: Record<string, unknown>) => void;
}): CloudLaunchSeeder {
  return async ({ host, session }) => {
    const sync = await gatherClaudeSync(options.config, session.account);
    // What the Mac copied last time. The pod could make it say anything;
    // the worst it can do is have a file skipped or deleted in the pod.
    const manifest = parseManifest(
      await host.readText(SYNC_MANIFEST_PATH).catch(() => undefined),
    );
    const plan = planSync(sync, manifest);
    const merged: { path: string; bytes: Uint8Array }[] = [];
    const put = (path: string, text: string | undefined) => {
      if (text !== undefined) merged.push({ path, bytes: Buffer.from(text) });
    };
    put(
      CLOUD_SEED_PATHS.claudeSettings,
      syncedSettings(
        await host.readText(CLOUD_SEED_PATHS.claudeSettings),
        sync,
        manifest,
      ),
    );
    put(
      CLOUD_SEED_PATHS.claudeState,
      syncedState(
        await host.readText(CLOUD_SEED_PATHS.claudeState),
        sync,
        manifest,
      ),
    );
    put(
      POD_INSTALLED_PLUGINS,
      seedInstalledPlugins(
        await host.readText(POD_INSTALLED_PLUGINS).catch(() => undefined),
        sync.plugins,
        manifest.plugins,
      ),
    );
    put(
      POD_KNOWN_MARKETPLACES,
      seedKnownMarketplaces(
        await host.readText(POD_KNOWN_MARKETPLACES).catch(() => undefined),
        sync.marketplaces,
        manifest.marketplaces,
      ),
    );
    const isManifest = (file: { path: string }) =>
      file.path === SYNC_MANIFEST_PATH;
    // The manifest goes last, after everything it lists.
    await host.writeFiles([
      ...plan.writes.filter((file) => !isManifest(file)),
      ...merged,
      ...plan.writes.filter(isManifest),
    ]);
    // fs.write makes plain files; scripts in skills and plugins need to run.
    // Neither command stops a launch: the files are in place either way.
    const failed: string[] = [];
    const run = async (executable: string, args: string[]) => {
      const result = await host
        .run(executable, args)
        .catch((error: unknown) => ({
          exitCode: -1,
          stdout: "",
          stderr: error instanceof Error ? error.message : String(error),
        }));
      if (result.exitCode !== 0)
        failed.push(`${executable}: ${result.stderr.trim().slice(0, 200)}`);
    };
    if (plan.executable.length)
      await run("chmod", ["+x", "--", ...plan.executable]);
    if (plan.removed.length) await run("rm", ["-f", "--", ...plan.removed]);
    options.log?.("cloud_claude_sync", {
      hostId: session.hostId,
      ...syncReport(sync, plan),
      ...(failed.length ? { failed } : {}),
    });
  };
}
