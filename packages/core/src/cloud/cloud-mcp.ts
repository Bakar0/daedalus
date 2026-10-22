import { updateSettings, type DaedalusConfig } from "../config";
import { DaedalusError } from "../errors";
import { claudeStatePath } from "../services/folder-trust";
import { cloudMcpUrlHash, remoteMcpServers } from "./claude-sync";

/**
 * The remote MCP servers the user may turn on for cloud sessions, from the
 * default Claude account, and the ones that cannot go with why. A server's
 * URL never leaves this module: a key can sit in its path, so the renderer
 * gets its host.
 */
export async function cloudMcpChoices(config: DaedalusConfig): Promise<{
  servers: { name: string; host: string; on: boolean }[];
  leftOut: { name: string; reason: string }[];
}> {
  const { servers, leftOut } = remoteMcpServers(await claudeState(config));
  return {
    servers: Object.entries(servers).map(([name, server]) => ({
      name,
      host: new URL(server.url).host,
      on: config.cloudMcpServers[name] === cloudMcpUrlHash(server.url),
    })),
    leftOut,
  };
}

/**
 * Turns a server on or off for cloud sessions. On records the hash of its
 * URL now, so a later change of URL turns it off again.
 */
export async function setCloudMcpServer(
  config: DaedalusConfig,
  name: string,
  on: boolean,
): Promise<void> {
  const server = remoteMcpServers(await claudeState(config)).servers[name];
  if (on && !server)
    throw new DaedalusError(
      "VALIDATION",
      `'${name}' is not a remote MCP server that can go to the cloud`,
    );
  await updateSettings(config, (current) => {
    const next = { ...current.cloudMcpServers };
    if (on && server) next[name] = cloudMcpUrlHash(server.url);
    else delete next[name];
    return { cloudMcpServers: next };
  });
}

async function claudeState(
  config: DaedalusConfig,
): Promise<string | undefined> {
  const file = Bun.file(claudeStatePath(config));
  return (await file.exists()) ? file.text().catch(() => undefined) : undefined;
}
